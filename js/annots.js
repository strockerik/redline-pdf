/* Text box and callout annotations: DOM overlay, pointer interactions,
 * and the two placement tools.
 *
 * All geometry here is plain visual-space 2D math (origin top-left, y
 * down). Conversion to the PDF's native content space happens once, at
 * export time — see export.js and guide §3.
 */
import {
  state, markDirty, computeAttachPoint, computeArrowWings,
  ANNO_PAD, LINE_HEIGHT_MULT, DEFAULT_BOX_WIDTH,
} from './state.js';
import { updateThumbBadge, updateToolbarState } from './view.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// ============================================================
// Layer
// ============================================================
export function renderAnnotationLayer(page) {
  const overlay = $('annoLayer');
  const svg = $('leaderSvg');
  overlay.querySelectorAll('.anno-box').forEach((n) => n.remove());
  svg.replaceChildren();
  state.domRefs = {};
  for (const a of page.annotations) buildAnnoDom(page, a);
}

function buildAnnoDom(page, a) {
  const overlay = $('annoLayer');
  const svg = $('leaderSvg');
  const scale = state.currentScale;

  const box = document.createElement('div');
  box.className = 'anno-box' + (a.id === state.selectedAnnoId ? ' selected' : '');
  box.style.left = (a.x * scale) + 'px';
  box.style.top = (a.y * scale) + 'px';
  box.style.width = (a.width * scale) + 'px';
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
  del.textContent = '×';
  del.title = 'Delete note';
  box.appendChild(del);

  overlay.appendChild(box);

  let lineEl = null, wing1 = null, wing2 = null, tipHandle = null;
  if (a.type === 'callout') {
    lineEl = document.createElementNS(SVG_NS, 'line');
    wing1 = document.createElementNS(SVG_NS, 'line');
    wing2 = document.createElementNS(SVG_NS, 'line');
    for (const l of [lineEl, wing1, wing2]) {
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

  state.domRefs[a.id] = { boxEl: box, textEl: text, lineEl, wing1, wing2, tipHandle };
  updateLeaderVisual(page, a);

  wireAnnoInteractions(page, a, { box, text, resize, del, tipHandle });
}

// ============================================================
// Interactions
// ============================================================
function wireAnnoInteractions(page, a, els) {
  const { box, text, resize, del, tipHandle } = els;

  const selectThis = () => {
    if (state.selectedAnnoId === a.id) return;
    state.selectedAnnoId = a.id;
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
    startDragMove(e, page, a, box, (moved) => {
      if (!moved && wasSelected) enterEditing();
    });
  });

  // Keep the desktop double-click working as a shortcut into editing.
  text.addEventListener('dblclick', (e) => { e.stopPropagation(); enterEditing(); });

  text.addEventListener('blur', () => {
    box.classList.remove('editing');
    a.text = text.innerText.replace(/\n+$/, '');
    text.classList.toggle('placeholder', a.text.length === 0);
    if (a.text.trim().length === 0) { deleteAnnotation(page, a.id); return; }
    markDirty();
    updateLeaderVisual(page, a);
    updateThumbBadge(page);
  });

  text.addEventListener('input', () => {
    text.classList.toggle('placeholder', text.innerText.trim().length === 0);
    updateLeaderVisual(page, a);
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
    startResize(e, page, a, box);
  });

  del.addEventListener('pointerdown', (e) => e.stopPropagation());
  del.addEventListener('click', (e) => { e.stopPropagation(); deleteAnnotation(page, a.id); });

  if (tipHandle) {
    tipHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectThis();
      startTipDrag(e, page, a);
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
const DRAG_SLOP = 4;   // px of movement before a press counts as a drag

function startDragMove(e, page, a, boxEl, onDone) {
  const startX = e.clientX, startY = e.clientY;
  const origX = a.x, origY = a.y;
  const scale = state.currentScale;
  let moved = false;
  boxEl.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
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
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    a.width = Math.max(40, origW + (ev.clientX - startX) / scale);
    boxEl.style.width = (a.width * scale) + 'px';
    updateLeaderVisual(page, a);
  };
  const onUp = (ev) => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    try { handle.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    markDirty();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

function startTipDrag(e, page, a) {
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    // Read the rect every move: the stage can scroll mid-drag, and a
    // rect captured at drag start would silently drift.
    const rect = $('pageCanvas').getBoundingClientRect();
    const scale = state.currentScale;
    a.tipX = (ev.clientX - rect.left) / scale;
    a.tipY = (ev.clientY - rect.top) / scale;
    updateLeaderVisual(page, a);
  };
  const onUp = (ev) => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    try { handle.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    markDirty();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

// ============================================================
// Leader line rendering
// ============================================================
export function updateLeaderVisual(page, a) {
  const refs = state.domRefs[a.id];
  if (!refs || a.type !== 'callout' || !refs.lineEl) return;

  const scale = state.currentScale;
  // Height is content-driven, so read it off the live DOM rather than
  // re-deriving it from a word-wrap estimate.
  const hPx = refs.boxEl.offsetHeight
    || (a.fontSize * LINE_HEIGHT_MULT + ANNO_PAD * 2) * scale;
  const attach = computeAttachPoint(a, hPx / scale);
  const tip = { x: a.tipX, y: a.tipY };

  refs.lineEl.setAttribute('x1', attach.x * scale);
  refs.lineEl.setAttribute('y1', attach.y * scale);
  refs.lineEl.setAttribute('x2', tip.x * scale);
  refs.lineEl.setAttribute('y2', tip.y * scale);

  const wings = computeArrowWings(attach, tip);
  const [w1, w2] = wings;
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
// Delete / deselect
// ============================================================
export function deleteAnnotation(page, annoId) {
  const idx = page.annotations.findIndex((a) => a.id === annoId);
  if (idx < 0) return;
  page.annotations.splice(idx, 1);
  if (state.selectedAnnoId === annoId) state.selectedAnnoId = null;
  markDirty();
  renderAnnotationLayer(page);
  updateToolbarState();
  updateThumbBadge(page);
}

export function deselectAnnotation() {
  state.selectedAnnoId = null;
  document.querySelectorAll('.anno-box').forEach((n) => {
    n.classList.remove('selected');
    n.classList.remove('editing');
  });
  document.querySelectorAll('.tip-handle').forEach((n) => { n.style.display = 'none'; });
  updateToolbarState();
}

// ============================================================
// Tools
// ============================================================
export function setActiveTool(tool) {
  state.activeTool = tool;
  state.pendingCalloutTip = null;

  $('toolText').classList.toggle('toggled', tool === 'text');
  $('toolCallout').classList.toggle('toggled', tool === 'callout');
  const layer = $('annoLayer');
  layer.classList.toggle('tool-text', tool === 'text');
  layer.classList.toggle('tool-callout', tool === 'callout');

  const hint = $('placeHint');
  if (tool === 'text') {
    hint.textContent = 'Tap the page to drop a text box.';
    hint.classList.add('show');
  } else if (tool === 'callout') {
    hint.textContent = 'Tap what you’re pointing at, then tap where the note goes.';
    hint.classList.add('show');
  } else {
    hint.classList.remove('show');
  }
}

/** Click/tap handler for the annotation layer — placement and deselect. */
export function handleLayerClick(e) {
  if (e.target.closest('.anno-box')) return;
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  if (!page) return;

  const rect = $('pageCanvas').getBoundingClientRect();
  const px = (e.clientX - rect.left) / state.currentScale;
  const py = (e.clientY - rect.top) / state.currentScale;

  if (state.activeTool === 'text') {
    placeAnnotation(page, {
      type: 'text', x: px, y: py,
    });
  } else if (state.activeTool === 'callout') {
    if (!state.pendingCalloutTip) {
      state.pendingCalloutTip = { x: px, y: py };
      $('placeHint').textContent = 'Now tap where the note itself should sit.';
      return;
    }
    placeAnnotation(page, {
      type: 'callout', x: px, y: py,
      tipX: state.pendingCalloutTip.x, tipY: state.pendingCalloutTip.y,
    });
  } else {
    deselectAnnotation();
  }
}

function placeAnnotation(page, props) {
  const a = {
    id: state.nextAnnoId++,
    width: DEFAULT_BOX_WIDTH,
    text: '',
    fontSize: state.currentFontSize,
    color: state.currentColor,
    ...props,
  };
  page.annotations.push(a);
  markDirty();

  renderAnnotationLayer(page);
  state.selectedAnnoId = a.id;

  const refs = state.domRefs[a.id];
  refs.boxEl.classList.add('selected', 'editing');
  if (refs.tipHandle) refs.tipHandle.style.display = '';
  refs.textEl.focus();

  setActiveTool('select');
  updateToolbarState();
  updateThumbBadge(page);
}

/** Apply a color or font size to the current selection, or set the
 *  default for the next placement when nothing is selected. */
export function applyAnnoStyle({ color, fontSize }) {
  if (color) state.currentColor = color;
  if (fontSize) state.currentFontSize = fontSize;
  if (!state.selectedAnnoId) return;

  const page = state.pages.find((p) => p.id === state.selectedPageId);
  const a = page?.annotations.find((x) => x.id === state.selectedAnnoId);
  if (!a) return;

  if (color) a.color = color;
  if (fontSize) a.fontSize = fontSize;
  markDirty();

  renderAnnotationLayer(page);
  const refs = state.domRefs[a.id];
  if (refs) {
    refs.boxEl.classList.add('selected');
    if (refs.tipHandle) refs.tipHandle.style.display = '';
  }
}
