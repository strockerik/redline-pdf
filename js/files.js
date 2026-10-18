/* Opening and saving.
 *
 * Three ways in — Finder launch (file_handlers + launchQueue), a file
 * picker, and drag-and-drop — and two ways out: write back over the
 * opened file, or a save panel. Everything degrades to the plain
 * <input type=file> / download path on iOS, which implements neither
 * the File System Access API nor file handlers.
 */
import {
  state, setStatus, markDirty, finishTyping,
  activeDoc, withDoc, captureActiveDoc,
} from './state.js';
import { noteClean } from './history.js';
import { setFinderHintSeen } from './persist.js';
import { importPdfBytes, importPdfFile } from './pages.js';
import { docForNewFile, renderTabs } from './tabs.js';
import { buildPdfBytes } from './export.js';
import { updateTitle, renderThumbnails, renderMainCanvas } from './view.js';

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
async function openFromHandle(handle, { into = activeDoc() } = {}) {
  const file = await handle.getFile();
  const bytes = await file.arrayBuffer();
  // Whether the handle becomes the save target is the import's call: it
  // is the one place that knows if this file opened an empty document or
  // was merged into a document that already had pages (pages.js).
  return importPdfBytes(bytes, file.name, { handle, into });
}

/** Wire up the Chrome file handler. When Redline is the app that opened
 *  a PDF from Finder, the handle arrives here — at launch, and again for
 *  every later double-click while the window is open.
 *
 *  Each file becomes its own document, in its own tab — never merged into
 *  whatever happens to be live — and not until `ready` (boot) is over, so
 *  nothing here writes to `state` while boot is still setting it up.
 */
export function installLaunchHandler(ready) {
  if (!('launchQueue' in window)) return;
  if (typeof LaunchParams === 'undefined' || !('files' in LaunchParams.prototype)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params || !params.files || !params.files.length) return;
    // A file arriving this way is proof the Finder association is set up;
    // the empty state can stop explaining how to do it.
    setFinderHintSeen();
    await ready;
    await openInTabs(params.files.map((handle) => ({ handle })));
  });
}

/** Open each file as its own document instead of merging them.
 *
 *  The merging path is unchanged and still the default — this is the
 *  other half of the choice. Each file lands in its own tab, so each one
 *  keeps its own save target and ⌘S means what it says.
 */
export async function openInTabs(entries) {
  let opened = 0;
  for (const entry of entries) {
    // Fill the current tab if it is still empty, so choosing "open in
    // tabs" from a blank app doesn't leave an unused tab at the front.
    const into = docForNewFile();
    // Show the tab as what it is — empty — while the file loads. Left
    // alone, the previous document's pages stay on screen under the new
    // tab until the import lands, and for good if it fails.
    renderThumbnails();
    renderMainCanvas();
    try {
      const ok = entry.handle
        ? await openFromHandle(entry.handle, { into })
        : await importPdfFile(entry.file, { into });
      if (ok !== null) opened++;
    } catch (err) {
      console.error(err);
      setStatus(`Couldn't open that file: ${err.message || err}`, 'err');
    }
  }
  renderTabs();
  updateTitle();
  if (opened) {
    setStatus(`Opened ${opened} document${opened === 1 ? '' : 's'} in tabs.`, 'ok');
  }
  return opened;
}

export async function openViaPickerInTabs() {
  if (!canUseFileSystemAccess || !('showOpenFilePicker' in window)) {
    // No picker here, so reuse the plain file input and route its result
    // through the tab path instead of the merging one.
    openViaFileInput('tabs');
    return;
  }
  try {
    const handles = await window.showOpenFilePicker({
      types: PDF_PICKER_TYPES,
      multiple: true,
    });
    await openInTabs(handles.map((handle) => ({ handle })));
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    setStatus(`Couldn't open: ${err.message || err}`, 'err');
  }
}

// The <input type=file> fallback is shared by both open modes, so it has
// to be told which one asked for it.
//
// Every caller goes through openViaFileInput, which sets the mode as it
// clicks. That matters because a cancelled file dialog fires no `change`
// event: an armed flag would survive, and the *next* open would silently
// run in the mode the abandoned one asked for. Whoever clicked last wins,
// which is right — the change event belongs to the most recent click.
let pendingInputMode = 'merge';

function openViaFileInput(mode) {
  pendingInputMode = mode;
  document.getElementById('fileInput').click();
}

export function takeInputMode() {
  const mode = pendingInputMode;
  pendingInputMode = 'merge';
  return mode;
}

