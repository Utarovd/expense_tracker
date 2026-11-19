const V = 'b54';
const SHELL = ['/', '/app.js', '/app.css', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request; const u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  // сеть в приоритете, при отсутствии сети отдаём кэш (для страниц это всегда оболочка приложения)
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const copy = res.clone(); const key = r.mode === 'navigate' ? '/' : r; caches.open(V).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(r.mode === 'navigate' ? '/' : r).then(x => x || caches.match('/'))));
});
