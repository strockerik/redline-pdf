/* Rendering: the main page canvas (with zoom/pan) and the thumbnail rail
 * (with pointer-based reorder that works under both mouse and finger).
 */
import {
  state, setStatus, visualSize, normRot, finishTyping,
  THUMB_WIDTH, PT_TO_PX, ZOOM_STEPS, MIN_ZOOM, MAX_ZOOM,
} from './state.js';
import { renderAnnotationLayer } from './annots.js';
import {
  plotAvailable, plotRecord, startPlot, drawPlot, plotBitmap, plotRoom,
  pageMatrix, setShownPlot, sweepPlots, onPlotEvent,
} from './plot.js';

const $ = (id) => document.getElementById(id);

// ============================================================
// Zoom
// ============================================================
const STAGE_PAD = 36;   // matches #canvasStage padding in app.css

/** Logical px per PDF point that `page` would be shown at, in the current
 *  zoom mode. No side effects: the page-ahead drawing below asks this of
 *  pages that are not on screen. */
function scaleFor(page) {
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
  return Math.min(Math.max(scale / PT_TO_PX, MIN_ZOOM), MAX_ZOOM) * PT_TO_PX;
}

/** The same, for the page on screen — which also keeps zoomLevel in sync,
 *  so the percentage readout is truthful even while in a fit mode. */
function computeScale(page) {
  const scale = scaleFor(page);
  state.zoomLevel = scale / PT_TO_PX;
  return scale;
}

const clampZoom = (level) => Math.min(Math.max(level, MIN_ZOOM), MAX_ZOOM);

/** Put the page at `level` now. One frame of a zoom. */
function applyZoom(level, anchor) {
  state.zoomMode = 'custom';
  state.zoomLevel = clampZoom(level);
  renderMainCanvas({ anchor, zooming: true });
}

// ---- Zoom is a movement, not a cut ----
//
// A zoom that jumps from one size to the next tells the eye nothing about
// how far it went: the sheet is simply different, and the thing being
// looked at has to be found again. So every zoom that arrives as a step —
// a wheel notch, a button, a key, a fit mode — is eased to its target
// over a few frames, about the point it was aimed at. The linework grows
// or shrinks on screen, and how much it moved is how much was zoomed.
//
// It is an exponential approach rather than a fixed-length tween, so a
// run of wheel notches keeps moving the target and the page keeps
// chasing it, without one animation queueing behind another.
//
// Each frame is cheap for every kind of page: see "Resizing" below.
const ZOOM_EASE_MS = 55;          // time constant: ~95% of the way in three of these
const zoomAnim = { raf: 0, target: null, anchor: undefined, last: 0, done: null };

const prefersStillness = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function stopZoomAnim() {
  cancelAnimationFrame(zoomAnim.raf);
  zoomAnim.raf = 0;
  zoomAnim.target = null;
  zoomAnim.done = null;
}

/** Ease to `level`, holding `anchor` (a point in the stage) still. `done`
 *  runs once it has arrived — unless another zoom takes over first. */
function zoomToward(level, anchor, done = null) {
  const target = clampZoom(level);
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  if (!page || prefersStillness()) {
    stopZoomAnim();
    if (page) applyZoom(target, anchor);
    if (done) done();
    return;
  }
  zoomAnim.target = target;
  zoomAnim.anchor = anchor;
  zoomAnim.done = done;
  if (zoomAnim.raf) return;                 // already moving: it now has a new target
  zoomAnim.last = performance.now();
  const frame = (now) => {
    const dt = Math.min(64, Math.max(1, now - zoomAnim.last));
    zoomAnim.last = now;
    const to = zoomAnim.target;
    // In log space, so 50% -> 100% moves like 100% -> 200%.
    const gap = Math.log(to / state.zoomLevel);
    const arrived = Math.abs(gap) < 0.004;
    applyZoom(arrived ? to : state.zoomLevel * Math.exp(gap * (1 - Math.exp(-dt / ZOOM_EASE_MS))), zoomAnim.anchor);
    if (!arrived) { zoomAnim.raf = requestAnimationFrame(frame); return; }
    const after = zoomAnim.done;
    stopZoomAnim();
    if (after) after();
  };
  zoomAnim.raf = requestAnimationFrame(frame);
}

/** Where the zoom is headed — which, mid-movement, is not where it is. A
 *  second step taken before the first has landed starts from here. */
const zoomGoal = () => (zoomAnim.target ?? state.zoomLevel);

/** The zoom a fit mode works out to for the page on screen. */
function fitLevel(mode, page) {
  const { w: Wv, h: Hv } = visualSize(page.rotation, page.W0, page.H0);
  const stage = $('canvasStage');
  const availW = Math.max(120, stage.clientWidth - STAGE_PAD * 2);
  const availH = Math.max(120, stage.clientHeight - STAGE_PAD * 2);
  const scale = mode === 'fit-width' ? availW / Wv : Math.min(availW / Wv, availH / Hv);
  return clampZoom(scale / PT_TO_PX);
}

export function setZoomMode(mode) {
  const fit = mode === 'fit-width' || mode === 'fit-page';
  // Recorded at once, not when the movement ends: the wheel keys off it.
  if (fit) state.lastFitMode = mode;
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  const settle = () => { state.zoomMode = mode; renderMainCanvas(); };
  if (!fit || !page) { stopZoomAnim(); settle(); return; }
  // Glide to the size the fit works out to, then hand over to the mode
  // itself, which keeps the page fitted as the window changes.
  zoomToward(fitLevel(mode, page), undefined, settle);
}

/** Zoom to `level` about `anchor` (stage coordinates; its centre if none).
 *  Eased, unless `instant` — for input that is already continuous, like a
 *  pinch, where easing would only make the page lag the fingers. */
export function setZoomLevel(level, anchor, { instant = false } = {}) {
  if (instant) { stopZoomAnim(); applyZoom(level, anchor); return; }
  zoomToward(level, anchor);
}

