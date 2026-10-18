/* The local model: Ollama, running on this Mac, over plain HTTP.
 *
 * Redline stays a static page with no backend. When Ollama is running, the
 * browser talks to it at localhost exactly as it would to any web API, and
 * nothing leaves the machine. When it is not, this module says so and the
 * rest of Redline carries on as if it did not exist.
 *
 * (Structured answers — Ollama's `format` with a JSON Schema — arrive with
 * title-block extraction, which is the first thing that needs them.)
 *
 * This file does networking and nothing else: no DOM, no `state`, no
 * imports. Nothing in the page, coordinate or export code imports it, so a
 * fault here cannot reach a saved PDF. aipanel.js is its only caller.
 *
 * Its settings are its own (`redline.ai` in localStorage): which model,
 * how much context, where Ollama is. They describe this installation, not
 * any document, so keeping them breaks no rule about documents closing
 * with the app.
 */
const KEY = 'redline.ai';

// What fits beside a browser on an 8 GB Mac. Gemma 4's smallest model was
// the plan, but Ollama needs 6.9 GB to load it and macOS lets the GPU have
// 4.8 GB of 8: it refuses outright, at any context size. Gemma 3 4B loads
// in about 6 s and answers at about 32 tokens a second there. A Mac with
// 16 GB or more can switch to gemma4:e4b and a 16K context in settings.
export const AI_DEFAULTS = Object.freeze({
  host: 'http://localhost:11434',
  model: 'gemma3:4b',
  numCtx: 8192,
});

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

const stored = load();
export const aiConfig = {
  host: typeof stored.host === 'string' && /^https?:\/\/[^\s]+$/.test(stored.host) ? stored.host.replace(/\/+$/, '') : AI_DEFAULTS.host,
  model: typeof stored.model === 'string' && stored.model.trim() ? stored.model.trim() : AI_DEFAULTS.model,
  numCtx: Number.isInteger(stored.numCtx) && stored.numCtx >= 2048 && stored.numCtx <= 131072 ? stored.numCtx : AI_DEFAULTS.numCtx,
  // Whether the panel has ever been opened here. Until it has, Redline
  // does not knock on localhost at all: the first look is the user's.
  used: stored.used === true,
};

export function saveAiConfig(patch) {
  Object.assign(aiConfig, patch);
  try { localStorage.setItem(KEY, JSON.stringify(aiConfig)); } catch { /* private mode: settings last the session */ }
}

/** Whether this page is served from this Mac. Such a page may reach
 *  Ollama freely; one served from the web may not, until Chrome has asked
 *  "access other apps and services on this device?" and been told Allow. */
export const isLocalOrigin = (origin) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

/** Chrome's standing answer to that question for this page: a
 *  PermissionStatus ('granted', 'prompt' or 'denied'), or null where
 *  nothing has to be asked. On a localhost page Chrome reports 'prompt'
 *  yet asks nothing, which is why the origin is checked first. */
export async function localAccess(origin = location.origin) {
  if (isLocalOrigin(origin) || !navigator.permissions) return null;
  for (const name of ['loopback-network', 'local-network-access']) {
    try { return await navigator.permissions.query({ name }); } catch { /* not this browser's name for it */ }
  }
  return null;
}

/** Is Ollama answering, and does it have the model?
 *  → { up, hasModel, models: [names] } — never throws. `timeout` is long
 *  while Chrome's question is on screen: the request waits for the answer. */
export async function aiStatus({ timeout = 2500 } = {}) {
  try {
    const r = await fetch(`${aiConfig.host}/api/tags`, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return { up: false, reason: `Ollama answered ${r.status}` };
    const { models = [] } = await r.json();
    const names = models.map((m) => m.name);
    return { up: true, hasModel: names.includes(aiConfig.model), models: names };
  } catch (err) {
    // Not running, blocked by its origin list, or refused by the browser:
    // from here those look the same.
    return { up: false, reason: err && err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

function body(messages, { options = {}, ...rest }) {
  return JSON.stringify({
    model: aiConfig.model,
    messages,
    ...rest,
    // Ollama's own default context is 4K tokens, whatever the model can
    // take, and a longer prompt is cut to fit without a word said. Every
    // request names the size it needs.
    options: { num_ctx: aiConfig.numCtx, ...options },
  });
}

/** Stream an answer, one fragment at a time.
 *
 *  /api/chat sends newline-delimited JSON: each line carries a piece of
 *  the reply in `message.content`, and the last has `done: true`. Pass an
 *  AbortSignal to stop it part way. */
export async function* chatStream(messages, { signal, options } = {}) {
  const r = await fetch(`${aiConfig.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body(messages, { stream: true, options }),
    signal,
  });
  if (!r.ok) throw new Error(await failure(r));
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        if (msg.message && msg.message.content) yield msg.message.content;
        if (msg.done) return;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** Load the model now, so the first answer does not wait for it: about
 *  6 s for gemma3:4b on an 8 GB Mac, spent while the question is still
 *  being typed instead of after it is asked. An empty chat is Ollama's way
 *  of saying "load, answer nothing". It goes with the same context size
 *  as a real request — a different num_ctx makes Ollama load the model a
 *  second time — and with Ollama's own keep-alive, so an unused model
 *  still leaves memory after five minutes. Once per model a session;
 *  never throws. */
let warmed = '';
export async function warmUp() {
  if (warmed === aiConfig.model) return;
  warmed = aiConfig.model;
  try {
    const r = await fetch(`${aiConfig.host}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body([], { stream: false }),
    });
    if (!r.ok) warmed = '';
  } catch { warmed = ''; }
}

async function failure(r) {
  let detail = '';
  try { detail = (await r.json()).error || ''; } catch { /* not JSON */ }
  return detail ? `Ollama: ${detail}` : `Ollama answered ${r.status}`;
}
