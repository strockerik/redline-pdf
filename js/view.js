/* Rendering: the main page canvas (with zoom/pan) and the thumbnail rail
 * (with pointer-based reorder that works under both mouse and finger).
 */
import {
  state, visualSize, normRot,
  THUMB_WIDTH, PT_TO_PX, ZOOM_STEPS, MIN_ZOOM, MAX_ZOOM,
} from './state.js';
import { renderAnnotationLayer } from './annots.js';

const $ = (id) => document.getElementById(id);

// ============================================================
// Zoom
// ============================================================
const STAGE_PAD = 36;   // matches #canvasStage padding in app.css

/** Logical px per PDF point for the current zoom mode and page. */
function computeScale(page) {
  const { w: Wv, h: Hv } = visualSize(page.rotation, page.W0, page.H0);
  const stage = $('canvasStage');
  const availW = Math.max(120, stage.clientWidth - STAGE_PAD * 2);
  const availH = Math.max(120, stage.clientHeight - STAGE_PAD * 2);

  let scale;
  if (state.zoomMode === 'fit-width') {
    scale = availW / Wv;
  } else if (state.zoomMode === 'fit-page') {
    scale = Math.min(availW / Wv, availH / Hv);
  } else {
    scale = state.zoomLevel * PT_TO_PX;
  }

  // Keep zoomLevel in sync so the percentage readout is truthful even
  // while in a fit mode.
  const clamped = Math.min(Math.max(scale / PT_TO_PX, MIN_ZOOM), MAX_ZOOM);
  state.zoomLevel = clamped;
  return clamped * PT_TO_PX;
}

export function setZoomMode(mode) {
  state.zoomMode = mode;
  if (mode === 'fit-width' || mode === 'fit-page') state.lastFitMode = mode;
  renderMainCanvas();
}

export function setZoomLevel(level, anchor) {
  state.zoomMode = 'custom';
  state.zoomLevel = Math.min(Math.max(level, MIN_ZOOM), MAX_ZOOM);
  renderMainCanvas({ anchor });
}

export function zoomStep(dir) {
  const cur = state.zoomLevel;
  let next;
  if (dir > 0) next = ZOOM_STEPS.find((z) => z > cur + 1e-4);
  else next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 1e-4);
  if (next) setZoomLevel(next);
}

export function updateZoomReadout() {
  const el = $('zoomReadout');
  if (el) el.textContent = Math.round(state.zoomLevel * 100) + '%';
  $('btnFitWidth')?.classList.toggle('toggled', state.zoomMode === 'fit-width');
  $('btnFitPage')?.classList.toggle('toggled', state.zoomMode === 'fit-page');
}

// ============================================================
// Main canvas
// ============================================================
let renderToken = 0;
let activeRenderTask = null;

/** Render the selected page. Safe to call repeatedly and concurrently —
 *  pdf.js rejects two renders against one canvas, so the previous task
 *  is cancelled and stale results are dropped via the token. */
export async function renderMainCanvas(opts = {}) {
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  const emptyState = $('emptyState');
  const pageStack = $('pageStack');

  updateToolbarState();

  if (!page) {
    emptyState.style.display = 'block';
    pageStack.style.display = 'none';
    return;
  }
  emptyState.style.display = 'none';
  pageStack.style.display = 'block';

  const token = ++renderToken;
  if (activeRenderTask) {
    try { activeRenderTask.cancel(); } catch { /* already settled */ }
    activeRenderTask = null;
  }

  const { w: Wv, h: Hv } = visualSize(page.rotation, page.W0, page.H0);
  const scale = computeScale(page);
  state.currentScale = scale;
  updateZoomReadout();

  // Record the scroll anchor before the canvas resizes under us.
  const stage = $('canvasStage');
  const prevW = pageStack.offsetWidth || 1;
  const prevH = pageStack.offsetHeight || 1;
  const anchorX = opts.anchor ? opts.anchor.x : stage.clientWidth / 2;
  const anchorY = opts.anchor ? opts.anchor.y : stage.clientHeight / 2;
  const relX = (stage.scrollLeft + anchorX) / prevW;
  const relY = (stage.scrollTop + anchorY) / prevH;

  const dpr = window.devicePixelRatio || 1;
  const canvas = $('pageCanvas');
  const ctx = canvas.getContext('2d');

  const cssW = Math.round(Wv * scale);
  const cssH = Math.round(Hv * scale);

  if (page.kind === 'blank') {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    const src = state.sources.find((s) => s.id === page.sourceId);
    const pjPage = await src.pdfjsDoc.getPage(page.sourcePageIndex + 1);
    if (token !== renderToken) return;
    // rotation here is absolute — it overrides the page's own /Rotate
    const viewport = pjPage.getViewport({ scale: scale * dpr, rotation: normRot(page.rotation) });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const task = pjPage.render({ canvasContext: ctx, viewport });
    activeRenderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      throw err;
    } finally {
      if (activeRenderTask === task) activeRenderTask = null;
    }
    if (token !== renderToken) return;
  }

  // Backing store is at device resolution; layout stays in logical px so
  // the annotation overlay's pt * currentScale math is unaffected.
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  pageStack.style.width = cssW + 'px';
  pageStack.style.height = cssH + 'px';
  pageStack.style.transform = '';

  const overlay = $('annoLayer');
  overlay.style.width = cssW + 'px';
  overlay.style.height = cssH + 'px';
  $('leaderSvg').setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);

  renderAnnotationLayer(page);

  // Restore the anchor point to roughly where it was pre-zoom.
  if (opts.anchor || state.zoomMode === 'custom') {
    stage.scrollLeft = relX * cssW - anchorX;
    stage.scrollTop = relY * cssH - anchorY;
  }
}

