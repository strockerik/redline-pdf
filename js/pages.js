/* Page assembly: import, blank pages, delete, rotate, reorder. */
import {
  state, normRot, toNative, toVisual, estimateBoxHeight,
  setStatus, markDirty, BLANK_SIZES,
} from './state.js';
import {
  renderThumbnails, renderMainCanvas, updateThumbSelection,
  invalidateThumb, invalidateAllThumbs,
} from './view.js';

const { PDFDocument } = PDFLib;

// ============================================================
// Import
// ============================================================
/** Load a PDF into `sources` and append its pages to the document.
 *  Returns the id of the first page added, or null on failure. */
export async function importPdfBytes(bytes, name) {
  try {
    // pdf.js transfers (and detaches) the buffer it is handed, so every
    // consumer — including a future session restore — needs its own copy.
    const pdfLibDoc = await PDFDocument.load(bytes.slice(0), { ignoreEncryption: true });
    const pdfjsDoc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;

    const sourceId = state.nextSourceId++;
    state.sources.push({ id: sourceId, name, bytes, pdfLibDoc, pdfjsDoc });

    const count = pdfLibDoc.getPageCount();
    let firstNew = null;
    for (let i = 0; i < count; i++) {
      const p = pdfLibDoc.getPage(i);
      const size = p.getSize();   // raw MediaBox — not rotation-adjusted
      const page = {
        id: state.nextPageId++,
        kind: 'imported',
        sourceId,
        sourcePageIndex: i,
        W0: size.width,
        H0: size.height,
        rotation: normRot(p.getRotation().angle),
        annotations: [],
      };
      state.pages.push(page);
      if (firstNew === null) firstNew = page.id;
    }

    markDirty();
    renderThumbnails();
    if (!state.selectedPageId) selectPage(firstNew);
    setStatus(`Imported ${name} (${count} page${count === 1 ? '' : 's'})`, 'ok');
    return firstNew;
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't open ${name}: ${err.message || err}`, 'err');
    return null;
  }
}

export async function importPdfFile(file) {
  const buf = await file.arrayBuffer();
  return importPdfBytes(buf, file.name);
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
  if (!confirm('Delete this page? This cannot be undone.')) return;

  state.pages.splice(idx, 1);
  invalidateThumb(pageId);
  markDirty();

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
export function selectPage(pageId) {
  state.selectedPageId = pageId;
  state.selectedAnnoId = null;
  state.pendingCalloutTip = null;
  updateThumbSelection();
  renderMainCanvas();
}

export function clearAll() {
  if (!state.pages.length) return;
  if (!confirm('Remove all pages and start over? This cannot be undone.')) return false;
  invalidateAllThumbs();
  return true;
}
