/* The command surface: everything around the sheet that is not the sheet.
 *
 *   - the file menu behind Save's chevron
 *   - the properties row, which shows only what can be styled right now
 *   - where you are: the page field, and the list of every markup
 *   - what state the work is in: undo and redo, the save chip, and the
 *     alert that stays up when a save did not happen
 *
 * None of it holds state of its own. refreshChrome() redraws all of it
 * from `state` and the history, and is called whenever either may have
 * changed — so there is no second copy of the truth to fall out of step.
 */
import {
  state, COLORS, COLOR_NAMES, PEN_SIZES, TOOL_TYPE, TOOL_LABEL, TYPE_LABEL,
  isPointShape, sizeForType, setStatus, onDirtyChange, finishTyping, MOD_KEY,
} from './state.js';
import {
  onToolbarUpdate, renderThumbnails, renderMainCanvas, updateTitle,
} from './view.js';
import { selectPage, stepPage } from './pages.js';
import {
  applyAnnoStyle, deleteAnnotation, duplicateSelected, selectMarkup, setActiveTool,
} from './annots.js';
import { undo, redo, historyStatus } from './history.js';
import { saveAs, downloadCopy, dismissSaveAlert, canUseFileSystemAccess } from './files.js';
import { renderTabs, switchToDoc } from './tabs.js';
import { finderHintSeen, setFinderHintSeen } from './persist.js';
import { installAiPanel, aiPanelOpened } from './aipanel.js';

const $ = (id) => document.getElementById(id);
const show = (el, on) => { el.hidden = !on; };

const isNarrow = () => !!window.matchMedia?.('(max-width: 820px)').matches;

// iOS never shows the "leave without saving?" prompt, so there the save
// chip is the only warning there will ever be. It says so.
const NO_CLOSE_PROMPT = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent || '')
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

const currentPage = () => state.pages.find((p) => p.id === state.selectedPageId);
const selectedMarkup = () => currentPage()?.annotations.find((a) => a.id === state.selectedAnnoId) || null;

// ============================================================
// Undo / redo
// ============================================================
function stepHistory(fn, verb) {
  // A note being typed into is committed first, so that the typing is
  // what gets undone rather than something before it.
  finishTyping();

  const label = fn();
  if (label === null) { setStatus(`Nothing to ${verb}.`); return; }
  // Half-placed callouts and the hint that goes with them belong to the
  // document as it was a moment ago.
  setActiveTool(state.activeTool);
  renderTabs();
  updateTitle();
  renderThumbnails();
  renderMainCanvas();
  setStatus(`${verb === 'undo' ? 'Undid' : 'Redid'}: ${label.toLowerCase()}`, 'ok');
}

export const doUndo = () => stepHistory(undo, 'undo');
export const doRedo = () => stepHistory(redo, 'redo');

function refreshHistory(h) {
  const u = $('btnUndo'), r = $('btnRedo');
  u.disabled = !h.canUndo;
  r.disabled = !h.canRedo;
  // Read by the hover box, so it always says what the next press will do.
  u.dataset.tip = h.canUndo ? h.undoLabel : 'Nothing to undo';
  r.dataset.tip = h.canRedo ? h.redoLabel : 'Nothing to redo';
  if (tipShownFor === u || tipShownFor === r) fillTip(tipShownFor);
}

// ============================================================
// Save state, in words
// ============================================================
/** The documents other than this one whose work is only in memory. */
const otherUnsaved = () =>
  state.docs.filter((d) => d.id !== state.activeDocId && d.dirty && d.pages.length);

