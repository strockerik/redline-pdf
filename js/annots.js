/* Markups: the DOM overlay, the pointer interactions, and the tools.
 *
 * Two families (see state.js). A *note* — text box or callout — is a DOM
 * box you type into. A *point shape* — pen, highlight, arrow, box, cloud —
 * is an SVG path stroked from shapePolylines(), the same lines the
 * exporter draws.
 *
 * All geometry here is plain visual-space 2D math (origin top-left, y
 * down). Conversion to the PDF's native content space happens once, at
 * export time — see export.js and guide §3.
 *
 * A tool is used once. Picking one arms it for a single markup; placing
 * that markup puts the tool back to Select.
 *
 * Every change to a markup is preceded by a history checkpoint, taken on
 * the first movement of a drag rather than on the press, so a click that
 * changes nothing leaves nothing to undo.
 */
import {
  state, markDirty, computeLeader, computeArrowWings, shapePolylines,
  isPointShape, sizeForType, TOOL_TYPE,
  ANNO_PAD, LINE_HEIGHT_MULT, DEFAULT_BOX_WIDTH, PEN_MIN_POINT_DIST, HIGHLIGHT_OPACITY,
} from './state.js';
import { updateThumbBadge, updateToolbarState } from './view.js';
import { checkpoint, hold, commit, discardLast } from './history.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

const FREEHAND = new Set(['pen', 'highlight']);
const TWO_POINT = new Set(['arrow', 'rect', 'cloud']);
const isDrawingTool = (t) => FREEHAND.has(t) || TWO_POINT.has(t);
const MIN_NOTE_WIDTH = 40;      // pt
const DRAG_SLOP = 4;            // px of movement before a press counts as a drag

const currentPage = () => state.pages.find((p) => p.id === state.selectedPageId);

/** Where a pointer event is on the page, in pt. The rect is read every
 *  time: the stage can scroll mid-gesture, and one captured at the start
 *  would silently drift. */
function pointAt(ev) {
  const rect = $('pageCanvas').getBoundingClientRect();
  const scale = state.currentScale;
  return { x: (ev.clientX - rect.left) / scale, y: (ev.clientY - rect.top) / scale };
}

const colourFor = (type) => (type === 'highlight' ? state.currentHighlightColor : state.currentColor);

// ============================================================
// Layer
// ============================================================
export function renderAnnotationLayer(page) {
  const overlay = $('annoLayer');
  clearCalloutPreview();
  overlay.querySelectorAll('.anno-box').forEach((n) => n.remove());
  $('leaderSvg').replaceChildren();
  $('hiliteSvg').replaceChildren();
  state.domRefs = {};
  for (const a of page.annotations) {
    if (isPointShape(a)) buildShapeDom(page, a); else buildNoteDom(page, a);
  }
}

// ============================================================
// Notes
// ============================================================
function buildNoteDom(page, a) {
  const overlay = $('annoLayer');
  const svg = $('leaderSvg');
  const scale = state.currentScale;

  const box = document.createElement('div');
  box.className = 'anno-box' + (a.id === state.selectedAnnoId ? ' selected' : '')
    + (a.fill === false ? ' no-fill' : '') + (a.fit ? ' fit' : '');
  box.style.left = (a.x * scale) + 'px';
  box.style.top = (a.y * scale) + 'px';
  // One that shrinks to its text is given no width: the text sets it.
  if (!a.fit) box.style.width = (a.width * scale) + 'px';
  box.style.borderColor = a.color;

  const text = document.createElement('div');
  text.className = 'anno-text' + ((a.text || '').length === 0 ? ' placeholder' : '');
  text.contentEditable = 'true';
  text.spellcheck = false;
  text.style.fontSize = (a.fontSize * scale) + 'px';
  text.style.lineHeight = LINE_HEIGHT_MULT;
  text.style.color = a.color;
  text.style.padding = (ANNO_PAD * scale) + 'px';
  text.textContent = a.text || '';
  box.appendChild(text);

  const resize = document.createElement('div');
  resize.className = 'anno-resize';
  box.appendChild(resize);

  const del = document.createElement('div');
  del.className = 'anno-del';
  del.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">'
    + '<path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"></path></svg>';
  del.title = 'Delete note';
  box.appendChild(del);

  overlay.appendChild(box);

  let lineEl = null, wing1 = null, wing2 = null, jogEl = null, tipHandle = null;
  if (a.type === 'callout') {
    lineEl = document.createElementNS(SVG_NS, 'line');
    wing1 = document.createElementNS(SVG_NS, 'line');
    wing2 = document.createElementNS(SVG_NS, 'line');
    jogEl = document.createElementNS(SVG_NS, 'line');
    for (const l of [lineEl, wing1, wing2, jogEl]) {
      l.setAttribute('stroke', a.color);
      l.setAttribute('stroke-width', '1.6');
      l.setAttribute('stroke-linecap', 'round');
      svg.appendChild(l);
    }
    tipHandle = document.createElementNS(SVG_NS, 'circle');
    tipHandle.setAttribute('r', '7');
    tipHandle.setAttribute('fill', a.color);
    tipHandle.setAttribute('class', 'tip-handle');
    tipHandle.style.display = (a.id === state.selectedAnnoId) ? '' : 'none';
    svg.appendChild(tipHandle);
  }

  state.domRefs[a.id] = { boxEl: box, textEl: text, lineEl, wing1, wing2, jogEl, tipHandle };
  syncFit(a, box);
  updateLeaderVisual(page, a);

  wireNoteInteractions(page, a, { box, text, resize, del, tipHandle });
}

