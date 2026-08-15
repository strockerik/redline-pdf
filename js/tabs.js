/* Document tabs.
 *
 * Each tab is a whole document — its own sources, pages, annotations and
 * save target. Only one is live at a time: `state` carries the active
 * document's fields (see state.js), so switching is a field swap plus a
 * re-render, and the rest of the app never learns that tabs exist.
 */
import {
  state, blankDoc, captureActiveDoc, loadDocIntoState, activeDoc, markDirty,
} from './state.js';
import {
  renderThumbnails, renderMainCanvas, updateTitle, invalidateAllThumbs,
} from './view.js';

const $ = (id) => document.getElementById(id);

let onChange = null;   // called after any switch/open/close, for autosave

export function setTabsChangeHandler(fn) { onChange = fn; }

// ============================================================
// Model
// ============================================================
/** Adopt whatever is already in `state` as the first document. Called at
 *  boot, after any session restore, so the fields the restore wrote are
 *  the ones the first tab gets. */
export function ensureInitialDoc() {
  if (state.docs.length) return activeDoc();
  const doc = blankDoc();
  state.docs.push(doc);
  state.activeDocId = doc.id;
  // Take the live fields rather than the blank ones — a restore may have
  // already filled them in.
  captureActiveDoc();
  return doc;
}

/** Add a document and make it active. */
export function openDocument({ activate = true } = {}) {
  captureActiveDoc();
  const doc = blankDoc();
  state.docs.push(doc);
  if (activate) loadDocIntoState(doc);
  renderTabs();
  return doc;
}

/** The active document if it is still empty, otherwise a fresh one. Lets
 *  "open in tabs" fill the blank tab you already have instead of leaving
 *  an empty one at the front. */
export function docForNewFile() {
  const cur = activeDoc();
  if (cur && !state.pages.length) return cur;
  return openDocument();
}

function switchToDoc(id) {
  if (id === state.activeDocId) return;
  const target = state.docs.find((d) => d.id === id);
  if (!target) return;
  captureActiveDoc();
  loadDocIntoState(target);

  // Thumbnails are cached by page id, and page ids restart per document,
  // so a stale cache would show the previous tab's pages.
  invalidateAllThumbs();
  renderTabs();
  updateTitle();
  renderThumbnails();
  renderMainCanvas();
  onChange?.();
}

function closeDoc(id) {
  const idx = state.docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const doc = state.docs[idx];
  const isActive = id === state.activeDocId;
  const dirty = isActive ? state.dirty : doc.dirty;
  const pages = isActive ? state.pages.length : doc.pages.length;

  if (dirty && pages &&
      !confirm(`${isActive ? state.docName : doc.docName} has unsaved changes. Close it anyway?`)) {
    return;
  }

  state.docs.splice(idx, 1);
  if (!state.docs.length) {
    const fresh = blankDoc();
    state.docs.push(fresh);
    loadDocIntoState(fresh);
  } else if (isActive) {
    loadDocIntoState(state.docs[Math.min(idx, state.docs.length - 1)]);
  }

  invalidateAllThumbs();
  renderTabs();
  updateTitle();
  renderThumbnails();
  renderMainCanvas();
  onChange?.();
}

// ============================================================
// Tab bar
// ============================================================
export function renderTabs() {
  const bar = $('tabBar');
  if (!bar) return;

  // One tab is just the app as it always was; the strip would be noise.
  bar.classList.toggle('show', state.docs.length > 1);

  const strip = $('tabStrip');
  strip.replaceChildren();

  for (const doc of state.docs) {
    const isActive = doc.id === state.activeDocId;
    // The active document's truth lives in `state`, not in its record.
    const name = isActive ? state.docName : doc.docName;
    const dirty = isActive ? state.dirty : doc.dirty;
    const count = isActive ? state.pages.length : doc.pages.length;

    const tab = document.createElement('div');
    tab.className = 'tab' + (isActive ? ' active' : '');
    tab.dataset.docId = String(doc.id);
    tab.title = `${name} — ${count} page${count === 1 ? '' : 's'}`;

    if (dirty && count) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      tab.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = name;
    tab.appendChild(label);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close this document';
    close.setAttribute('aria-label', `Close ${name}`);
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeDoc(doc.id);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => switchToDoc(doc.id));
    strip.appendChild(tab);
  }
}

/** Keep the strip honest as the active document is edited. */
export function refreshActiveTab() {
  const strip = $('tabStrip');
  if (!strip) return;
  const el = strip.querySelector(`.tab[data-doc-id="${state.activeDocId}"]`);
  if (!el) { renderTabs(); return; }
  const label = el.querySelector('.tab-name');
  if (label && label.textContent !== state.docName) label.textContent = state.docName;
  const hasDot = !!el.querySelector('.tab-dot');
  const wantDot = state.dirty && state.pages.length > 0;
  if (hasDot !== wantDot) renderTabs();
}

export function installTabs() {
  $('btnNewTab')?.addEventListener('click', () => {
    openDocument();
    updateTitle();
    renderThumbnails();
    renderMainCanvas();
    markDirty(false);
    onChange?.();
  });
  renderTabs();
}