// ============================================================
// Gestures: pinch zoom, trackpad zoom, space-drag pan
// ============================================================
export function installStageGestures(onPageStep) {
  const stage = $('canvasStage');
  const pageStack = $('pageStack');

  // --- Wheel ---
  //
  // What a plain wheel does depends on the fit mode the user picked:
  //
  //            plain wheel     Ctrl + wheel
  //   Fit Pg   change page     zoom
  //   Fit W    zoom            scroll
  //
  // Cmd + wheel always zooms, whatever the mode.
  //
  // A Mac trackpad pinch arrives as a wheel event with ctrlKey set and is
  // otherwise indistinguishable from a real Ctrl+wheel — so track whether
  // Ctrl is physically down. Without this, pinch-to-zoom would silently
  // turn into a scroll in Fit W, which is the default mode.
  let ctrlHeld = false;
  const syncCtrl = (e) => { ctrlHeld = e.ctrlKey; };
  window.addEventListener('keydown', syncCtrl);
  window.addEventListener('keyup', syncCtrl);
  window.addEventListener('blur', () => { ctrlHeld = false; });

  // A trackpad pinch arrives as many small deltas and wants to track the
  // fingers exactly. A mouse wheel arrives as a few big ones — ~120 per
  // notch, which through the same curve would be a 3x jump per click — so
  // discrete wheels get clamped and damped to about 20% per notch.
  const zoomBy = (e, fine) => {
    const rect = stage.getBoundingClientRect();
    const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const d = fine ? e.deltaY
                   : Math.max(-50, Math.min(50, e.deltaY)) * 0.35;
    setZoomLevel(state.zoomLevel * Math.exp(-d * 0.01), anchor);
  };

  // One flick of a trackpad is a burst of small deltas, so accumulate to a
  // threshold and then go deaf briefly — otherwise a single gesture would
  // skate through half the document.
  const PAGE_STEP_DELTA = 50;
  const PAGE_STEP_COOLDOWN = 350;
  const GESTURE_GAP = 200;
  let accum = 0, lastWheelAt = 0, cooling = false;

  const stepPages = (e) => {
    const now = performance.now();
    if (now - lastWheelAt > GESTURE_GAP) accum = 0;   // a new gesture
    lastWheelAt = now;
    if (cooling) return;                              // swallow momentum
    // deltaMode 1 is lines, not pixels (some mice report it).
    accum += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (Math.abs(accum) < PAGE_STEP_DELTA) return;
    const dir = accum > 0 ? 1 : -1;
    accum = 0;
    cooling = true;
    setTimeout(() => { cooling = false; }, PAGE_STEP_COOLDOWN);
    onPageStep?.(dir);
  };

  stage.addEventListener('wheel', (e) => {
    const pinch = e.ctrlKey && !ctrlHeld;             // trackpad, not the key
    if (e.metaKey || pinch) { e.preventDefault(); zoomBy(e, pinch); return; }

    if (state.lastFitMode === 'fit-page') {
      e.preventDefault();
      if (e.ctrlKey) zoomBy(e, false); else stepPages(e);
    } else if (e.ctrlKey) {
      // Ctrl+wheel scrolls in Fit W. It has to be done by hand: letting
      // the event through means Chrome takes it as browser zoom, so the
      // stage would never scroll and the whole page would resize instead.
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : 1;
      stage.scrollTop += e.deltaY * k;
      stage.scrollLeft += e.deltaX * k;
    } else {
      e.preventDefault();
      zoomBy(e, false);
    }
  }, { passive: false });

  // --- Two-finger pinch on a touchscreen ---
  const pointers = new Map();
  let pinchStart = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const rect = stage.getBoundingClientRect();
      // Hand the gesture entirely to us for its duration; preventDefault
      // on pointermove alone does not reliably stop a scroll already in
      // progress.
      stage.style.touchAction = 'none';
      pinchStart = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        zoom: state.zoomLevel,
        anchor: {
          x: (a.x + b.x) / 2 - rect.left,
          y: (a.y + b.y) / 2 - rect.top,
        },
      };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size !== 2 || !pinchStart) return;
    e.preventDefault();
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const ratio = dist / pinchStart.dist;
    // Live feedback via CSS transform — cheap and smooth. The real
    // re-render at the settled scale happens on gesture end, because
    // a transform-scaled canvas is blurry.
    pageStack.style.transformOrigin = '0 0';
    pageStack.style.transform = `scale(${ratio})`;
  }, { passive: false });

  const endPinch = (e) => {
    if (!pointers.has(e.pointerId)) return;
    const had = pinchStart;
    const [a, b] = pointers.size === 2 ? [...pointers.values()] : [null, null];
    let ratio = 1;
    if (had && a && b) ratio = (Math.hypot(a.x - b.x, a.y - b.y) || 1) / had.dist;
    pointers.delete(e.pointerId);
    if (pointers.size < 2 && had) {
      pinchStart = null;
      pageStack.style.transform = '';
      stage.style.touchAction = '';
      if (Math.abs(ratio - 1) > 0.01) setZoomLevel(had.zoom * ratio, had.anchor);
    }
  };
  stage.addEventListener('pointerup', endPinch);
  stage.addEventListener('pointercancel', endPinch);

  // --- Drag to pan ---
  // Pan is the default: with no placement tool active, dragging the page
  // moves it, the way every PDF viewer behaves. Holding Space pans even
  // while a tool is active, so a note can be placed off-screen without
  // putting the tool away first.
  let spaceDown = false;
  let panning = null;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && !isTypingTarget(e.target)) {
      spaceDown = true;
      state.spaceHeld = true;
      stage.classList.add('pannable');
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      state.spaceHeld = false;
      stage.classList.remove('pannable');
    }
  });

  /** Anything with its own drag gesture keeps it — panning must not
   *  hijack moving a note, dragging a leader tip, or picking a stroke. */
  const ownsTheDrag = (target) =>
    !!(target.closest?.('.anno-box') ||
       target.classList?.contains('ink-stroke') ||
       target.classList?.contains('tip-handle'));

  // Set when a pan actually moved, so the click that ends the drag can be
  // swallowed. A flag rather than a one-shot listener: a drag ended by
  // pointercancel never produces that click, and the listener would sit
  // armed and eat an unrelated click later.
  let swallowClick = false;
  stage.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, { capture: true });

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;          // native scroll handles touch
    if (e.button !== 0) return;                     // right/middle keep the menu
    if (!spaceDown && state.activeTool !== 'select') return;
    // Notes keep their own drag even under Space — panning and the note's
    // own move gesture at once dragged it at roughly double speed.
    if (ownsTheDrag(e.target)) return;
    // Deliberately no preventDefault here. It suppresses the compat
    // mousedown and with it the focus change, so an open note would never
    // blur: typing kept landing in it, and every single-key shortcut
    // stayed dead because isTypingTarget still saw a focused
    // contenteditable. Text selection is suppressed from pointermove
    // instead, once this is genuinely a drag.
    swallowClick = false;
    panning = {
      x: e.clientX, y: e.clientY, id: e.pointerId,
      sl: stage.scrollLeft, st: stage.scrollTop, moved: false,
    };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const dx = e.clientX - panning.x, dy = e.clientY - panning.y;
    if (!panning.moved) {
      if (Math.hypot(dx, dy) <= 3) return;
      // Capture only once this is genuinely a drag. Capturing on every
      // press would retarget the click that follows to the stage, and
      // click-to-deselect on the annotation layer would stop firing.
      panning.moved = true;
      stage.classList.add('panning');
      try { stage.setPointerCapture(panning.id); } catch { /* not capturable */ }
    }
    e.preventDefault();                             // no text selection mid-pan
    stage.scrollLeft = panning.sl - dx;
    stage.scrollTop = panning.st - dy;
  });
  const endPan = (e) => {
    if (!panning) return;
    // Only a real pointerup produces the trailing click worth swallowing.
    swallowClick = panning.moved && e.type === 'pointerup';
    panning = null;
    stage.classList.remove('panning');
    try { stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  // A keyup lands on whoever has focus; switching apps mid-hold would
  // otherwise leave the app stuck in pan mode forever.
  window.addEventListener('blur', () => {
    spaceDown = false;
    state.spaceHeld = false;
    stage.classList.remove('pannable');
  });
}

export function isTypingTarget(el) {
  return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

// ============================================================
// Thumbnails
// ============================================================
// Cache keyed by page id; invalidated when the page's rotation changes,
// so reordering pages costs no pdf.js work at all.
const thumbCache = new Map();

export function invalidateThumb(pageId) { thumbCache.delete(pageId); }
export function invalidateAllThumbs() { thumbCache.clear(); }

async function paintThumbCanvas(page) {
  const cached = thumbCache.get(page.id);
  if (cached && cached.rotation === page.rotation) return cached.canvas;

  const { w, h } = visualSize(page.rotation, page.W0, page.H0);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = THUMB_WIDTH / w;
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';

  if (page.kind === 'blank') {
    canvas.width = Math.round(w * scale * dpr);
    canvas.height = Math.round(h * scale * dpr);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = dpr;
    ctx.strokeRect(dpr / 2, dpr / 2, canvas.width - dpr, canvas.height - dpr);
  } else {
    const src = state.sources.find((s) => s.id === page.sourceId);
    if (!src) return canvas;
    const pjPage = await src.pdfjsDoc.getPage(page.sourcePageIndex + 1);
    const viewport = pjPage.getViewport({ scale: scale * dpr, rotation: normRot(page.rotation) });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await pjPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
  thumbCache.set(page.id, { rotation: page.rotation, canvas });
  return canvas;
}

let paintGeneration = 0;

/** Guide §6: render thumbnails sequentially. Concurrent pdf.js renders
 *  are flaky, and at personal-document scale this is not a bottleneck. */
async function paintAllThumbs(generation) {
  for (const page of state.pages) {
    if (generation !== paintGeneration) return;
    const holder = document.querySelector(`.thumb[data-page-id="${page.id}"] .thumb-canvas`);
    if (!holder) continue;
    try {
      const canvas = await paintThumbCanvas(page);
      if (generation !== paintGeneration) return;
      holder.replaceChildren(canvas);
    } catch (err) {
      console.error('thumbnail render failed', err);
    }
  }
}

export function updateThumbBadge(page) {
  const el = document.querySelector(`.thumb[data-page-id="${page.id}"]`);
  if (!el) return;
  let badge = el.querySelector('.anno-badge');
  const n = page.annotations.length;
  if (!n) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'anno-badge';
    el.appendChild(badge);
  }
  badge.textContent = n;
}

export function renderThumbnails() {
  const list = $('thumbList');
  $('sidebarEmptyHint').style.display = state.pages.length ? 'none' : 'block';
  $('pageCountLabel').textContent = state.pages.length
    ? `${state.pages.length} page${state.pages.length === 1 ? '' : 's'}` : '';

  const frag = document.createDocumentFragment();
  state.pages.forEach((page, i) => {
    const el = document.createElement('div');
    el.className = 'thumb' + (page.id === state.selectedPageId ? ' selected' : '');
    el.dataset.pageId = page.id;

    const holder = document.createElement('div');
    holder.className = 'thumb-canvas';
    // Reserve the right aspect ratio so the rail doesn't reflow as
    // canvases land asynchronously.
    const { w, h } = visualSize(page.rotation, page.W0, page.H0);
    holder.style.aspectRatio = `${w} / ${h}`;
    el.appendChild(holder);

    const row = document.createElement('div');
    row.className = 'thumb-row';
    row.innerHTML =
      `<div class="thumb-label">PG ${i + 1}${page.kind === 'blank' ? ' · blank' : ''}</div>` +
      `<div class="thumb-actions">` +
      `<button class="mini-btn" data-act="ccw" title="Rotate counter-clockwise" aria-label="Rotate page ${i + 1} counter-clockwise">⟲</button>` +
      `<button class="mini-btn" data-act="cw" title="Rotate clockwise" aria-label="Rotate page ${i + 1} clockwise">⟳</button>` +
      `<button class="mini-btn del" data-act="del" title="Delete page" aria-label="Delete page ${i + 1}">✕</button>` +
      `</div>`;
    el.appendChild(row);

    if (page.annotations.length) {
      const badge = document.createElement('div');
      badge.className = 'anno-badge';
      badge.textContent = page.annotations.length;
      el.appendChild(badge);
    }

    frag.appendChild(el);
  });

  list.replaceChildren(frag);
  paintAllThumbs(++paintGeneration);
}

export function updateThumbSelection() {
  document.querySelectorAll('.thumb').forEach((el) => {
    el.classList.toggle('selected', Number(el.dataset.pageId) === state.selectedPageId);
  });
  document.querySelector('.thumb.selected')
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ============================================================
// Thumbnail reorder — pointer based.
//
// HTML5 drag-and-drop is not implemented in iOS Safari, so it can't be
// used here. Mouse starts a drag after a few px of movement; touch
// requires a short hold first, otherwise the gesture would fight with
// scrolling the rail.
// ============================================================
export function installThumbReorder(onReorder, onSelect, onRotate, onDelete) {
  const list = $('thumbList');
  let drag = null;
  let holdTimer = null;

  const clearMarkers = () => {
    list.querySelectorAll('.thumb').forEach((n) =>
      n.classList.remove('drop-before', 'drop-after', 'dragging'));
  };

  list.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.mini-btn');
    const thumb = e.target.closest('.thumb');
    if (!thumb) return;
    const pageId = Number(thumb.dataset.pageId);

    if (btn) {
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'ccw') onRotate(pageId, -90);
      else if (act === 'cw') onRotate(pageId, 90);
      else if (act === 'del') onDelete(pageId);
      return;
    }

    const startX = e.clientX, startY = e.clientY;
    const isTouch = e.pointerType === 'touch';
    let armed = !isTouch;
    let started = false;
    let moved = false;

    if (isTouch) {
      holdTimer = setTimeout(() => {
        armed = true;
        if (navigator.vibrate) navigator.vibrate(8);
        thumb.classList.add('dragging');
        started = true;
        drag = { pageId, thumb };
      }, 250);
    }

    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > 6) {
        moved = true;
        if (isTouch && !started) { clearTimeout(holdTimer); cleanup(); return; }
      }
      if (!armed) return;
      if (!started) {
        if (Math.hypot(dx, dy) <= 6) return;
        started = true;
        thumb.classList.add('dragging');
        drag = { pageId, thumb };
      }
      ev.preventDefault();

      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.thumb');
      list.querySelectorAll('.thumb').forEach((n) =>
        n.classList.remove('drop-before', 'drop-after'));
      if (over && over !== thumb) {
        const r = over.getBoundingClientRect();
        // The rail is vertical on desktop and horizontal on narrow
        // screens, so pick the axis from the element's own shape.
        const horizontal = list.classList.contains('horizontal');
        const before = horizontal
          ? (ev.clientX - r.left) < r.width / 2
          : (ev.clientY - r.top) < r.height / 2;
        over.classList.add(before ? 'drop-before' : 'drop-after');
      }
    };

    const onUp = (ev) => {
      clearTimeout(holdTimer);
      if (started && drag) {
        const target = list.querySelector('.drop-before, .drop-after');
        if (target) {
          const toId = Number(target.dataset.pageId);
          onReorder(drag.pageId, toId, target.classList.contains('drop-before'));
        }
      } else if (!moved) {
        onSelect(pageId);
      }
      cleanup();
    };

    function cleanup() {
      clearTimeout(holdTimer);
      clearMarkers();
      drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    }

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });
}

// ============================================================
// Toolbar enable/disable
// ============================================================
export function updateToolbarState() {
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  const hasPage = !!page;
  const hasDoc = state.pages.length > 0;

  for (const id of ['btnRotateCCW', 'btnRotateCW', 'btnDeletePage', 'toolText', 'toolCallout',
                    'toolPen', 'btnZoomIn', 'btnZoomOut', 'btnFitWidth', 'btnFitPage']) {
    const el = $(id);
    if (el) el.disabled = !hasPage;
  }
  for (const id of ['btnSave', 'btnSaveAs', 'btnDownload', 'btnClearAll']) {
    const el = $(id);
    if (el) el.disabled = !hasDoc;
  }
  const delAnno = $('btnDeleteAnno');
  if (delAnno) delAnno.disabled = !state.selectedAnnoId;

  updateZoomReadout();
}

export function updateTitle() {
  const name = $('docTitle');
  if (name) name.textContent = state.docName;
  const dot = $('dirtyDot');
  if (dot) dot.style.display = state.dirty ? '' : 'none';
  document.title = (state.dirty ? '• ' : '') + state.docName + ' — Redline';
}
