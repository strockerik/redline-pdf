/* The service worker's install step (sw.js), under a stand-in for the
 * worker's globals.
 *
 * What it has to guarantee is small and has already been got wrong once:
 * the cache named for a build must contain that build. Rev 0.24 shipped a
 * worker that filled its new cache through the HTTP cache and the CDN,
 * and an app that was open when the deploy landed ended up with a cache
 * called v0.24 full of 0.23 — permanently.
 */
import { ROOT } from './paths.mjs';

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};

// ---- a worker's world, just enough of it ----
const listeners = {};
const stores = new Map();              // cache name -> Map(url -> body)
let requests = [];                     // every fetch the worker made
let serve = () => null;                // (plainUrl) -> { ok, status, body }
let skipped = 0;

globalThis.self = globalThis;
globalThis.addEventListener = (type, fn) => { listeners[type] = fn; };
globalThis.skipWaiting = async () => { skipped++; };
globalThis.clients = { claim: async () => {} };
globalThis.caches = {
  open: async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return { put: async (url, res) => { m.set(url, await res.text()); } };
  },
  delete: async (name) => stores.delete(name),
  keys: async () => [...stores.keys()],
};
globalThis.fetch = async (url, opts = {}) => {
  requests.push({ url, cache: opts.cache });
  const r = serve(String(url).replace(/[?&]v=[^&]*$/, ''));
  if (!r) return { ok: false, status: 404, text: async () => '', clone() { return this; } };
  const res = { ok: r.ok !== false, status: r.status || 200, text: async () => r.body, clone() { return res; } };
  return res;
};

load(ROOT + '/sw.js');

const src = readFile(ROOT + '/sw.js');
const VERSION = src.match(/const CACHE = 'redline-v([\d.]+)'/)[1];
const NAME = `redline-v${VERSION}`;
const LIST = src.slice(src.indexOf('const PRECACHE'), src.indexOf('];')).match(/'\.[^']*'/g).map((s) => s.slice(1, -1));

async function install() {
  requests = [];
  skipped = 0;
  let work = null;
  listeners.install({ waitUntil: (p) => { work = p; } });
  try { await work; return null; } catch (err) { return err; }
}
const pageFor = (v) => `<span id="buildStamp">rev ${v} · 2026-10-11 · something</span>`;
const good = (url) => ({ body: /^\.\/(index\.html)?$/.test(url) ? pageFor(VERSION) : `// ${url}` });

// --- 1. A clean install ---
serve = good;
let err = await install();
check('an install with the right build on the server succeeds', err === null && skipped === 1, String(err));
check('every app-shell file is asked for', requests.length === LIST.length, `${requests.length} of ${LIST.length}`);
check('each with this build in its address, so no CDN has an old copy of it',
  requests.every((r) => new RegExp(`[?&]v=${VERSION.replace('.', '\\.')}$`).test(r.url)), requests.find((r) => !/[?&]v=/.test(r.url))?.url);
check('and round the browser\'s own HTTP cache', requests.every((r) => r.cache === 'no-store'), String(requests[0].cache));
const stored = stores.get(NAME) || new Map();
check('they are stored under the address the page asks for, not the one fetched',
  LIST.every((u) => stored.has(u)) && [...stored.keys()].every((k) => !k.includes('?')), [...stored.keys()].slice(0, 3).join());
check('the stored page is this build', stored.get('./index.html').includes(`rev ${VERSION} ·`) && stored.get('./').includes(`rev ${VERSION} ·`));

// --- 2. The server is still handing out the previous build ---
stores.clear();
serve = (url) => ({ body: /^\.\/(index\.html)?$/.test(url) ? pageFor('0.01') : `// ${url}` });
err = await install();
check('a page from another build fails the install', err !== null && /different build/.test(String(err.message)), String(err));
check('so that build is never stored under this one\'s name', !stores.has(NAME), [...stores.keys()].join());
check('and the old worker is left in charge', skipped === 0);

// Only the bare address stale: the two are fetched separately.
stores.clear();
serve = (url) => ({ body: url === './' ? pageFor('0.01') : (url === './index.html' ? pageFor(VERSION) : 'x') });
err = await install();
check('either address of the page being stale is enough to refuse', err !== null && !stores.has(NAME));

// --- 3. One missing file stores nothing ---
stores.clear();
serve = (url) => (url === './js/view.js' ? null : good(url));
err = await install();
check('a missing file fails the install', err !== null && /view\.js/.test(String(err.message)), String(err));
check('and leaves no half-filled cache', !stores.has(NAME));

// --- 4. A newer build's name is not a prefix-match accident ---
stores.clear();
serve = (url) => ({ body: /^\.\/(index\.html)?$/.test(url) ? pageFor(VERSION + '1') : 'x' });
err = await install();
check('"rev 0.251" is not "rev 0.25"', err !== null, 'accepted a different build whose number starts the same');

print(failures ? `\n${failures} FAILURE(S)` : '\nAll service-worker checks passed');
if (failures) throw new Error('service-worker checks failed');
