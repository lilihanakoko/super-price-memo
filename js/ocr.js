// カメラのライブ映像から値札の文字を読み取る。
// ・写真撮影APIは使わない（シャッター音なし）
// ・フレームはメモリ上のcanvasにだけ描き、認識後すぐ消去する（保存・送信しない）
// ・OCRは Tesseract.js（WebAssembly）で端末内処理

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('文字認識エンジンを読み込めませんでした。初回はネット接続が必要です。'));
    document.head.appendChild(s);
  });
}

let workerPromise = null;
let progressCb = null;

export function getWorker(onProgress) {
  progressCb = onProgress || null;
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT_URL);
      // 日本語データは初回ダウンロード後、Tesseract.js が IndexedDB にキャッシュする
      const w = await window.Tesseract.createWorker('jpn', 1, {
        logger: m => progressCb && progressCb(m),
      });
      await w.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '0' });
      return w;
    })().catch(e => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

const STATUS_JA = {
  'loading tesseract core': 'エンジン読込',
  'initializing tesseract': '初期化',
  'loading language traineddata': '日本語データ読込',
  'loading language traineddata (from cache)': '日本語データ読込',
  'initializing api': '初期化',
};
export const statusJa = s => STATUS_JA[s] || s;

export class Scanner {
  constructor({ video, guide, onResult, onStatus }) {
    Object.assign(this, { video, guide, onResult, onStatus });
    this.running = false;
    this.stopped = false;
    this.paused = false;
    this.stream = null;
    this.detector = null;
    this.canvas = document.createElement('canvas'); // DOMには追加しない
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('このブラウザーではカメラを使えません。HTTPS（またはlocalhost）で開いているか確認してください。');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    if (this.stopped) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => {});
    this.running = true;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        const want = ['ean_13', 'ean_8'].filter(f => formats.includes(f));
        if (want.length) this.detector = new window.BarcodeDetector({ formats: want });
      } catch { /* 非対応端末では使わない */ }
    }
    this.loop();
  }

  get track() { return this.stream?.getVideoTracks()[0]; }

  canTorch() {
    try { return !!this.track?.getCapabilities?.().torch; } catch { return false; }
  }

  setTorch(on) { return this.track?.applyConstraints({ advanced: [{ torch: on }] }); }

  stop() {
    this.stopped = true;
    this.running = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.release();
  }

  async loop() {
    let worker;
    try {
      this.onStatus('文字認識の準備中…');
      worker = await getWorker(m => {
        if (m.status !== 'recognizing text' && typeof m.progress === 'number' && m.progress < 1) {
          this.onStatus(`文字認識の準備中… ${statusJa(m.status)} ${Math.round(m.progress * 100)}%`);
        }
      });
    } catch (e) {
      this.onStatus(e.message, true);
      return;
    }
    if (this.running) this.onStatus('');
    while (this.running) {
      if (!this.paused && this.video.readyState >= 2) {
        try {
          let jan = null;
          if (this.detector) {
            try { jan = (await this.detector.detect(this.video))[0]?.rawValue || null; } catch { /* 無視 */ }
          }
          const frame = this.grab();
          if (frame) {
            const { data } = await worker.recognize(frame, {}, { text: true, blocks: true });
            this.release();
            if (this.running && !this.paused) {
              const result = parseTag(data);
              if (jan && isValidJan(jan)) result.jan = jan;
              this.onResult(result);
            }
          }
        } catch (e) {
          console.warn(e);
          this.release();
        }
      }
      await sleep(this.paused ? 300 : 200);
    }
  }

  // ガイド枠の範囲だけを切り出し、グレースケール＋コントラスト補正してcanvasに描く
  grab() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const vr = v.getBoundingClientRect();
    const gr = this.guide.getBoundingClientRect();
    const scale = Math.max(vr.width / vw, vr.height / vh); // object-fit: cover
    const offX = (vr.width - vw * scale) / 2;
    const offY = (vr.height - vh * scale) / 2;
    let sx = (gr.left - vr.left - offX) / scale;
    let sy = (gr.top - vr.top - offY) / scale;
    let sw = gr.width / scale;
    let sh = gr.height / scale;
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
    if (sw < 20 || sh < 20) return null;

    const k = Math.min(2, 1400 / sw);
    const cw = Math.round(sw * k), ch = Math.round(sh * k);
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, cw, ch);

    const img = this.ctx.getImageData(0, 0, cw, ch);
    const p = img.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < p.length; i += 4) {
      const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0;
      p[i] = g;
      hist[g]++;
    }
    const total = cw * ch;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > total * 0.02) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > total * 0.02) break; }
    const range = Math.max(1, hi - lo);
    for (let i = 0; i < p.length; i += 4) {
      const g = Math.max(0, Math.min(255, (p[i] - lo) * 255 / range));
      p[i] = p[i + 1] = p[i + 2] = g;
    }
    this.ctx.putImageData(img, 0, 0);
    return this.canvas;
  }

  release() {
    if (!this.canvas.width) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.width = this.canvas.height = 0;
  }
}