function refreshSaveChip(h) {
  const chip = $('saveChip');
  const others = otherUnsaved();
  if (!state.pages.length) { show(chip, false); return; }
  show(chip, true);

  const at = h.savedAt
    ? new Date(h.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  // Four states, in this order, because each one makes the next beside
  // the point: a write that failed, a document no write can ever reach, a
  // document whose work is only in memory, and one that is on disk.
  let text, title;
  if (state.saveFailed) {
    text = 'NOT SAVED — the last attempt failed';
    title = 'Nothing was written. The markups are still here, and still only here.';
  } else if (state.locked) {
    text = 'Locked by its author — can’t be saved';
    title = 'This file is encrypted. Redline can show it and mark it up, but every way of '
      + 'writing it would blank the pages, so none of them will.';
  } else if (state.dirty) {
    const n = h.changes;
    text = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'Unsaved changes';
    if (NO_CLOSE_PROMPT) text += ' · leaving loses them';
    else if (at) text += ` · last saved ${at}`;
    // Only of a document that did not come from a file. One that did has
    // a saved version, even if this session has not written to it.
    else if (state.combined || !state.sources.length) text += ' · never saved';
    title = 'Documents close with the app. Save before you quit.';
  } else {
    // "No unsaved changes" is said of the window, not of this tab, so it
    // cannot be said while another tab is holding work: with nothing kept
    // between launches, that is the one sentence this app must never get
    // wrong. Scoped to the tab instead, and the half below says the rest.
    text = at ? `Saved ${at}` : (others.length ? 'Nothing unsaved in this tab' : 'No unsaved changes');
    title = others.length
      ? 'This document is on disk. Another tab is not.'
      : 'Everything in this document is on disk.';
  }
  $('saveChipText').textContent = text;

  // The second half counts the tabs you cannot see. It is the only place
  // the app says that work is waiting somewhere else, so it is also the
  // way there: a press goes to the first of them. With one document open
  // there is nothing to say and the header is as it always was.
  const more = $('saveChipOthers');
  show(more, others.length > 0);
  if (others.length) {
    more.textContent = `· ${others.length} other tab${others.length === 1 ? '' : 's'} unsaved`;
    more.title = `Go to ${others[0].docName} — ${others.length === 1 ? 'it has' : 'these tabs have'} `
      + 'unsaved changes too.';
  }

  chip.classList.toggle('failed', !!state.saveFailed);
  chip.classList.toggle('locked', !state.saveFailed && !!state.locked);
  // One warning for the window, not one per document: anything unsaved
  // anywhere makes the whole chip the loud one.
  chip.classList.toggle('unsaved', state.dirty || others.length > 0);
  chip.title = title;

  // Save is the recommended action everywhere except where it cannot
  // work. A locked document has nothing for it to do.
  $('btnSave').classList.toggle('primary', !state.locked);
  $('btnFileMenu').classList.toggle('primary', !state.locked);
}

// ============================================================
// Properties row
// ============================================================
function buildSwatches() {
  const grp = $('colorGrp');
  for (const c of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.dataset.color = c;
    sw.style.background = c;
    // A name, not a hex value: that is what gets read out.
    sw.title = COLOR_NAMES[c] || c;
    sw.setAttribute('aria-label', COLOR_NAMES[c] || c);
    sw.addEventListener('click', () => applyAnnoStyle({ color: c }));
    grp.appendChild(sw);
  }
}

function buildPenSizes() {
  const grp = $('penSizeGrp');
  for (const p of PEN_SIZES) {
    const b = document.createElement('button');
    b.className = 'pen-dot';
    // Scaled up a little so the three presets are tellable apart at
    // toolbar size; the number in the tooltip is the real width.
    const dot = document.createElement('i');
    const px = Math.max(3, Math.round(p.width * 2.2));
    dot.style.width = px + 'px';
    dot.style.height = px + 'px';
    b.appendChild(dot);
    b.addEventListener('click', () => applyAnnoStyle({ penSize: p.width }));
    grp.appendChild(b);
  }
}

// What the armed tool does with the next press. Said here, beside its
// properties, rather than in a second hint somewhere else on screen.
const ARMED = {
  text: 'click to drop a note, or drag to set its width',
  callout: 'click what you’re pointing at, then where the note goes',
  pen: 'draw one stroke',
  highlight: 'draw one stroke',
  arrow: 'drag from tail to tip',
  rect: 'drag from corner to corner',
  cloud: 'drag from corner to corner',
};

function refreshProps() {
  const sel = selectedMarkup();
  const tool = state.activeTool;
  // What the row is about: the selected markup if there is one, otherwise
  // the markup the armed tool is about to make.
  const type = sel ? sel.type : (TOOL_TYPE[tool] || null);
  const isNote = type === 'text' || type === 'callout';
  const isShape = !!type && !isNote;

  $('propsLabel').textContent = sel ? TYPE_LABEL[type] : TOOL_LABEL[tool];
  show($('propsNone'), !type);
  show($('fontSizeGrp'), isNote);
  show($('penSizeGrp'), isShape);
  show($('colorGrp'), !!type);
  show($('fillGrp'), isNote);
  show($('fitGrp'), isNote);
  show($('btnDuplicate'), !!sel);
  show($('btnDeleteAnno'), !!sel);
  $('btnDeleteAnno').disabled = !sel;
  show($('armedNote'), !sel && tool !== 'select');
  $('armedText').textContent = ARMED[tool] || '';

  // The controls show the selected markup's own values, or else what the
  // next one will get.
  const fontSize = sel && isNote ? sel.fontSize : state.currentFontSize;
  const select = $('fontSizeSelect');
  if (![...select.options].some((o) => Number(o.value) === fontSize)) {
    // A note saved elsewhere at a size the list does not offer.
    select.add(new Option(String(fontSize), String(fontSize)));
  }
  select.value = String(fontSize);

  const colour = sel ? sel.color
    : (type === 'highlight' ? state.currentHighlightColor : state.currentColor);
  $('colorGrp').querySelectorAll('.swatch').forEach((n) => {
    const on = n.dataset.color === colour;
    n.classList.toggle('selected', on);
    n.setAttribute('aria-pressed', String(on));
  });

  const sizeType = isShape ? type : 'ink';
  $('penSizeGrp').querySelectorAll('.pen-dot').forEach((n, i) => {
    const p = PEN_SIZES[i];
    const width = sizeForType(sizeType, p.width);
    const on = sel && isPointShape(sel) ? sel.size === width : p.width === state.currentPenSize;
    n.classList.toggle('toggled', on);
    n.setAttribute('aria-pressed', String(on));
    n.title = `${p.label} (${width}pt)`;
    n.setAttribute('aria-label', `${p.label}, ${width} point`);
  });

  $('fillToggle').checked = sel && isNote ? sel.fill !== false : state.currentFill;
  $('fitToggle').checked = sel && isNote ? sel.fit === true : state.currentFit;
}

// ============================================================
// Where you are: the page field
// ============================================================
function refreshPageNav() {
  const count = state.pages.length;
  const idx = state.pages.findIndex((p) => p.id === state.selectedPageId);
  const input = $('pageInput');
  // Not while it is being typed into.
  if (document.activeElement !== input) input.value = idx >= 0 ? String(idx + 1) : '';
  input.disabled = !count;
  $('pageTotal').textContent = `/ ${count}`;
  $('btnPrevPage').disabled = idx <= 0;
  $('btnNextPage').disabled = idx < 0 || idx >= count - 1;
}

function installPageNav() {
  const input = $('pageInput');
  const go = () => {
    const n = parseInt(input.value, 10);
    input.blur();
    if (Number.isFinite(n) && state.pages.length) {
      const page = state.pages[Math.min(state.pages.length, Math.max(1, n)) - 1];
      if (page.id !== state.selectedPageId) { selectPage(page.id); return; }
    }
    refreshPageNav();          // put back what was there
  };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('change', go);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); refreshPageNav(); }
  });
  $('btnPrevPage').addEventListener('click', () => stepPage(-1));
  $('btnNextPage').addEventListener('click', () => stepPage(1));
}

