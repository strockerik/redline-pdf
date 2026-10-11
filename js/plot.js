/* The fast path for heavy vector pages: compile once in a worker, then
 * draw on the GPU (plotcompile.js, plotworker.js, plotgl.js).
 *
 * This file is the part that knows about documents. It pulls a page's
 * content streams and the few resources the compiler needs out of pdf-lib,
 * hands them to the worker, uploads the geometry as it comes back, and
 * builds the small "residual" PDF — the page's text and images, with the
 * linework taken out — that pdf.js draws into textures.
 *
 * Nothing here knows about zoom modes, tabs or annotations: view.js asks
 * for a record, tells it where the page is on screen, and is called back
 * when there is more to show.
 */
import { createPlotRenderer } from './plotgl.js';
import { LAYER_PREFIX, TEXT_LAYER } from './plotcompile.js';

// Geometry kept on the GPU across pages. A large sheet is ~300 MB of it;
// past the budget the page viewed longest ago is dropped and compiled
// again (a second or two) if it is ever wanted back.
const smallDevice = () => !!window.matchMedia?.('(pointer: coarse)').matches;
const geometryBudget = () => (smallDevice() ? 200e6 : navigator.deviceMemory <= 4 ? 350e6 : 700e6);

const LAYER_PIXELS = 4e6;          // per residual layer bitmap
const OVERVIEW_PIXELS = 6e6;       // the whole-page stand-in shown while the view moves
const MAX_LAYERS = 24;
const HEAVY_FORM_BYTES = 2e6;      // a form XObject this large is the page, and pdf.js would draw it
// A redraw of more instances than this is too slow to do on every frame
// of a zoom, so the overview stands in until the view comes to rest.
const DIRECT_INSTANCES = 2e6;
const SETTLE_MS = 140;

// ============================================================
// Renderer and worker, both created on first use
// ============================================================
let renderer;                       // undefined: not tried; null: unavailable

function getRenderer() {
  if (renderer !== undefined) return renderer;
  renderer = null;
  try {
    const canvas = document.getElementById('plotCanvas');
    if (canvas) renderer = createPlotRenderer(canvas);
  } catch (err) {
    console.warn('plot renderer unavailable', err);
  }
  // A lost context takes every buffer and texture with it.
  renderer?.onReset(() => {
    for (const rec of live) { rec.gen++; rec.page = null; rec.doc = null; rec.state = 'none'; }
    onCanvas = { rec: null, sig: '' };
    live.clear();
    jobs.clear();
    emit(null, 'reset');
  });
  return renderer;
}

/** Can this browser run the fast path at all? */
export function plotAvailable() {
  if (typeof Worker === 'undefined' || typeof DecompressionStream === 'undefined') return false;
  const r = getRenderer();
  return !!r && !r.isLost();
}

let worker = null;
let nextJob = 1;
const jobs = new Map();             // job id -> record

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./plotworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => {
    // The worker itself is broken (it failed to load, say). Nothing queued
    // on it will ever answer.
    console.warn('plot worker failed', e.message || e);
    for (const rec of [...jobs.values()]) fail(rec, 'worker failed');
    worker = null;
  };
  return worker;
}

// pdf.js for the residual documents gets a worker of its own, so a label
// layer never queues behind a large document being parsed for another tab.
let residualWorker = null;
const getResidualWorker = () => (residualWorker ||= new pdfjsLib.PDFWorker({ name: 'redline-plot' }));

// ============================================================
// Records
// ============================================================
const records = new WeakMap();      // source -> Map(pageIndex -> record)
const live = new Set();             // records holding GPU memory
let clock = 0;

const listeners = [];
/** fn(record, kind) — kind is 'progress', 'ready', 'failed', or 'reset'
 *  (record null: the GPU context was lost and everything is gone). */
export function onPlotEvent(fn) { listeners.push(fn); }
function emit(rec, kind) { for (const fn of listeners) fn(rec, kind); }

export function plotRecord(src, index) {
  let byIndex = records.get(src);
  if (!byIndex) records.set(src, byIndex = new Map());
  let rec = byIndex.get(index);
  if (!rec) {
    rec = {
      src, index,
      state: 'none',          // 'none' | 'compiling' | 'ready' | 'failed'
      gen: 0,                 // bumped whenever the GPU side is thrown away
      job: 0, page: null, box: null,
      doc: null, task: null, pjPage: null,
      used: 0, view: null, settleTimer: 0,
      stats: null, ms: 0,
    };
    byIndex.set(index, rec);
  }
  return rec;
}

