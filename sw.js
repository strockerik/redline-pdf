/* Redline service worker — offline app shell.
 *
 * Bump CACHE on every deploy. A stale worker quietly serving last week's
 * code is the classic PWA failure; the version bump plus the
 * delete-everything-else pass in `activate` is what prevents it.
 */
const CACHE = 'redline-v11';

const PRECACHE = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './js/main.js',
  './js/state.js',
  './js/files.js',
  './js/persist.js',
  './js/pages.js',
  './js/view.js',
  './js/annots.js',
  './js/tabs.js',
  './js/export.js',
  './js/rotmath.test.js',
  './vendor/pdf-lib.min.js',
  './vendor/pdf.min.js',
  './vendor/pdf.worker.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is atomic — one 404 fails the whole install, which is what
      // we want: a half-populated cache is worse than no cache.
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigations always resolve to the app shell so a deep link or a
  // file-handler launch works offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((hit) => hit || fetch(req))
    );
    return;
  }

  // Everything else: cache first, fall back to network, and populate the
  // cache on the way through so anything missed by PRECACHE still lands.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