// ============================================================
// The markups list
// ============================================================
function refreshMarkups() {
  let total = 0;
  for (const p of state.pages) total += p.annotations.length;
  $('markupCount').textContent = String(total);

  const rail = $('markupRail');
  if (rail.hidden) return;
  $('markupRailCount').textContent = total ? String(total) : '';
  show($('markupEmptyHint'), !total);

  const frag = document.createDocumentFragment();
  state.pages.forEach((page, i) => {
    if (!page.annotations.length) return;
    const head = document.createElement('div');
    head.className = 'markup-page';
    head.textContent = `PG ${i + 1}`;
    frag.appendChild(head);

    for (const a of page.annotations) {
      const row = document.createElement('button');
      row.className = 'markup-row';
      if (page.id === state.selectedPageId && a.id === state.selectedAnnoId) row.classList.add('current');
      row.dataset.pageId = String(page.id);
      row.dataset.annoId = String(a.id);

      const dot = document.createElement('i');
      dot.style.background = a.color;
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = TYPE_LABEL[a.type] || a.type;
      const what = document.createElement('span');
      what.className = 'snippet';
      // A note is known by what it says; a shape only by its colour.
      what.textContent = isPointShape(a)
        ? (COLOR_NAMES[a.color] || '')
        : ((a.text || '').replace(/\s+/g, ' ').trim() || '(empty)');
      row.append(dot, kind, what);
      frag.appendChild(row);
    }
  });
  $('markupList').replaceChildren(frag);
}