export const plotBusy = () => jobs.size > 0;

/** Begin compiling, if that has not already happened. */
export function startPlot(rec) {
  if (rec.state !== 'none') return;
  const r = getRenderer();
  let input = null;
  try {
    input = prepare(rec.src, rec.index);
  } catch (err) {
    console.warn('plot: page not usable', err);
  }
  if (!r || !input) { rec.state = 'failed'; emit(rec, 'failed'); return; }

  rec.state = 'compiling';
  rec.box = input.box;
  rec.page = r.createPage();
  rec.job = nextJob++;
  rec.used = ++clock;
  live.add(rec);
  jobs.set(rec.job, rec);
  getWorker().postMessage(
    { type: 'compile', id: rec.job, streams: input.streams, res: input.res, box: input.box },
    input.streams.map((s) => s.bytes.buffer),
  );
}

function onWorkerMessage(m) {
  const rec = jobs.get(m.id);
  if (!rec) return;                 // released while the worker was busy
  const r = getRenderer();
  if (m.type === 'chunks') {
    for (const c of m.chunks) r.addChunk(rec.page, c);
    if (rec.page.bytes > geometryBudget()) { fail(rec, 'page too large for this device'); return; }
    emit(rec, 'progress');
  } else if (m.type === 'poly') {
    r.addClipPoly(rec.page, m.polyId, m.tris);
  } else if (m.type === 'done') {
    jobs.delete(m.id);
    finish(rec, m);
  } else if (m.type === 'fail') {
    fail(rec, `${m.stage}: ${m.reason}`);
  }
}

async function finish(rec, m) {
  const gen = rec.gen;
  rec.stats = m.stats;
  rec.ms = m.ms;
  emit(rec, 'progress');            // every line is in; show it without waiting for labels
  try {
    const layers = m.layers.map((box, k) => ({ box, k })).filter((l) => l.box);
    if (layers.length > MAX_LAYERS) throw new Error('too many image layers');
    // An empty list is what a page is left with once Redline's own markups
    // have been lifted out of it; it is not a reason to draw a text layer.
    const annots = rec.src.pdfLibDoc.getPage(rec.index).node.Annots();
    const hasAnnots = !!annots && annots.size() > 0;
    if (layers.length || m.text || hasAnnots) {
      await buildResidual(rec, m.residual, m.layers.length);
      if (rec.gen !== gen) return;
      const r = getRenderer();
      for (const { box, k } of layers) {
        const area = (box[2] - box[0]) * (box[3] - box[1]);
        const scale = Math.min(4, Math.sqrt(LAYER_PIXELS / area), r.maxTextureSize / Math.max(box[2] - box[0], box[3] - box[1]));
        const bmp = await rasterize(rec, LAYER_PREFIX + k, box, scale, false);
        if (rec.gen !== gen) return;
        r.setLayer(rec.page, k, bmp.canvas, bmp.rect);
        emit(rec, 'progress');
      }
      if (m.text || hasAnnots) {
        const b = rec.box;
        const scale = Math.sqrt(LAYER_PIXELS / ((b[2] - b[0]) * (b[3] - b[1])));
        // Annotations already in the file are drawn with the text, on top.
        const bmp = await rasterize(rec, TEXT_LAYER, b, scale, true);
        if (rec.gen !== gen) return;
        r.setText(rec.page, 'base', bmp.canvas, bmp.rect, scale);
      }
    }
    {
      const b = rec.box;
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      let s = Math.sqrt(OVERVIEW_PIXELS / area);
      // If the whole page is on screen right now, make the overview at
      // exactly that size: it is then indistinguishable from the real
      // draw, and nothing shifts when one replaces the other.
      const v = rec.view;
      if (v && v.visible[0] <= b[0] && v.visible[1] <= b[1] && v.visible[2] >= b[2] && v.visible[3] >= b[3]) {
        s = Math.min(Math.max(v.pxPerPt, s / 2), s * 1.3);
      }
      const w = Math.round((b[2] - b[0]) * s), h = Math.round((b[3] - b[1]) * s);
      getRenderer().makeOverview(rec.page, { m: pageMatrix(b, 0, s), w, h, pxPerPt: s, visible: b, minW: 1 });
    }
    rec.state = 'ready';
    emit(rec, 'ready');
    enforceBudget(rec);
  } catch (err) {
    if (rec.gen === gen) fail(rec, err.message || String(err));
  }
}

