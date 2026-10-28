// オフラインでも店舗選択・履歴確認・手入力ができるよう、アプリ本体をキャッシュする
const VERSION = 'v1';
const SHELL = [
  './', 'index.html', 'style.css', 'js/app.js', 'js/db.js', 'js/ocr.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'cdn').map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // OCRエンジン（CDN）は一度取得したらキャッシュを使う
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open('cdn').then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  if (url.origin !== location.origin) return;

  // アプリ本体：キャッシュを即返し、裏で更新（次回起動時に反映）
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const update = fetch(req).then(res => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }).catch(() => hit);
    return hit || update;
  }));
});
