/* Redline service worker — offline app shell.
 *
 * Bump CACHE on every deploy. A stale worker quietly serving last week's
 * code is the classic PWA failure; the version bump plus the
 * delete-everything-else pass in `activate` is what prevents it.
 *
 * The other half is that a cache must *contain* the build it is named
 * for. See precache() below: that is not automatic, and getting it wrong
 * strands an installed app on the previous build for good.
 */
const CACHE = 'redline-v0.31';
const VERSION = CACHE.replace('redline-v', '');

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
  './js/history.js',
  './js/chrome.js',
  './js/ai.js',
  './js/aipanel.js',
  './js/aitext.js',
  './js/export.js',
  './js/plot.js',
  './js/plotcompile.js',
  './js/plotgl.js',
  './js/plotworker.js',
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

/** One app-shell file, as it is on the server *now*.
 *
 *  A plain fetch is answered from wherever a copy is nearest: the
 *  browser's own HTTP cache, or the host's CDN, both of which keep a file
 *  for ten minutes after it was last asked for. A worker that installs
 *  inside that window — the app was open when the deploy landed — fills
 *  its new cache with the *previous* build's files. Rev 0.24 did exactly
 *  that in Chrome: a cache named v0.24 holding 0.23, served cache-first,
 *  and never corrected, because the worker script itself was already up
 *  to date and so nothing ever prompted another install.
 *
 *  `no-store` goes round the browser's cache. The version in the query
 *  goes round the CDN's: it has never seen this URL, so it has no old
 *  copy to offer. */
async function fetchFresh(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}v=${VERSION}`, { cache: 'no-store' });
  if (!res || !res.ok) throw new Error(`precache ${url}: ${res ? res.status : 'no response'}`);
  return res;
}

/** Fill this build's cache, or leave nothing behind.
 *
 *  Everything is fetched before anything is stored, so one failure stores
 *  nothing — a half-populated cache is worse than no cache. And the page
 *  that comes back has to carry this build's own stamp: if it does not,
 *  the server is still handing out the last build, and installing would
 *  put it in a cache with this build's name on it. Failing instead leaves
 *  the previous worker in charge, and the browser tries again on the next
 *  launch. */
async function precache() {
  const fetched = await Promise.all(PRECACHE.map(async (url) => [url, await fetchFresh(url)]));
  for (const [url, res] of fetched) {
    if (url !== './' && url !== './index.html') continue;
    const page = await res.clone().text();
    if (!page.includes(`rev ${VERSION} ·`)) {
      throw new Error(`precache ${url}: the server sent a different build than ${VERSION}`);
    }
  }
  const cache = await caches.open(CACHE);
  // Stored under the plain URL — the one the page actually asks for.
  await Promise.all(fetched.map(([url, res]) => cache.put(url, res)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precache()
      .then(() => self.skipWaiting())
      .catch(async (err) => {
        await caches.delete(CACHE);
        throw err;
      })
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
