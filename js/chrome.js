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
import { renderTabs } from './tabs.js';
import { finderHintSeen, setFinderHintSeen } from './persist.js';

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
  u.title = h.canUndo ? `Undo ${h.undoLabel.toLowerCase()} (${MOD_KEY}Z)` : 'Nothing to undo';
  r.title = h.canRedo ? `Redo ${h.redoLabel.toLowerCase()} (⇧${MOD_KEY}Z)` : 'Nothing to redo';
}

// ============================================================
// Save state, in words
// ============================================================
function refreshSaveChip(h) {
  const chip = $('saveChip');
  if (!state.pages.length) { show(chip, false); return; }
  show(chip, true);

  const at = h.savedAt
    ? new Date(h.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  let text;
  if (state.dirty) {
    const n = h.changes;
    text = n ? `${n} unsaved change${n === 1 ? '' : 's'}` : 'Unsaved changes';
    if (NO_CLOSE_PROMPT) text += ' · leaving loses them';
    else if (at) text += ` · last saved ${at}`;
    // Only of a document that did not come from a file. One that did has
    // a saved version, even if this session has not written to it.
    else if (state.combined || !state.sources.length) text += ' · never saved';
  } else {
    text = at ? `Saved ${at}` : 'No unsaved changes';
  }
  chip.classList.toggle('unsaved', state.dirty);
  $('saveChipText').textContent = text;
  chip.title = state.dirty
    ? 'Documents close with the app. Save before you quit.'
    : 'Everything in this document is on disk.';
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
  pen: 'draw as many as you like',
  highlight: 'draw as many as you like',
  arrow: 'drag from tail to tip, as many as you like',
  rect: 'drag from corner to corner, as many as you like',
  cloud: 'drag from corner to corner, as many as you like',
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
  const open = $('sidebar').classList.contains('open') || (isNarrow() && !$('markupRail').hidden);
  $('drawerScrim').classList.toggle('show', open);
}

function setPagesDrawerOpen(open) {
  if (open && isNarrow()) setRailOpen(false);
  $('sidebar').classList.toggle('open', open);
  $('btnPages').setAttribute('aria-expanded', String(open));
  syncScrim();
}

export const closePagesDrawer = () => setPagesDrawerOpen(false);

function installDrawers() {
  $('btnPages').addEventListener('click', () => setPagesDrawerOpen(!$('sidebar').classList.contains('open')));
  $('drawerScrim').addEventListener('click', () => {
    setPagesDrawerOpen(false);
    if (isNarrow()) setRailOpen(false);
  });
}

function setRailOpen(open) {
  const rail = $('markupRail');
  if (rail.hidden === !open) return;
  if (open && isNarrow()) setPagesDrawerOpen(false);
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
  installPageNav();
  installMarkups();
  installShortcuts();

  // The two ways out of a failed save. Where there is no save panel,
  // Save As *is* a download, so only one of them is offered.
  $('btnAlertSaveAs').addEventListener('click', saveAs);
  $('btnAlertDownload').addEventListener('click', downloadCopy);
  $('btnAlertDismiss').addEventListener('click', dismissSaveAlert);
  show($('btnAlertSaveAs'), canUseFileSystemAccess);

  installPlatformNote();

  onToolbarUpdate(refreshChrome);
  onDirtyChange(refreshChrome);
  refreshChrome();
}