/** A note that shrinks to its text has no width of its own: the browser
 *  lays it out, and the model follows — so a leader knows where the box's
 *  edge is, and a later resize starts from what is on screen. Derived, so
 *  it is not a change to undo or to save. */
function syncFit(a, box) {
  if (a.fit && box.offsetWidth) a.width = box.offsetWidth / state.currentScale;
}

// Notes placed and not yet typed into. Placing one and typing its first
// words is one action to undo, not two; and one abandoned empty is none.
// Held by object, not by id: ids restart in every document, and a note
// that undo has put back is a different object from the one first placed.
const fresh = new WeakSet();

function wireNoteInteractions(page, a, els) {
  const { box, text, resize, del, tipHandle } = els;
  let held = null;       // the document as it was when editing began

  const selectThis = () => {
    if (state.selectedAnnoId === a.id) return;
    const hadShape = !!state.domRefs[state.selectedAnnoId]?.inkEl;
    state.selectedAnnoId = a.id;
    if (hadShape) { renderAnnotationLayer(page); updateToolbarState(); return; }
    document.querySelectorAll('.anno-box').forEach((n) => n.classList.remove('selected'));
    box.classList.add('selected');
    document.querySelectorAll('.tip-handle').forEach((n) => { n.style.display = 'none'; });
    if (tipHandle) tipHandle.style.display = '';
    updateToolbarState();
  };

  const enterEditing = () => {
    box.classList.add('editing');
    text.focus();
    placeCaretAtEnd(text);
  };

  box.addEventListener('pointerdown', (e) => {
    if (e.target === resize || e.target === del) return;
    if (box.classList.contains('editing')) return;   // let text editing have the event

    // A press always begins a potential drag; what it *meant* is only
    // known on release. Releasing without moving, on a box that was
    // already selected, means "edit" — the touch-workable equivalent of
    // a double-click. Deciding on pointerup rather than pointerdown is
    // what keeps dragging an already-selected box working.
    const wasSelected = state.selectedAnnoId === a.id;
    e.preventDefault();
    selectThis();
    // selectThis may have rebuilt the layer; this box is then gone and the
    // press simply selects.
    if (!box.isConnected) return;
    startDragMove(e, page, a, box, (moved) => {
      if (!moved && wasSelected) enterEditing();
    });
  });

  // Keep the desktop double-click working as a shortcut into editing.
  text.addEventListener('dblclick', (e) => { e.stopPropagation(); enterEditing(); });

  text.addEventListener('focus', () => { held = fresh.has(a) ? null : hold(); });

  text.addEventListener('blur', () => {
    box.classList.remove('editing');
    // Undo, or anything else that rebuilt the document while this note
    // had focus, has left this handler holding a note that is gone.
    if (!page.annotations.includes(a)) return;
    const before = a.text || '';
    const typed = text.innerText.replace(/\n+$/, '');
    const wasFresh = fresh.delete(a);
    const was = held;
    held = null;

    if (typed.trim().length === 0) {
      if (wasFresh) {
        // Placed and abandoned: take it away, and the step that added it.
        removeMarkup(page, a.id);
        discardLast();
      } else {
        deleteAnnotation(page, a.id);
      }
      return;
    }
    a.text = typed;
    text.classList.remove('placeholder');
    // "Shrink to text" is a standing instruction, not a property a note
    // had to be born with: while it is on, any note that is typed into
    // and finished — by ⌘Return, Esc or a click away — is pulled in to
    // its text. Otherwise a note placed before the box was ticked, or one
    // from a file saved earlier, would sit there at its old width looking
    // as though the option did nothing. (Part of the same undo step as the
    // typing, which was checkpointed before either.)
    if (state.currentFit && !a.fit && typed !== before) {
      a.fit = true;
      box.classList.add('fit');
      box.style.width = '';
    }
    syncFit(a, box);
    if (typed !== before) {
      if (!wasFresh && was) commit(was, 'Edit note');
      markDirty();
    }
    updateLeaderVisual(page, a);
    updateThumbBadge(page);
  });

  text.addEventListener('input', () => {
    text.classList.toggle('placeholder', text.innerText.trim().length === 0);
    syncFit(a, box);
    updateLeaderVisual(page, a);
    // The text itself is still only taken on blur, but the document is
    // unsaved from the first keystroke that changes it. Left to blur, an
    // edit to a note on a clean document was work the save chip did not
    // count and beforeunload did not guard — and closing the window while
    // the caret was still in the box took it with no warning at all.
    if (!state.dirty && text.innerText.replace(/\n+$/, '') !== (a.text || '')) markDirty();
  });

  // ⌘Return finishes the note from the keyboard, without reaching for
  // the mouse, and puts it down altogether: its text is kept and it is
  // deselected, handles and all — what a click on bare page does. Return
  // alone is a new line.
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      text.blur();
      deselectAnnotation();
    }
  });

  // Notes are plain text; pasted markup can't survive the export path.
  text.addEventListener('paste', (e) => {
    e.preventDefault();
    const plain = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, plain);
  });

  resize.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectThis();
    if (box.isConnected) startResize(e, page, a, box);
  });

  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteAnnotation(page, a.id); });

  if (tipHandle) {
    tipHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectThis();
      if (tipHandle.isConnected) startTipDrag(e, page, a);
    });
  }
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ---- drag / resize / tip-drag ----
function startDragMove(e, page, a, boxEl, onDone) {
  const startX = e.clientX, startY = e.clientY;
  const origX = a.x, origY = a.y;
  const scale = state.currentScale;
  let moved = false;
  boxEl.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!moved) checkpoint('Move note');
    moved = true;
    a.x = origX + dx / scale;
    a.y = origY + dy / scale;
    boxEl.style.left = (a.x * scale) + 'px';
    boxEl.style.top = (a.y * scale) + 'px';
    updateLeaderVisual(page, a);
  };
  const onUp = (ev) => {
    boxEl.removeEventListener('pointermove', onMove);
    boxEl.removeEventListener('pointerup', onUp);
    boxEl.removeEventListener('pointercancel', onUp);
    try { boxEl.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (moved) markDirty();
    if (onDone) onDone(moved);
  };
  boxEl.addEventListener('pointermove', onMove);
  boxEl.addEventListener('pointerup', onUp);
  boxEl.addEventListener('pointercancel', onUp);
}