export function zoomStep(dir) {
  const cur = zoomGoal();
  let next;
  if (dir > 0) next = ZOOM_STEPS.find((z) => z > cur + 1e-4);
  else next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 1e-4);
  if (next) setZoomLevel(next);
}

function updateZoomReadout() {
  const el = $('zoomReadout');
  if (el) el.textContent = Math.round(state.zoomLevel * 100) + '%';
  $('btnFitWidth')?.classList.toggle('toggled', state.zoomMode === 'fit-width');
  $('btnFitPage')?.classList.toggle('toggled', state.zoomMode === 'fit-page');
}

/** Latch the wheel into zooming, or let it go.
 *
 *  The mode needs a visible marker, or a wheel that suddenly zooms in Fit
 *  Pg (where it normally turns pages) reads as a bug. The cursor covers
 *  the page, and the percentage readout lights up so the state is still
 *  legible once the pointer has left the stage. `placeHint` is
 *  deliberately not used — setActiveTool owns that, and the two would
 *  overwrite each other. */
export function setWheelZoom(on) {
  const next = !!on;
  if (next === state.wheelZoom) return;
  state.wheelZoom = next;
  $('canvasStage')?.classList.toggle('wheel-zoom', next);
  const readout = $('zoomReadout');
  readout?.classList.toggle('toggled', next);
  if (readout) {
    readout.title = next
      ? 'Wheel zoom is on — double-click the page or press Esc to exit'
      : 'Reset to 100%';
  }
  setStatus(next
    ? 'Zoom mode: scroll to zoom. Double-click or Esc to exit.'
    : 'Zoom mode off.', 'ok');
}

// ============================================================
// Heavy pages
//
// A sheet plotted from CAD can be tens of millions of drawing operators.
// pdf.js copes, but only just: one page of the plot this was written for
// takes ~11 s and ~2 GB of heap to turn into an operator list, then
// another ~25 s to replay onto a canvas — at *any* size, because the cost
// is the operator count, not the pixel count. The ordinary path below
// re-renders on every zoom and renders each page again for its thumbnail,
// and pdf.js keeps every operator list until told otherwise, so opening
// such a file ran the tab out of memory before a page appeared.
//
// A heavy page therefore never goes through the ordinary path. It takes
// one of two others:
//
//   plot    The page's linework is compiled once, in a worker, into GPU
//           geometry and drawn with WebGL into #plotCanvas (plot.js). A
//           redraw is milliseconds, so zoom and pan stay true vectors.
//           pdf.js only draws what is left: text and images.
//
//   master  Where that is not available — no WebGL2, or a page built from
//           things the compiler does not take — the page is rendered
//           exactly once by pdf.js, unrotated, into an offscreen "master"
//           canvas, and everything is drawn from that bitmap. Slow to
//           arrive and soft past its resolution, but it always works.
//
// Either way the thumbnail comes from the same result, and pdf.js's
// operator list is never held. Ordinary pages come through neither and
// stay exactly as sharp as before.
// ============================================================
const HEAVY_CONTENT_BYTES = 4e6;   // compressed content; ordinary pages are well under 1 MB
const MAX_CANVAS_SIDE = 16384;     // Chrome refuses a canvas larger than this on either side
const MAX_CANVAS_AREA = MAX_CANVAS_SIDE * MAX_CANVAS_SIDE;
const PROGRESS_BLIT_MS = 400;

// iOS caps a canvas near 16.7 MP and has far less memory to give.
const smallDevice = () => !!window.matchMedia?.('(pointer: coarse)').matches;
const masterPixels = () => (smallDevice() ? 16e6 : 32e6);
const maxMasters = () => (smallDevice() ? 1 : 4);

/** Device px per pt for a heavy page's master. Exported for testing. */
export function masterScale(w, h, pixels = masterPixels()) {
  return Math.min(
    Math.sqrt(pixels / (w * h)),
    MAX_CANVAS_SIDE / Math.max(w, h),
    MAX_ZOOM * PT_TO_PX * 2,          // never larger than the deepest zoom could show
  );
}

/** The largest backing scale a canvas of w × h pt can actually have.
 *  Exported for testing. */
export function clampBackingScale(scale, w, h) {
  const area = smallDevice() ? 16e6 : MAX_CANVAS_AREA;
  return Math.min(scale, Math.sqrt(area / (w * h)), MAX_CANVAS_SIDE / Math.max(w, h));
}

// Keyed by the source object and page index rather than by page id: page
// ids restart per document, and a master is far too expensive to throw
// away on a tab switch the way the thumbnail cache is.
const pageRecords = new WeakMap();     // source -> Map(pageIndex -> record)

function recordFor(src, index) {
  let byIndex = pageRecords.get(src);
  if (!byIndex) pageRecords.set(src, byIndex = new Map());
  let rec = byIndex.get(index);
  if (!rec) {
    rec = {
      src, index,
      heavy: null,          // decided once, on first use
      state: 'none',        // 'none' | 'rendering' | 'done' — the master's
      canvas: null,         // the master, unrotated
      thumb: null,          // small unrotated bitmap; outlives the master
      thumbFailed: false,
      plot: null,           // plot.js record, once the fast path has been tried
      plotFailed: false,    // ... and whether it had to give up
    };
    byIndex.set(index, rec);
  }
  return rec;
}

/** Compressed size of everything the page draws: its content streams plus
 *  any form XObjects it paints, which is where some producers put the
 *  whole sheet. Known as soon as pdf-lib has parsed the file, long before
 *  pdf.js could say how many operators that amounts to. */
function contentBytes(src, index) {
  try {
    const node = src.pdfLibDoc.getPage(index).node;
    const sizeOf = (s) => (typeof s?.getContentsSize === 'function' ? s.getContentsSize() : 0);
    let total = 0;

    const contents = node.Contents();
    if (contents && typeof contents.size === 'function') {
      for (let i = 0; i < contents.size(); i++) total += sizeOf(contents.lookup(i));
    } else {
      total += sizeOf(contents);
    }

    const { PDFName } = PDFLib;
    const xobjects = node.Resources()?.lookup(PDFName.of('XObject'));
    for (const key of xobjects?.keys?.() || []) {
      const x = xobjects.lookup(key);
      if (x?.dict?.get(PDFName.of('Subtype')) === PDFName.of('Form')) total += sizeOf(x);
    }
    return total;
  } catch {
    return 0;       // an odd file is simply treated as an ordinary one
  }
}