function fail(rec, reason) {
  console.warn(`plot: falling back for page ${rec.index + 1} — ${reason}`);
  release(rec);
  rec.state = 'failed';
  emit(rec, 'failed');
}

function release(rec) {
  rec.gen++;
  clearTimeout(rec.settleTimer);
  if (jobs.has(rec.job)) {
    jobs.delete(rec.job);
    worker?.postMessage({ type: 'cancel', id: rec.job });
  }
  if (rec.page) getRenderer()?.releasePage(rec.page);
  rec.page = null;
  // Destroying the loading task is what lets pdf.js drop the document.
  try { rec.task?.destroy(); } catch { /* already gone */ }
  rec.task = rec.doc = rec.pjPage = null;
  rec.view = null;
  if (onCanvas.rec === rec) onCanvas = { rec: null, sig: '' };
  rec.state = 'none';
  live.delete(rec);
}

let shownRec = null;
/** The record on screen is never the one evicted. */
export function setShownPlot(rec) { shownRec = rec; }

function enforceBudget(keep) {
  let total = 0;
  for (const rec of live) total += rec.page ? rec.page.bytes : 0;
  while (total > geometryBudget()) {
    let oldest = null;
    for (const rec of live) {
      if (rec === keep || rec === shownRec || rec.state !== 'ready') continue;
      if (!oldest || rec.used < oldest.used) oldest = rec;
    }
    if (!oldest) break;
    total -= oldest.page.bytes;
    release(oldest);
  }
}

/** Drop the plots of documents that are no longer open. */
export function sweepPlots(isAlive) {
  for (const rec of [...live]) if (rec !== shownRec && !isAlive(rec.src)) release(rec);
}

// ============================================================
// What the compiler needs from the page
// ============================================================
/** Content streams and reduced resources for one page, or null when the
 *  page uses something the fast path does not handle. */
