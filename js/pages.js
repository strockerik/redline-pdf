/* Page assembly: import, blank pages, delete, rotate, reorder. */
import {
  state, normRot, toNative, toVisual, estimateBoxHeight, isPointShape, activeDoc, withDoc,
  setStatus, markDirty, resetDocument, finishTyping, BLANK_SIZES, MOD_KEY, SAVE_PACE,
} from './state.js';
import {
  renderThumbnails, renderMainCanvas, updateThumbSelection,
  invalidateThumb, invalidateAllThumbs, updateTitle, updateToolbarState, sweepSources,
} from './view.js';
import { renderTabs } from './tabs.js';
import { takeMarkups } from './export.js';
import { checkpoint, startFresh } from './history.js';

const { PDFDocument, ParseSpeeds } = PDFLib;

// One Web Worker for every document. pdf.js starts a dedicated worker per
// getDocument() call, and nothing here ever destroys a document — a
// moderate session left 27 worker threads alive. Sharing one costs
// nothing: it is a message pump, and pdf.js multiplexes documents over it.
// Created lazily so importing this module stays side-effect free, and so
// GlobalWorkerOptions.workerSrc (set in main.js) is in place first.
let sharedWorker = null;
function pdfWorker() {
  if (!sharedWorker) sharedWorker = new pdfjsLib.PDFWorker({ name: 'redline' });
  return sharedWorker;
}

// ============================================================
// Import
// ============================================================
/** Load a PDF into `sources` and append its pages to the document.
 *  Returns the id of the first page added, or null on failure.
 *
 *  A file landing in an empty document *is* that document: it takes the
 *  file's name, and `handle` if there is one becomes where ⌘S writes.
 *  Landing among pages that are already there, it is an edit — one that
 *  can be undone — and no handle is adopted, because the result is not
 *  that file any more. */