/** The record for `page` if it is a heavy one, else null. */
function heavyRecordFor(page) {
  if (!page || page.kind !== 'imported') return null;
  const src = state.sources.find((s) => s.id === page.sourceId);
  if (!src) return null;
  const rec = recordFor(src, page.sourcePageIndex);
  if (rec.heavy === null) {
    rec.heavy = contentBytes(src, page.sourcePageIndex) > HEAVY_CONTENT_BYTES;
  }
  return rec.heavy ? rec : null;
}

/** Draw an unrotated bitmap onto `dest` at page rotation R, filling it.
 *  `/Rotate` is clockwise, so at 90° the bitmap's top-left corner lands
 *  top-right. A missing source just leaves white paper. */
function drawRotated(dest, source, rotation) {
  const ctx = dest.getContext('2d');
  const w = dest.width, h = dest.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (!source || !source.width) return;

  const R = normRot(rotation);
  if (R === 90) ctx.setTransform(0, 1, -1, 0, w, 0);
  else if (R === 180) ctx.setTransform(-1, 0, 0, -1, w, h);
  else if (R === 270) ctx.setTransform(0, -1, 1, 0, 0, h);
  const quarter = R === 90 || R === 270;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, quarter ? h : w, quarter ? w : h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// The heavy page #pageCanvas is currently showing, so a master that is
// still rendering can keep repainting it. Null for every other page.
let shown = null;            // { rec, rotation }

function blitShown(rec) {
  if (!shown || shown.rec !== rec) return;
  drawRotated($('pageCanvas'), rec.canvas, shown.rotation);
}

function setRenderingBadge(on) {
  $('pageStack').classList.toggle('rendering', on);
}

// Masters are large, so only the most recently viewed few are kept.
const masterOrder = [];      // records holding a master, least recent first

function touchMaster(rec) {
  const at = masterOrder.indexOf(rec);
  if (at >= 0) masterOrder.splice(at, 1);
  masterOrder.push(rec);
  for (let i = 0; masterOrder.length > maxMasters() && i < masterOrder.length;) {
    const old = masterOrder[i];
    if (old === rec || old.state !== 'done') { i++; continue; }
    masterOrder.splice(i, 1);
    old.canvas.width = old.canvas.height = 0;   // give the memory back now, not at GC
    old.canvas = null;
    old.state = 'none';
  }
}

// ---------- the plot path ----------
const PLOT_MARGIN = 160;     // CSS px drawn beyond the visible stage, so a scroll has somewhere to go
const PLOT_PROGRESS_MS = 220;

// The plot on screen, and how its page is laid out: { rec, heavy,
// rotation, scale, cssW, cssH }. Null whenever #plotCanvas is hidden.
let shownPlot = null;
let plotEventsOn = false;
let plotRaf = 0, plotTimer = 0, plotDrawnAt = 0;

/** The plot record for a heavy page, or null if it has to use a master. */
function plotFor(heavy) {
  if (heavy.plotFailed || !plotAvailable()) return null;
  if (!plotEventsOn) { plotEventsOn = true; onPlotEvent(onPlotChange); }
  if (!heavy.plot) {
    heavy.plot = plotRecord(heavy.src, heavy.index);
    heavy.plot.owner = heavy;
  }
  return heavy.plot;
}

function onPlotChange(rec, kind) {
  if (kind === 'reset') {              // GPU context lost: every plot is gone
    if (shownPlot) renderMainCanvas();
    return;
  }
  const heavy = rec.owner;
  if (kind === 'failed') {
    // Not an error the user needs to hear about: the master path takes it.
    heavy.plotFailed = true;
    heavy.plot = null;
    if (shownPlot && shownPlot.rec === rec) renderMainCanvas();
    pumpHeavyThumbs();
    return;
  }
  if (kind === 'ready') {
    const b = rec.box;
    heavy.thumb = plotBitmap(rec, thumbBitmapScale(b[2] - b[0], b[3] - b[1]), true);
    paintAllThumbs(++paintGeneration);
  }
  if (!shownPlot || shownPlot.rec !== rec) return;
  if (kind === 'ready') setRenderingBadge(false);
  if (kind !== 'progress') { schedulePlotDraw(); return; }
  // Geometry arrives in dozens of batches; a full-sheet redraw for each
  // would spend the time saved.
  const wait = PLOT_PROGRESS_MS - (performance.now() - plotDrawnAt);
  if (wait <= 0) schedulePlotDraw();
  else if (!plotTimer) plotTimer = setTimeout(() => { plotTimer = 0; schedulePlotDraw(); }, wait);
}

function schedulePlotDraw() {
  if (plotRaf) return;
  plotRaf = requestAnimationFrame(() => { plotRaf = 0; drawShownPlot(); });
}

/** Put #plotCanvas over the part of the page that is on screen and draw
 *  into it. The canvas is only ever as large as the stage, however far the
 *  page is zoomed — that is what lets 800% stay sharp without a backing
 *  store the browser would refuse. */
function drawShownPlot() {
  const sp = shownPlot;
  if (!sp) return;
  const stage = $('canvasStage');
  const canvas = $('plotCanvas');
  const dpr = window.devicePixelRatio || 1;

  const cw = Math.min(sp.cssW, stage.clientWidth + PLOT_MARGIN * 2);
  const ch = Math.min(sp.cssH, stage.clientHeight + PLOT_MARGIN * 2);
  const sr = stage.getBoundingClientRect();
  const pr = $('pageStack').getBoundingClientRect();
  // Snapped to device pixels, so nothing is resampled on its way to the screen.
  const snap = (v) => Math.round(v * dpr) / dpr;
  const left = snap(Math.min(Math.max(sr.left - pr.left - PLOT_MARGIN, 0), sp.cssW - cw));
  const top = snap(Math.min(Math.max(sr.top - pr.top - PLOT_MARGIN, 0), sp.cssH - ch));

  const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.style.left = left + 'px';
  canvas.style.top = top + 'px';

  const m = pageMatrix(sp.rec.box, sp.rotation, sp.scale);
  m[4] -= left; m[5] -= top;
  for (let k = 0; k < 6; k++) m[k] *= dpr;
  plotDrawnAt = performance.now();
  drawPlot(sp.rec, { m, w, h, pxPerPt: sp.scale * dpr });
}

function hidePlot() {
  if (!shownPlot) return;
  shownPlot = null;
  setShownPlot(null);
  $('plotCanvas').style.display = 'none';
}

/** What the plot on screen looks like, as the whole page `width` px wide
 *  at its current rotation. For the tests: a WebGL canvas cannot be read
 *  back after the frame it was drawn in. */
export function shownPlotImage(width) {
  const sp = shownPlot;
  if (!sp || !sp.rec.page) return null;
  const b = sp.rec.box;
  const bmp = plotBitmap(sp.rec, width / (b[2] - b[0]));
  if (!bmp) return null;
  const quarter = normRot(sp.rotation) === 90 || normRot(sp.rotation) === 270;
  const out = document.createElement('canvas');
  out.width = quarter ? bmp.height : bmp.width;
  out.height = quarter ? bmp.width : bmp.height;
  drawRotated(out, bmp, sp.rotation);
  return out;
}

// ---------- the master path ----------
// One heavy render at a time, and a master always outranks a thumbnail.
let heavyJob = null;         // { rec, kind: 'master' | 'thumb', task, cancelled }
let heavyQueue = Promise.resolve();

function cancelHeavyJob() {
  const job = heavyJob;
  if (!job) return;
  heavyJob = null;
  job.cancelled = true;
  if (job.kind === 'master') {
    const at = masterOrder.indexOf(job.rec);
    if (at >= 0) masterOrder.splice(at, 1);
    job.rec.canvas = null;
    job.rec.state = 'none';
  }
  try { job.task?.cancel(); } catch { /* already settled */ }
}

function startHeavyJob(rec, kind) {
  const job = { rec, kind, task: null, cancelled: false };
  heavyJob = job;
  // Chained, so a cancelled render has let go of pdf.js before the next
  // one starts.
  heavyQueue = heavyQueue.then(() => runHeavyJob(job));
}

async function runHeavyJob(job) {
  const { rec, kind } = job;
  let pjPage = null;
  let canvas = null;
  let ticker = null;
  try {
    if (job.cancelled) return;
    pjPage = await rec.src.pdfjsDoc.getPage(rec.index + 1);
    if (job.cancelled) return;

    // rotation: 0 is absolute — it overrides the page's own /Rotate, which
    // is what lets one bitmap serve every rotation.
    const base = pjPage.getViewport({ scale: 1, rotation: 0 });
    const scale = kind === 'master'
      ? masterScale(base.width, base.height)
      : thumbBitmapScale(base.width, base.height);
    const viewport = pjPage.getViewport({ scale, rotation: 0 });
    canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);

    if (kind === 'master') {
      rec.canvas = canvas;
      // The page fills in as pdf.js works through it, which is the only
      // progress report a render this long can give.
      ticker = setInterval(() => blitShown(rec), PROGRESS_BLIT_MS);
    }
    job.task = pjPage.render({ canvasContext: canvas.getContext('2d'), viewport });
    await job.task.promise;
    if (job.cancelled) return;

    if (kind === 'master') {
      rec.state = 'done';
      const t = thumbBitmapScale(base.width, base.height);
      rec.thumb = document.createElement('canvas');
      rec.thumb.width = Math.round(base.width * t);
      rec.thumb.height = Math.round(base.height * t);
      drawRotated(rec.thumb, canvas, 0);
      if (shown && shown.rec === rec) {
        blitShown(rec);
        setRenderingBadge(false);
      }
    } else {
      rec.thumb = canvas;
    }
    paintAllThumbs(++paintGeneration);
  } catch (err) {
    if (!job.cancelled && err?.name !== 'RenderingCancelledException') {
      console.error('large page render failed', err);
      if (kind === 'thumb') rec.thumbFailed = true;
      else setStatus(`Couldn't render that page: ${err.message || err}`, 'err');
    }
  } finally {
    clearInterval(ticker);
    // The whole point: without this pdf.js holds the page's operator list
    // — gigabytes of it — for as long as the document is open.
    try { pjPage?.cleanup(); } catch { /* nothing to release */ }

    if (kind === 'master' && rec.state !== 'done' && canvas) {
      if (rec.canvas === canvas) {
        rec.canvas = null;
        rec.state = 'none';
        const at = masterOrder.indexOf(rec);
        if (at >= 0) masterOrder.splice(at, 1);
        if (shown && shown.rec === rec) setRenderingBadge(false);
      }
      canvas.width = canvas.height = 0;
    }
    if (heavyJob === job) heavyJob = null;
    pumpHeavyThumbs();
  }
}

