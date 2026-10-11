/* Undo and redo: one stack per document, every action on it.
 *
 * A checkpoint is the whole editable shape of the document — its page
 * order, each page's rotation and markups, its sources and its identity —
 * taken *before* something changes. Undo puts a checkpoint back. That is
 * coarser than recording individual edits and far harder to get wrong:
 * there is no inverse to write for each new tool, and nothing a checkpoint
 * can forget to include.
 *
 * Page objects are kept, not copied. Thumbnails and the GPU plots are
 * cached against a page's identity, and a 200-sheet set must not re-render
 * every thumbnail because one note was un-moved.
 *
 * No DOM here. The caller re-renders after undo() or redo().
 */
import { state, activeDoc, markDirty } from './state.js';

const LIMIT = 200;
const stacks = new WeakMap();        // document record -> its history

function history(doc = activeDoc()) {
  if (!doc) return null;
  let h = stacks.get(doc);
  if (!h) stacks.set(doc, h = { undo: [], redo: [], sinceSave: 0, adrift: false, savedAt: null });
  return h;
}

const copyMarkups = (list) => list.map((a) => (a.points
  ? { ...a, points: a.points.map((p) => ({ x: p.x, y: p.y })) }
  : { ...a }));

function capture() {
  return {
    pages: state.pages.map((page) => ({ page, rotation: page.rotation, annotations: copyMarkups(page.annotations) })),
    sources: state.sources.slice(),
    selectedPageId: state.selectedPageId,
    docName: state.docName,
    fileHandle: state.fileHandle,
    combined: state.combined,
  };
}

function restore(snap) {
  state.pages = snap.pages.map((e) => {
    e.page.rotation = e.rotation;
    // Copied again on the way out: the checkpoint has to survive being
    // restored, edited, and restored a second time by redo.
    e.page.annotations = copyMarkups(e.annotations);
    return e.page;
  });
  state.sources = snap.sources.slice();
  state.docName = snap.docName;
  state.fileHandle = snap.fileHandle;
  state.combined = snap.combined;
  state.selectedAnnoId = null;
  state.pendingCalloutTip = null;
  // Go to where the change was made: undoing something on a page that is
  // not showing would otherwise look like nothing happened.
  const has = (id) => state.pages.some((p) => p.id === id);
  state.selectedPageId = has(snap.selectedPageId) ? snap.selectedPageId
    : has(state.selectedPageId) ? state.selectedPageId
    : (state.pages[0] ? state.pages[0].id : null);
}

/** Call *before* changing the document. `label` is what Undo will say. */
export function checkpoint(label) {
  commit(hold(), label);
}

/** Take a checkpoint without committing to it — for an action that may
 *  turn out to change nothing, like opening a note for editing. It
 *  remembers which document it was taken of, so that committing it later
 *  can never put one document's pages on another's stack. */
export function hold() {
  return { doc: activeDoc(), snap: capture() };
}

export function commit(held, label) {
  if (!held) return;
  const h = history(held.doc);
  if (!h) return;
  h.undo.push({ label, snap: held.snap });
  if (h.undo.length > LIMIT) h.undo.shift();
  // Undo past the save, then do something else: the saved state was on the
  // redo side, and that side has just been thrown away. No amount of
  // undoing reaches it again, so the count must never come back to zero.
  if (h.sinceSave < 0) { h.adrift = true; h.sinceSave = -h.sinceSave; }
  h.redo.length = 0;
  h.sinceSave++;
}

/** Drop the most recent checkpoint: the action it guarded was abandoned
 *  (a note placed and left empty), so there is nothing to step back over. */
export function discardLast() {
  const h = history();
  if (!h || !h.undo.length) return;
  h.undo.pop();
  h.sinceSave--;
  markDirty(h.adrift || h.sinceSave !== 0);
}

function step(from, to, delta) {
  const h = history();
  if (!h || !h[from].length) return null;
  const entry = h[from].pop();
  h[to].push({ label: entry.label, snap: capture() });
  restore(entry.snap);
  h.sinceSave += delta;
  // Stepping back to exactly what is on disk is not unsaved work.
  markDirty(h.adrift || h.sinceSave !== 0);
  return entry.label;
}

/** Returns the label of what was undone, or null if there was nothing. */
export const undo = () => step('undo', 'redo', -1);
export const redo = () => step('redo', 'undo', 1);

/** The document on screen now matches a file on disk — it was just
 *  opened from one, or just written to one. */
export function noteClean({ saved = false } = {}) {
  const h = history();
  if (!h) return;
  h.sinceSave = 0;
  h.adrift = false;
  if (saved) h.savedAt = Date.now();
}

/** A file has just become this document. There is nothing before that to
 *  step back to. */
export function startFresh() {
  const doc = activeDoc();
  if (doc) stacks.set(doc, { undo: [], redo: [], sinceSave: 0, adrift: false, savedAt: null });
}

export function historyStatus() {
  const h = history();
  if (!h) return { canUndo: false, canRedo: false, undoLabel: '', redoLabel: '', changes: 0, savedAt: null };
  return {
    canUndo: h.undo.length > 0,
    canRedo: h.redo.length > 0,
    undoLabel: h.undo.length ? h.undo[h.undo.length - 1].label : '',
    redoLabel: h.redo.length ? h.redo[h.redo.length - 1].label : '',
    changes: Math.abs(h.sinceSave) || (h.adrift ? 1 : 0),
    savedAt: h.savedAt,
  };
}