// ============================================================
// The two side panels on a narrow screen
//
// There, the pages rail and the markups list are both drawers over the
// sheet. They behave alike: one at a time, a scrim behind, and a tap on
// the scrim or Esc puts either away. On a wide screen the markups list is
// a panel beside the sheet and none of this applies to it.
// ============================================================
function syncScrim() {
  const open = $('sidebar').classList.contains('open')
    || (isNarrow() && (!$('markupRail').hidden || !$('aiRail').hidden));
  $('drawerScrim').classList.toggle('show', open);
}

function setPagesDrawerOpen(open) {
  if (open && isNarrow()) { setRailOpen(false); setAiOpen(false); }
  $('sidebar').classList.toggle('open', open);
  $('btnPages').setAttribute('aria-expanded', String(open));
  syncScrim();
}

export const closePagesDrawer = () => setPagesDrawerOpen(false);

function installDrawers() {
  $('btnPages').addEventListener('click', () => setPagesDrawerOpen(!$('sidebar').classList.contains('open')));
  $('drawerScrim').addEventListener('click', () => {
    setPagesDrawerOpen(false);
    if (isNarrow()) { setRailOpen(false); setAiOpen(false); }
  });
}

/** The local AI's panel. On the right like the markups list, and one of
 *  the two at a time: side by side they would leave the sheet a strip. */
function setAiOpen(open) {
  const rail = $('aiRail');
  if (rail.hidden === !open) return;
  if (open) { setRailOpen(false); if (isNarrow()) setPagesDrawerOpen(false); }
  show(rail, open);
  syncScrim();
  $('btnAi').setAttribute('aria-expanded', String(open));
  $('btnAi').classList.toggle('open', open);
  if (open) aiPanelOpened();
  renderMainCanvas();
}

function setRailOpen(open) {
  const rail = $('markupRail');
  if (rail.hidden === !open) return;
  if (open) { setAiOpen(false); if (isNarrow()) setPagesDrawerOpen(false); }
  show(rail, open);
  syncScrim();
  $('btnMarkups').setAttribute('aria-expanded', String(open));
  $('btnMarkups').classList.toggle('open', open);
  refreshMarkups();
  // The sheet just gained or lost that much width; fit modes follow it.
  renderMainCanvas();
}

function installMarkups() {
  $('btnMarkups').addEventListener('click', () => setRailOpen($('markupRail').hidden));
  $('btnCloseMarkups').addEventListener('click', () => setRailOpen(false));
  $('markupList').addEventListener('click', async (e) => {
    const row = e.target.closest('.markup-row');
    if (!row) return;
    const pageId = Number(row.dataset.pageId), annoId = Number(row.dataset.annoId);
    // The markup's DOM exists only once its page has been drawn.
    if (state.selectedPageId !== pageId) await selectPage(pageId);
    if (state.selectedPageId === pageId) selectMarkup(annoId);
    // On a phone the list covers the sheet it has just scrolled.
    if (isNarrow()) setRailOpen(false);
  });
}

// ============================================================
// The file menu
// ============================================================
let closeFileMenu = () => false;

function installFileMenu() {
  const btn = $('btnFileMenu');
  const menu = $('fileMenu');
  const items = () => [...menu.querySelectorAll('[role=menuitem]')].filter((n) => !n.disabled && !n.hidden);

  const setOpen = (open, focusFirst = false) => {
    show(menu, open);
    btn.setAttribute('aria-expanded', String(open));
    if (open && focusFirst) items()[0]?.focus();
  };
  closeFileMenu = () => {
    if (menu.hidden) return false;
    setOpen(false);
    return true;
  };

  // `detail` is 0 for a click that came from the keyboard, and only then
  // is focus moved into the menu: a mouse user did not ask for it.
  btn.addEventListener('click', (e) => setOpen(menu.hidden, e.detail === 0));
  // Each item does its own work (main.js); this only puts the menu away.
  menu.addEventListener('click', (e) => { if (e.target.closest('[role=menuitem]')) setOpen(false); });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); btn.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('.split')) setOpen(false);
  });
}