/** Make sure `rec` has a master, or is on its way to one. */
function ensureMaster(rec) {
  touchMaster(rec);
  if (rec.state !== 'none') return;
  // Whatever is running is either a thumbnail, or the master of a page the
  // user has since left for this one.
  cancelHeavyJob();
  rec.state = 'rendering';
  startHeavyJob(rec, 'master');
}

/** Bitmap scale for a heavy page's thumbnail: enough for the rail at 2x
 *  whichever way round the page ends up. */
function thumbBitmapScale(w, h) {
  return (THUMB_WIDTH * 2) / Math.min(w, h);
}

/** Heavy pages nobody has looked at yet still deserve a thumbnail. Render
 *  them one at a time, small, whenever nothing more urgent is running. */
function pumpHeavyThumbs() {
  for (const page of state.pages) {
    const rec = heavyRecordFor(page);
    if (!rec || rec.thumb || rec.thumbFailed) continue;
    const plot = plotFor(rec);
    if (plot) {
      // Several at once, on the compilers the sheet on screen does not
      // need (plot.js, plotRoom). Each is a few hundred MB of geometry on
      // its way through, so not all of them.
      if (plot.state !== 'none') continue;
      if (!plotRoom()) return;
      startPlot(plot);
      continue;
    }
    if (heavyJob) return;
    if (rec.state !== 'none') continue;
    startHeavyJob(rec, 'thumb');
    return;
  }
}

