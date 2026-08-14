/* Session autosave to IndexedDB.
 *
 * Motivation is mostly the phone: iOS terminates backgrounded web apps
 * without warning, so anything not written down is gone. Saves are
 * debounced during editing and flushed synchronously-ish on pagehide.
 */
import {
  state, setStatus, captureActiveDoc, loadDocIntoState,
} from './state.js';

const DB_NAME = 'redline';
const DB_VERSION = 1;
const STORE = 'session';
const KEY = 'current';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// ============================================================
// Save
// ============================================================
function serialiseDoc(d) {
  return {
    id: d.id,
    // Only the raw bytes are stored. pdfLibDoc / pdfjsDoc are live
    // objects that can't be cloned; they're rebuilt from bytes on load.
    sources: d.sources.map((s) => ({ id: s.id, name: s.name, bytes: s.bytes })),
    pages: d.pages.map((p) => ({
      id: p.id,
      kind: p.kind,
      sourceId: p.sourceId,
      sourcePageIndex: p.sourcePageIndex,
      W0: p.W0,
      H0: p.H0,
      rotation: p.rotation,
      annotations: p.annotations.map((a) => ({ ...a })),
    })),
    nextSourceId: d.nextSourceId,
    nextPageId: d.nextPageId,
    nextAnnoId: d.nextAnnoId,
    selectedPageId: d.selectedPageId,
    docName: d.docName,
    // FileSystemFileHandle is structured-cloneable, so ⌘S still targets
    // the right file after a restart — subject to a permission
    // re-prompt, which Chrome requires once per session.
    fileHandle: d.fileHandle || null,
    combined: d.combined,
    dirty: d.dirty,
  };
}

function snapshot() {
  // The active document's truth lives in `state`, not in its record, so
  // fold it back in before serialising or the current tab saves stale.
  captureActiveDoc();
  return {
    version: 2,
    savedAt: Date.now(),
    docs: state.docs.map(serialiseDoc),
    activeDocId: state.activeDocId,
    nextDocId: state.nextDocId,
    // App-wide preferences, not per-document.
    zoomMode: state.zoomMode,
    lastFitMode: state.lastFitMode,
    zoomLevel: state.zoomLevel,
    currentColor: state.currentColor,
    currentFontSize: state.currentFontSize,
    currentPenSize: state.currentPenSize,
  };
}

export async function saveSession() {
  try {
    const snap = snapshot();
    await tx('readwrite', (store) => store.put(snap, KEY));
  } catch (err) {
    // A failed autosave must never interrupt editing; surface it quietly.
    console.warn('autosave failed', err);
  }
}

let debounceTimer = null;

export function scheduleSave() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(saveSession, 800);
}

export function flushSave() {
  clearTimeout(debounceTimer);
  return saveSession();
}

export async function clearSession() {
  clearTimeout(debounceTimer);
  try {
    await tx('readwrite', (store) => store.delete(KEY));
  } catch (err) {
    console.warn('clearing session failed', err);
  }
}

// ============================================================
// Restore
// ============================================================
export async function loadSession() {
  try {
    return await tx('readonly', (store) => store.get(KEY));
  } catch (err) {
    console.warn('reading session failed', err);
    return null;
  }
}

/** Rebuild one document's live pdf.js / pdf-lib objects from stored
 *  bytes. Returns null if nothing usable survived. */
async function reviveDoc(d) {
  const { PDFDocument } = PDFLib;
  const sources = [];
  for (const s of d.sources || []) {
    try {
      // Same detach hazard as a fresh import: pdf.js takes ownership of
      // the buffer it's handed, so each consumer gets its own copy and
      // the pristine original is kept for the next save.
      const pdfLibDoc = await PDFDocument.load(s.bytes.slice(0), { ignoreEncryption: true });
      const pdfjsDoc = await pdfjsLib.getDocument({ data: s.bytes.slice(0) }).promise;
      sources.push({ id: s.id, name: s.name, bytes: s.bytes, pdfLibDoc, pdfjsDoc });
    } catch (err) {
      console.error(`couldn't restore source ${s.name}`, err);
    }
  }

  const liveIds = new Set(sources.map((s) => s.id));
  const pages = (d.pages || []).filter((p) => p.kind === 'blank' || liveIds.has(p.sourceId));
  if (!pages.length) return { doc: null, dropped: (d.pages || []).length };

  return {
    dropped: (d.pages || []).length - pages.length,
    doc: {
      id: d.id,
      sources,
      pages,
      nextSourceId: d.nextSourceId || sources.length + 1,
      nextPageId: d.nextPageId || pages.length + 1,
      nextAnnoId: d.nextAnnoId || 1,
      selectedPageId: pages.some((p) => p.id === d.selectedPageId) ? d.selectedPageId : pages[0].id,
      selectedAnnoId: null,
      docName: d.docName || 'Untitled.pdf',
      fileHandle: d.fileHandle || null,
      combined: !!d.combined,
      dirty: d.dirty !== false,
    },
  };
}

/** Rehydrate a snapshot into live state. Returns true if anything was
 *  restored. The caller re-renders. */
export async function restoreSession(snap) {
  if (!snap) return false;

  // v1 snapshots predate tabs and are a single document inline. Treat one
  // as a one-tab session rather than discarding somebody's work.
  const stored = Array.isArray(snap.docs)
    ? snap.docs
    : (snap.pages && snap.pages.length ? [{ ...snap, id: 1 }] : []);
  if (!stored.length) return false;

  const docs = [];
  let dropped = 0;
  for (const d of stored) {
    const { doc, dropped: lost } = await reviveDoc(d);
    dropped += lost || 0;
    if (doc) docs.push(doc);
  }
  if (!docs.length) return false;

  state.docs = docs;
  state.nextDocId = Math.max(snap.nextDocId || 1, ...docs.map((d) => d.id + 1));
  const active = docs.find((d) => d.id === snap.activeDocId) || docs[0];
  loadDocIntoState(active);

  state.zoomMode = snap.zoomMode || 'fit-width';
  // Sessions saved before lastFitMode existed fall back to the zoom mode.
  state.lastFitMode = snap.lastFitMode
    || (snap.zoomMode === 'fit-page' ? 'fit-page' : 'fit-width');
  state.zoomLevel = snap.zoomLevel || 1;
  if (snap.currentColor) state.currentColor = snap.currentColor;
  if (snap.currentFontSize) state.currentFontSize = snap.currentFontSize;
  if (snap.currentPenSize) state.currentPenSize = snap.currentPenSize;

  if (dropped > 0) {
    setStatus(`Restored session — ${dropped} page(s) couldn't be recovered.`, 'err');
  }
  return true;
}

/** Save on the events that actually precede a kill. visibilitychange is
 *  the one that fires reliably on iOS; pagehide covers desktop closes. */
export function installAutosaveTriggers() {
  const flush = () => {
    if (state.pages.length || state.docs.some((d) => d.pages.length)) flushSave();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
