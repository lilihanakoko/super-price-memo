import { db, uid, STORES } from './db.js';
import { Scanner, parseSize, normalize, preloadOcr, statusJa } from './ocr.js';

// ---------- 定数・小道具 ----------

const DEFAULT_BRANDS = ['ザ・ビッグ', 'ラルズマート', 'スーパーアークス', 'コープさっぽろ', 'ダイイチ', 'イオン', 'マックスバリュ'];
const CATEGORIES = ['野菜', '果物', '肉', '魚', '乳製品・卵', '豆腐・納豆', '米・パン・麺', '調味料', '冷凍食品', '惣菜', 'お菓子', '飲料', '日用品', 'その他'];
const CONDITIONS = ['', '特売', '会員価格', '見切り・値引き', 'まとめ買い', 'その他'];
const TODAY_PROMPT = '今日の夕食の献立が決まりません。一般的な家庭にある調味料で作れて、スーパーで材料を揃えやすい料理をいくつか提案して。最近作った料理と似た味付けはできるだけ避けてね。';
const CHATGPT_URL = 'https://chatgpt.com/';
const DUP_WINDOW_MS = 30 * 60 * 1000;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { const n = parseInt(normalize(String(v ?? '')).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const yen = n => (n == null ? '—' : `${Number(n).toLocaleString('ja-JP')}円`);
const pad = n => String(n).padStart(2, '0');
const fmtDate = t => { const d = new Date(t); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const fmtDateTime = t => { const d = new Date(t); return `${fmtDate(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const storeName = s => (s ? (s.branch ? `${s.brand} ${s.branch}` : s.brand) : '（削除された店舗）');
const productLabel = p => (p ? `${p.name}${p.size ? ` ${p.size}` : ''}` : '（不明な商品）');

const state = { store: null, draft: null, scanner: null };

// ---------- 起動 ----------

async function init() {
  if (!(await db.kvGet('seeded'))) {
    const now = Date.now();
    await db.bulkPut('stores', DEFAULT_BRANDS.map((brand, i) => ({ id: uid(), brand, branch: '', camera: true, createdAt: now + i, lastUsedAt: 0 })));
    await db.kvSet('seeded', true);
  }
  const cur = await db.kvGet('currentStoreId');
  if (cur) state.store = (await db.get('stores', cur)) || null;

  $('#backBtn').addEventListener('click', () => (history.length > 1 ? history.back() : go('#/main')));
  $('#storeBadge').addEventListener('click', () => go('#/stores'));
  window.addEventListener('hashchange', render);
  document.addEventListener('visibilitychange', () => {
    // 画面を離れたらカメラを止める。戻ったら再開する
    if (document.hidden) stopScanner();
    else if (location.hash === '#/scan') render();
  });

  // 起動時は店舗選択画面から
  history.replaceState(null, '', '#/stores');
  render();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
}

const go = hash => { if (location.hash === hash) render(); else location.hash = hash; };

function stopScanner() {
  if (state.scanner) { state.scanner.stop(); state.scanner = null; }
}

const routes = {
  stores: viewStores, 'store-edit': viewStoreEdit, main: viewMain, scan: viewScan, manual: viewManual,
  item: viewItem, history: viewHistory, record: viewRecord, list: viewList, settings: viewSettings,
};
const NO_STORE_OK = new Set(['stores', 'store-edit', 'settings']);

async function render() {
  stopScanner();
  closeModal();
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const key = routes[name] ? name : 'stores';
  if (!state.store && !NO_STORE_OK.has(key)) return go('#/stores');
  $('#backBtn').hidden = key === 'stores';
  $('#storeBadge').textContent = state.store ? storeName(state.store) : '';
  $('#storeBadge').hidden = !state.store || key === 'stores';
  window.scrollTo(0, 0);
  await routes[key](decodeURIComponent(arg || ''));
}

function setView(title, html) {
  $('#title').textContent = title;
  // 画面ごとに要素を作り直して、前の画面のイベントを残さない
  const old = $('#view');
  const view = old.cloneNode(false);
  view.innerHTML = html;
  old.replaceWith(view);
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

function showModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.hidden = false;
  m.onclick = e => { if (e.target === m || e.target.closest('[data-close]')) closeModal(); };
  return m;
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }

async function storesMap() {
  return new Map((await db.all('stores')).map(s => [s.id, s]));
}

// ---------- A. 店舗選択 ----------

async function viewStores() {
  const stores = (await db.all('stores')).sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.createdAt - b.createdAt);
  const last = stores.find(s => s.lastUsedAt);
  const row = s => `
    <div class="store-row">
      <button class="store-pick" data-pick="${s.id}">
        <span class="store-name">${esc(storeName(s))}</span>
        <span class="store-sub">${s.camera ? '📷 カメラ可' : '✍️ 手入力のみ'}${s.branch ? '' : '・支店名未登録'}</span>
      </button>
      <a class="store-edit" href="#/store-edit/${s.id}" aria-label="編集">✎</a>
    </div>`;
  setView('店舗を選ぶ', `
    ${last ? `<h2 class="sec">前回の店舗</h2><div class="last-store">${row(last)}</div>` : ''}
    <h2 class="sec">登録店舗</h2>
    <div class="list">${stores.filter(s => s !== last).map(row).join('') || '<p class="empty">店舗がありません</p>'}</div>
    <a class="btn" href="#/store-edit/new">＋ 店舗を追加</a>
    <a class="btn ghost" href="#/settings">設定・バックアップ</a>
  `);
  $('#view').addEventListener('click', async e => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const s = await db.get('stores', b.dataset.pick);
    s.lastUsedAt = Date.now();
    await db.put('stores', s);
    await db.kvSet('currentStoreId', s.id);
    state.store = s;
    go('#/main');
  });
}

async function viewStoreEdit(id) {
  const isNew = id === 'new';
  const s = isNew ? { id: uid(), brand: '', branch: '', camera: true, createdAt: Date.now(), lastUsedAt: 0 } : await db.get('stores', id);
  if (!s) return go('#/stores');
  setView(isNew ? '店舗を追加' : '店舗を編集', `
    <div class="card form">
      <label>ブランド名<input id="f-brand" list="brands" required></label>
      <datalist id="brands">${DEFAULT_BRANDS.map(b => `<option value="${esc(b)}">`).join('')}</datalist>
      <label>支店名<input id="f-branch" placeholder="例：〇〇店"></label>
      <label class="check"><input type="checkbox" id="f-camera"> この店舗でカメラ読み取りを使う</label>
      <p class="hint">無音・画像保存なしでも、店内でのカメラ使用が許可されているとは限りません。各店舗のルールに従ってください。オフにすると手入力のみになります。</p>
    </div>
    <button class="btn primary" id="save">保存</button>
    ${isNew ? '' : '<button class="btn danger" id="del">この店舗を削除</button>'}
  `);
  $('#f-brand').value = s.brand;
  $('#f-branch').value = s.branch;
  $('#f-camera').checked = !!s.camera;
  $('#save').onclick = async () => {
    s.brand = $('#f-brand').value.trim();
    s.branch = $('#f-branch').value.trim();
    s.camera = $('#f-camera').checked;
    if (!s.brand) return toast('ブランド名を入力してください');
    await db.put('stores', s);
    if (state.store?.id === s.id) state.store = s;
    toast('保存しました');
    history.back();
  };
  $('#del')?.addEventListener('click', async () => {
    const recs = await db.byIndex('prices', 'storeId', s.id);
    if (!confirm(`「${storeName(s)}」を削除しますか？\nこの店舗の価格記録 ${recs.length} 件も削除されます。`)) return;
    for (const r of recs) await db.del('prices', r.id);
    await db.del('stores', s.id);
    if (state.store?.id === s.id) { state.store = null; await db.kvSet('currentStoreId', null); }
    toast('削除しました');
    go('#/stores');
  });
}

// ---------- B. 買い物メイン ----------

async function viewMain() {
  const s = state.store;
  const list = (await db.kvGet('ingredients')) || [];
  setView('買い物中', `
    <div class="current-store">
      <div><span class="hint">いまの店舗</span><div class="store-big">${esc(storeName(s))}</div></div>
      <a class="btn small" href="#/stores">店舗を変更</a>
    </div>
    ${s.camera
      ? '<a class="btn primary hero" href="#/scan">📷 値札を読み取る</a>'
      : '<div class="note">この店舗は「手入力のみ」に設定されています</div>'}
    <a class="btn ${s.camera ? '' : 'hero'}" href="#/manual">✍️ 手入力・商品から選ぶ</a>
    <button class="btn" id="today">🍳 今日なに作ろう？</button>
    <div class="grid2">
      <a class="btn" href="#/list">🧺 材料リスト${list.length ? `（${list.length}）` : ''}</a>
      <a class="btn" href="#/history">📈 価格履歴</a>
    </div>
    <a class="btn ghost" href="#/settings">⚙️ 設定</a>
  `);
  $('#today').onclick = () => openAiSheet(todayPrompt(list.map(i => i.name)), '今日なに作ろう？');
}

// ---------- C. カメラ読み取り ----------

async function viewScan() {
  const s = state.store;
  if (!s.camera) {
    setView('値札読み取り', `
      <div class="card"><p>この店舗はカメラ使用が「オフ」です。</p></div>
      <a class="btn primary" href="#/manual">手入力で記録</a>
      <a class="btn" href="#/store-edit/${s.id}">店舗設定を変更</a>`);
    return;
  }
  setView('値札読み取り', `
    <div class="cam-wrap">
      <video id="video" playsinline muted autoplay></video>
      <div class="guide" id="guide"><span>値札をこの枠に合わせる</span></div>
      <div class="cam-status" id="camStatus">カメラを起動しています…</div>
      <button class="torch" id="torch" hidden>💡</button>
    </div>
    <div class="scan-panel">
      <div class="scan-top">
        <span class="badge" id="stable">読み取り中</span>
        <button class="btn small" id="pause">一時停止</button>
      </div>
      <div class="field-label">価格として採用する数字 <span class="hint">（タップで変更）</span></div>
      <div class="chips" id="priceChips"><span class="hint">値札を枠に入れてください</span></div>
      <div class="seg" id="taxSeg">
        <button data-tt="in">税込</button><button data-tt="ex">税抜（本体）</button>
      </div>
      <p class="hint" id="pairInfo"></p>
      <div class="field-label">商品名 <span class="hint">（タップで変更）</span></div>
      <div class="chips" id="nameChips"></div>
      <div class="kv"><span>内容量</span><b id="sizeVal">—</b><span>JAN</span><b id="janVal">—</b></div>
      <button class="btn primary hero" id="toItem">この内容で確認へ ›</button>
      <a class="btn ghost" href="#/manual">カメラを使わず手入力</a>
      <details class="raw"><summary>読み取った文字（全文）</summary><pre id="rawText"></pre></details>
      <p class="hint">映像は保存・送信しません。文字認識は端末内で行います。</p>
    </div>
  `);

  const sel = { price: null, type: null, pair: null, prices: [], name: '', names: [], size: '', jan: '', text: '' };
  let lastKey = '', sameCount = 0;

  const renderSel = () => {
    $('#priceChips').innerHTML = sel.prices.length
      ? sel.prices.map(p => `<button class="chip ${p.value === sel.price ? 'on' : ''}" data-price="${p.value}">${yen(p.value)}<small>${p.type === 'in' ? '税込' : p.type === 'ex' ? '本体' : ''}</small></button>`).join('')
      : '<span class="hint">価格らしい数字が見つかりません</span>';
    $$('#taxSeg button').forEach(b => b.classList.toggle('on', b.dataset.tt === sel.type));
    $('#pairInfo').textContent = sel.pair
      ? `本体 ${yen(sel.pair.ex)} ／ 税込 ${yen(sel.pair.in)} の組み合わせを検出`
      : sel.price != null && !sel.type ? '税込か税抜か判別できません。どちらか選んでください。' : '';
    const names = sel.names.includes(sel.name) || !sel.name ? sel.names : [sel.name, ...sel.names];
    $('#nameChips').innerHTML = names.length
      ? names.map(n => `<button class="chip ${n === sel.name ? 'on' : ''}" data-name="${esc(n)}">${esc(n)}</button>`).join('')
      : '<span class="hint">商品名は確認画面で入力できます</span>';
    $('#sizeVal').textContent = sel.size || '—';
    $('#janVal').textContent = sel.jan || '—';
    $('#rawText').textContent = sel.text;
  };

  const setPaused = p => {
    scanner.paused = p;
    $('#pause').textContent = p ? '読み取り再開' : '一時停止';
    $('#stable').textContent = p ? '一時停止中' : '読み取り中';
    $('#stable').className = 'badge' + (p ? ' paused' : '');
  };

  const scanner = new Scanner({
    video: $('#video'),
    guide: $('#guide'),
    onStatus: (msg, isError) => {
      const el = $('#camStatus');
      if (!el) return;
      el.textContent = msg;
      el.hidden = !msg;
      el.classList.toggle('error', !!isError);
    },
    onResult: r => {
      if (!r.prices.length && !r.names.length) return;
      Object.assign(sel, { prices: r.prices, price: r.price, type: r.type, pair: r.pair, names: r.names, name: r.name, size: r.size || sel.size, text: r.text });
      if (r.jan) sel.jan = r.jan;
      const key = `${r.name}|${r.price}`;
      sameCount = key === lastKey ? sameCount + 1 : 1;
      lastKey = key;
      const st = $('#stable');
      st.textContent = sameCount >= 2 ? '安定 ✓' : '読み取り中';
      st.className = 'badge' + (sameCount >= 2 ? ' ok' : '');
      renderSel();
    },
  });
  state.scanner = scanner;

  $('#view').addEventListener('click', e => {
    const p = e.target.closest('[data-price]');
    const n = e.target.closest('[data-name]');
    const t = e.target.closest('[data-tt]');
    if (!p && !n && !t) return;
    setPaused(true); // 選んでいる最中に結果が変わらないよう止める
    if (p) {
      sel.price = Number(p.dataset.price);
      const c = sel.prices.find(x => x.value === sel.price);
      if (c?.type) sel.type = c.type;
    }
    if (n) sel.name = n.dataset.name;
    if (t) sel.type = t.dataset.tt;
    renderSel();
  });
  $('#pause').onclick = () => setPaused(!scanner.paused);
  $('#toItem').onclick = async () => {
    stopScanner();
    state.draft = await draftFromScan(sel);
    go('#/item');
  };

  try {
    await scanner.start();
    if (scanner.canTorch()) {
      let on = false;
      $('#torch').hidden = false;
      $('#torch').onclick = () => { on = !on; scanner.setTorch(on)?.catch(() => {}); };
    }
  } catch (e) {
    const msg = e.name === 'NotAllowedError'
      ? 'カメラの使用が許可されていません。ブラウザーの設定で許可してください。'
      : e.name === 'NotFoundError' ? 'カメラが見つかりません。' : e.message;
    const el = $('#camStatus');
    if (el) { el.textContent = msg; el.classList.add('error'); }
  }
}

async function draftFromScan(sel) {
  const d = newDraft({ name: sel.name, size: sel.size, jan: sel.jan });
  if (sel.pair && (sel.price === sel.pair.in || sel.price === sel.pair.ex)) {
    d.priceIn = sel.pair.in;
    d.priceEx = sel.pair.ex;
  } else if (sel.price != null) {
    if (sel.type === 'ex') {
      d.priceEx = sel.price;
      d.taxNote = '税抜（本体）価格のみ読み取りました。税込価格を入力するか、×1.08 / ×1.10 で計算してください。';
    } else {
      d.priceIn = sel.price;
      if (!sel.type) d.taxNote = '税込か税抜か判別できませんでした。値札を見て確認してください。';
    }
  }
  if (d.jan) {
    const hit = (await db.byIndex('products', 'jan', d.jan))[0];
    if (hit) applyProduct(d, hit);
  }
  return d;
}

// ---------- 手入力・商品検索 ----------

async function viewManual() {
  const [products, prices] = await Promise.all([db.all('products'), db.all('prices')]);
  const latestAt = new Map();
  const lastHere = new Map();
  for (const r of prices.sort((a, b) => a.at - b.at)) {
    latestAt.set(r.productId, r.at);
    if (r.storeId === state.store.id) lastHere.set(r.productId, r);
  }
  setView('手入力・商品選択', `
    <button class="btn primary" id="new">＋ 新しい商品を入力</button>
    <input type="search" id="q" class="search" placeholder="登録済みの商品を検索（商品名・JAN）">
    <p class="hint">登録済みの商品を選ぶと、価格だけ入力できます。</p>
    <div class="list" id="results"></div>
  `);
  const draw = () => {
    const q = normalize($('#q').value).toLowerCase().replace(/\s/g, '');
    const hits = products
      .filter(p => !q || normalize(`${p.name}${p.maker}${p.size}`).toLowerCase().replace(/\s/g, '').includes(q) || (p.jan && p.jan.includes(q)))
      .sort((a, b) => (latestAt.get(b.id) || 0) - (latestAt.get(a.id) || 0))
      .slice(0, 50);
    $('#results').innerHTML = hits.map(p => {
      const r = lastHere.get(p.id);
      return `<button class="row-btn" data-id="${p.id}">
        <span><b>${esc(p.name)}</b> <span class="hint">${esc(p.size || '')}${p.maker ? ` ／ ${esc(p.maker)}` : ''}</span></span>
        <span class="right">${r ? `${yen(r.priceIn)}<small>${fmtDate(r.at)}</small>` : '<small>この店舗は未記録</small>'}</span>
      </button>`;
    }).join('') || `<p class="empty">${products.length ? '見つかりません' : 'まだ商品が登録されていません'}</p>`;
  };
  draw();
  $('#q').addEventListener('input', draw);
  $('#new').onclick = () => {
    state.draft = newDraft({ name: $('#q').value.trim() });
    go('#/item');
  };
  $('#results').addEventListener('click', async e => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const d = newDraft();
    applyProduct(d, await db.get('products', b.dataset.id));
    state.draft = d;
    go('#/item');
  });
}

// ---------- D. 商品情報（確認・記録・比較） ----------

function newDraft(init = {}) {
  return { productId: null, name: '', maker: '', size: '', jan: '', category: '', priceIn: null, priceEx: null, condition: '', note: '', savedRecordId: null, taxNote: '', ...init };
}

function applyProduct(d, p) {
  Object.assign(d, {
    productId: p.id, name: p.name, maker: p.maker || '', size: p.size || '',
    jan: p.jan || d.jan || '', category: p.category || '',
  });
}

const normName = s => normalize(s).toLowerCase().replace(/[\s・]/g, '');
function similarity(a, b) {
  const A = normName(a), B = normName(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = s => { const g = []; for (let i = 0; i < s.length - 1; i++) g.push(s.slice(i, i + 2)); return g; };
  const ga = grams(A), gb = grams(B);
  if (!ga.length || !gb.length) return 0;
  const m = new Map();
  ga.forEach(x => m.set(x, (m.get(x) || 0) + 1));
  let hit = 0;
  gb.forEach(x => { const c = m.get(x); if (c) { hit++; m.set(x, c - 1); } });
  return (2 * hit) / (ga.length + gb.length);
}

async function findSimilar(d) {
  if (!d.name && !d.jan) return [];
  return (await db.all('products'))
    .map(p => ({ p, score: d.jan && p.jan === d.jan ? 2 : similarity(d.name, p.name) }))
    .filter(x => x.score >= 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(x => x.p);
}

function unitPriceText(price, size) {
  const s = parseSize(size || '');
  if (!s || price == null) return '';
  if (s.unit === '個') return `1個あたり ${(price / s.amount).toFixed(1)}円`;
  return `100${s.unit}あたり ${((price / s.amount) * 100).toFixed(1)}円`;
}

function diffText(cur, prev) {
  const diff = cur - prev;
  if (diff < 0) return { text: `${yen(-diff)}安い`, cls: 'good' };
  if (diff > 0) return { text: `${yen(diff)}高い`, cls: 'bad' };
  return { text: '前回と同じ', cls: '' };
}

async function viewItem() {
  const d = state.draft;
  if (!d) return go('#/main');
  const stores = await storesMap();
  const records = d.productId ? (await db.byIndex('prices', 'productId', d.productId)).sort((a, b) => b.at - a.at) : [];
  const similar = d.productId ? [] : await findSimilar(d);

  setView('商品情報', `
    ${d.productId
      ? `<div class="note ok">登録済みの商品として記録します <button class="link" id="unlink">別の商品として扱う</button></div>`
      : similar.length ? `
        <div class="card">
          <h3>登録済みの似た商品</h3>
          <p class="hint">同じ商品なら選んでください。<b>容量・規格が違う場合は選ばないでください。</b></p>
          ${similar.map(p => `<button class="row-btn" data-pick="${p.id}"><span><b>${esc(p.name)}</b> <span class="hint">${esc(p.size || '規格未入力')}${p.maker ? ` ／ ${esc(p.maker)}` : ''}</span></span>${d.jan && p.jan === d.jan ? '<span class="badge ok">JAN一致</span>' : ''}</button>`).join('')}
          <p class="hint">選ばなければ新しい商品として記録されます。</p>
        </div>` : ''}

    <div class="card form">
      <label>商品名<input id="f-name" autocomplete="off"></label>
      <label>内容量・規格<input id="f-size" placeholder="例：1000ml、300g、6個" autocomplete="off"></label>
      <details class="more" ${d.maker || d.category || d.jan ? 'open' : ''}>
        <summary>メーカー・カテゴリ・JAN</summary>
        <div class="row2">
          <label>メーカー<input id="f-maker" autocomplete="off"></label>
          <label>カテゴリ<input id="f-cat" list="cats" autocomplete="off"></label>
        </div>
        <datalist id="cats">${CATEGORIES.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
        <label>JANコード<input id="f-jan" inputmode="numeric" autocomplete="off"></label>
      </details>
    </div>

    <div class="card form">
      <h3>今回の価格 <span class="hint">${esc(storeName(state.store))}</span></h3>
      <div class="row2">
        <label>税込価格<input id="f-in" class="price-input" inputmode="numeric" autocomplete="off"></label>
        <label>税抜（本体）<input id="f-ex" inputmode="numeric" autocomplete="off"></label>
      </div>
      <div class="inline"><span class="hint">税抜→税込：</span><button class="btn small" data-rate="1.08">×1.08（食品）</button><button class="btn small" data-rate="1.1">×1.10</button></div>
      ${d.taxNote ? `<p class="warn">${esc(d.taxNote)}</p>` : ''}
      <div class="row2">
        <label>条件<select id="f-cond">${CONDITIONS.map(c => `<option value="${esc(c)}">${c || '通常'}</option>`).join('')}</select></label>
        <label>メモ<input id="f-note" autocomplete="off"></label>
      </div>
      <p class="unit" id="unit"></p>
    </div>

    <div class="card" id="compare"></div>

    <button class="btn primary hero" id="save">価格を記録</button>
    <div class="grid2">
      <button class="btn" id="addList">🧺 材料リストに追加</button>
      <button class="btn" id="askAi">🍳 この材料でのレシピをAIに聞く</button>
    </div>

    <div class="card muted">
      <h3>参考情報</h3>
      <dl class="ext">
        <dt>全国平均</dt><dd>全国平均データなし<small>（公的統計との連携は第3段階で対応予定）</small></dd>
        <dt>値上げ情報</dt><dd>未対応<small>（第3段階で対応予定）</small></dd>
        <dt>レビュー</dt><dd>未対応<small>（第3段階で対応予定）</small></dd>
      </dl>
    </div>

    ${records.length ? `
      <div class="card">
        <h3>この商品の価格履歴</h3>
        ${priceChart(records, stores)}
        <div class="list">${records.map(r => `
          <a class="row-btn" href="#/record/${r.id}">
            <span>${fmtDate(r.at)} <span class="hint">${esc(storeName(stores.get(r.storeId)))}</span>${r.condition ? ` <span class="badge">${esc(r.condition)}</span>` : ''}</span>
            <span class="right">${yen(r.priceIn)}</span>
          </a>`).join('')}</div>
        <button class="btn danger small" id="delProduct">この商品と履歴をすべて削除</button>
      </div>` : ''}
  `);

  const fields = { 'f-name': 'name', 'f-size': 'size', 'f-maker': 'maker', 'f-cat': 'category', 'f-jan': 'jan', 'f-cond': 'condition', 'f-note': 'note' };
  for (const [id, key] of Object.entries(fields)) {
    const el = $('#' + id);
    el.value = d[key] || '';
    el.addEventListener('input', () => { d[key] = el.value.trim(); if (key === 'size') updateLive(); });
  }
  const fin = $('#f-in'), fex = $('#f-ex');
  fin.value = d.priceIn ?? '';
  fex.value = d.priceEx ?? '';
  const onPrice = () => {
    d.priceIn = num(fin.value);
    d.priceEx = num(fex.value);
    if (d.savedRecordId) { d.savedRecordId = null; }
    updateLive();
  };
  fin.addEventListener('input', onPrice);
  fex.addEventListener('input', onPrice);
  $$('[data-rate]').forEach(b => b.onclick = () => {
    const ex = num(fex.value);
    if (ex == null) return toast('先に税抜価格を入力してください');
    fin.value = Math.floor(ex * Number(b.dataset.rate));
    onPrice();
  });

  function updateLive() {
    $('#unit').textContent = unitPriceText(d.priceIn, d.size);
    $('#compare').innerHTML = compareHtml(d, records, stores);
    const save = $('#save');
    save.disabled = !!d.savedRecordId;
    save.textContent = d.savedRecordId ? '記録しました ✓' : '価格を記録';
  }
  updateLive();

  $('#view').addEventListener('click', async e => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      applyProduct(d, await db.get('products', pick.dataset.pick));
      render();
    }
  });
  $('#unlink')?.addEventListener('click', () => { d.productId = null; d.savedRecordId = null; render(); });
  $('#save').onclick = () => saveRecord(d);
  $('#addList').onclick = () => addIngredient(d.name);
  $('#askAi').onclick = () => {
    if (!d.name) return toast('商品名を入力してください');
    openAiSheet(`${d.name}を使ったレシピを提案して。`, 'この材料でレシピを聞く');
  };
  $('#delProduct')?.addEventListener('click', async () => {
    if (!confirm(`「${productLabel(d)}」と価格記録 ${records.length} 件を削除しますか？`)) return;
    for (const r of records) await db.del('prices', r.id);
    await db.del('products', d.productId);
    state.draft = null;
    toast('削除しました');
    go('#/main');
  });
}

function compareHtml(d, records, stores) {
  const cur = d.priceIn;
  const recs = records.filter(r => r.id !== d.savedRecordId);
  const here = recs.filter(r => r.storeId === state.store.id);
  const otherLatest = new Map();
  for (const r of recs) if (r.storeId !== state.store.id && !otherLatest.has(r.storeId)) otherLatest.set(r.storeId, r);

  if (!recs.length) {
    return `<h3>価格の比較</h3><div class="big-msg">初回記録</div><p class="hint">この商品の価格履歴はまだありません。</p>`;
  }
  const rows = [];
  rows.push(['今回の価格', cur != null ? `<b>${yen(cur)}</b>` : '<span class="hint">未入力</span>']);
  let headline = '';
  if (here.length) {
    const prev = here[0];
    const min = Math.min(...here.map(r => r.priceIn));
    rows.push(['この店舗の前回価格', `${yen(prev.priceIn)} <small>${fmtDate(prev.at)}${prev.condition ? `・${esc(prev.condition)}` : ''}</small>`]);
    if (cur != null) {
      const df = diffText(cur, prev.priceIn);
      rows.push(['前回との差', `<span class="${df.cls}">${df.text}</span>`]);
      headline = `<div class="big-msg ${df.cls}">${df.cls ? `前回より${df.text}` : df.text}</div>`;
    }
    rows.push(['この店舗の過去最安値', `${yen(min)}${cur != null && cur < min ? ' <span class="badge ok">最安値更新！</span>' : ''}`]);
  } else {
    headline = '<div class="big-msg">この店舗では初回記録</div>';
  }
  for (const [sid, r] of [...otherLatest].sort((a, b) => a[1].priceIn - b[1].priceIn)) {
    const df = cur != null ? diffText(cur, r.priceIn) : null;
    rows.push([`${esc(storeName(stores.get(sid)))}`, `${yen(r.priceIn)} <small>${fmtDate(r.at)}記録</small>${df ? `<br><small class="${df.cls}">今回は${df.cls ? df.text : '同じ'}</small>` : ''}`]);
  }
  return `<h3>価格の比較 <span class="hint">税込</span></h3>${headline}
    <table class="cmp">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    ${otherLatest.size ? '' : '<p class="hint">他店舗の記録はまだありません。</p>'}`;
}

function priceChart(records, stores) {
  const rs = [...records].filter(r => r.priceIn != null).sort((a, b) => a.at - b.at);
  if (rs.length < 2) return '';
  const W = 320, H = 120, P = 24;
  const t0 = rs[0].at, t1 = rs[rs.length - 1].at || t0 + 1;
  const vals = rs.map(r => r.priceIn);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const x = t => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - P * 2);
  const y = v => H - P - ((v - lo) / Math.max(1, hi - lo)) * (H - P * 2);
  const here = rs.filter(r => r.storeId === state.store.id);
  const line = here.length > 1 ? `<polyline points="${here.map(r => `${x(r.at)},${y(r.priceIn)}`).join(' ')}" class="ln"/>` : '';
  const dots = rs.map(r => `<circle cx="${x(r.at)}" cy="${y(r.priceIn)}" r="4" class="${r.storeId === state.store.id ? 'dot here' : 'dot'}"><title>${esc(storeName(stores.get(r.storeId)))} ${fmtDate(r.at)} ${yen(r.priceIn)}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="価格推移">
    <text x="2" y="${y(hi) + 4}" class="ax">${hi}</text><text x="2" y="${y(lo) + 4}" class="ax">${lo}</text>
    ${line}${dots}</svg>
    <p class="hint legend"><span class="dot-k here"></span>この店舗 <span class="dot-k"></span>他店舗</p>`;
}

async function saveRecord(d) {
  if (!d.name) return toast('商品名を入力してください');
  if (d.priceIn == null || d.priceIn <= 0) {
    return toast(d.priceEx != null ? '税込価格を入力してください（×1.08ボタンで計算できます）' : '税込価格を入力してください');
  }
  if (d.jan && !/^\d{8}$|^\d{13}$/.test(d.jan)) return toast('JANコードは8桁か13桁の数字です');

  let product = d.productId ? await db.get('products', d.productId) : null;
  if (!product) product = { id: uid(), createdAt: Date.now() };
  Object.assign(product, { name: d.name, maker: d.maker, size: d.size, jan: d.jan, category: d.category, updatedAt: Date.now() });

  const recs = d.productId ? await db.byIndex('prices', 'productId', d.productId) : [];
  const dup = recs.find(r => r.storeId === state.store.id && r.priceIn === d.priceIn && Date.now() - r.at < DUP_WINDOW_MS);
  if (dup && !confirm(`同じ店舗・同じ価格の記録が${Math.max(1, Math.round((Date.now() - dup.at) / 60000))}分前にあります。もう一度記録しますか？`)) return;

  await db.put('products', product);
  const rec = {
    id: uid(), productId: product.id, storeId: state.store.id, at: Date.now(),
    priceIn: d.priceIn, priceEx: d.priceEx, condition: d.condition, note: d.note,
  };
  await db.put('prices', rec);

  const here = recs.filter(r => r.storeId === state.store.id).sort((a, b) => b.at - a.at);
  const msg = here.length ? `記録しました：${diffText(d.priceIn, here[0].priceIn).cls ? '前回より' : ''}${diffText(d.priceIn, here[0].priceIn).text}` : '記録しました（この店舗で初回）';
  d.productId = product.id;
  d.savedRecordId = rec.id;
  d.taxNote = '';
  await render();
  toast(msg);
}

// ---------- E. 価格履歴 ----------

async function viewHistory() {
  const [stores, products, prices] = await Promise.all([storesMap(), db.all('products'), db.all('prices')]);
  const pmap = new Map(products.map(p => [p.id, p]));
  const saved = (await db.kvGet('historyFilter')) || {};
  setView('価格履歴', `
    <div class="filters">
      <select id="fs"><option value="">すべての店舗</option>${[...stores.values()].map(s => `<option value="${s.id}">${esc(storeName(s))}</option>`).join('')}</select>
      <input type="search" id="fq" placeholder="商品名で検索">
    </div>
    <p class="hint" id="count"></p>
    <div class="list" id="hist"></div>
  `);
  $('#fs').value = stores.has(saved.store) ? saved.store : '';
  $('#fq').value = saved.q || '';
  const draw = () => {
    const sid = $('#fs').value;
    const q = normName($('#fq').value);
    db.kvSet('historyFilter', { store: sid, q: $('#fq').value });
    const rows = prices
      .filter(r => (!sid || r.storeId === sid) && (!q || normName(productLabel(pmap.get(r.productId)) + (pmap.get(r.productId)?.maker || '')).includes(q)))
      .sort((a, b) => b.at - a.at);
    $('#count').textContent = `${rows.length} 件`;
    $('#hist').innerHTML = rows.slice(0, 300).map(r => `
      <a class="row-btn" href="#/record/${r.id}">
        <span><b>${esc(productLabel(pmap.get(r.productId)))}</b><br><small>${fmtDateTime(r.at)}・${esc(storeName(stores.get(r.storeId)))}${r.condition ? `・${esc(r.condition)}` : ''}</small></span>
        <span class="right">${yen(r.priceIn)}</span>
      </a>`).join('') || '<p class="empty">記録がありません</p>';
  };
  draw();
  $('#fs').addEventListener('change', draw);
  $('#fq').addEventListener('input', draw);
}

async function viewRecord(id) {
  const r = await db.get('prices', id);
  if (!r) return go('#/history');
  const [stores, product] = await Promise.all([storesMap(), db.get('products', r.productId)]);
  const d = new Date(r.at);
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  setView('記録の修正', `
    <div class="card">
      <h3>${esc(productLabel(product))}</h3>
      ${product ? '<button class="btn small" id="openProduct">商品情報・比較を開く</button>' : ''}
    </div>
    <div class="card form">
      <label>日時<input type="datetime-local" id="r-at" value="${local}"></label>
      <label>店舗<select id="r-store">${[...stores.values()].map(s => `<option value="${s.id}">${esc(storeName(s))}</option>`).join('')}</select></label>
      <div class="row2">
        <label>税込価格<input id="r-in" inputmode="numeric" class="price-input"></label>
        <label>税抜（本体）<input id="r-ex" inputmode="numeric"></label>
      </div>
      <div class="row2">
        <label>条件<select id="r-cond">${CONDITIONS.map(c => `<option value="${esc(c)}">${c || '通常'}</option>`).join('')}</select></label>
        <label>メモ<input id="r-note"></label>
      </div>
    </div>
    <button class="btn primary" id="save">保存</button>
    <button class="btn danger" id="del">この記録を削除</button>
  `);
  $('#r-store').value = r.storeId;
  $('#r-in').value = r.priceIn ?? '';
  $('#r-ex').value = r.priceEx ?? '';
  $('#r-cond').value = r.condition || '';
  $('#r-note').value = r.note || '';
  $('#openProduct')?.addEventListener('click', () => {
    const dr = newDraft();
    applyProduct(dr, product);
    state.draft = dr;
    go('#/item');
  });
  $('#save').onclick = async () => {
    const priceIn = num($('#r-in').value);
    if (priceIn == null || priceIn <= 0) return toast('税込価格を入力してください');
    const at = new Date($('#r-at').value).getTime();
    Object.assign(r, {
      at: Number.isFinite(at) ? at : r.at, storeId: $('#r-store').value, priceIn,
      priceEx: num($('#r-ex').value), condition: $('#r-cond').value, note: $('#r-note').value.trim(),
    });
    await db.put('prices', r);
    toast('保存しました');
    history.back();
  };
  $('#del').onclick = async () => {
    if (!confirm('この記録を削除しますか？')) return;
    await db.del('prices', r.id);
    toast('削除しました');
    history.back();
  };
}

// ---------- 材料リスト・ChatGPT相談 ----------

async function addIngredient(name) {
  name = (name || '').trim();
  if (!name) return toast('商品名を入力してください');
  const list = (await db.kvGet('ingredients')) || [];
  if (list.some(i => i.name === name)) return toast('すでに材料リストにあります');
  list.push({ id: uid(), name });
  await db.kvSet('ingredients', list);
  toast(`材料リストに追加しました（${list.length}品）`);
}

async function viewList() {
  const list = (await db.kvGet('ingredients')) || [];
  setView('材料リスト', `
    <div class="inline add-row"><input id="newIng" placeholder="材料を追加（例：豚こま肉）"><button class="btn small primary" id="add">追加</button></div>
    <p class="hint">名前はタップして書き換えられます（例：「〇〇産 白菜 1/2カット」→「白菜」）。</p>
    <div class="list">${list.map(i => `
      <div class="ing-row"><input data-ing="${i.id}" value="${esc(i.name)}"><button class="btn small" data-rm="${i.id}" aria-label="削除">✕</button></div>`).join('') || '<p class="empty">材料はまだありません。商品画面の「材料リストに追加」から追加できます。</p>'}</div>
    ${list.length ? `
      <button class="btn primary hero" id="ask">🍳 この材料でレシピを相談</button>
      <button class="btn" id="today">今日なに作ろう？（材料入り）</button>
      <button class="btn danger small" id="clear">全部消す</button>` : '<button class="btn" id="today">🍳 今日なに作ろう？</button>'}
  `);
  const save = async () => { await db.kvSet('ingredients', list); };
  $('#add').onclick = async () => {
    const v = $('#newIng').value.trim();
    if (!v) return;
    if (!list.some(i => i.name === v)) list.push({ id: uid(), name: v });
    await save();
    render();
  };
  $('#newIng').addEventListener('keydown', e => { if (e.key === 'Enter') $('#add').click(); });
  $$('[data-ing]').forEach(el => el.addEventListener('change', async () => {
    const it = list.find(i => i.id === el.dataset.ing);
    const v = el.value.trim();
    if (it && v) { it.name = v; await save(); }
  }));
  $$('[data-rm]').forEach(b => b.onclick = async () => {
    list.splice(list.findIndex(i => i.id === b.dataset.rm), 1);
    await save();
    render();
  });
  $('#clear')?.addEventListener('click', async () => {
    if (!confirm('材料リストを全部消しますか？')) return;
    list.length = 0;
    await save();
    render();
  });
  $('#ask')?.addEventListener('click', () => openAiSheet(`${list.map(i => i.name).join('、')}を使ったレシピを提案して。`, 'レシピを相談'));
  $('#today').onclick = () => openAiSheet(todayPrompt(list.map(i => i.name)), '今日なに作ろう？');
}

function todayPrompt(names) {
  if (!names.length) return TODAY_PROMPT;
  return `今日の夕食の献立が決まりません。${names.join('、')}を使って、一般的な家庭にある調味料で作れて、スーパーで材料を揃えやすい料理をいくつか提案して。最近作った料理と似た味付けはできるだけ避けてね。`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* 失敗時は手動コピー */ }
    ta.remove();
    return ok;
  }
}

function openAiSheet(text, title) {
  const m = showModal(`
    <h3>${esc(title)}</h3>
    <textarea id="aiText" rows="5">${esc(text)}</textarea>
    <p class="hint" id="copyStatus">コピーしています…</p>
    <a class="btn primary hero" id="openGpt" href="${CHATGPT_URL}" target="_blank" rel="noopener">コピーしてChatGPTを開く</a>
    <div class="grid2">
      <button class="btn" id="copyOnly">文章をコピー</button>
      <button class="btn ghost" data-close>閉じる</button>
    </div>
    <p class="hint">ChatGPTの入力欄を長押しして「ペースト」し、送信してください。</p>
  `);
  const status = ok => { $('#copyStatus', m).textContent = ok ? '✓ コピーしました' : 'コピーできませんでした。上の文章を長押しでコピーしてください。'; };
  // ボタン操作の直後なのでそのままコピーできる
  copyText(text).then(status);
  $('#copyOnly', m).onclick = () => copyText($('#aiText', m).value).then(status);
  $('#openGpt', m).onclick = () => { copyText($('#aiText', m).value).then(status); };
}

// ---------- F. 設定・バックアップ ----------

async function viewSettings() {
  const stores = (await db.all('stores')).sort((a, b) => a.createdAt - b.createdAt);
  const counts = { products: (await db.all('products')).length, prices: (await db.all('prices')).length };
  let persisted = null;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* 非対応 */ }
  setView('設定', `
    <h2 class="sec">店舗管理・カメラ使用設定</h2>
    <div class="list">${stores.map(s => `
      <a class="row-btn" href="#/store-edit/${s.id}"><span>${esc(storeName(s))}</span><span class="right"><small>${s.camera ? '📷 カメラ可' : '✍️ 手入力のみ'}</small> ✎</span></a>`).join('')}</div>
    <a class="btn small" href="#/store-edit/new">＋ 店舗を追加</a>

    <h2 class="sec">文字認識（OCR）</h2>
    <div class="card">
      <p class="hint">初回のカメラ読み取り時に日本語の認識データ（数MB）をダウンロードします。Wi-Fiのある場所で事前に準備しておくと、売り場ですぐ使えます。</p>
      <button class="btn small" id="preload">認識データを準備する</button>
      <p class="hint" id="preloadStatus"></p>
    </div>

    <h2 class="sec">API設定</h2>
    <div class="card muted"><p class="hint">全国平均・値上げ情報・レビュー検索（Sarashina API など）は第3段階で追加予定です。APIキーはこの端末内にのみ保存し、コードには埋め込みません。</p></div>

    <h2 class="sec">バックアップ・復元</h2>
    <div class="card">
      <p class="hint">店舗 ${stores.length}・商品 ${counts.products}・価格記録 ${counts.prices} 件（文字データのみ）。${persisted === true ? 'ストレージは保護されています。' : persisted === false ? 'ブラウザーのデータ消去で消える可能性があるため、定期的にバックアップしてください。' : ''}</p>
      <button class="btn" id="export">JSONで書き出す</button>
      <label class="btn" for="importFile">JSONから読み込む</label>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </div>

    <h2 class="sec">このアプリについて</h2>
    <div class="card muted"><p class="hint">データはすべてこの端末のブラウザー内に保存されます。カメラ映像は保存・送信せず、写真撮影機能（シャッター音）も使いません。アカウント・広告・利用状況の追跡はありません。</p></div>
  `);

  $('#preload').onclick = async () => {
    const st = $('#preloadStatus');
    st.textContent = '準備中…';
    try {
      await preloadOcr(m => { if (typeof m.progress === 'number' && m.status !== 'recognizing text') st.textContent = `${statusJa(m.status)} ${Math.round(m.progress * 100)}%`; });
      st.textContent = '✓ 準備できました';
    } catch (e) { st.textContent = e.message; }
  };
  $('#export').onclick = exportBackup;
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importBackup(file);
  });
}

async function exportBackup() {
  const data = { app: 'super-price-memo', version: 1, exportedAt: new Date().toISOString() };
  for (const s of STORES) data[s] = await db.all(s);
  data.ingredients = (await db.kvGet('ingredients')) || [];
  const d = new Date();
  const fname = `price-memo-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const file = new File([blob], fname, { type: 'application/json' });
  // iPhoneでは共有シートから「ファイルに保存」できる
  if (navigator.canShare?.({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    try { await navigator.share({ files: [file], title: fname }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('書き出しました');
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('JSONを読み込めませんでした'); }
  if (data?.app !== 'super-price-memo' || !STORES.every(s => Array.isArray(data[s]))) return toast('このアプリのバックアップではありません');
  const m = showModal(`
    <h3>バックアップを読み込む</h3>
    <p>店舗 ${data.stores.length}・商品 ${data.products.length}・価格記録 ${data.prices.length} 件<br><small>${esc(data.exportedAt || '')}</small></p>
    <button class="btn primary" id="merge">今のデータに統合する</button>
    <button class="btn danger" id="replace">今のデータを置き換える</button>
    <button class="btn ghost" data-close>やめる</button>
  `);
  const run = async replace => {
    if (replace && !confirm('今のデータをすべて消して、バックアップの内容に置き換えます。よろしいですか？')) return;
    for (const s of STORES) {
      if (replace) await db.clear(s);
      await db.bulkPut(s, data[s].filter(x => x && x.id));
    }
    if (Array.isArray(data.ingredients)) {
      const cur = replace ? [] : (await db.kvGet('ingredients')) || [];
      for (const i of data.ingredients) if (!cur.some(c => c.name === i.name)) cur.push(i);
      await db.kvSet('ingredients', cur);
    }
    if (state.store) state.store = (await db.get('stores', state.store.id)) || null;
    closeModal();
    toast('読み込みました');
    render();
  };
  $('#merge', m).onclick = () => run(false);
  $('#replace', m).onclick = () => run(true);
}

init();