// ============================================================
// Main canvas
// ============================================================
let renderToken = 0;
let activeRenderTask = null;
// Everything that touches #pageCanvas runs through here, one at a time.
let renderQueue = Promise.resolve();

/** Render the selected page. Safe to call repeatedly and concurrently.
 *
 *  pdf.js permits exactly one render per canvas, and `cancel()` is *not*
 *  synchronous — the task keeps the canvas until its promise settles.
 *  Cancelling and immediately starting the next render therefore throws
 *
 *      Cannot use the same canvas during multiple render() operations
 *
 *  which aborts this function before it reaches the sizing below, leaving
 *  the canvas at its old dimensions and the annotation overlay on pre-zoom
 *  coordinates — the "my document lost its pages" failure. Serialising per
 *  *canvas* is what matters: rapid page switches and zooms render
 *  different pages to the same one, so a lock keyed by page gives no
 *  mutual exclusion at all.
 */
export function renderMainCanvas(opts = {}) {
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  const emptyState = $('emptyState');
  const pageStack = $('pageStack');

  // One frame of a zoom changes nothing the toolbar shows but the
  // percentage, which the layout below updates itself. Redrawing the
  // whole command surface sixty times a second — the markups list
  // included — is what a zoom has no time for.
  const resizing = !!page && !!held && held.page === page && held.rotation === page.rotation;
  if (!(opts.zooming && resizing)) updateToolbarState();

  if (!page) {
    shown = null;
    held = null;
    hidePlot();
    emptyState.style.display = 'block';
    pageStack.style.display = 'none';
    return Promise.resolve();
  }
  emptyState.style.display = 'none';
  pageStack.style.display = 'block';

  const token = ++renderToken;
  // Ask the in-flight render to wind up so the queue drains promptly. The
  // *waiting* is the queue's job, not ours.
  if (activeRenderTask) {
    try { activeRenderTask.cancel(); } catch { /* already settled */ }
  }
  wakeSettle();
  stopAhead();

  // Resizing: the canvas already shows this page, this way up, and only
  // its size is changing. Lay it out at the new size *now*, in this call,
  // with the pixels it has — the browser stretches them — and let the
  // sharp ones follow. That is what makes a zoom read as one movement:
  // every frame of it is on screen the moment it is asked for, instead of
  // waiting its turn behind a pdf.js render that is about to be thrown
  // away. See paintPage for the other half.
  if (resizing) layoutPage(page, opts);

  const run = renderQueue.then(() => paintPage(page, token, opts, resizing));
  renderQueue = run.then(() => {}, () => {});   // a failure must not jam the queue
  return run;
}

// What #pageCanvas is showing: { page, rotation, backing } once a page has
// been drawn into it in full, null while it holds anything else. Keyed by
// the page object, like every other cache here — ids restart per document.
// `backing` is the resolution it was drawn at, so a call that changes
// nothing about the pixels (an undo, a markup edit) draws none.
let held = null;

// The pause before a resized page is redrawn sharp. A zoom arrives as a
// burst of sizes a few milliseconds apart; starting a full-resolution
// pdf.js render for each, only to cancel it, is work that shows up as
// dropped frames. So the sharp render waits until the sizes stop coming.
const ZOOM_SETTLE_MS = 90;
let wakeSettle = () => {};
const settle = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  // The next render does not wait this one's pause out.
  wakeSettle = () => { clearTimeout(timer); resolve(); };
});

// ---- The pages either side, drawn ahead ----
//
// Turning a page waited for pdf.js: 75–200 ms on an ordinary drawing
// sheet, every time. So once a page has been drawn and nothing else is
// asked for, the pages before and after it are drawn too, out of sight, at
// the size they will be shown — and the arrow key that turns to one of
// them copies it in.
//
// Only ordinary pages (heavy ones have their own cache, plot.js), and
// not at zooms where each copy would be a large share of memory. Anything
// else the user asks for stops it at once (stopAhead, from
// renderMainCanvas), so it never delays what is on screen.
const AHEAD_MS = 150;                // after the page on screen settles
const AHEAD_MAX_PIXELS = 24e6;       // ~96 MB a copy; beyond this, don't
const ahead = new Map();             // page -> { rotation, backing, canvas }
let aheadTimer = 0;
let aheadTask = null;
let aheadRun = 0;

function stopAhead() {
  clearTimeout(aheadTimer);
  aheadRun++;
  if (aheadTask) {
    try { aheadTask.cancel(); } catch { /* already settled */ }
    aheadTask = null;
  }
}

const aheadBacking = (page) => {
  const { w: Wv, h: Hv } = visualSize(page.rotation, page.W0, page.H0);
  return clampBackingScale(scaleFor(page) * (window.devicePixelRatio || 1), Wv, Hv);
};

/** The copy of `page` drawn ahead, if it is still the right one. It is
 *  handed over, not shared: the cache lets go of it. */
function takeAhead(page, backing) {
  const hit = ahead.get(page);
  if (!hit) return null;
  ahead.delete(page);
  if (hit.rotation === page.rotation && hit.backing === backing) return hit.canvas;
  hit.canvas.width = hit.canvas.height = 0;
  return null;
}