export const preloadOcr = onProgress => getWorker(onProgress);

// ---------- 文字列の解析 ----------

const JP_RE = /[぀-ヿ㐀-鿿ｦ-ﾟ]/g;

export function normalize(s) {
  return String(s ?? '')
    .replace(/￥/g, '¥')
    .replace(/　/g, ' ')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, '$1')
    .replace(/(\d) (?=\d)/g, '$1')
    .replace(/(\d)[oO](?=\d)/g, (_, d) => d + '0')
    .trim();
}

const SIZE_RE = /(\d+(?:\.\d+)?)\s*(kg|g|ml|l|ℓ|cc|個|枚|本|袋|パック|玉|尾|切れ|切|入り|入|束|房|株)(?:\s*[×xX]\s*(\d+))?/i;
const UNIT_AFTER = /^\s*(kg|g|ml|l\b|ℓ|cc|個|枚|本|袋|パック|玉|尾|切|入|束|房|株|%|cm|mm|kcal|年|月|日|時|分|号|番|[×xX]\d)/i;

function collectLines(data) {
  if (data.lines?.length) return data.lines;
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) out.push(l);
  return out;
}

function isTaxPair(ex, inc) {
  return [1.08, 1.1].some(r => Math.abs(Math.floor(ex * r) - inc) <= 1);
}

