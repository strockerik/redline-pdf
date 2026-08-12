/* Opening and saving.
 *
 * Three ways in — Finder launch (file_handlers + launchQueue), a file
 * picker, and drag-and-drop — and two ways out: write back over the
 * opened file, or a save panel. Everything degrades to the plain
 * <input type=file> / download path on iOS, which implements neither
 * the File System Access API nor file handlers.
 */
import { state, setStatus, markDirty } from './state.js';
import { importPdfBytes, importPdfFile } from './pages.js';
import { buildPdfBytes } from './export.js';
import { updateTitle } from './view.js';

export const canUseFileSystemAccess = 'showSaveFilePicker' in window;

const PDF_PICKER_TYPES = [{
  description: 'PDF document',
  accept: { 'application/pdf': ['.pdf'] },
}];

// ============================================================
// Opening
// ============================================================
/** Open from a FileSystemFileHandle — the Finder / picker path. The
 *  handle is retained so ⌘S can write straight back to it. */
export async function openFromHandle(handle, { asPrimary = true } = {}) {
  const file = await handle.getFile();
  const bytes = await file.arrayBuffer();
  const first = await importPdfBytes(bytes, file.name);
  if (first !== null && asPrimary && !state.fileHandle) {
    state.fileHandle = handle;
    state.docName = file.name;
    markDirty(false);
    updateTitle();
  }
  return first;
}

/** Wire up the Chrome file handler. When Redline is the app that opened
 *  a PDF from Finder, the handle arrives here at launch. */
export function installLaunchHandler() {
  if (!('launchQueue' in window)) return;
  if (typeof LaunchParams === 'undefined' || !('files' in LaunchParams.prototype)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;
    for (const handle of params.files) {
      try {
        await openFromHandle(handle);
      } catch (err) {
        console.error(err);
        setStatus(`Couldn't open that file: ${err.message || err}`, 'err');
      }
    }
  });
}

export async function openViaPicker() {
  if (!canUseFileSystemAccess || !('showOpenFilePicker' in window)) {
    document.getElementById('fileInput').click();
    return;
  }
  try {
    const handles = await window.showOpenFilePicker({
      types: PDF_PICKER_TYPES,
      multiple: true,
    });
    for (const h of handles) await openFromHandle(h);
  } catch (err) {
    if (err.name === 'AbortError') return;   // user dismissed the panel
    console.error(err);
    setStatus(`Couldn't open: ${err.message || err}`, 'err');
  }
}

/** Drag a PDF anywhere onto the window. Works in every browser and
 *  needs no permissions, so it's the most reliable path in practice. */
export function installDragAndDrop() {
  const overlay = document.getElementById('dropOverlay');
  let depth = 0;

  const isFileDrag = (e) =>
    e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (++depth === 1) overlay.classList.add('show');
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    if (--depth <= 0) { depth = 0; overlay.classList.remove('show'); }
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('show');

    // Prefer handles when the browser offers them, so a dragged-in file
    // can still be the ⌘S target.
    const items = [...(e.dataTransfer.items || [])];
    const pdfs = [...e.dataTransfer.files].filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
    );
    if (!pdfs.length) { setStatus('Only PDF files can be opened.', 'err'); return; }

    if (canUseFileSystemAccess && items.length && items[0].getAsFileSystemHandle) {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        try {
          const handle = await item.getAsFileSystemHandle();
          if (handle && handle.kind === 'file') { await openFromHandle(handle); continue; }
        } catch { /* fall through to the plain File below */ }
      }
      return;
    }
    for (const f of pdfs) await importPdfFile(f);
  });
}

// ============================================================
// Saving
// ============================================================
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function ensurePdfExt(name) {
  const n = (name || '').trim() || 'document.pdf';
  return /\.pdf$/i.test(n) ? n : n + '.pdf';
}

async function ensureWritePermission(handle) {
  if (!handle.queryPermission) return true;
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

/** Write the document back to `handle`.
 *
 *  The export is completed into memory *before* the writable stream is
 *  opened. createWritable truncates the file, so building the bytes
 *  afterward would mean a failed export leaves the original at zero
 *  length — the one way this tool could actually destroy your work.
 */
async function writeToHandle(handle, bytes) {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

/** ⌘S — overwrite the file we opened, or fall through to Save As. */
export async function save() {
  if (!state.pages.length) { setStatus('Nothing to save yet.', 'err'); return; }
  if (!state.fileHandle) return saveAs();

  setStatus('Saving…');
  try {
    // Permission must be requested while the user gesture is still
    // live, so it happens before the (slower) export.
    if (!await ensureWritePermission(state.fileHandle)) {
      setStatus('Permission to write that file was declined.', 'err');
      return;
    }
    const bytes = await buildPdfBytes();
    await writeToHandle(state.fileHandle, bytes);
    markDirty(false);
    updateTitle();
    setStatus(`Saved ${state.docName} ✓`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus('Save failed: ' + (err.message || err), 'err');
  }
}

/** ⇧⌘S — native save panel, then remember the handle for later ⌘S. */
export async function saveAs() {
  if (!state.pages.length) { setStatus('Nothing to save yet.', 'err'); return; }

  const suggested = ensurePdfExt(
    document.getElementById('filenameInput')?.value || state.docName
  );

  if (!canUseFileSystemAccess) {
    setStatus('Building PDF…');
    try {
      const bytes = await buildPdfBytes();
      downloadBytes(bytes, suggested);
      state.docName = suggested;
      markDirty(false);
      updateTitle();
      setStatus('Downloaded ✓', 'ok');
    } catch (err) {
      console.error(err);
      setStatus('Export failed: ' + (err.message || err), 'err');
    }
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggested,
      types: PDF_PICKER_TYPES,
    });
    setStatus('Saving…');
    const bytes = await buildPdfBytes();
    await writeToHandle(handle, bytes);
    state.fileHandle = handle;
    state.docName = handle.name || suggested;
    markDirty(false);
    updateTitle();
    setStatus(`Saved ${state.docName} ✓`, 'ok');
  } catch (err) {
    if (err.name === 'AbortError') return;   // user dismissed the panel
    console.error(err);
    setStatus('Save failed: ' + (err.message || err), 'err');
  }
}

/** Always-download path, kept as an explicit action so the behaviour is
 *  available even where the File System Access API exists. */
export async function downloadCopy() {
  if (!state.pages.length) { setStatus('Nothing to export yet.', 'err'); return; }
  setStatus('Building PDF…');
  try {
    const bytes = await buildPdfBytes();
    downloadBytes(bytes, ensurePdfExt(
      document.getElementById('filenameInput')?.value || state.docName
    ));
    setStatus('Downloaded ✓', 'ok');
  } catch (err) {
    console.error(err);
    setStatus('Export failed: ' + (err.message || err), 'err');
  }
}