function prepare(src, index) {
  const { PDFName, PDFArray, PDFDict, PDFRawStream, PDFNumber, PDFRef } = PDFLib;
  const N = (s) => PDFName.of(s);
  const doc = src.pdfLibDoc;
  const node = doc.getPage(index).node;
  const num = (o) => (o instanceof PDFNumber ? o.asNumber() : undefined);
  const key = (name) => name.decodeText();

  // pdf.js lays the page out on CropBox ∩ MediaBox; so must we.
  const rect = (arr) => {
    if (!(arr instanceof PDFArray) || arr.size() < 4) return null;
    const v = [0, 1, 2, 3].map((i) => num(arr.lookup(i)) || 0);
    return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  };
  const media = rect(node.MediaBox()) || [0, 0, 612, 792];
  const crop = rect(node.CropBox());
  let box = media;
  if (crop) {
    const b = [Math.max(media[0], crop[0]), Math.max(media[1], crop[1]), Math.min(media[2], crop[2]), Math.min(media[3], crop[3])];
    if (b[2] > b[0] && b[3] > b[1]) box = b;
  }

  // ---- content streams ----
  const contents = node.Contents();
  const list = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i))
    : [contents];
  const streams = [];
  for (const s of list) {
    if (!(s instanceof PDFRawStream)) return null;
    let filter = s.dict.lookup(N('Filter'));
    if (filter instanceof PDFArray) {
      if (filter.size() > 1) return null;
      filter = filter.size() ? filter.lookup(0) : undefined;
    }
    if (filter && filter !== N('FlateDecode')) return null;
    let parms = s.dict.lookup(N('DecodeParms'));
    if (parms instanceof PDFArray) parms = parms.size() ? parms.lookup(0) : undefined;
    if (parms instanceof PDFDict && (num(parms.lookup(N('Predictor'))) || 1) > 1) return null;
    // A copy: the worker takes ownership, and pdf-lib still needs its own.
    streams.push({ bytes: s.contents.slice(), flate: !!filter });
  }

  // ---- optional content: which layers are switched off ----
  const off = new Set(), on = new Set();
  let baseOff = false;
  const ocp = doc.catalog.lookup(N('OCProperties'));
  const dflt = ocp instanceof PDFDict ? ocp.lookup(N('D')) : null;
  if (dflt instanceof PDFDict) {
    baseOff = dflt.lookup(N('BaseState')) === N('OFF');
    const collect = (arr, into) => {
      if (arr instanceof PDFArray) for (const r of arr.asArray()) if (r instanceof PDFRef) into.add(r.tag);
    };
    collect(dflt.lookup(N('OFF')), off);
    collect(dflt.lookup(N('ON')), on);
  }
  const groupHidden = (ref) => ref instanceof PDFRef && (off.has(ref.tag) || (baseOff && !on.has(ref.tag)));
  /** `ref` is how the dictionary was referred to; an OCG is known by it. */
  const hiddenBy = (ref, dict) => {
    if (!(dict instanceof PDFDict)) return false;
    if (dict.lookup(N('Type')) !== N('OCMD')) return groupHidden(ref);
    let members = dict.get(N('OCGs'));
    if (members instanceof PDFRef && !(dict.lookup(N('OCGs')) instanceof PDFArray)) members = [members];
    else members = dict.lookup(N('OCGs')) instanceof PDFArray ? dict.lookup(N('OCGs')).asArray() : [];
    if (!members.length) return false;
    const hidden = members.map(groupHidden);
    const policy = dict.lookup(N('P'));
    if (policy === N('AllOn')) return hidden.some(Boolean);
    if (policy === N('AnyOff')) return !hidden.some(Boolean);
    if (policy === N('AllOff')) return !hidden.every(Boolean);
    return hidden.every(Boolean);                       // AnyOn, the default
  };

  // ---- resources ----
  const res = { gs: {}, cs: {}, hidden: {}, xobj: {} };
  const R = node.Resources();
  const sub = (name) => {
    const d = R ? R.lookup(N(name)) : null;
    return d instanceof PDFDict ? d : null;
  };

  const gs = sub('ExtGState');
  if (gs) for (const [k, v] of gs.entries()) {
    const d = gs.lookup(k);
    if (!(d instanceof PDFDict)) continue;
    const g = {};
    const put = (field, pdfKey) => { const x = num(d.lookup(N(pdfKey))); if (x !== undefined) g[field] = x; };
    put('lw', 'LW'); put('cap', 'LC'); put('join', 'LJ'); put('miter', 'ML'); put('CA', 'CA'); put('ca', 'ca');
    const dash = d.lookup(N('D'));
    if (dash instanceof PDFArray && dash.size() === 2 && dash.lookup(0) instanceof PDFArray) {
      g.dash = [dash.lookup(0).asArray().map((x) => num(x) || 0), num(dash.lookup(1)) || 0];
    }
    let bm = d.lookup(N('BM'));
    if (bm instanceof PDFArray) bm = bm.size() ? bm.lookup(0) : undefined;
    if (bm) g.bm = bm !== N('Normal') && bm !== N('Compatible');
    const sm = d.lookup(N('SMask'));
    if (sm) g.sm = sm !== N('None');
    res.gs[key(k)] = g;
    void v;
  }

  const cs = sub('ColorSpace');
  if (cs) for (const [k] of cs.entries()) {
    const v = cs.lookup(k);
    let n = 0;
    if (v instanceof PDFName) n = { '/DeviceGray': 1, '/DeviceRGB': 3, '/DeviceCMYK': 4 }[v.asString()] || 0;
    else if (v instanceof PDFArray && v.size()) {
      const kind = v.lookup(0);
      if (kind === N('ICCBased')) n = num(v.lookup(1)?.dict?.lookup(N('N'))) || 0;
      else if (kind === N('CalRGB')) n = 3;
      else if (kind === N('CalGray')) n = 1;
    }
    res.cs[key(k)] = n === 1 || n === 3 || n === 4 ? n : 0;
  }

  const props = sub('Properties');
  if (props) for (const [k, v] of props.entries()) {
    if (hiddenBy(v, props.lookup(k))) res.hidden[key(k)] = true;
  }

  const xo = sub('XObject');
  if (xo) for (const [k] of xo.entries()) {
    const x = xo.lookup(k);
    const d = x?.dict;
    if (!(d instanceof PDFDict)) continue;
    const entry = {};
    if (d.lookup(N('Subtype')) === N('Form')) {
      entry.form = true;
      // Forms are not compiled; they go to pdf.js whole. One that holds
      // the sheet's linework would bring back everything this avoids.
      if ((x.getContentsSize?.() || 0) > HEAVY_FORM_BYTES) return null;
    }
    if (hiddenBy(d.get(N('OC')), d.lookup(N('OC')))) entry.hidden = true;
    if (entry.form || entry.hidden) res.xobj[key(k)] = entry;
  }

  return { streams, res, box };
}