function drawAheadSoon(from) {
  clearTimeout(aheadTimer);
  const run = ++aheadRun;
  const go = () => {
    if (run !== aheadRun) return;
    // The thumbnail rail first: it is on screen, and these are not yet.
    if (thumbsDoneGeneration !== paintGeneration) { aheadTimer = setTimeout(go, AHEAD_MS); return; }
    // Through the render queue, so it never shares pdf.js with a page
    // render that is on its way to the screen.
    renderQueue = renderQueue.then(() => drawAhead(from, run)).then(() => {}, () => {});
  };
  aheadTimer = setTimeout(go, AHEAD_MS);
}

async function drawAhead(from, run) {
  const at = state.pages.indexOf(from);
  if (at < 0 || run !== aheadRun) return;
  const wanted = [state.pages[at + 1], state.pages[at - 1]].filter(Boolean);
  // Let go of copies that are no longer either side of the page on screen.
  for (const [page, hit] of ahead) {
    if (!wanted.includes(page)) { hit.canvas.width = hit.canvas.height = 0; ahead.delete(page); }
  }
  for (const page of wanted) {
    if (run !== aheadRun) return;
    if (page.kind !== 'imported' || heavyRecordFor(page)) continue;
    const backing = aheadBacking(page);
    const have = ahead.get(page);
    if (have && have.rotation === page.rotation && have.backing === backing) continue;
    const { w: Wv, h: Hv } = visualSize(page.rotation, page.W0, page.H0);
    if (Wv * Hv * backing * backing > AHEAD_MAX_PIXELS) continue;
    const src = state.sources.find((s) => s.id === page.sourceId);
    if (!src) continue;
    const pjPage = await src.pdfjsDoc.getPage(page.sourcePageIndex + 1);
    if (run !== aheadRun) return;
    const viewport = pjPage.getViewport({ scale: backing, rotation: normRot(page.rotation) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    aheadTask = pjPage.render({ canvasContext: canvas.getContext('2d'), viewport });
    try {
      await aheadTask.promise;
    } catch {
      canvas.width = canvas.height = 0;     // stopped, or failed: either way, not kept
      return;
    } finally {
      aheadTask = null;
    }
    if (run !== aheadRun) { canvas.width = canvas.height = 0; return; }
    if (have) have.canvas.width = have.canvas.height = 0;
    ahead.set(page, { rotation: page.rotation, backing, canvas });
  }
}

/** Size and place everything for `page` at the current zoom: the canvas's
 *  box, the stack, the markup layer and the scroll position. No pixels —
 *  whatever #pageCanvas holds is stretched to the new box. */
function layoutPage(page, opts) {
  // The markup layer is about to be rebuilt; a note being typed into
  // would go with it, text and all.
  finishTyping();
  const pageStack = $('pageStack');
  const { w: Wv, h: Hv } = visualSize(page.rotation, page.W0, page.H0);
  const scale = computeScale(page);
  state.currentScale = scale;
  updateZoomReadout();

  // Record the scroll anchor before the page resizes under us.
  const stage = $('canvasStage');
  const prevW = pageStack.offsetWidth || 1;
  const prevH = pageStack.offsetHeight || 1;
  const anchorX = opts.anchor ? opts.anchor.x : stage.clientWidth / 2;
  const anchorY = opts.anchor ? opts.anchor.y : stage.clientHeight / 2;
  const relX = (stage.scrollLeft + anchorX) / prevW;
  const relY = (stage.scrollTop + anchorY) / prevH;

  const cssW = Math.round(Wv * scale);
  const cssH = Math.round(Hv * scale);

  // Backing store is at device resolution; layout stays in logical px so
  // the annotation overlay's pt * currentScale math is unaffected.
  const canvas = $('pageCanvas');
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  pageStack.style.width = cssW + 'px';
  pageStack.style.height = cssH + 'px';
  pageStack.style.transform = '';

  const overlay = $('annoLayer');
  overlay.style.width = cssW + 'px';
  overlay.style.height = cssH + 'px';
  $('leaderSvg').setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);
  $('hiliteSvg').setAttribute('viewBox', `0 0 ${cssW} ${cssH}`);

  renderAnnotationLayer(page);

  // Restore the anchor point to roughly where it was pre-zoom.
  if (opts.anchor || state.zoomMode === 'custom') {
    stage.scrollLeft = relX * cssW - anchorX;
    stage.scrollTop = relY * cssH - anchorY;
  }
  return { scale, cssW, cssH, Wv, Hv };
}

async function paintPage(page, token, opts, resizing) {
  // Superseded while queued: a newer call is already on its way.
  if (token !== renderToken) return;

  const pageStack = $('pageStack');
  const canvas = $('pageCanvas');
  const ctx = canvas.getContext('2d');

  // Layout first, pixels after. A page being resized was laid out by
  // renderMainCanvas already and must not be again: by now the user may
  // be dragging a note that a rebuild of the markup layer would drop.
  let L;
  if (resizing) {
    const { w: Wv, h: Hv } = visualSize(page.rotation, page.W0, page.H0);
    const scale = state.currentScale;
    L = { scale, cssW: Math.round(Wv * scale), cssH: Math.round(Hv * scale), Wv, Hv };
  } else {
    // A different page, or this one turned: what the canvas holds is not
    // this page at any size. Blank it before the new layout is seen, so
    // the last page's pixels are never shown under this page's markups.
    held = null;
    canvas.width = canvas.height = 2;
    L = layoutPage(page, opts);
  }
  const { scale, cssW, cssH, Wv, Hv } = L;

  const dpr = window.devicePixelRatio || 1;
  // Past the browser's canvas limits the backing store stops growing and
  // the CSS size alone carries the zoom. A large sheet at 800% would
  // otherwise ask for a canvas Chrome silently declines to draw into.
  const backing = clampBackingScale(scale * dpr, Wv, Hv);

  const heavy = heavyRecordFor(page);
  let plot = heavy ? plotFor(heavy) : null;
  if (plot) {
    // A page the fast path cannot take says so at once; the master path
    // then has it within this same paint.
    startPlot(plot);
    if (heavy.plotFailed) plot = null;
  }
  shown = heavy && !plot ? { rec: heavy, rotation: page.rotation } : null;
  setRenderingBadge(false);
  if (!plot) hidePlot();

  if (page.kind === 'blank') {
    canvas.width = Math.round(Wv * backing);
    canvas.height = Math.round(Hv * backing);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else if (plot) {
    // Drawn by the GPU into #plotCanvas, below. #pageCanvas stays in the
    // layout at full size — the annotation code measures against it — but
    // has nothing to show, so it needs no backing store to speak of.
    canvas.width = canvas.height = 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 2, 2);
    shownPlot = { rec: plot, heavy, rotation: page.rotation, scale, cssW, cssH };
    setShownPlot(plot);
    $('plotCanvas').style.display = 'block';
    setRenderingBadge(plot.state !== 'ready');
  } else if (heavy) {
    // No pdf.js here: the page is drawn from its master, which may still
    // be filling in. Everything else — layout, the annotation layer —
    // carries on regardless, so the page can be marked up while it does.
    ensureMaster(heavy);
    const s = Math.min(backing, masterScale(page.W0, page.H0));
    canvas.width = Math.round(Wv * s);
    canvas.height = Math.round(Hv * s);
    drawRotated(canvas, heavy.canvas, page.rotation);
    setRenderingBadge(heavy.state !== 'done');
  } else {
    // An ordinary page, through pdf.js. Resized, it is redrawn out of
    // sight and swapped in whole: drawing straight onto the canvas would
    // clear it first, and the page would blink white at every step of a
    // zoom. And not until the sizes have stopped coming.
    if (resizing) {
      // Already sharp at this size: there is nothing to draw — but the
      // pages either side may have been interrupted on their way.
      if (held.backing === backing) { drawAheadSoon(page); return; }
      await settle(ZOOM_SETTLE_MS);
      if (token !== renderToken) return;
    }
    // Drawn already, while the last page was being looked at: the step
    // to it is a copy, not a render.
    const early = takeAhead(page, backing);
    if (early) {
      canvas.width = early.width;
      canvas.height = early.height;
      ctx.drawImage(early, 0, 0);
      early.width = early.height = 0;
      held = { page, rotation: page.rotation, backing };
      drawAheadSoon(page);
      return;
    }
    const src = state.sources.find((s) => s.id === page.sourceId);
    const pjPage = await src.pdfjsDoc.getPage(page.sourcePageIndex + 1);
    if (token !== renderToken) return;
    // rotation here is absolute — it overrides the page's own /Rotate
    const viewport = pjPage.getViewport({ scale: backing, rotation: normRot(page.rotation) });
    const target = resizing ? document.createElement('canvas') : canvas;
    target.width = Math.round(viewport.width);
    target.height = Math.round(viewport.height);
    const task = pjPage.render({ canvasContext: target.getContext('2d'), viewport });
    activeRenderTask = task;
    try {
      await task.promise;
    } catch (err) {
      if (target !== canvas) target.width = target.height = 0;      // give the memory back now
      if (err && err.name === 'RenderingCancelledException') return;
      // Loud, but not fatal: one failed render must not reject the promise
      // every caller ignores, and must not stop the queue.
      console.error('page render failed', err);
      return;
    } finally {
      if (activeRenderTask === task) activeRenderTask = null;
    }
    if (token !== renderToken) {
      if (target !== canvas) target.width = target.height = 0;
      return;
    }
    if (target !== canvas) {
      canvas.width = target.width;
      canvas.height = target.height;
      ctx.drawImage(target, 0, 0);
      target.width = target.height = 0;
    }
  }
  held = { page, rotation: page.rotation, backing };
  drawAheadSoon(page);

  // Last, once the page has its final size and scroll position: the plot
  // canvas is placed by where the page actually sits in the stage.
  if (shownPlot) drawShownPlot();
}

// ============================================================
// Gestures: pinch zoom, trackpad zoom, space-drag pan
// ============================================================
export function installStageGestures(onPageStep) {
  const stage = $('canvasStage');
  const pageStack = $('pageStack');

  // --- Wheel ---
  //
  // What a plain wheel does depends on the fit mode the user picked, and
  // on whether a double-click has latched wheel-zoom on:
  //
  //              plain wheel     Ctrl + wheel
  //   Fit Pg     change page     zoom
  //   Fit W      zoom            scroll
  //   zoom mode  zoom            scroll
  //
  // Cmd + wheel always zooms, whatever the mode.
  //
  // A Mac trackpad pinch arrives as a wheel event with ctrlKey set and is
  // otherwise indistinguishable from a real Ctrl+wheel — so track whether
  // Ctrl is physically down. Without this, pinch-to-zoom would silently
  // turn into a scroll in Fit W, which is the default mode.
  // A plot is drawn only where it is visible, so it follows the scroll.
  stage.addEventListener('scroll', () => { if (shownPlot) schedulePlotDraw(); }, { passive: true });

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
    // A pinch is already a stream of small steps and must track the
    // fingers. A wheel notch is one big step: it moves the *goal*, and the
    // page glides after it, so a spin of the wheel is one smooth zoom.
    if (fine) setZoomLevel(state.zoomLevel * Math.exp(-d * 0.01), anchor, { instant: true });
    else setZoomLevel(zoomGoal() * Math.exp(-d * 0.01), anchor);
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

    // Latched by a double-click on the page: the wheel zooms and nothing
    // else, whatever the fit mode says. Ctrl still scrolls, so a zoomed-in
    // page is still navigable without leaving the mode.
    if (state.wheelZoom) {
      e.preventDefault();
      if (e.ctrlKey) {
        const k = e.deltaMode === 1 ? 16 : 1;
        stage.scrollTop += e.deltaY * k;
        stage.scrollLeft += e.deltaX * k;
      } else {
        zoomBy(e, false);
      }
      return;
    }

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
      // The transform has been showing this size all along; cut to it.
      if (Math.abs(ratio - 1) > 0.01) setZoomLevel(had.zoom * ratio, had.anchor, { instant: true });
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
       ['ink-stroke', 'ink-hit', 'tip-handle', 'pt-handle']
         .some((c) => target.classList?.contains(c)));

  // --- Double-click to latch the wheel into zoom ---
  stage.addEventListener('dblclick', (e) => {
    // Only the plain pointer mode. With a tool active a double-click means
    // something else — placing, or opening a note for editing — and notes,
    // strokes and handles all own their own double-click.
    if (state.activeTool !== 'select') return;
    if (ownsTheDrag(e.target)) return;
    setWheelZoom(!state.wheelZoom);
  });

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
  if (!el) return false;
  // A checkbox takes focus when it is clicked but is not somewhere to
  // type; treating it as one left every shortcut dead until the next click.
  if (el.tagName === 'INPUT' && /^(checkbox|radio|button)$/.test(el.type)) return false;
  return !!(el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

// ============================================================
// Thumbnails
// ============================================================
// Cache keyed by the page *object*; invalidated when the page's rotation
// changes, so reordering pages costs no pdf.js work at all.
//
// Not by page id. Ids restart at 1 in every document, so an id-keyed cache
// hands one document's thumbnail to another's page whenever the live
// document is replaced without a flush — and that has happened twice: on a
// tab switch, and when (in the days of saved sessions) a restore landed on
// top of a file opened from Finder, leaving that file's thumbnail on a
// page it did not belong to. An object can only ever be itself.
let thumbCache = new WeakMap();

export function invalidateThumb(pageId) {
  const page = state.pages.find((p) => p.id === pageId);
  if (page) thumbCache.delete(page);       // a deleted page takes its entry with it
}
export function invalidateAllThumbs() { thumbCache = new WeakMap(); }

async function paintThumbCanvas(page) {
  const cached = thumbCache.get(page);
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
    const heavy = heavyRecordFor(page);
    if (heavy) {
      // Never through pdf.js from here — see "Heavy pages" above.
      canvas.width = Math.round(w * scale * dpr);
      canvas.height = Math.round(h * scale * dpr);
      drawRotated(canvas, heavy.thumb, page.rotation);
      // Not cached while it is still a blank: the rail is repainted when
      // the real bitmap arrives, and must not find the placeholder.
      if (!heavy.thumb) return canvas;
    } else {
      const pjPage = await src.pdfjsDoc.getPage(page.sourcePageIndex + 1);
      const viewport = pjPage.getViewport({ scale: scale * dpr, rotation: normRot(page.rotation) });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await pjPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
  }
  thumbCache.set(page, { rotation: page.rotation, canvas });
  return canvas;
}

let paintGeneration = 0;
// The generation whose thumbnails have all been painted. While it lags
// paintGeneration the rail is still filling in, and the pages drawn ahead
// wait for it (drawAheadSoon): a full-size render next door slowed the
// last thumbnails of a newly opened file noticeably.
let thumbsDoneGeneration = 0;

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
  thumbsDoneGeneration = generation;
  pumpHeavyThumbs();
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

// Drawn, not typed: a rotate arrow that is a text character changes
// weight and baseline from one platform's font to the next.
const thumbIcon = (d) => `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">`
  + `<path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
const THUMB_ICON = {
  ccw: thumbIcon('M3.2 7.5a4.3 4.3 0 108-2.2M3 3.2v3h3'),
  cw: thumbIcon('M10.8 7.5a4.3 4.3 0 11-8-2.2M11 3.2v3h-3'),
  del: thumbIcon('M3.5 3.5l7 7M10.5 3.5l-7 7'),
};

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
      `<button class="mini-btn" data-act="ccw" title="Rotate this page in the document, counter-clockwise" aria-label="Rotate page ${i + 1} counter-clockwise in the document">${THUMB_ICON.ccw}</button>` +
      `<button class="mini-btn" data-act="cw" title="Rotate this page in the document, clockwise" aria-label="Rotate page ${i + 1} clockwise in the document">${THUMB_ICON.cw}</button>` +
      `<button class="mini-btn del" data-act="del" title="Delete this page from the document" aria-label="Delete page ${i + 1}">${THUMB_ICON.del}</button>` +
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

  // Every change to what is open comes through here, which makes it the
  // place to give back the GPU memory of documents that have closed.
  sweepPlots((src) => state.sources.includes(src)
    || state.docs.some((d) => d.id !== state.activeDocId && d.sources.includes(src)));
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
// The rest of the command surface — properties, page field, undo, save
// state — is drawn by chrome.js, which registers itself here. It imports
// this module, so this module cannot import it.
let afterToolbarUpdate = null;
export function onToolbarUpdate(fn) { afterToolbarUpdate = fn; }

export function updateToolbarState() {
  const page = state.pages.find((p) => p.id === state.selectedPageId);
  const hasPage = !!page;
  const hasDoc = state.pages.length > 0;

  for (const id of ['btnRotateCCW', 'btnRotateCW', 'btnDeletePage', 'toolSelect', 'toolText',
                    'toolCallout', 'toolPen', 'toolHighlight', 'toolArrow', 'toolRect', 'toolCloud',
                    'btnZoomIn', 'btnZoomOut', 'btnFitWidth', 'btnFitPage']) {
    const el = $(id);
    if (el) el.disabled = !hasPage;
  }
  for (const id of ['btnSave', 'btnSaveAs', 'btnDownload', 'btnFlatten', 'btnClearAll']) {
    const el = $(id);
    if (el) el.disabled = !hasDoc;
  }

  updateZoomReadout();
  if (afterToolbarUpdate) afterToolbarUpdate();
}

export function updateTitle() {
  const name = $('docTitle');
  if (name) name.textContent = state.docName;
  const dot = $('dirtyDot');
  if (dot) dot.style.display = state.dirty ? '' : 'none';
  document.title = (state.dirty ? '• ' : '') + state.docName + ' — Redline';
}