/** Put away whatever is open over the app. True if something was. */
export function dismissOverlays() {
  if (closeFileMenu()) return true;
  if ($('sidebar').classList.contains('open')) { setPagesDrawerOpen(false); return true; }
  if (isNarrow() && !$('markupRail').hidden) { setRailOpen(false); return true; }
  if (isNarrow() && !$('aiRail').hidden) { setAiOpen(false); return true; }
  return false;
}

// ============================================================
// Keyboard shortcuts reference
// ============================================================
export function openShortcuts() {
  const dlg = $('shortcutsDialog');
  if (dlg.open) return;
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
}

function installShortcuts() {
  const dlg = $('shortcutsDialog');
  const close = () => (dlg.close ? dlg.close() : dlg.removeAttribute('open'));
  $('btnShortcuts').addEventListener('click', openShortcuts);
  $('btnCloseShortcuts').addEventListener('click', close);
  // A click on the backdrop lands on the dialog element itself.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
}

// ============================================================
// Hover boxes: what a button is, and the key that does the same
//
// Every button with a shortcut carries data-tip-name, data-tip and
// data-key (index.html). Hovering it shows those in a box under it —
// after a short pause, and then at once while the pointer moves along the
// row, so reading the tool rail is one sweep, not eight waits. Keyboard
// focus shows it too. A finger has no hover, so touch never does.
//
// They replace the browser's own tooltip on those buttons, which arrives
// after a second, says it in a sentence with the key in brackets, and
// cannot be styled.
// ============================================================
const TIP_DELAY_MS = 450;
const TIP_WARM_MS = 600;            // after one closes, the next opens at once
let tipShownFor = null;
let tipTimer = 0;
let tipClosedAt = -Infinity;

/** The key as this platform writes it. */
const keyLabel = (k) => (MOD_KEY === '⌘' ? k : k.replace(/⇧/g, 'Shift+').replace(/⌘/g, 'Ctrl+').replace(/⌃/g, 'Ctrl+'));

function fillTip(el) {
  const tip = $('tooltip');
  const name = document.createElement('span');
  name.className = 'tip-name';
  name.textContent = el.dataset.tipName || el.getAttribute('aria-label') || el.textContent.trim();
  const parts = [name];
  if (el.dataset.key) {
    const key = document.createElement('kbd');
    key.textContent = keyLabel(el.dataset.key);
    parts.push(key);
  }
  if (el.dataset.tip) {
    const desc = document.createElement('span');
    desc.className = 'tip-desc';
    desc.textContent = el.dataset.tip;
    parts.push(desc);
  }
  tip.replaceChildren(...parts);
}

function placeTip(el) {
  const tip = $('tooltip');
  const r = el.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const margin = 8;
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));
  // Below, unless that runs off the window.
  let top = r.bottom + 8;
  if (top + t.height > window.innerHeight - margin) top = r.top - t.height - 8;
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
}

function showTip(el) {
  clearTimeout(tipTimer);
  const tip = $('tooltip');
  fillTip(el);
  show(tip, true);
  placeTip(el);
  tipShownFor = el;
  el.setAttribute('aria-describedby', 'tooltip');
}

function hideTip() {
  clearTimeout(tipTimer);
  if (!tipShownFor) return;
  tipShownFor.removeAttribute('aria-describedby');
  tipShownFor = null;
  tipClosedAt = performance.now();
  show($('tooltip'), false);
}

function installTooltips() {
  const target = (e) => e.target.closest?.('[data-key]');

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = target(e);
    if (!el || el === tipShownFor) return;
    hideTip();
    const wait = performance.now() - tipClosedAt < TIP_WARM_MS ? 0 : TIP_DELAY_MS;
    tipTimer = setTimeout(() => { if (el.isConnected && !el.hidden) showTip(el); }, wait);
  });
  document.addEventListener('pointerout', (e) => {
    const el = target(e);
    if (!el || el.contains(e.relatedTarget)) return;
    clearTimeout(tipTimer);
    if (el === tipShownFor) hideTip();
  });
  // From the keyboard, at once: there is no pointer to rest.
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el && el.matches(':focus-visible')) showTip(el);
  });
  document.addEventListener('focusout', (e) => { if (target(e) === tipShownFor) hideTip(); });
  // Using the button, or anything else, puts the box away.
  document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); hideTip(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key !== 'Tab') hideTip(); }, true);
  window.addEventListener('blur', hideTip);
  window.addEventListener('scroll', hideTip, true);
}