export async function openViaPicker() {
  if (!canUseFileSystemAccess || !('showOpenFilePicker' in window)) {
    openViaFileInput('merge');
    return;
  }
  try {
    const handles = await window.showOpenFilePicker({
      types: PDF_PICKER_TYPES,
      multiple: true,
    });
    const into = activeDoc();
    for (const h of handles) await openFromHandle(h, { into });
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
  const zones = document.getElementById('dropZones');
  const one = document.getElementById('dropOne');
  const here = document.getElementById('dropHere');
  const newTab = document.getElementById('dropNewTab');
  let depth = 0;

  const isFileDrag = (e) =>
    e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  // What the drop can mean, decided as the overlay appears. ⌘O and ⇧⌘O
  // are the same two answers, asked outright; a drop used to take the
  // first of them without ever saying so. An empty document has only one
  // answer, so it keeps the message it always had.
  const arm = () => {
    const open = state.pages.length > 0;
    zones.hidden = !open;
    one.hidden = open;
    if (open) document.getElementById('dropHereName').textContent = state.docName;
  };

  /** Which answer a point is over. Half the overlay each, rather than the
   *  cards themselves: a file let go in the gap between two cards still
   *  has to land somewhere. */
  const zoneFor = (x, y) => {
    if (zones.hidden) return 'merge';
    const a = here.getBoundingClientRect(), b = newTab.getBoundingClientRect();
    // Side by side on a wide window, stacked on a narrow one.
    return b.top >= a.bottom
      ? (y > (a.bottom + b.top) / 2 ? 'tabs' : 'merge')
      : (x > (a.right + b.left) / 2 ? 'tabs' : 'merge');
  };

  const mark = (zone) => {
    here.classList.toggle('hot', zone === 'merge');
    newTab.classList.toggle('hot', zone === 'tabs');
  };

  const putAway = () => {
    depth = 0;
    overlay.classList.remove('show');
    mark(null);
  };

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (++depth === 1) { arm(); overlay.classList.add('show'); }
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    mark(zoneFor(e.clientX, e.clientY));
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    if (--depth <= 0) putAway();
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const zone = zoneFor(e.clientX, e.clientY);
    putAway();

    const files = [...e.dataTransfer.files];
    const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    if (!files.some(isPdf)) { setStatus('Only PDF files can be opened.', 'err'); return; }
    // Every file of one drop goes where the drop said, and the document
    // it was dropped on is taken now — before the first await, like every
    // other way in.
    const into = activeDoc();

    // Prefer handles when the browser offers them, so a dragged-in file
    // can still be the ⌘S target. All of them are asked for now, before
    // anything awaits: once this handler has yielded, the drop's items are
    // gone, and asking for the next one gets nothing. Asked for one at a
    // time, a drop of two files opened the first and lost the second.
    const fileItems = [...(e.dataTransfer.items || [])].filter((i) => i.kind === 'file');
    const handles = canUseFileSystemAccess && fileItems[0]?.getAsFileSystemHandle
      ? fileItems.map((item) => item.getAsFileSystemHandle().catch(() => null))
      : [];

    const entries = [];
    for (let i = 0; i < files.length; i++) {
      if (!isPdf(files[i])) continue;
      const handle = await handles[i];
      entries.push(handle && handle.kind === 'file' ? { handle } : { file: files[i] });
    }

    if (zone === 'tabs') { await openInTabs(entries); return; }
    for (const entry of entries) {
      if (entry.handle) await openFromHandle(entry.handle, { into });
      else await importPdfFile(entry.file, { into });
    }
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

// A save that did not happen is the one message that must not fade. It
// stays until it is dismissed or a save succeeds, says that the work is
// still here, and offers the ways out that actually lead anywhere.
//
// `reason` says which failure this is, because that decides what to
// offer. Every write path goes through buildPdfBytes, which refuses a
// locked source before a byte exists — flatten included — so for 'locked'
// both Save As and Download a copy are dead ends and there is nothing to
// offer but having read it. A revoked handle or a read-only folder is the
// other kind: another name or another folder is exactly the way out.
function showSaveAlert(what, reason) {
  setStatus('');
  const alert = document.getElementById('saveAlert');
  if (!alert) { setStatus(what, 'err'); return; }
  document.getElementById('saveAlertWhy').textContent = what;
  alert.dataset.reason = reason || '';
  const dead = reason === 'locked';
  const offer = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  offer('btnAlertSaveAs', !dead && canUseFileSystemAccess);
  offer('btnAlertDownload', !dead);
  offer('btnAlertUnderstood', dead);
  alert.classList.add('show');
  // It sits in the flow above the tool row now, so the stage is that much
  // shorter than it was: a fit mode has to be given the new height.
  renderMainCanvas();
}

/** Dismissing the banner takes away the banner and nothing else. The
 *  document's `saveFailed` state outlives it — that is the whole point of
 *  the chip — and is cleared only by a write that works. */
export function dismissSaveAlert() {
  const alert = document.getElementById('saveAlert');
  if (!alert || !alert.classList.contains('show')) return;
  alert.classList.remove('show');
  renderMainCanvas();
}

/** A pinned document's own fields, read without disturbing the one on
 *  screen. The active document's truth is in `state` and its record only
 *  as current as the last capture; a document that has since been
 *  switched away from has its record, which is then the only place its
 *  fields are. With no tabs at all, `state` is the document. */
function fieldsOf(doc) {
  if (!doc) return state;
  return doc.id === state.activeDocId ? (captureActiveDoc() || state) : doc;
}

/** Run `fn` on `doc`, wherever it is, and leave its record agreeing with
 *  it afterwards. A document that is not on screen is swapped in for the
 *  call (withDoc); for the one that is, `state` is already the truth and
 *  its record is brought up to date so that nothing later reads a copy
 *  from before the save. */
function onDoc(doc, fn) {
  if (!doc) return fn();
  const out = withDoc(doc, fn);
  if (doc.id === state.activeDocId) captureActiveDoc();
  return out;
}

/** Where `doc` saves to from now on. Writing it to `state` would land on
 *  whichever tab is in front — and be overwritten by the next capture
 *  anyway — so it goes to the document that was actually saved. */
function aimAt(doc, { name, handle }) {
  onDoc(doc, () => {
    state.docName = name;
    if (handle !== undefined) state.fileHandle = handle;
  });
}

/** Say how the attempt to write `doc` ended.
 *
 *  The outcome belongs to the document that was saved, which may no
 *  longer be the one on screen — only the active document's fields live
 *  on `state` (state.js), so writing the record of an inactive one would
 *  be overwritten by the next capture. withDoc puts it where it will be
 *  read either way.
 */
function noteSaveFailed(doc, failed) {
  if (!doc) return;
  onDoc(doc, () => { state.saveFailed = failed; });
  // The chip and the tabs are drawn from this; chrome.js redraws on any
  // change to the save state, which is what markDirty's listeners are
  // (state.js). The value is left exactly as it was.
  renderTabs();
  markDirty(state.dirty);
}

/** The document that was written is now exactly what is on disk. Not
 *  necessarily the one on screen: a long export finishes whenever it
 *  finishes, and marking the active tab clean would call another
 *  document's unsaved work saved. */
function saved(doc) {
  dismissSaveAlert();
  onDoc(doc, () => { noteClean({ saved: true }); markDirty(false); });
  // Last, and against the active document: this redraws the chip and the
  // tabs from what is on screen now, over anything the line above drew
  // while another document was swapped in.
  noteSaveFailed(doc, false);
  updateTitle();
  renderTabs();            // the dot and the lock on this document's tab
}

/** ⌘S — overwrite the file we opened, or fall through to Save As. */
export async function save() {
  // A note being typed into has its text taken on blur and nowhere else,
  // and ⌘S runs straight off the keydown (main.js) — with a handle
  // already granted, nothing here takes the focus away. Without this the
  // text written is the text from before the edit, and `saved()` then
  // calls the document clean, after which beforeunload no longer warns.
  // Before the pages check, because finishing a note that was placed and
  // left empty takes it away again.
  finishTyping();
  if (!state.pages.length) { setStatus('Nothing to save yet.', 'err'); return; }
  if (!state.fileHandle) return saveAs();
  // Which document this save is of, and what it writes where, all taken
  // before the first await: the export yields (export.js), so by the time
  // it finishes another tab may be in front, and reading `state` then
  // would serialise one document into another's file and record the
  // outcome against the wrong one.
  const doc = activeDoc();
  const handle = state.fileHandle;
  const name = state.docName;

  setStatus('Saving…');
  try {
    // Permission must be requested while the user gesture is still
    // live, so it happens before the (slower) export.
    if (!await ensureWritePermission(handle)) {
      // Declined, not failed: nothing about the file says it cannot be
      // written, and the chip goes on counting the unsaved work.
      showSaveAlert(`Permission to write ${name} was declined.`, 'permission');
      return;
    }
    const bytes = await buildPdfBytes({ doc });
    await writeToHandle(handle, bytes);
    saved(doc);
    setStatus(`Saved ${name} ✓`, 'ok');
  } catch (err) {
    console.error(err);
    // A locked document is not a save that went wrong; it is one that can
    // never go right. It says so in the chip already, so the failure is
    // not also recorded over it.
    if (fieldsOf(doc).locked) showSaveAlert(`${name} can’t be saved: ${err.message || err}`, 'locked');
    else {
      noteSaveFailed(doc, true);
      showSaveAlert(`Couldn’t save ${name}: ${err.message || err}`, 'write');
    }
  }
}

/** ⇧⌘S — native save panel, then remember the handle for later ⌘S. */
export async function saveAs() {
  finishTyping();                 // the note on screen, not the one before it
  if (!state.pages.length) { setStatus('Nothing to save yet.', 'err'); return; }
  const doc = activeDoc();

  // The save panel is where a name is chosen; it starts from the
  // document's own.
  const suggested = ensurePdfExt(state.docName);

  if (!canUseFileSystemAccess) {
    setStatus('Building PDF…');
    try {
      const bytes = await buildPdfBytes({ doc });
      downloadBytes(bytes, suggested);
      aimAt(doc, { name: suggested });
      saved(doc);
      setStatus('Downloaded ✓', 'ok');
    } catch (err) {
      console.error(err);
      failedToBuild(doc, `Couldn’t build the PDF: ${err.message || err}`);
    }
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggested,
      types: PDF_PICKER_TYPES,
    });
    setStatus('Saving…');
    const bytes = await buildPdfBytes({ doc });
    await writeToHandle(handle, bytes);
    const name = handle.name || suggested;
    aimAt(doc, { name, handle });
    saved(doc);
    setStatus(`Saved ${name} ✓`, 'ok');
  } catch (err) {
    if (err.name === 'AbortError') { setStatus(''); return; }   // user dismissed the panel
    console.error(err);
    failedToBuild(doc, `Couldn’t save: ${err.message || err}`);
  }
}

