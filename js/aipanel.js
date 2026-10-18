/* The local AI panel: whether Ollama is there, a conversation with the
 * model, and its settings.
 *
 * Everything the model says stays in this panel. Nothing here writes to
 * the document; the features that will (polishing a note, say) go through
 * Redline's own edit path and wait for the user to accept.
 *
 * Redline does not look for Ollama until this panel has been opened once
 * on this machine. After that it checks when the app starts, every 30
 * seconds while the window is in front, and whenever something fails.
 */
import { aiConfig, saveAiConfig, aiStatus, chatStream, AI_DEFAULTS } from './ai.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 30000;
const SLOW_START_MS = 1500;          // no first word by now: the model is being loaded

// The conversation, for this session only: it goes when the app closes,
// like the documents do.
const conversation = [];
let last = null;                     // the most recent status
let pollTimer = 0;
let answering = null;                // the AbortController of an answer in progress

const SYSTEM = 'You are the assistant built into Redline, a PDF markup tool used to review civil '
  + 'engineering drawings. Answer briefly and plainly. If you are not sure, say so.';

// ============================================================
// Status
// ============================================================
function setDot() {
  const state = answering ? 'busy'
    : !last ? 'unknown'
    : !last.up ? 'off'
    : last.hasModel ? 'ready' : 'nomodel';
  $('aiDot').dataset.state = state;
  const words = { busy: 'answering', unknown: 'not checked yet', off: 'Ollama is not answering',
    ready: `ready (${aiConfig.model})`, nomodel: `the model ${aiConfig.model} is not downloaded` };
  $('btnAi').title = `Local AI — ${words[state]}. Runs on this Mac through Ollama; nothing is uploaded.`;
}

/** A short block of help with a command to copy. */
function help(lines, command) {
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const p = document.createElement('div');
    p.textContent = line;
    frag.appendChild(p);
  }
  if (command) {
    const code = document.createElement('code');
    code.textContent = command;
    frag.appendChild(code);
  }
  return frag;
}

function renderStatus() {
  const line = $('aiStatusLine');
  $('aiModelName').textContent = aiConfig.model;
  $('aiModelName').title = `${aiConfig.model} · ${aiConfig.numCtx.toLocaleString()} tokens of context`;
  const list = $('aiModelList');
  list.replaceChildren(...(last?.models || []).map((m) => new Option(m)));

  const ready = !!(last && last.up && last.hasModel);
  $('btnAiAsk').disabled = !ready || !!answering;
  if (!last) { line.textContent = 'Checking for Ollama…'; return; }
  if (ready) { line.replaceChildren(); return; }

  if (last.up) {
    const others = (last.models || []).filter((m) => m !== aiConfig.model);
    line.replaceChildren(help(
      [`Ollama is running, but ${aiConfig.model} isn’t downloaded. In Terminal:`],
      `ollama pull ${aiConfig.model}`,
    ));
    if (others.length) line.appendChild(help([`Or choose one you have in settings: ${others.join(', ')}.`]));
    return;
  }
  // Not running, or not letting this page in: from the browser the two
  // look exactly the same, so say both.
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(location.origin);
  const lines = [`Ollama isn’t answering at ${aiConfig.host}. If it isn’t running, open it from Applications.`];
  if (local) {
    line.replaceChildren(help(lines));
  } else {
    // Quitting Ollama from the menu bar leaves its server running with the
    // old setting; the second line is what actually restarts it.
    lines.push('If it is running, it isn’t letting this page in yet. In Terminal:');
    line.replaceChildren(help(lines,
      `launchctl setenv OLLAMA_ORIGINS "${location.origin}"\nlaunchctl kickstart -k gui/$(id -u)/com.ollama.ollama`));
  }
}

// Checks can overlap — change the model, then the host, and two are in
// flight — and they need not finish in order. Only the newest may speak:
// an older "ready" landing last would otherwise hide a newer "unreachable".
let checkSeq = 0;

