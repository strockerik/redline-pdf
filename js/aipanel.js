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
import { aiConfig, saveAiConfig, aiStatus, chatStream, localAccess, AI_DEFAULTS } from './ai.js';
import { chooseText } from './aitext.js';
import { state } from './state.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 30000;
const SLOW_START_MS = 1500;          // no first word by now: the model is being loaded

// The conversation, for this session only: it goes when the app closes,
// like the documents do.
const conversation = [];
let last = null;                     // the most recent status
// Chrome's permission for this page to reach apps on this Mac (null: none
// needed), looked up once; and whether its question is on screen now.
let access;
let asking = false;
const ASK_WAIT_MS = 120000;
let pollTimer = 0;
let answering = null;                // the AbortController of an answer in progress

// Without the document the model will still claim to have read it — it
// told the owner "Yes, I can see the Bernalillo PDF" and invented an
// acreage. So each mode says plainly what it has and has not been given.
const SYSTEM_NONE = 'You are the assistant in Redline, a PDF markup tool for reviewing civil engineering '
  + 'drawings. You have NOT been given the open document or any drawing, and cannot see them. If asked '
  + 'about the document, say you can’t see it and suggest choosing “Whole document”. Be brief.';

const SYSTEM_DOC = [
  'You answer questions about a set of PDF drawings, using only the text taken from them, given below.',
  'That text was pulled out of the drawings by position, so labels, notes and tables are broken up and may be out of order.',
  'Rules:',
  '- Use only that text. Never say you can see the drawings or images; you have only their text.',
  '- Quote names and numbers exactly as written, with their units, and name the sheet like (p. 3).',
  '- Answer with what the passages do say, even if it is only part of the answer, and name the sheet.',
  '- Labels are often missing from the text, because some words on drawings are drawn as lines. If a figure seems to be the answer but its label is missing, give it and say its label isn’t readable.',
  '- Only if nothing in the passages bears on the question, say you can’t find it in the text of these sheets.',
  '- Be brief: answer first, in a sentence or two.',
].join('\n');

// What fits: the model's context, less room for the answer and the
// conversation, at about three characters to a token — drawings are dense
// with numbers, which tokenise worse than prose.
const ANSWER_ROOM = 1400;              // tokens
const CHARS_PER_TOKEN = 3;
const HISTORY_TURNS = 4;               // messages of the conversation sent back each time
const EXCERPT_CHARS = 5000;            // the most of the document sent with one question

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
  // Chrome's own question comes first: until it is answered, nothing else
  // can be known, and the usual advice about Ollama would be wrong.
  if (asking) {
    line.replaceChildren(help([
      'Chrome is asking whether Redline may reach other apps on this Mac. Click Allow in the box under the address bar.',
      'That is how it talks to Ollama; nothing leaves this Mac.',
    ]));
    return;
  }
  if (last && last.reason === 'denied') {
    line.replaceChildren(help([
      'Chrome is blocking Redline from reaching apps on this Mac, so it can’t talk to Ollama.',
      'Click the icon at the left of the address bar, allow access to apps and services on this device, then reload.',
    ]));
    return;
  }
  if (last && last.reason === 'unanswered') {
    line.replaceChildren(help([
      'Chrome’s question about reaching apps on this Mac wasn’t answered.',
      'Close this panel and open it again to be asked again, and click Allow.',
    ]));
    return;
  }
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
  if (access === undefined) {
    access = await localAccess();
    // Allowed or blocked from Chrome's own settings: look again at once.
    access?.addEventListener('change', () => check());
  }
  const state = access ? access.state : 'granted';
  if (state === 'denied') {
    if (seq === checkSeq) { last = { up: false, reason: 'denied' }; setDot(); renderStatus(); }
    return last;
  }
  // The first request from a page on the web is what makes Chrome ask.
  // It waits for the answer, so this look does too.
  asking = state === 'prompt';
  if (asking) renderStatus();
  const s = await aiStatus({ timeout: asking ? ASK_WAIT_MS : undefined });
  if (seq !== checkSeq) return last;
  asking = false;
  last = !s.up && access && access.state === 'prompt' ? { up: false, reason: 'unanswered' } : s;
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