// ============================================================
// The residual document: what pdf.js still draws
// ============================================================
async function buildResidual(rec, residual, layerCount) {
  const { PDFDocument, PDFName, PDFString, PDFArray, PDFDict, PDFRef } = PDFLib;
  const N = (s) => PDFName.of(s);
  const gen = rec.gen;

  const out = await PDFDocument.create();
  const [pg] = await out.copyPages(rec.src.pdfLibDoc, [rec.index]);
  out.addPage(pg);
  const ctx = out.context;
  const node = pg.node;

  // The copy brought the original content along; take it back out so the
  // residual document is kilobytes, not the whole sheet again.
  const old = node.get(N('Contents'));
  const refs = old instanceof PDFRef ? [old] : old instanceof PDFArray ? old.asArray() : [];
  for (const r of refs) if (r instanceof PDFRef) ctx.delete(r);
  node.set(N('Contents'), ctx.register(ctx.stream(residual)));

  // One optional-content group per layer, so pdf.js can draw them apart.
  let resources = node.Resources();
  if (!resources) { resources = ctx.obj({}); node.set(N('Resources'), resources); }
  let props = resources.lookup(N('Properties'));
  if (!(props instanceof PDFDict)) { props = ctx.obj({}); resources.set(N('Properties'), props); }
  const names = [TEXT_LAYER];
  for (let k = 0; k < layerCount; k++) names.push(LAYER_PREFIX + k);
  const groups = names.map((name) => {
    const ref = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
    props.set(N(name), ref);
    return ref;
  });
  out.catalog.set(N('OCProperties'), ctx.obj({ OCGs: groups, D: { Order: groups } }));

  const bytes = await out.save({ useObjectStreams: false });
  if (rec.gen !== gen) return;
  const task = pdfjsLib.getDocument({ data: bytes, worker: getResidualWorker() });
  rec.task = task;
  const doc = await task.promise;
  const pjPage = await doc.getPage(1);
  if (rec.gen !== gen) { try { task.destroy(); } catch { /* gone */ } return; }
  rec.doc = doc;
  rec.pjPage = pjPage;
}

// pdf.js draws one thing at a time here; the bitmaps are small and nothing
// is gained by overlapping them.
let rasterQueue = Promise.resolve();

/** Draw one residual layer over `box` (page space) at `scale` px per pt,
 *  unrotated, on a transparent background. */
function rasterize(rec, layerName, box, scale, withAnnotations) {
  const run = rasterQueue.then(async () => {
    const { doc, pjPage } = rec;
    if (!doc) throw new Error('released');
    const w = Math.max(1, Math.ceil((box[2] - box[0]) * scale));
    const h = Math.max(1, Math.ceil((box[3] - box[1]) * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const viewport = pjPage.getViewport({
      scale, rotation: 0,
      offsetX: -(box[0] - rec.box[0]) * scale,
      offsetY: -(rec.box[3] - box[3]) * scale,
    });
    const config = await doc.getOptionalContentConfig();
    const groups = config.getGroups() || {};
    for (const id of Object.keys(groups)) config.setVisibility(id, groups[id].name === layerName);
    await pjPage.render({
      canvasContext: canvas.getContext('2d'),
      viewport,
      background: 'rgba(0,0,0,0)',
      annotationMode: withAnnotations ? pdfjsLib.AnnotationMode.ENABLE : pdfjsLib.AnnotationMode.DISABLE,
      optionalContentConfigPromise: Promise.resolve(config),
    }).promise;
    // The bitmap's edges, back in page space (the size was rounded up).
    return { canvas, rect: [box[0], box[3] - h / scale, box[0] + w / scale, box[3]] };
  });
  rasterQueue = run.then(() => {}, () => {});
  return run;
}

// ============================================================
// Drawing
// ============================================================
/** Page point -> CSS pixel within the page's own box on screen, for a page
 *  shown at `rotation` and `scale` CSS px per pt. Returned as [A, B, C, D,
 *  E, F]: X = A x + C y + E, Y = B x + D y + F, y down. */
export function pageMatrix(box, rotation, scale) {
  const [x0, y0, x1, y1] = box;
  const s = scale;
  switch (((rotation % 360) + 360) % 360) {
    case 90: return [0, s, s, 0, -y0 * s, -x0 * s];
    case 180: return [-s, 0, 0, s, x1 * s, -y0 * s];
    case 270: return [0, -s, -s, 0, y1 * s, x1 * s];
    default: return [s, 0, 0, -s, -x0 * s, y1 * s];
  }
}

/** The page-space box that a w x h pixel target shows under `m`. */
function visibleBox(m, w, h) {
  const [A, B, C, D, E, F] = m;
  const det = A * D - B * C;
  const at = (X, Y) => [(D * (X - E) - C * (Y - F)) / det, (-B * (X - E) + A * (Y - F)) / det];
  const p = at(0, 0), q = at(w, h);
  return [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])];
}