export async function importPdfBytes(bytes, name, { handle = null, into = activeDoc() } = {}) {
  // `into` is the document the file was opened into. Reading and parsing
  // a drawing set takes seconds, time enough to turn to another tab; the
  // file still belongs where it was asked for, not in whichever document
  // is on screen when it arrives — which used to merge it into that one.
  // A caller that waits before getting here (for the file's bytes) passes
  // the document it had when it began.
  let reading = true;
  try {
    // pdf-lib keeps views into the buffer it parsed; pdf.js transfers (and
    // detaches) the one it is handed. So they can never share one.
    // At its default pace pdf-lib stops every 100 objects to let the page
    // breathe, and each stop is a timer of at least 4 ms: a drawing set of
    // a few thousand objects spent most of its open time waiting. Reading
    // a file is quick work; let it run straight through.
    const pdfLibDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, parseSpeed: ParseSpeeds.Fastest });
    // A file with a PDF header and no document behind it gets this far;
    // asking for its pages is what finds out.
    pdfLibDoc.getPageCount();

    // Markups Redline saved earlier come back as markups. They are taken
    // out of the document first, so pdf.js has to be given the document as
    // it now stands — without them — or it would draw each one underneath
    // its editable self.
    const markups = takeMarkups(pdfLibDoc);
    const forPdfjs = markups.size
      ? await pdfLibDoc.save({ useObjectStreams: false, updateFieldAppearances: false, objectsPerTick: SAVE_PACE })
      : bytes.slice(0);
    const pdfjsDoc = await pdfjsLib.getDocument({ data: forPdfjs, worker: pdfWorker() }).promise;
    reading = false;

    if (into && !state.docs.includes(into)) {
      pdfjsDoc.destroy().catch(() => { /* gone already */ });
      setStatus(`${name} was not opened: its tab was closed while it loaded.`);
      return null;
    }
    if (!into || into === activeDoc()) return land(name, handle, pdfLibDoc, pdfjsDoc, markups, true);
    const first = withDoc(into, () => land(name, handle, pdfLibDoc, pdfjsDoc, markups, false));
    sweepSources();
    renderTabs();
    updateTitle();
    updateToolbarState();
    return first;
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open ${name}: ${reading ? unreadable(err) : err.message || err}`, 'err');
    return null;
  }
}

/** Why a file could not be read, in words for the person who chose it.
 *  The parsers' own messages ("Failed to parse PDF document (line:252
 *  col:1660 offset=634536)", or a TypeError from deep inside pdf-lib)
 *  say nothing they can act on. */
function unreadable(err) {
  if (err && err.name === 'PasswordException') return 'it needs a password, and Redline can’t open password-protected PDFs.';
  if (err instanceof RangeError) return 'there wasn’t enough memory to read it.';
  return 'it isn’t a PDF Redline can read. It may be damaged, or not a PDF at all.';
}

/** The second half of an import, with nothing left to wait for: the
 *  loaded file joins the live document. `shown` is false while that
 *  document is not the one on screen (withDoc), and then nothing is drawn. */
function land(name, handle, pdfLibDoc, pdfjsDoc, markups, shown) {
  // Decided here, after the slow part: only now is it known what the
  // file is landing in.
  const opening = !state.pages.length && !state.sources.length;
  if (!opening) checkpoint(`Add ${name}`);

  const sourceId = state.nextSourceId++;
  state.sources.push({ id: sourceId, name, pdfLibDoc, pdfjsDoc });

  // One encrypted source and the whole document is unsavable: pdf-lib
  // cannot decrypt, so every page written back would be blank, and
  // export refuses before a byte of it exists. The document carries that
  // from here on, so the save chip and the tab can say so rather than
  // leaving ⌘S to find out, and it travels with the sources through undo
  // (history.js). Said in words further down, once the import is over.
  if (pdfLibDoc.isEncrypted) state.locked = true;

  // Merging a file into pages that are already there means the document
  // no longer corresponds to any single file on disk. Keeping the first
  // file's handle here is what used to make ⌘S silently replace *that*
  // file with the merged result — open A then B, hit save, and A is now
  // A+B. Dropping the handle sends save() through saveAs(), so the target
  // is chosen explicitly. Every import path funnels through here, so this
  // covers the picker, drag-and-drop and the Finder handler alike.
  //
  // *Every* merge drops it, not only the first. A Save As in between
  // gives the document a new handle and leaves `combined` set, so the
  // next merge used to keep that handle — and ⌘S would then overwrite
  // the file the save panel had just written with a document that has
  // another file in it now. The name is taken over once only: one the
  // user chose in the save panel is a better suggestion for the next
  // save than "Combined.pdf" again.
  const merged = !opening;
  const firstMerge = merged && !state.combined;
  // Whether ⌘S has just lost its target and will ask where instead.
  const asksWhere = merged && (firstMerge || !!state.fileHandle);
  if (merged) {
    state.combined = true;
    state.fileHandle = null;
    if (firstMerge) state.docName = 'Combined.pdf';
    updateTitle();
  }

  const count = pdfLibDoc.getPageCount();
  let firstNew = null;
  let restored = 0;
  for (let i = 0; i < count; i++) {
    const p = pdfLibDoc.getPage(i);
    const box = visibleBox(p);  // not rotation-adjusted
    const page = {
      id: state.nextPageId++,
      kind: 'imported',
      sourceId,
      sourcePageIndex: i,
      W0: box.width,
      H0: box.height,
      // Where that box starts in the page's own coordinates. Markups are
      // kept relative to the box, as everything on screen is; the file
      // needs them back where the box is (export.js).
      ox: box.x,
      oy: box.y,
      rotation: normRot(p.getRotation().angle),
      annotations: [],
    };
    for (const { markup, R } of markups.get(i) || []) {
      page.annotations.push({ id: state.nextAnnoId++, ...markup });
      // Saved against one rotation, opened at another: something else
      // has turned the page since. Carry the markup round with it.
      if (R !== page.rotation) {
        remapAnnotationsForRotation({ annotations: [page.annotations.at(-1)], W0: page.W0, H0: page.H0 }, R, page.rotation);
      }
      restored++;
    }
    state.pages.push(page);
    if (firstNew === null) firstNew = page.id;
  }

  if (opening) {
    state.docName = name;
    state.fileHandle = handle;
    startFresh();
    // Opening a file is not a change to it.
    markDirty(false);
    updateTitle();
  } else {
    markDirty();
  }
  if (!shown) {
    if (!state.selectedPageId) state.selectedPageId = firstNew;
  } else {
    renderThumbnails();
    if (!state.selectedPageId) selectPage(firstNew);
  }
  // After the import message, not before — otherwise it is overwritten
  // in the same tick and the user never sees why Save changed.
  if (pdfLibDoc.isEncrypted) {
    // Shown, but it can never be saved (export.js): better known now than
    // after an hour of markups.
    setStatus(`${name} is locked by its author. Redline can show it, but can’t save it.`, 'err');
  } else if (asksWhere) {
    // The first merge is the one that renames the document; a later one
    // only takes away the file ⌘S was aimed at — which is the half that
    // has to be said either way.
    const what = !shown ? `${name} was added to another tab`
      : firstMerge ? 'Combined document' : `${name} added`;
    setStatus(`${what} — Save now asks where to put it.`, 'ok');
  } else {
    const notes = restored ? `, ${restored} editable markup${restored === 1 ? '' : 's'}` : '';
    setStatus(`${shown ? 'Imported' : 'Opened in its tab:'} ${name} (${count} page${count === 1 ? '' : 's'}${notes})`, 'ok');
  }
  return firstNew;
}

/** The part of a page that is shown: its CropBox, kept within its
 *  MediaBox — what pdf.js draws and plot.js compiles. Taking the MediaBox
 *  alone, as this once did, laid a page cropped in Preview out at its
 *  uncropped size: the crop was stretched to fill it, and every markup
 *  saved at the wrong place. Nor need a box start at 0,0. */
function visibleBox(p) {
  const norm = (b) => ({ x0: Math.min(b.x, b.x + b.width), y0: Math.min(b.y, b.y + b.height),
    x1: Math.max(b.x, b.x + b.width), y1: Math.max(b.y, b.y + b.height) });
  const m = norm(p.getMediaBox());
  const c = norm(p.getCropBox());
  const x0 = Math.max(m.x0, c.x0), y0 = Math.max(m.y0, c.y0);
  const x1 = Math.min(m.x1, c.x1), y1 = Math.min(m.y1, c.y1);
  // A crop that misses the page altogether is ignored, as pdf.js does.
  if (!(x1 > x0 && y1 > y0)) return { x: m.x0, y: m.y0, width: m.x1 - m.x0, height: m.y1 - m.y0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export async function importPdfFile(file, { into = activeDoc() } = {}) {
  const buf = await file.arrayBuffer();
  return importPdfBytes(buf, file.name, { into });
}

// ============================================================
// Blank pages
// ============================================================
export function addBlankPage(sizeKey) {
  const dims = BLANK_SIZES[sizeKey] || BLANK_SIZES.Letter;
  const page = {
    id: state.nextPageId++,
    kind: 'blank',
    W0: dims[0],
    H0: dims[1],
    rotation: 0,
    annotations: [],
  };

  let idx = state.pages.length;
  if (state.selectedPageId) {
    const cur = state.pages.findIndex((p) => p.id === state.selectedPageId);
    if (cur >= 0) idx = cur + 1;
  }
  checkpoint('Add blank page');
  state.pages.splice(idx, 0, page);

  markDirty();
  renderThumbnails();
  selectPage(page.id);
}

// ============================================================
// Delete / rotate / reorder
// ============================================================
export function deletePage(pageId) {
  const idx = state.pages.findIndex((p) => p.id === pageId);
  if (idx < 0) return;

  // No "are you sure?": undo is the way back, and says so.
  checkpoint('Delete page');
  invalidateThumb(pageId);
  state.pages.splice(idx, 1);
  markDirty();
  setStatus(`Deleted page ${idx + 1} — ${MOD_KEY}Z brings it back.`, 'ok');

  if (state.selectedPageId === pageId) {
    const next = state.pages[idx] || state.pages[idx - 1] || null;
    state.selectedPageId = next ? next.id : null;
    state.selectedAnnoId = null;
  }
  renderThumbnails();
  renderMainCanvas();
}

/** Move a page's annotations so they stay with the content when the
 *  page is rotated, instead of jumping.
 *
 *  Each anchor goes through native space — toNative at the old rotation,
 *  toVisual at the new one — because native space is the only frame
 *  that doesn't move when /Rotate changes. Width is unchanged; height
 *  re-derives from the wrapped text at the same width.
 *
 *  Exported for testing: rotating four times must be the identity.
 */
export function remapAnnotationsForRotation(page, oldR, newR) {
  // Not just an optimization: the center round-trip adds then subtracts
  // h/2, which is not bit-exact in floating point. Skipping it keeps a
  // no-op rotation genuinely lossless.
  if (normRot(oldR) === normRot(newR)) return;

  for (const a of page.annotations) {
    // A point shape has no box — remap the points themselves and move on.
    if (isPointShape(a)) {
      for (const p of a.points) {
        const n = toNative(oldR, page.W0, page.H0, p.x, p.y);
        const v = toVisual(newR, page.W0, page.H0, n.x, n.y);
        p.x = v.x;
        p.y = v.y;
      }
      continue;
    }
    const h = estimateBoxHeight(a);
    const cx = a.x + a.width / 2, cy = a.y + h / 2;
    const nat = toNative(oldR, page.W0, page.H0, cx, cy);
    const nc = toVisual(newR, page.W0, page.H0, nat.x, nat.y);
    a.x = nc.x - a.width / 2;
    a.y = nc.y - h / 2;
    if (a.type === 'callout') {
      const tn = toNative(oldR, page.W0, page.H0, a.tipX, a.tipY);
      const tv = toVisual(newR, page.W0, page.H0, tn.x, tn.y);
      a.tipX = tv.x;
      a.tipY = tv.y;
    }
  }
}

export function rotatePage(pageId, delta) {
  const page = state.pages.find((p) => p.id === pageId);
  if (!page) return;

  const oldR = page.rotation;
  const newR = normRot(oldR + delta);

  checkpoint('Rotate page');
  remapAnnotationsForRotation(page, oldR, newR);
  page.rotation = newR;
  invalidateThumb(pageId);
  markDirty();
  renderThumbnails();
  if (state.selectedPageId === pageId) renderMainCanvas();
}

/** Move `movedId` to sit before or after `targetId`. */
export function reorderPage(movedId, targetId, before) {
  if (movedId === targetId) return;
  const fromIdx = state.pages.findIndex((p) => p.id === movedId);
  if (fromIdx < 0) return;

  checkpoint('Move page');
  const [moved] = state.pages.splice(fromIdx, 1);
  let toIdx = state.pages.findIndex((p) => p.id === targetId);
  if (toIdx < 0) toIdx = state.pages.length;
  else if (!before) toIdx += 1;

  state.pages.splice(toIdx, 0, moved);
  markDirty();
  renderThumbnails();
}

// ============================================================
// Selection
// ============================================================
/** Resolves once the page has been drawn and its markups are in the DOM. */
export function selectPage(pageId) {
  if (pageId !== state.selectedPageId) finishTyping();
  state.selectedPageId = pageId;
  state.selectedAnnoId = null;
  state.pendingCalloutTip = null;
  updateThumbSelection();
  return renderMainCanvas();
}

/** Previous or next page — the arrow keys, the wheel, and the buttons
 *  either side of the page field. False at either end. */
export function stepPage(dir) {
  const idx = state.pages.findIndex((p) => p.id === state.selectedPageId);
  if (idx < 0) return false;
  const next = state.pages[idx + dir];
  if (!next) return false;
  selectPage(next.id);
  return true;
}

/** Empty this document. Like everything else, it can be undone. */
export function clearAll() {
  if (!state.pages.length) return false;
  checkpoint('Clear all');
  resetDocument();
  invalidateAllThumbs();
  setStatus(`Cleared — ${MOD_KEY}Z brings it back.`, 'ok');
  return true;
}