/** The messages for one question: the rules, the document's text if it
 *  is to be read, the last few turns, and the question. */
async function prompt(question, scope, signal) {
  const history = conversation.slice(-HISTORY_TURNS);
  if (scope === 'none' || !state.pages.length) {
    return { messages: [{ role: 'system', content: SYSTEM_NONE }, ...history, { role: 'user', content: question }], source: null };
  }
  // Short on purpose: well under what the context could take. The excerpt
  // that holds the answer is what matters, and every character more is
  // time before the first word and room for the model to wander.
  const used = [SYSTEM_DOC, question, ...history.map((m) => m.content)].join('').length;
  const budget = Math.max(1500, Math.min(EXCERPT_CHARS, (aiConfig.numCtx - ANSWER_ROOM) * CHARS_PER_TOKEN - used));
  const chosen = await chooseText(question, { scope, budget });
  if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
  // Best match first, each passage tagged with its sheet.
  const text = chosen.passages.map((p) => `(p. ${p.n}) ${p.text.replace(/\n+/g, ' / ')}`).join('\n');
  return {
    messages: [
      { role: 'system', content: SYSTEM_DOC },
      { role: 'system', content: `Document: ${state.docName}, ${state.pages.length} pages. Passages that may bear on the question:\n\n${text || '(No readable text found for this question.)'}` },
      ...history,
      { role: 'user', content: question },
    ],
    source: chosen,
  };
}

/** Which sheets an answer was drawn from — what to check it against. */
function sourceLine(src) {
  const parts = [];
  parts.push(src.pages.length ? `Passages from p. ${src.pages.join(', ')}` : 'Nothing in the text matched');
  if (src.empty.length) parts.push(`no text on p. ${src.empty.join(', ')}`);
  return parts.join(' · ');
}

async function ask(question) {
  if (answering || !question.trim()) return;
  const scope = $('aiScope').value;
  addMessage('user', question);
  const reply = addMessage('bot waiting', scope === 'none' ? 'Thinking…' : 'Reading the sheets…');
  let slow = 0;

  const controller = new AbortController();
  setAnswering(controller);
  let text = '';
  try {
    const { messages, source } = await prompt(question, scope, controller.signal);
    if (source) {
      const note = document.createElement('div');
      note.className = 'ai-src';
      note.textContent = sourceLine(source);
      reply.after(note);
    }
    if (reply.classList.contains('waiting')) reply.textContent = 'Thinking…';
    // The first answer after Ollama has been idle loads the model into
    // memory, which takes several seconds. Say so rather than look stuck —
    // timed from here, not from the click: reading a heavy sheet for the
    // first time takes a while of its own, and is not the model loading.
    slow = setTimeout(() => {
      if (reply.classList.contains('waiting')) reply.textContent = 'Loading the model into memory — the first answer takes a few seconds…';
    }, SLOW_START_MS);
    conversation.push({ role: 'user', content: question });
    // Lower than the default: an answer about a drawing should be the same
    // answer each time, not a creative one.
    const options = scope === 'none' ? undefined : { temperature: 0.2 };
    for await (const piece of chatStream(messages, { signal: controller.signal, options })) {
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
      if (conversation.at(-1)?.role === 'user') conversation.push({ role: 'assistant', content: text });
    } else {
      // The question goes back too: it was never answered.
      if (conversation.at(-1)?.role === 'user' && conversation.at(-1).content === question) conversation.pop();
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
    addMessage('bot hint', 'Ask about the open document. The model reads its text — not its linework, so a table '
      + 'drawn in a CAD font can’t be read — and says which sheets it used. Check anything that matters.');
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