function startResize(e, page, a, boxEl) {
  const startX = e.clientX;
  const origW = a.width;
  const scale = state.currentScale;
  const handle = e.currentTarget;
  let moved = false;
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    // Brushing the handle is not a resize: no step to undo, no unsaved change.
    if (!moved && Math.abs(ev.clientX - startX) < DRAG_SLOP) return;
    if (!moved) checkpoint('Resize note');
    moved = true;
    // Dragging the edge is choosing a width, which is the opposite of
    // letting the text choose it.
    if (a.fit) { a.fit = false; boxEl.classList.remove('fit'); }
    a.width = Math.max(MIN_NOTE_WIDTH, origW + (ev.clientX - startX) / scale);
    boxEl.style.width = (a.width * scale) + 'px';
    updateLeaderVisual(page, a);
  };
  const onUp = (ev) => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    try { handle.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (moved) { markDirty(); updateToolbarState(); }
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

function startTipDrag(e, page, a) {
  const handle = e.currentTarget;
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_SLOP) return;
    if (!moved) checkpoint('Move leader');
    moved = true;
    const p = pointAt(ev);
    a.tipX = p.x;
    a.tipY = p.y;
    updateLeaderVisual(page, a);
  };
  const onUp = (ev) => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    try { handle.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (moved) markDirty();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

function updateLeaderVisual(page, a) {
  const refs = state.domRefs[a.id];
  if (!refs || a.type !== 'callout' || !refs.lineEl) return;

  const scale = state.currentScale;
  // Height is content-driven, so read it off the live DOM rather than
  // re-deriving it from a word-wrap estimate.
  const hPx = refs.boxEl.offsetHeight
    || (a.fontSize * LINE_HEIGHT_MULT + ANNO_PAD * 2) * scale;
  const { attach, knee, tip } = computeLeader(a, hPx / scale);

  refs.jogEl.setAttribute('x1', attach.x * scale);
  refs.jogEl.setAttribute('y1', attach.y * scale);
  refs.jogEl.setAttribute('x2', knee.x * scale);
  refs.jogEl.setAttribute('y2', knee.y * scale);

  refs.lineEl.setAttribute('x1', knee.x * scale);
  refs.lineEl.setAttribute('y1', knee.y * scale);
  refs.lineEl.setAttribute('x2', tip.x * scale);
  refs.lineEl.setAttribute('y2', tip.y * scale);

  // The head points along the last leg, from the knee.
  const [w1, w2] = computeArrowWings(knee, tip);
  refs.wing1.setAttribute('x1', tip.x * scale);
  refs.wing1.setAttribute('y1', tip.y * scale);
  refs.wing1.setAttribute('x2', w1.x * scale);
  refs.wing1.setAttribute('y2', w1.y * scale);
  refs.wing2.setAttribute('x1', tip.x * scale);
  refs.wing2.setAttribute('y1', tip.y * scale);
  refs.wing2.setAttribute('x2', w2.x * scale);
  refs.wing2.setAttribute('y2', w2.y * scale);

  if (refs.tipHandle) {
    refs.tipHandle.setAttribute('cx', tip.x * scale);
    refs.tipHandle.setAttribute('cy', tip.y * scale);
  }
}

// ============================================================
// Point shapes
// ============================================================
function pathData(a, scale) {
  let d = '';
  for (const line of shapePolylines(a)) {
    line.forEach((p, i) => { d += `${i ? 'L' : 'M'}${(p.x * scale).toFixed(2)},${(p.y * scale).toFixed(2)} `; });
  }
  return d;
}

function makePath(a, scale, role) {
  const el = document.createElementNS(SVG_NS, 'path');
  el.setAttribute('d', pathData(a, scale));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  const w = a.size * scale;
  if (role === 'halo') {
    el.setAttribute('stroke', a.color);
    el.setAttribute('stroke-width', a.type === 'highlight' ? w + 8 : w * 3);
    el.setAttribute('stroke-opacity', '0.28');
    el.setAttribute('class', 'ink-halo');
  } else if (role === 'hit') {
    // A fine line is a miserable thing to hit with a finger. This is the
    // same path, invisible, and never narrower than a fingertip is kind.
    el.setAttribute('stroke', 'transparent');
    el.setAttribute('stroke-width', Math.max(w, 14));
    el.setAttribute('class', 'ink-hit');
  } else {
    el.setAttribute('stroke', a.color);
    el.setAttribute('stroke-width', w);
    if (a.type === 'highlight') el.setAttribute('stroke-opacity', String(HIGHLIGHT_OPACITY));
    el.setAttribute('class', 'ink-stroke');
  }
  return el;
}

function buildShapeDom(page, a) {
  const svg = $('leaderSvg');
  const scale = state.currentScale;
  const selected = a.id === state.selectedAnnoId;

  // The halo goes underneath, so selection reads without altering the
  // stroke the user actually drew.
  const halo = selected ? makePath(a, scale, 'halo') : null;
  if (halo) svg.appendChild(halo);

  const line = makePath(a, scale, 'stroke');
  // A highlighter multiplies with the sheet instead of covering it, which
  // takes a layer of its own (see #hiliteSvg in app.css).
  (a.type === 'highlight' ? $('hiliteSvg') : svg).appendChild(line);

  const hit = makePath(a, scale, 'hit');
  if (selected) hit.classList.add('selected');
  svg.appendChild(hit);

  // An arrow, a box and a cloud are two points; show both so either can
  // be dragged.
  const handles = [];
  if (selected && a.type !== 'ink' && a.type !== 'highlight') {
    [0, a.points.length - 1].forEach((idx) => {
      const h = document.createElementNS(SVG_NS, 'circle');
      h.setAttribute('r', '6');
      h.setAttribute('cx', a.points[idx].x * scale);
      h.setAttribute('cy', a.points[idx].y * scale);
      h.setAttribute('fill', '#ffffff');
      h.setAttribute('stroke', a.color);
      h.setAttribute('stroke-width', '2');
      h.setAttribute('class', 'pt-handle');
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        startPointDrag(e, page, a, idx);
      });
      svg.appendChild(h);
      handles.push(h);
    });
  }

  state.domRefs[a.id] = { inkEl: line, haloEl: halo, hitEl: hit, handles };

  for (const el of [line, hit]) {
    el.addEventListener('pointerdown', (e) => {
      if (isDrawingTool(state.activeTool)) return;   // drawing wins over selecting
      if (e.button !== 0) return;
      e.stopPropagation();
      // A finger on an unselected shape may be the start of a scroll, so
      // it only selects; the drag belongs to the touch after that.
      const canDrag = e.pointerType !== 'touch' || state.selectedAnnoId === a.id;
      selectShape(page, a);
      if (canDrag) startShapeDrag(e, page, a);
    });
  }
}