// ============================================================
// First launch: the one caveat that applies here
// ============================================================
function platformNote() {
  if (NO_CLOSE_PROMPT) {
    return { text: 'On an iPhone or iPad nothing asks before the app closes, and nothing is kept. '
      + 'Save downloads a copy to Files — do it before you leave.' };
  }
  if (!canUseFileSystemAccess) {
    return { text: 'This browser has no save panel, so Save downloads a copy instead of writing back to your file. '
      + 'Chrome on a Mac saves in place.' };
  }
  if (!window.matchMedia?.('(display-mode: standalone)').matches) {
    return { text: 'Install Redline from the address bar for a dock icon, and to open PDFs straight from Finder.' };
  }
  // A step done once should not be explained on every launch: it goes
  // away when it is dismissed, or when a PDF arrives from Finder — which
  // is the proof it has been done.
  if ('launchQueue' in window && !finderHintSeen()) {
    return {
      text: 'To open PDFs here with a double-click: in Finder, select any PDF → Get Info → '
        + 'Open with: Redline → Change All.',
      once: true,
    };
  }
  return null;
}

function installPlatformNote() {
  const note = platformNote();
  show($('platformNote'), !!note);
  if (!note) return;
  $('platformNoteText').textContent = note.text;
  show($('btnPlatformNoteDone'), !!note.once);
  $('btnPlatformNoteDone').addEventListener('click', () => {
    setFinderHintSeen();
    show($('platformNote'), false);
  });
}

// ============================================================
// Install / refresh
// ============================================================
function refreshChrome() {
  const h = historyStatus();
  refreshHistory(h);
  refreshSaveChip(h);
  refreshProps();
  refreshPageNav();
  refreshMarkups();
}

export function installChrome() {
  buildSwatches();
  buildPenSizes();

  $('fontSizeSelect').addEventListener('change', (e) => {
    applyAnnoStyle({ fontSize: parseInt(e.target.value, 10) });
    // Left focused, the list would go on swallowing every shortcut.
    e.target.blur();
  });
  $('fillToggle').addEventListener('change', (e) => applyAnnoStyle({ fill: e.target.checked }));
  $('fitToggle').addEventListener('change', (e) => applyAnnoStyle({ fit: e.target.checked }));
  $('btnDuplicate').addEventListener('click', () => duplicateSelected());
  $('btnDeleteAnno').addEventListener('click', () => {
    const page = currentPage();
    if (page && state.selectedAnnoId) deleteAnnotation(page, state.selectedAnnoId);
  });

  $('btnUndo').addEventListener('click', doUndo);
  $('btnRedo').addEventListener('click', doRedo);

  installFileMenu();
  installDrawers();
  $('btnAi').addEventListener('click', () => setAiOpen($('aiRail').hidden));
  $('btnCloseAi').addEventListener('click', () => setAiOpen(false));
  installAiPanel();
  installPageNav();
  installMarkups();
  installShortcuts();
  installTooltips();

  // The ways out of a failed save. Which of them are offered is the
  // failure's to decide — a locked document has none, and gets a button
  // that only says the message was read (showSaveAlert in files.js).
  $('btnAlertSaveAs').addEventListener('click', saveAs);
  $('btnAlertDownload').addEventListener('click', downloadCopy);
  $('btnAlertUnderstood').addEventListener('click', dismissSaveAlert);
  $('btnAlertDismiss').addEventListener('click', dismissSaveAlert);

  // Straight to the work that is waiting out of sight.
  $('saveChipOthers').addEventListener('click', () => {
    const first = otherUnsaved()[0];
    if (first) switchToDoc(first.id);
  });

  installPlatformNote();

  onToolbarUpdate(refreshChrome);
  onDirtyChange(refreshChrome);
  refreshChrome();
}