/** A write that never reached a file, from any of the three paths that
 *  build the bytes themselves. Same two kinds as ⌘S: a locked document
 *  cannot be written by any of them, anything else can be written
 *  somewhere else. */
function failedToBuild(doc, what) {
  const d = fieldsOf(doc);
  if (d.locked) { showSaveAlert(`${d.docName} can’t be saved: it is locked by its author.`, 'locked'); return; }
  noteSaveFailed(doc, true);
  showSaveAlert(what, 'write');
}

/** Save a copy with the markups painted into the pages. In that copy they
 *  are part of the drawing: nobody can move, edit or delete them again,
 *  here or anywhere else. The open document is not touched — it keeps its
 *  markups, its name and its save target — so flattening is never the thing
 *  that loses the editable version. */
export async function saveFlattenedCopy() {
  finishTyping();
  if (!state.pages.length) { setStatus('Nothing to flatten yet.', 'err'); return; }
  const doc = activeDoc();
  // Named after the document, so the two sit together.
  const name = ensurePdfExt(state.docName);
  const suggested = `${name.replace(/\.pdf$/i, '')} - flattened.pdf`;

  if (!canUseFileSystemAccess) {
    setStatus('Building PDF…');
    try {
      downloadBytes(await buildPdfBytes({ flatten: true, doc }), suggested);
      noteSaveFailed(doc, false);
      setStatus('Downloaded a flattened copy ✓', 'ok');
    } catch (err) {
      console.error(err);
      failedToBuild(doc, `Couldn’t build the flattened copy: ${err.message || err}`);
    }
    return;
  }

  try {
    const handle = await window.showSaveFilePicker({ suggestedName: suggested, types: PDF_PICKER_TYPES });
    setStatus('Saving…');
    await writeToHandle(handle, await buildPdfBytes({ flatten: true, doc }));
    noteSaveFailed(doc, false);
    dismissSaveAlert();
    setStatus(`Saved a flattened copy as ${handle.name || suggested} ✓`, 'ok');
  } catch (err) {
    if (err.name === 'AbortError') { setStatus(''); return; }   // user dismissed the panel
    console.error(err);
    failedToBuild(doc, `Couldn’t save the flattened copy: ${err.message || err}`);
  }
}

/** Always-download path, kept as an explicit action so the behaviour is
 *  available even where the File System Access API exists. */
export async function downloadCopy() {
  finishTyping();
  if (!state.pages.length) { setStatus('Nothing to export yet.', 'err'); return; }
  const doc = activeDoc();
  const name = ensurePdfExt(state.docName);
  setStatus('Building PDF…');
  try {
    const bytes = await buildPdfBytes({ doc });
    downloadBytes(bytes, name);
    // One of the two ways out of a failed save, so it has to be a way
    // out: the work is on disk, even if not in the file ⌘S aims at.
    noteSaveFailed(doc, false);
    dismissSaveAlert();
    setStatus('Downloaded a copy ✓', 'ok');
  } catch (err) {
    console.error(err);
    failedToBuild(doc, `Couldn’t build the PDF: ${err.message || err}`);
  }
}