function selectShape(page, a) {
  if (state.selectedAnnoId === a.id) return;
  state.selectedAnnoId = a.id;
  renderAnnotationLayer(page);
  updateToolbarState();
}

/** Redraw one shape in place — what a drag does on every move. */
function refreshShape(a) {
  const refs = state.domRefs[a.id];
  if (!refs || !refs.inkEl) return;
  const scale = state.currentScale;
  const d = pathData(a, scale);
  for (const el of [refs.inkEl, refs.haloEl, refs.hitEl]) if (el) el.setAttribute('d', d);
  (refs.handles || []).forEach((h, k) => {
    const p = a.points[k ? a.points.length - 1 : 0];
    h.setAttribute('cx', p.x * scale);
    h.setAttribute('cy', p.y * scale);
  });
}

/** Follow a pointer from press to release on the window. Shapes rebuild
 *  their own elements when selected, so capture on the element pressed
 *  would be lost with it. `onMove(dx, dy, ev)` is in pt and only called
 *  once the press has become a drag. */
function trackDrag(e, onMove, onDone) {
  const id = e.pointerId;
  const startX = e.clientX, startY = e.clientY;
  let moved = false;
  const move = (ev) => {
    if (ev.pointerId !== id) return;
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    const first = !moved;
    moved = true;
    ev.preventDefault();                 // no text selection mid-drag
    onMove(dx / state.currentScale, dy / state.currentScale, ev, first);
  };
  const up = (ev) => {
    if (ev.pointerId !== id) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (onDone) onDone(moved, ev);
  };
  window.addEventListener('pointermove', move, { passive: false });
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function startShapeDrag(e, page, a) {
  const orig = a.points.map((p) => ({ x: p.x, y: p.y }));
  trackDrag(e, (dx, dy, ev, first) => {
    if (first) checkpoint('Move markup');
    a.points.forEach((p, i) => { p.x = orig[i].x + dx; p.y = orig[i].y + dy; });
    refreshShape(a);
  }, (moved) => {
    if (moved) { markDirty(); swallowClick = true; }
  });
}

function startPointDrag(e, page, a, idx) {
  trackDrag(e, (dx, dy, ev, first) => {
    if (first) checkpoint('Reshape markup');
    const p = pointAt(ev);
    a.points[idx].x = p.x;
    a.points[idx].y = p.y;
    refreshShape(a);
  }, (moved) => {
    if (moved) { markDirty(); swallowClick = true; }
  });
}

// ============================================================
// Drawing
// ============================================================
// Set when a gesture has already done what the click that ends it would
// do. A flag, not a one-shot listener: a gesture ended by pointercancel
// never produces that click, and a listener would sit armed for the next.
let swallowClick = false;
// Whether a note was being typed into when the current press began. That
// press only finishes the note; it is not also a request for another one.
let wasEditing = false;

/** Every tool that is drawn rather than tapped: the pen and highlighter
 *  (a freehand path), the arrow, box and cloud (a drag from one point to
 *  another), and the text box when it is dragged out to a width. Points
 *  are captured in visual-space pt, exactly like every other markup. */
export function installDrawing() {
  const layer = $('annoLayer');
  let live = null;        // { a, el, pointerId, freehand }

  layer.addEventListener('pointerdown', (e) => {
    swallowClick = false;
    wasEditing = !!document.querySelector('.anno-box.editing');
    const tool = state.activeTool;
    // A right- or middle-click would otherwise commit a permanent mark on
    // the way to the context menu.
    if (e.button !== 0) return;
    // Space means "pan", even mid-drawing. Returning before the
    // stopPropagation below is what lets the stage see this press.
    if (state.spaceHeld) return;
    if (e.target.closest('.anno-box')) return;
    const page = currentPage();
    if (!page) return;

    if (tool === 'text') { beginNoteDrag(e, page); return; }
    if (!isDrawingTool(tool)) return;

    e.preventDefault();
    e.stopPropagation();
    const type = TOOL_TYPE[tool];
    const p = pointAt(e);
    const a = {
      id: state.nextAnnoId++, type,
      color: colourFor(type),
      size: sizeForType(type, state.currentPenSize),
      points: FREEHAND.has(tool) ? [p] : [p, { ...p }],
    };
    const el = makePath(a, state.currentScale, 'stroke');
    (type === 'highlight' ? $('hiliteSvg') : $('leaderSvg')).appendChild(el);
    live = { a, el, pointerId: e.pointerId, freehand: FREEHAND.has(tool) };
    try { layer.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });

  layer.addEventListener('pointermove', (e) => {
    // Between a callout's two clicks, show what a click here would make.
    // (A finger does not hover, so there the tip alone stays marked.)
    if (!live && state.pendingCalloutTip && e.pointerType !== 'touch') showCalloutPreview(pointAt(e));
    if (!live || e.pointerId !== live.pointerId) return;
    e.preventDefault();
    const p = pointAt(e);
    const pts = live.a.points;
    if (live.freehand) {
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < PEN_MIN_POINT_DIST) return;
      pts.push(p);
    } else {
      pts[1] = p;
    }
    live.el.setAttribute('d', pathData(live.a, state.currentScale));
  });

  const finish = (e) => {
    if (!live || e.pointerId !== live.pointerId) return;
    try { layer.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const { a, el, freehand } = live;
    live = null;
    el.remove();
    const page = currentPage();
    if (!page) return;

    if (freehand) {
      // A tap is a dot: duplicate the point so every stroke has a segment.
      if (a.points.length === 1) a.points.push({ ...a.points[0] });
    } else if (Math.hypot(a.points[1].x - a.points[0].x, a.points[1].y - a.points[0].y) < 3) {
      return;        // a click with a two-point tool draws nothing
    }
    checkpoint('Add ' + ({ ink: 'pen stroke', highlight: 'highlight', arrow: 'arrow', rect: 'box', cloud: 'cloud' })[a.type]);
    page.annotations.push(a);
    markDirty();
    // One pick of a tool, one markup. The tool goes back, and what was
    // just drawn is left selected — ready to be restyled, nudged or
    // deleted without having to find its line again.
    state.selectedAnnoId = a.id;
    renderAnnotationLayer(page);
    updateThumbBadge(page);
    setActiveTool('select');
    // The click that ends this drag now reaches a layer with no drawing
    // tool on it, where a click on bare page means "deselect".
    swallowClick = true;
  };
  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', finish);
}

/** With the text tool, dragging sets the note's width; a plain click still
 *  drops one at the default width (handled by the click that follows).
 *
 *  Only the width. A note is as tall as its text, so the outline shown
 *  while dragging is one line high however far down the pointer goes —
 *  it shows the box that will actually appear, not one it would discard. */
function beginNoteDrag(e, page) {
  // With "Shrink to text" on there is no width to choose: the text sets
  // it. The press is left to the click that follows.
  if (state.currentFit) return;
  const start = pointAt(e);
  // A click with an unsteady hand travels a few pixels. That is not a
  // request for a box a few pixels wide — which, at the minimum width,
  // wraps a note into a column one word across.
  const meant = (p) => Math.abs(p.x - start.x) >= MIN_NOTE_WIDTH;
  let ghost = null;
  trackDrag(e, (dx, dy, ev) => {
    const scale = state.currentScale;
    const p = pointAt(ev);
    if (!meant(p)) { if (ghost) { ghost.remove(); ghost = null; } return; }
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'note-ghost';
      $('annoLayer').appendChild(ghost);
    }
    ghost.style.left = (Math.min(start.x, p.x) * scale) + 'px';
    ghost.style.top = (start.y * scale) + 'px';
    ghost.style.width = (Math.max(MIN_NOTE_WIDTH, Math.abs(p.x - start.x)) * scale) + 'px';
    ghost.style.height = ((state.currentFontSize * LINE_HEIGHT_MULT + ANNO_PAD * 2) * scale) + 'px';
  }, (moved, ev) => {
    if (ghost) ghost.remove();
    if (!moved) return;
    if (ev.type === 'pointercancel') { swallowClick = true; return; }
    const p = pointAt(ev);
    // Too short to have been a drag: the click that follows drops a note
    // of the ordinary width, as a clean click would.
    if (!meant(p)) return;
    swallowClick = true;                  // the click that ends this drag places nothing
    placeNote(page, {
      type: 'text',
      x: Math.min(start.x, p.x), y: start.y,
      width: Math.max(MIN_NOTE_WIDTH, Math.abs(p.x - start.x)),
      fit: false,              // a width was just chosen by hand
    });
  });
}

/** Click/tap handler for the annotation layer — placement and deselect. */
export function handleLayerClick(e) {
  if (swallowClick) { swallowClick = false; return; }
  if (e.target.closest('.anno-box')) return;
  const tool = state.activeTool;
  // A stroke ends in a click; it must not also deselect or place.
  if (isDrawingTool(tool)) return;
  // Selecting a shape happens on pointerdown, but the click that follows
  // still bubbles here — without this it would deselect it again.
  const cls = e.target.classList;
  if (cls && (cls.contains('ink-stroke') || cls.contains('ink-hit') || cls.contains('pt-handle'))) return;
  const page = currentPage();
  if (!page) return;

  // A tool can be in hand while an existing note is being typed into (it
  // was picked, then a note was opened instead of placing one). The click
  // away from that note only ends the typing; it is not also a placement.
  if (wasEditing && (tool === 'text' || tool === 'callout')) { wasEditing = false; return; }

  const p = pointAt(e);
  if (tool === 'text') {
    placeNote(page, { type: 'text', x: p.x, y: p.y });
  } else if (tool === 'callout') {
    if (!state.pendingCalloutTip) {
      state.pendingCalloutTip = p;
      showCalloutPreview(null);
      $('placeHint').textContent = 'Now tap where the note itself should sit.';
      // Mid-gesture, so it shows wherever the properties row can be seen too.
      $('placeHint').classList.add('step');
      return;
    }
    const tip = state.pendingCalloutTip;
    state.pendingCalloutTip = null;
    $('placeHint').textContent = TOOL_HINT.callout;
    $('placeHint').classList.remove('step');
    placeNote(page, { type: 'callout', x: p.x, y: p.y, tipX: tip.x, tipY: tip.y });
  } else {
    deselectAnnotation();
  }
}

// ---- callout preview ----
let preview = null;       // { dot, line, wing1, wing2, jog, box } while a callout is half placed

function clearCalloutPreview() {
  if (!preview) return;
  for (const el of Object.values(preview)) el.remove();
  preview = null;
}

/** How wide the note a click would make starts out. */
function newNoteWidth() {
  // A note that shrinks to its text opens at the width of its placeholder.
  return state.currentFit ? state.currentFontSize * 5.2 + ANNO_PAD * 2 : DEFAULT_BOX_WIDTH;
}

/** Between a callout's two clicks: the leader, its arrowhead and the
 *  note's outline, following the pointer. Drawn with the same geometry
 *  the placed callout uses — which side the leader leaves from, its jog,
 *  where the head points — so what is shown is what a click at `p` would
 *  make.
 *  With no `p` yet (the first click has only just landed) the tip alone
 *  is marked. */
function showCalloutPreview(p) {
  const tip = state.pendingCalloutTip;
  if (!tip) return;
  const scale = state.currentScale;
  const colour = state.currentColor;

  if (!preview || !preview.dot.isConnected) {
    clearCalloutPreview();
    const svg = $('leaderSvg');
    const mk = (tag) => {
      const el = document.createElementNS(SVG_NS, tag);
      el.setAttribute('class', 'callout-preview');
      svg.appendChild(el);
      return el;
    };
    const dot = mk('circle');
    dot.setAttribute('r', '3.5');
    const lines = [mk('line'), mk('line'), mk('line'), mk('line')];
    for (const l of lines) {
      l.setAttribute('stroke-width', '1.6');
      l.setAttribute('stroke-linecap', 'round');
    }
    const box = document.createElement('div');
    box.className = 'note-ghost callout-preview';
    $('annoLayer').appendChild(box);
    preview = { dot, line: lines[0], wing1: lines[1], wing2: lines[2], jog: lines[3], box };
  }
  preview.dot.setAttribute('fill', colour);
  preview.dot.setAttribute('cx', tip.x * scale);
  preview.dot.setAttribute('cy', tip.y * scale);

  const show = (el, on) => { el.style.display = on ? '' : 'none'; };
  for (const k of ['line', 'wing1', 'wing2', 'jog', 'box']) show(preview[k], !!p);
  show(preview.dot, !p);
  if (!p) return;

  const a = { x: p.x, y: p.y, width: newNoteWidth(), tipX: tip.x, tipY: tip.y };
  const height = state.currentFontSize * LINE_HEIGHT_MULT + ANNO_PAD * 2;
  const { attach, knee } = computeLeader(a, height);
  const [w1, w2] = computeArrowWings(knee, tip);
  const seg = (el, from, to) => {
    el.setAttribute('stroke', colour);
    el.setAttribute('x1', from.x * scale); el.setAttribute('y1', from.y * scale);
    el.setAttribute('x2', to.x * scale); el.setAttribute('y2', to.y * scale);
  };
  seg(preview.jog, attach, knee);
  seg(preview.line, knee, tip);
  seg(preview.wing1, tip, w1);
  seg(preview.wing2, tip, w2);
  preview.box.style.borderColor = colour;
  preview.box.style.left = (a.x * scale) + 'px';
  preview.box.style.top = (a.y * scale) + 'px';
  preview.box.style.width = (a.width * scale) + 'px';
  preview.box.style.height = (height * scale) + 'px';
}

function placeNote(page, props) {
  const a = {
    id: state.nextAnnoId++,
    width: DEFAULT_BOX_WIDTH,
    text: '',
    fontSize: state.currentFontSize,
    color: state.currentColor,
    fill: state.currentFill,
    fit: state.currentFit,
    ...props,
  };
  checkpoint('Add note');
  fresh.add(a);
  page.annotations.push(a);
  markDirty();

  state.selectedAnnoId = a.id;
  renderAnnotationLayer(page);

  const refs = state.domRefs[a.id];
  refs.boxEl.classList.add('selected', 'editing');
  if (refs.tipHandle) refs.tipHandle.style.display = '';
  refs.textEl.focus();

  // One pick of a tool, one markup: it has been used, so it goes back.
  // (The owner's call, over the review that had tools stay armed.)
  setActiveTool('select');
  updateThumbBadge(page);
}

// ============================================================
// Delete / select / duplicate
// ============================================================
function removeMarkup(page, annoId) {
  const idx = page.annotations.findIndex((a) => a.id === annoId);
  if (idx < 0) return false;
  fresh.delete(page.annotations[idx]);
  page.annotations.splice(idx, 1);
  if (state.selectedAnnoId === annoId) state.selectedAnnoId = null;
  renderAnnotationLayer(page);
  updateToolbarState();
  updateThumbBadge(page);
  return true;
}

export function deleteAnnotation(page, annoId) {
  if (!page.annotations.some((a) => a.id === annoId)) return;
  checkpoint('Delete markup');
  removeMarkup(page, annoId);
  markDirty();
}

export function deselectAnnotation() {
  const wasShape = !!state.domRefs[state.selectedAnnoId]?.inkEl;
  state.selectedAnnoId = null;
  document.querySelectorAll('.anno-box').forEach((n) => {
    n.classList.remove('selected');
    n.classList.remove('editing');
  });
  document.querySelectorAll('.tip-handle').forEach((n) => { n.style.display = 'none'; });
  // A shape's selection is drawn as extra elements, so it has to be
  // rebuilt rather than declassed.
  if (wasShape) {
    const page = currentPage();
    if (page) renderAnnotationLayer(page);
  }
  updateToolbarState();
}

/** Select a markup on the page being shown and bring it into view. */
export function selectMarkup(annoId) {
  const page = currentPage();
  const a = page?.annotations.find((x) => x.id === annoId);
  if (!a) return;
  state.selectedAnnoId = annoId;
  renderAnnotationLayer(page);
  updateToolbarState();
  const refs = state.domRefs[annoId];
  (refs.boxEl || refs.inkEl)?.scrollIntoView({ block: 'center', inline: 'center' });
}

const copyOf = (a) => (a.points
  ? { ...a, points: a.points.map((p) => ({ x: p.x, y: p.y })) }
  : { ...a });

function nudge(a, d) {
  if (a.points) a.points.forEach((p) => { p.x += d; p.y += d; });
  else {
    a.x += d; a.y += d;
    if (a.type === 'callout') { a.tipX += d; a.tipY += d; }
  }
}

function addCopy(page, source, label, offset) {
  const a = copyOf(source);
  a.id = state.nextAnnoId++;
  if (offset) nudge(a, offset);
  checkpoint(label);
  page.annotations.push(a);
  markDirty();
  state.selectedAnnoId = a.id;
  renderAnnotationLayer(page);
  updateToolbarState();
  updateThumbBadge(page);
  return a;
}

const selectedMarkup = () => currentPage()?.annotations.find((x) => x.id === state.selectedAnnoId) || null;

/** A second copy of the selected markup, just off the first. */
export function duplicateSelected() {
  const a = selectedMarkup();
  if (!a) return false;
  addCopy(currentPage(), a, 'Duplicate markup', 12);
  return true;
}

// The same note often belongs on a dozen sheets. Copy keeps it here; paste
// puts it on whatever page is showing, in the same place.
let clipboard = null;

export function copySelected() {
  const a = selectedMarkup();
  if (!a) return false;
  clipboard = copyOf(a);
  return true;
}

export function pasteMarkup() {
  const page = currentPage();
  if (!clipboard || !page) return false;
  // Pasting onto the sheet it came from would land exactly on top of it.
  const at = (m) => (m.points ? m.points[0] : m);
  const clash = page.annotations.some((m) => m.type === clipboard.type
    && Math.abs(at(m).x - at(clipboard).x) < 0.5 && Math.abs(at(m).y - at(clipboard).y) < 0.5);
  addCopy(page, clipboard, 'Paste markup', clash ? 12 : 0);
  return true;
}

// ============================================================
// Tools
// ============================================================
const TOOL_BUTTON = {
  select: 'toolSelect', text: 'toolText', callout: 'toolCallout', pen: 'toolPen',
  highlight: 'toolHighlight', arrow: 'toolArrow', rect: 'toolRect', cloud: 'toolCloud',
};
const TOOL_HINT = {
  text: 'Tap to drop a note, or drag to set its width.',
  callout: 'Tap what you’re pointing at, then tap where the note goes.',
};

export function setActiveTool(tool) {
  if (!TOOL_BUTTON[tool]) tool = 'select';
  state.activeTool = tool;
  state.pendingCalloutTip = null;
  clearCalloutPreview();

  for (const [name, id] of Object.entries(TOOL_BUTTON)) {
    const btn = $(id);
    btn.classList.toggle('toggled', name === tool);
    btn.setAttribute('aria-pressed', String(name === tool));
  }
  const layer = $('annoLayer');
  for (const name of Object.keys(TOOL_BUTTON)) layer.classList.toggle('tool-' + name, name === tool);
  layer.classList.toggle('tool-draw', isDrawingTool(tool));

  const hint = $('placeHint');
  hint.textContent = TOOL_HINT[tool] || '';
  hint.classList.toggle('show', !!TOOL_HINT[tool]);
  hint.classList.remove('step');

  // Arming a tool is about the next markup, not the selected one.
  if (tool !== 'select' && state.selectedAnnoId) deselectAnnotation();
  else updateToolbarState();
}

/** Apply a style to the current selection, or set the default for the
 *  next placement when nothing is selected. */
export function applyAnnoStyle({ color, fontSize, penSize, fill, fit }) {
  const page = currentPage();
  const a = page?.annotations.find((x) => x.id === state.selectedAnnoId);
  const type = a ? a.type : TOOL_TYPE[state.activeTool];

  if (color) {
    if (type === 'highlight') state.currentHighlightColor = color; else state.currentColor = color;
  }
  if (fontSize) state.currentFontSize = fontSize;
  if (penSize) state.currentPenSize = penSize;
  if (fill !== undefined) state.currentFill = fill;
  if (fit !== undefined) state.currentFit = fit;
  if (!a) { updateToolbarState(); return; }

  // Each property only means something to one family.
  const shape = isPointShape(a);
  const next = {};
  if (color && color !== a.color) next.color = color;
  if (fontSize && !shape && fontSize !== a.fontSize) next.fontSize = fontSize;
  if (penSize && shape && sizeForType(a.type, penSize) !== a.size) next.size = sizeForType(a.type, penSize);
  if (fill !== undefined && !shape && fill !== (a.fill !== false)) next.fill = fill;
  if (fit !== undefined && !shape && fit !== (a.fit === true)) {
    next.fit = fit;
    // Turned off, the note keeps roughly the width it had shrunk to, as a
    // fixed one — with a little room. Exactly the width of its text is a
    // knife-edge: a rounding at another zoom, or the PDF font being a
    // touch wider than the screen's, and the last word drops to a line
    // of its own.
    if (!fit) next.width = Math.ceil(a.width * 1.06) + 2;
  }
  if (!Object.keys(next).length) { updateToolbarState(); return; }

  checkpoint('Change style');
  Object.assign(a, next);
  markDirty();

  renderAnnotationLayer(page);
  const refs = state.domRefs[a.id];
  if (refs && refs.boxEl) {
    refs.boxEl.classList.add('selected');
    if (refs.tipHandle) refs.tipHandle.style.display = '';
  }
  updateToolbarState();
}
