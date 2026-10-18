/* Document tabs.
 *
 * Each tab is a whole document — its own sources, pages, annotations and
 * save target. Only one is live at a time: `state` carries the active
 * document's fields (see state.js), so switching is a field swap plus a
 * re-render, and the rest of the app never learns that tabs exist.
 */
import {
  state, blankDoc, captureActiveDoc, loadDocIntoState, activeDoc, markDirty, finishTyping,
} from './state.js';
import {
  renderThumbnails, renderMainCanvas, updateTitle, invalidateAllThumbs,
} from './view.js';

const $ = (id) => document.getElementById(id);

// ============================================================
// Model
// ============================================================
/** Adopt whatever is already in `state` as the first document. Called
 *  once, at boot. */
export function ensureInitialDoc() {
  if (state.docs.length) return activeDoc();
  const doc = blankDoc();
  state.docs.push(doc);
  state.activeDocId = doc.id;
  // Take the live fields rather than the blank ones.
  captureActiveDoc();
  return doc;
}

/** Add a document and make it active. */
export function openDocument({ activate = true } = {}) {
  finishTyping();
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

/** Bring a document to the front. Exported because the save chip says
 *  how many other tabs have unsaved work, and is the way to the first of
 *  them (chrome.js). */
export function switchToDoc(id) {
  if (id === state.activeDocId) return;
  const target = state.docs.find((d) => d.id === id);
  if (!target) return;
  finishTyping();
  captureActiveDoc();
  loadDocIntoState(target);

  // Only the visible document's thumbnails are worth holding on to.
  invalidateAllThumbs();
  renderTabs();
  updateTitle();
  renderThumbnails();
  renderMainCanvas();
}

function closeDoc(id) {
  const idx = state.docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  finishTyping();
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
    const locked = isActive ? state.locked : doc.locked;

    const tab = document.createElement('div');
    // A tab is the only sign a document that is not on screen gives, so
    // it carries the two things that cannot wait for a switch: work only
    // in memory, and a file that can never be written.
    tab.className = 'tab' + (isActive ? ' active' : '')
      + (dirty && count ? ' dirty' : '') + (locked ? ' locked' : '');
    tab.dataset.docId = String(doc.id);
    tab.title = `${name} — ${count} page${count === 1 ? '' : 's'}`
      + (dirty && count ? ' · unsaved changes' : '')
      + (locked ? ' · locked by its author, and can’t be saved' : '');

    if (dirty && count) {
      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      tab.appendChild(dot);
    }

    if (locked) {
      const lock = document.createElement('span');
      lock.className = 'tab-lock';
      lock.setAttribute('aria-hidden', 'true');
      lock.innerHTML = '<svg width="9" height="11" viewBox="0 0 9 11" fill="none">'
        + '<rect x="0.9" y="4.4" width="7.2" height="6.2" rx="1.2" stroke="currentColor" stroke-width="1.2"></rect>'
        + '<path d="M2.6 4.4V3.1a1.9 1.9 0 013.8 0v1.3" stroke="currentColor" stroke-width="1.2"></path></svg>';
      tab.appendChild(lock);
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
  const hasLock = !!el.querySelector('.tab-lock');
  if (hasDot !== wantDot || hasLock !== !!state.locked) renderTabs();
}

export function installTabs() {
  $('btnNewTab')?.addEventListener('click', () => {
    openDocument();
    updateTitle();
    renderThumbnails();
    renderMainCanvas();
    markDirty(false);
  });
  renderTabs();
}