async function check() {
  const seq = ++checkSeq;
  const s = await aiStatus();
  if (seq !== checkSeq) return last;
  last = s;
  setDot();
  renderStatus();
  return last;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible' && !answering) check(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !answering) check();
  });
}

// ============================================================
// The conversation
// ============================================================
function addMessage(kind, text) {
  const el = document.createElement('div');
  el.className = `ai-msg ${kind}`;
  el.textContent = text;
  $('aiLog').appendChild(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

function setAnswering(controller) {
  answering = controller;
  $('btnAiStop').hidden = !controller;
  $('btnAiAsk').hidden = !!controller;
  setDot();
  renderStatus();
}

async function ask(question) {
  if (answering || !question.trim()) return;
  conversation.push({ role: 'user', content: question });
  addMessage('user', question);
  const reply = addMessage('bot waiting', 'Thinking…');
  // The first answer after Ollama has been idle loads the model into
  // memory, which takes several seconds. Say so rather than look stuck.
  const slow = setTimeout(() => {
    if (reply.classList.contains('waiting')) reply.textContent = 'Loading the model into memory — the first answer takes a few seconds…';
  }, SLOW_START_MS);

  const controller = new AbortController();
  setAnswering(controller);
  let text = '';
  try {
    for await (const piece of chatStream([{ role: 'system', content: SYSTEM }, ...conversation], { signal: controller.signal })) {
      if (!text) reply.classList.remove('waiting');
      text += piece;
      reply.textContent = text;
      reply.scrollIntoView({ block: 'end' });
    }
    conversation.push({ role: 'assistant', content: text });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      reply.classList.remove('waiting');
      reply.classList.add('stopped');
      reply.textContent = text;
      conversation.push({ role: 'assistant', content: text });
    } else {
      // The question goes back too: it was never answered.
      conversation.pop();
      reply.className = 'ai-msg err';
      reply.textContent = `Couldn’t get an answer: ${err && err.message || err}`;
      check();
    }
  } finally {
    clearTimeout(slow);
    setAnswering(null);
  }
}

// ============================================================
// Settings
// ============================================================
function installSettings() {
  const panel = $('aiSettings');
  const model = $('aiModelInput'), ctx = $('aiCtxInput'), host = $('aiHostInput');
  const fill = () => {
    model.value = aiConfig.model;
    ctx.value = String(aiConfig.numCtx);
    host.value = aiConfig.host;
  };
  $('btnAiSettings').addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    $('btnAiSettings').setAttribute('aria-expanded', String(open));
    if (open) fill();
  });
  model.addEventListener('change', () => {
    saveAiConfig({ model: model.value.trim() || AI_DEFAULTS.model });
    check();
  });
  ctx.addEventListener('change', () => { saveAiConfig({ numCtx: parseInt(ctx.value, 10) || AI_DEFAULTS.numCtx }); renderStatus(); });
  host.addEventListener('change', () => {
    const v = host.value.trim().replace(/\/+$/, '');
    saveAiConfig({ host: /^https?:\/\/\S+$/.test(v) ? v : AI_DEFAULTS.host });
    fill();
    check();
  });
}

// ============================================================
// Install
// ============================================================
/** The panel has just been opened. The first time ever, that is the
 *  moment Redline first looks for Ollama. */
export function aiPanelOpened() {
  if (!aiConfig.used) saveAiConfig({ used: true });
  startPolling();
  check();
  if (!$('aiLog').children.length) {
    addMessage('bot hint', 'Ask the local model anything. It can’t see the open document yet — that comes next.');
  }
  setTimeout(() => $('aiInput').focus(), 0);
}

export function installAiPanel() {
  setDot();
  renderStatus();
  installSettings();
  const input = $('aiInput');
  $('aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value;
    if (!q.trim() || answering || $('btnAiAsk').disabled) return;
    input.value = '';
    ask(q);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $('aiForm').requestSubmit();
    }
  });
  $('btnAiStop').addEventListener('click', () => answering?.abort());
  // Used here before: look now, so the dot in the header is honest from
  // the start.
  if (aiConfig.used) { startPolling(); check(); }
}
