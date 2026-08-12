/* Session autosave to IndexedDB.
 *
 * Motivation is mostly the phone: iOS terminates backgrounded web apps
 * without warning, so anything not written down is gone. Saves are
 * debounced during editing and flushed synchronously-ish on pagehide.
 */
import { state, setStatus } from './state.js';

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
function snapshot() {
  return {
    version: 1,
    savedAt: Date.now(),
    // Only the raw bytes are stored. pdfLibDoc / pdfjsDoc are live
    // objects that can't be cloned; they're rebuilt from bytes on load.
    sources: state.sources.map((s) => ({ id: s.id, name: s.name, bytes: s.bytes })),
    pages: state.pages.map((p) => ({
      id: p.id,
      kind: p.kind,
      sourceId: p.sourceId,
      sourcePageIndex: p.sourcePageIndex,
      W0: p.W0,
      H0: p.H0,
      rotation: p.rotation,
      annotations: p.annotations.map((a) => ({ ...a })),
    })),
    nextSourceId: state.nextSourceId,
    nextPageId: state.nextPageId,
    nextAnnoId: state.nextAnnoId,
    selectedPageId: state.selectedPageId,
    docName: state.docName,
    // FileSystemFileHandle is structured-cloneable, so ⌘S still targets
    // the right file after a restart — subject to a permission
    // re-prompt, which Chrome requires once per session.
    fileHandle: state.fileHandle || null,
    dirty: state.dirty,
    zoomMode: state.zoomMode,
    zoomLevel: state.zoomLevel,
    currentColor: state.currentColor,
    currentFontSize: state.currentFontSize,
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

/** Rehydrate a snapshot into live state. Returns true if anything was
 *  restored. The caller re-renders. */
export async function restoreSession(snap) {
  if (!snap || !snap.pages || !snap.pages.length) return false;

  const { PDFDocument } = PDFLib;
  const sources = [];

  for (const s of snap.sources || []) {
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
  const pages = snap.pages.filter((p) => p.kind === 'blank' || liveIds.has(p.sourceId));
  if (!pages.length) return false;

  state.sources = sources;
  state.pages = pages;
  state.nextSourceId = snap.nextSourceId || sources.length + 1;
  state.nextPageId = snap.nextPageId || pages.length + 1;
  state.nextAnnoId = snap.nextAnnoId || 1;
  state.selectedPageId = pages.some((p) => p.id === snap.selectedPageId)
    ? snap.selectedPageId : pages[0].id;
  state.selectedAnnoId = null;
  state.docName = snap.docName || 'Untitled.pdf';
  state.fileHandle = snap.fileHandle || null;
  state.dirty = snap.dirty !== false;
  state.zoomMode = snap.zoomMode || 'fit-width';
  state.zoomLevel = snap.zoomLevel || 1;
  if (snap.currentColor) state.currentColor = snap.currentColor;
  if (snap.currentFontSize) state.currentFontSize = snap.currentFontSize;

  const dropped = (snap.pages.length - pages.length);
  if (dropped > 0) {
    setStatus(`Restored session — ${dropped} page(s) couldn't be recovered.`, 'err');
  }
  return true;
}

/** Save on the events that actually precede a kill. visibilitychange is
 *  the one that fires reliably on iOS; pagehide covers desktop closes. */
export function installAutosaveTriggers() {
  const flush = () => { if (state.pages.length) flushSave(); };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