export function isValidJan(code) {
  if (!/^\d{8}$|^\d{13}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function parseTag(data) {
  const lines = collectLines(data).map(l => ({
    text: normalize(l.text),
    h: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0,
    conf: l.confidence ?? 50,
    words: (l.words || []).map(w => ({ t: normalize(w.text), h: w.bbox ? w.bbox.y1 - w.bbox.y0 : 0 })),
  })).filter(l => l.text);
  const full = lines.length ? lines.map(l => l.text).join('\n') : normalize(data.text);

  // 価格候補：文字の大きさ（行・単語の高さ）と「円」「税込」などの表記から点数を付ける
  const map = new Map();
  let labelAbove = null; // 「税込価格」などが数字の上の行に書かれている場合
  for (const l of lines) {
    const lineLabel = /\d/.test(l.text) ? null
      : /税込/.test(l.text) ? 'in' : /本体|税抜|税別/.test(l.text) ? 'ex' : null;
    const re = /(¥\s*)?(\d{1,3}(?:,\d{3})+|\d{2,5})(?:\.(\d{1,2}))?(\s*円)?/g;
    let m;
    while ((m = re.exec(l.text))) {
      const digits = m[2].replace(/,/g, '');
      const value = parseInt(digits, 10);
      const before = l.text.slice(Math.max(0, m.index - 8), m.index);
      const after = l.text.slice(m.index + m[0].length, m.index + m[0].length + 4);
      const yenMark = !!(m[1] || m[4]);
      if (/\d$/.test(before) || /^\d/.test(after)) continue; // JANなど長い数字の一部
      if (!yenMark && UNIT_AFTER.test(after)) continue;
      if (!yenMark && (/[/:.]$/.test(before) || /^[/:\-]/.test(after))) continue;
      if (value < 10 || value > 50000) continue;
      let type = null;
      if (/(税込|込み|込)[^\d]{0,4}$/.test(before)) type = 'in';
      else if (/(本体|税抜|税別|抜)[^\d]{0,4}$/.test(before)) type = 'ex';
      else if (/税込/.test(l.text) && !/本体|税抜|税別/.test(l.text)) type = 'in';
      else if (/本体|税抜|税別/.test(l.text) && !/税込/.test(l.text)) type = 'ex';
      else if (labelAbove) type = labelAbove;
      else if (m[3]) type = 'in'; // 小数付き（213.84円など）は税込表示であることが多い
      const w = l.words.find(w => w.t.replace(/,/g, '').includes(digits));
      const h = (w && w.h) || l.h || 1;
      const score = h * (yenMark ? 1.25 : 1) * (m[3] ? 0.8 : 1);
      const prev = map.get(value);
      if (!prev || prev.score < score) map.set(value, { value, type: type || prev?.type || null, score });
      else if (!prev.type && type) prev.type = type;
    }
    labelAbove = lineLabel;
  }
  const prices = [...map.values()].sort((a, b) => b.score - a.score).slice(0, 6);

  let pair = null;
  outer: for (const a of prices) {
    for (const b of prices) {
      if (a !== b && a.value < b.value && isTaxPair(a.value, b.value)) { pair = { ex: a.value, in: b.value }; break outer; }
    }
  }
  if (pair) {
    prices.find(p => p.value === pair.in).type = 'in';
    prices.find(p => p.value === pair.ex).type = 'ex';
  }

  // 比較は税込で行うので、税込・税抜のペアが見つかれば税込側を採用候補にする
  const main = pair ? prices.find(p => p.value === pair.in) : prices[0] || null;

  const seen = new Set();
  const names = lines.map(l => {
    const t = l.text.replace(/¥?\s*\d[\d,]*(?:\.\d+)?\s*円/g, ' ').replace(/\s+/g, ' ').trim();
    const jp = (t.match(JP_RE) || []).length;
    return { t, jp, score: jp * (0.5 + l.conf / 100) };
  }).filter(x => x.jp >= 2 && !/税込|税抜|本体価格|税別|お一人様|限り/.test(x.t))
    .sort((a, b) => b.score - a.score)
    .filter(x => !seen.has(x.t) && seen.add(x.t))
    .slice(0, 6)
    .map(x => x.t);

  const sm = full.match(SIZE_RE);
  const size = sm ? `${sm[1]}${sm[2]}${sm[3] ? '×' + sm[3] : ''}` : '';

  const jm = full.replace(/\s/g, '').match(/(?:^|\D)(4[59]\d{11})(?:\D|$)/);
  const jan = jm && isValidJan(jm[1]) ? jm[1] : '';

  return {
    text: full,
    prices,
    price: main?.value ?? null,
    type: main?.type ?? null,
    pair,
    names,
    name: names[0] || '',
    size,
    jan,
  };
}

// 内容量文字列 → { amount, unit: 'g' | 'ml' | '個' }
export function parseSize(s) {
  const m = normalize(s).match(SIZE_RE);
  if (!m) return null;
  let amount = parseFloat(m[1]);
  let unit = m[2].toLowerCase();
  if (unit === 'kg') { amount *= 1000; unit = 'g'; }
  else if (unit === 'l' || unit === 'ℓ') { amount *= 1000; unit = 'ml'; }
  else if (unit === 'cc') unit = 'ml';
  else if (unit !== 'g' && unit !== 'ml') unit = '個';
  if (m[3]) amount *= parseInt(m[3], 10);
  return amount > 0 ? { amount, unit } : null;
}