// What #plotCanvas is showing. A WebGL canvas keeps its last frame until
// it is drawn to again, so a request for the very same picture is a no-op.
let onCanvas = { rec: null, sig: '' };

const signature = (rec, v) => rec.page.version + ':' + v.w + 'x' + v.h + ':' + v.m.map((x) => x.toFixed(3)).join(',');

/** Draw the record to the plot canvas. `m` maps page points to canvas
 *  pixels; `w`, `h` are the canvas's backing size. */
export function drawPlot(rec, { m, w, h, pxPerPt }) {
  const r = getRenderer();
  if (!r || !rec.page) return;
  rec.used = ++clock;
  const view = { m, w, h, pxPerPt, visible: visibleBox(m, w, h), minW: 1 };
  rec.view = view;

  // Most views are a few milliseconds of GPU time and are simply drawn.
  // The exception is most of a very dense sheet at once; then the cached
  // overview is shown now and the real thing once the view stops moving.
  const sig = signature(rec, view);
  if (onCanvas.rec === rec && onCanvas.sig === sig) return;
  if (rec.page.overview && r.visibleCount(rec.page, view) > DIRECT_INSTANCES) {
    r.drawPreview(rec.page, view);
    onCanvas = { rec, sig: '' };
  } else {
    r.draw(rec.page, view);
    onCanvas = { rec, sig };
  }

  clearTimeout(rec.settleTimer);
  if (rec.state === 'ready') rec.settleTimer = setTimeout(() => settle(rec, view), SETTLE_MS);
}

/** The view has come to rest: make everything in it sharp. Lines are
 *  sharp at any zoom for free; text is a bitmap, so it is drawn again at
 *  exactly this size first, and the page then redrawn once. */
async function settle(rec, view) {
  await refineText(rec, view);
  if (rec.view !== view || !rec.page) return;
  const sig = signature(rec, view);      // after the refine: new text is a new picture
  if (onCanvas.rec === rec && onCanvas.sig === sig) return;
  getRenderer().draw(rec.page, view);
  onCanvas = { rec, sig };
}

/** Returns true if the text bitmaps changed. */
async function refineText(rec, view) {
  const text = rec.page?.text;
  if (!text || !text.base) return false;
  const r = getRenderer();
  const gen = rec.gen;
  const d = text.detail;
  if (view.pxPerPt <= text.base.pxPerPt * 1.02) {
    // The whole-page bitmap is already at least this sharp.
    if (d) { r.setText(rec.page, 'detail', null); return true; }
    return false;
  }
  const b = rec.box, v = view.visible;
  const box = [Math.max(b[0], v[0]), Math.max(b[1], v[1]), Math.min(b[2], v[2]), Math.min(b[3], v[3])];
  if (box[2] <= box[0] || box[3] <= box[1]) return false;
  const covers = d && Math.abs(d.pxPerPt / view.pxPerPt - 1) < 0.002
    && d.rect[0] <= box[0] + 0.01 && d.rect[1] <= box[1] + 0.01 && d.rect[2] >= box[2] - 0.01 && d.rect[3] >= box[3] - 0.01;
  if (covers) return false;
  try {
    const bmp = await rasterize(rec, TEXT_LAYER, box, view.pxPerPt, true);
    if (rec.gen !== gen || !rec.page) return false;
    r.setText(rec.page, 'detail', bmp.canvas, bmp.rect, view.pxPerPt);
    return true;
  } catch (err) {
    if (rec.gen === gen) console.warn('plot: text refine failed', err);
    return false;
  }
}

/** The whole page as a bitmap, unrotated, `pxPerPt` device px per pt.
 *  Used for thumbnails, and by the tests to see what was drawn. `quick`
 *  takes it from the overview rather than drawing every line again. */
export function plotBitmap(rec, pxPerPt, quick = false) {
  const r = getRenderer();
  if (!r || !rec.page) return null;
  const b = rec.box;
  const w = Math.max(1, Math.round((b[2] - b[0]) * pxPerPt));
  const h = Math.max(1, Math.round((b[3] - b[1]) * pxPerPt));
  const img = r.snapshot(rec.page, { m: pageMatrix(b, 0, pxPerPt), w, h, pxPerPt, visible: b, minW: 1 },
    quick && !!rec.page.overview);
  if (!img) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').putImageData(img, 0, 0);
  return canvas;
}
