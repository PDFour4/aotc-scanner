/* sw.js - offline shell.
 *
 * Caches the application files so the app opens with no network at all: on a
 * plane, in a waiting room, or when GitHub Pages is having a bad morning.
 *
 * It never caches user data, because user data never leaves the page. There is
 * no API to cache; the whole computation is local.
 */
const CACHE = 'aotc-v1';
const SHELL = ['./', './index.html', './app.css', './engine.js', './ui.js',
               './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Network first so a deploy is picked up promptly; cache is the fallback.
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
