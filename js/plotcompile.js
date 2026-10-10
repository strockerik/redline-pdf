/* Compile a PDF content stream into GPU primitives.
 *
 * A sheet plotted from CAD is mostly one thing repeated ten million times:
 * a short stroked line. Every general-purpose renderer — pdf.js, MuPDF,
 * Apple's — walks that list again for each redraw and takes seconds to do
 * it. This walks it once and turns the lines and flat fills into a compact
 * instance list the GPU can redraw in milliseconds at any zoom.
 *
 * It is deliberately not a PDF renderer. Anything that is not a plainly
 * coloured path — text, images, shadings, patterns, soft masks — is left
 * alone and written back out as a much smaller "residual" content stream
 * for pdf.js to draw. The two are layered so that what was painted over
 * what stays true:
 *
 *     R0  G0  R1  G1  ...  T        (bottom to top)
 *
 * where G are GPU groups, R are residual layers and T is the text. An
 * image or a fill that pdf.js must draw closes the current group, so later
 * lines still land on top of it. Text all goes in one layer at the very
 * top: labels sit over linework in practice, and one full-page text
 * bitmap costs far less memory than one per group.
 *
 * Each residual paint operator is wrapped in its own optional-content
 * span (/OC /RdlnLn BDC ... EMC), so one stream serves every layer: pdf.js
 * renders it once per layer with only that layer switched on, and the
 * graphics state stays continuous without any replaying.
 *
 * No DOM and no imports: this runs in a worker and under JavaScriptCore.
 */

export const STRIDE = 20;          // bytes per instance
const CHUNK = 32768;               // instances per GPU chunk
export const LAYER_PREFIX = 'RdlnL';
export const TEXT_LAYER = 'RdlnLT';

// Instance flags.
export const F_TRI = 1;            // a triangle, not a line segment
export const F_ROUND0 = 2;         // round off the start of the segment
export const F_ROUND1 = 4;         // ... and the end

const WIDTH_UNITS = 64;            // line width is stored in 1/64 pt
const MAX_REST_OPS = 400000;       // past this pdf.js is doing the heavy lifting anyway
const MAX_FILL_POINTS = 4000;      // a larger polygon is left to pdf.js
const MAX_CLIP_DEPTH = 4;          // nested non-rectangular clips, counted in the stencil

// Lazily emitted state, one slot each. See flushState().
const S_GS = 0, S_LW = 1, S_CAP = 2, S_JOIN = 3, S_MITER = 4, S_DASH = 5,
      S_RI = 6, S_FLAT = 7, S_STROKE = 8, S_FILL = 9, S_TEXT = 10; // ..16
const NSLOT = 17;
const TEXT_OPS = ['Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts'];

const K_Q = 1, K_BT = 2;           // residual scope kinds

class GState {
  constructor() {
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    this.lw = 1; this.cap = 0; this.join = 0; this.miter = 10;
    this.dash = null; this.dashPhase = 0; this.dashRaw = '';
    this.sCol = 0xff000000; this.fCol = 0xff000000;   // opaque black, RGBA little-endian
    this.sAlpha = 1; this.fAlpha = 1;
    this.sN = 1; this.fN = 1;          // colour components; 0 = a space we do not model
    this.sOk = true; this.fOk = true;
    this.bmBad = false; this.smBad = false;
    this.clipId = 0;                   // index into the compiler's clip table; 0 = none
    this.clipBad = false;
    this.gsList = ''; this.riRaw = ''; this.flatRaw = '';
    this.sRaw = ''; this.fRaw = ''; this.sCs = ''; this.fCs = '';
    this.t0 = ''; this.t1 = ''; this.t2 = ''; this.t3 = ''; this.t4 = ''; this.t5 = ''; this.t6 = '';
    this.cur = new Int32Array(NSLOT);
    this.emitted = new Int32Array(NSLOT);
  }
  copy(o) {
    this.a = o.a; this.b = o.b; this.c = o.c; this.d = o.d; this.e = o.e; this.f = o.f;
    this.lw = o.lw; this.cap = o.cap; this.join = o.join; this.miter = o.miter;
    this.dash = o.dash; this.dashPhase = o.dashPhase; this.dashRaw = o.dashRaw;
    this.sCol = o.sCol; this.fCol = o.fCol;
    this.sAlpha = o.sAlpha; this.fAlpha = o.fAlpha;
    this.sN = o.sN; this.fN = o.fN; this.sOk = o.sOk; this.fOk = o.fOk;
    this.bmBad = o.bmBad; this.smBad = o.smBad;
    this.clipId = o.clipId;
    this.clipBad = o.clipBad;
    this.gsList = o.gsList; this.riRaw = o.riRaw; this.flatRaw = o.flatRaw;
    this.sRaw = o.sRaw; this.fRaw = o.fRaw; this.sCs = o.sCs; this.fCs = o.fCs;
    this.t0 = o.t0; this.t1 = o.t1; this.t2 = o.t2; this.t3 = o.t3; this.t4 = o.t4; this.t5 = o.t5; this.t6 = o.t6;
    this.cur.set(o.cur); this.emitted.set(o.emitted);
  }
}

const CS_COMPONENTS = { DeviceGray: 1, DeviceRGB: 3, DeviceCMYK: 4, G: 1, RGB: 3, CMYK: 4 };

const fmt = (v) => String(Math.round(v * 1e5) / 1e5);
// Resource names are looked up decoded; a content stream may spell them with #xx escapes.
const unescapeName = (n) => (n.indexOf('#') < 0 ? n
  : n.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
const clamp255 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

function rgbFrom(n, nums, at) {
  if (n === 1) { const g = clamp255(nums[at]); return g | (g << 8) | (g << 16); }
  if (n === 3) return clamp255(nums[at]) | (clamp255(nums[at + 1]) << 8) | (clamp255(nums[at + 2]) << 16);
  // Naive CMYK. pdf.js fits a curve instead, so tints differ slightly;
  // this is a viewer's approximation and export never comes through here.
  const k = 1 - nums[at + 3];
  return clamp255((1 - nums[at]) * k) | (clamp255((1 - nums[at + 1]) * k) << 8) | (clamp255((1 - nums[at + 2]) * k) << 16);
}

/** `res` describes the page's resources, already reduced to what matters:
 *    gs      name -> { lw, cap, join, miter, dash:[arr, phase], CA, ca, bm:bool, sm:bool }
 *    cs      name -> component count (0 = not a plain device-like space)
 *    hidden  name -> true, for /Properties entries whose layer is switched off
 *    xobj    name -> { hidden:bool, form:bool }
 *  `box` is the page box, the limit of anything a residual layer can show.
 *  `onChunk` receives each finished GPU chunk; `onClipPoly(id, triangles)`
 *  each distinct non-rectangular clip region, before any chunk that uses it. */
export function createCompiler({ res = {}, box = [0, 0, 612, 792], onChunk, onClipPoly }) {
  const gsRes = res.gs || {}, csRes = res.cs || {}, hiddenRes = res.hidden || {}, xobjRes = res.xobj || {};

  // ---------- geometry staging ----------
  const sx = new Float32Array(CHUNK * 6);
  const sc = new Uint32Array(CHUNK);
  const sw = new Uint16Array(CHUNK);
  const sf = new Uint16Array(CHUNK);
  let sn = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  let group = 0, dirty = false;
  const layerBoxes = [];         // residual layer -> [x0, y0, x1, y1] of what it draws
  let hasText = false;
  let chunkClipId = 0;
  const stats = { segments: 0, triangles: 0, dropped: 0, rest: 0, restPaths: 0, chunks: 0 };

  function flushChunk() {
    if (!sn) return;
    const span = Math.max(bx1 - bx0, by1 - by0, 1e-6);
    const q = 65535 / span;
    const buf = new ArrayBuffer(sn * STRIDE);
    const u16 = new Uint16Array(buf), u32 = new Uint32Array(buf);
    for (let i = 0, s = 0, o = 0; i < sn; i++, s += 6, o += 10) {
      u16[o] = (sx[s] - bx0) * q + 0.5;
      u16[o + 1] = (sx[s + 1] - by0) * q + 0.5;
      u16[o + 2] = (sx[s + 2] - bx0) * q + 0.5;
      u16[o + 3] = (sx[s + 3] - by0) * q + 0.5;
      u16[o + 4] = (sx[s + 4] - bx0) * q + 0.5;
      u16[o + 5] = (sx[s + 5] - by0) * q + 0.5;
      u32[i * 5 + 3] = sc[i];
      u16[o + 8] = sw[i];
      u16[o + 9] = sf[i];
    }
    stats.chunks++;
    onChunk({
      buffer: buf, count: sn, group,
      x0: bx0, y0: by0, span,
      bbox: [bx0, by0, bx1, by1],
      clipId: chunkClipId, clip: clips[chunkClipId],
    });
    sn = 0; bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
  }

  /** Chunks carry one clip each, so a change of clip ends one. */
  function syncClip() {
    if (st.clipId === chunkClipId) return;
    flushChunk();
    chunkClipId = st.clipId;
  }

  function seg(x0, y0, x1, y1, w, col, fl) {
    if (sn === CHUNK) flushChunk();
    const s = sn * 6;
    sx[s] = x0; sx[s + 1] = y0; sx[s + 2] = x1; sx[s + 3] = y1; sx[s + 4] = x0; sx[s + 5] = y0;
    sc[sn] = col; sw[sn] = w; sf[sn] = fl; sn++;
    if (x0 < bx0) bx0 = x0; if (x0 > bx1) bx1 = x0;
    if (x1 < bx0) bx0 = x1; if (x1 > bx1) bx1 = x1;
    if (y0 < by0) by0 = y0; if (y0 > by1) by1 = y0;
    if (y1 < by0) by0 = y1; if (y1 > by1) by1 = y1;
  }

  let triSink = null;            // when set, triangles are collected here instead (clip regions)

  function tri(x0, y0, x1, y1, x2, y2, col) {
    if (triSink) { triSink.push(x0, y0, x1, y1, x2, y2); return; }
    if (sn === CHUNK) flushChunk();
    const s = sn * 6;
    sx[s] = x0; sx[s + 1] = y0; sx[s + 2] = x1; sx[s + 3] = y1; sx[s + 4] = x2; sx[s + 5] = y2;
    sc[sn] = col; sw[sn] = 0; sf[sn] = F_TRI; sn++;
    if (x0 < bx0) bx0 = x0; if (x0 > bx1) bx1 = x0;
    if (x1 < bx0) bx0 = x1; if (x1 > bx1) bx1 = x1;
    if (x2 < bx0) bx0 = x2; if (x2 > bx1) bx1 = x2;
    if (y0 < by0) by0 = y0; if (y0 > by1) by1 = y0;
    if (y1 < by0) by0 = y1; if (y1 > by1) by1 = y1;
    if (y2 < by0) by0 = y2; if (y2 > by1) by1 = y2;
    stats.triangles++;
  }

  // ---------- graphics state ----------
  let st = new GState();
  const gstack = [];
  let gdepth = 0;
  let seq = 0;

  // ---------- current path, already in page space ----------
  let pts = new Float64Array(4096);
  let np = 0;                              // values used in pts (2 per point)
  let subStart = new Int32Array(256);
  let subClosed = new Uint8Array(256);
  let nsub = 0;
  let ux = 0, uy = 0, usx = 0, usy = 0;    // current point and subpath start, user space
  let pendingClip = 0;                     // 1 = W, 2 = W*
  let clipOpEnd = 0;

  function growPts() { const g = new Float64Array(pts.length * 2); g.set(pts); pts = g; }
  function moveTo(x, y) {
    if (nsub === subStart.length) {
      const a = new Int32Array(nsub * 2); a.set(subStart); subStart = a;
      const c = new Uint8Array(nsub * 2); c.set(subClosed); subClosed = c;
    }
    // A moveto straight after a moveto replaces it.
    if (nsub && subStart[nsub - 1] === np - 2 && !subClosed[nsub - 1]) { np -= 2; nsub--; }
    subStart[nsub] = np; subClosed[nsub] = 0; nsub++;
    if (np + 2 > pts.length) growPts();
    pts[np++] = st.a * x + st.c * y + st.e;
    pts[np++] = st.b * x + st.d * y + st.f;
    ux = usx = x; uy = usy = y;
  }
  function lineTo(x, y) {
    if (!nsub) { moveTo(x, y); return; }
    if (subClosed[nsub - 1]) moveTo(usx, usy);
    if (np + 2 > pts.length) growPts();
    pts[np++] = st.a * x + st.c * y + st.e;
    pts[np++] = st.b * x + st.d * y + st.f;
    ux = x; uy = y;
  }
  function curveTo(x1, y1, x2, y2, x3, y3) {
    if (!nsub) moveTo(x1, y1);
    if (subClosed[nsub - 1]) moveTo(usx, usy);
    const { a, b, c, d, e, f } = st;
    const p0x = pts[np - 2], p0y = pts[np - 1];
    const p1x = a * x1 + c * y1 + e, p1y = b * x1 + d * y1 + f;
    const p2x = a * x2 + c * y2 + e, p2y = b * x2 + d * y2 + f;
    const p3x = a * x3 + c * y3 + e, p3y = b * x3 + d * y3 + f;
    // Enough segments that the chord error stays under ~0.03 pt, which is
    // about half a pixel at the deepest zoom.
    const len = Math.hypot(p1x - p0x, p1y - p0y) + Math.hypot(p2x - p1x, p2y - p1y) + Math.hypot(p3x - p2x, p3y - p2y);
    const n = Math.min(64, Math.max(3, Math.ceil(Math.sqrt(len) * 2.5)));
    while (np + n * 2 > pts.length) growPts();
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
      pts[np++] = w0 * p0x + w1 * p1x + w2 * p2x + w3 * p3x;
      pts[np++] = w0 * p0y + w1 * p1y + w2 * p2y + w3 * p3y;
    }
    ux = x3; uy = y3;
  }
  function closePath() {
    if (!nsub) return;
    subClosed[nsub - 1] = 1;
    ux = usx; uy = usy;
  }

  // ---------- strokes ----------
  function strokePath() {
    syncClip();
    const scale = Math.sqrt(Math.abs(st.a * st.d - st.b * st.c));
    let w = st.lw * scale * WIDTH_UNITS + 0.5;
    w = w > 65535 ? 65535 : w | 0;
    const col = st.sCol;
    const capFl = st.cap ? 1 : 0;
    if (st.dash) { strokeDashed(scale, w, col, capFl); dirty = true; return; }
    const before = stats.segments;
    for (let k = 0; k < nsub; k++) {
      const s = subStart[k];
      const e = k + 1 < nsub ? subStart[k + 1] : np;
      const n = (e - s) >> 1;
      let closed = subClosed[k];
      if (n === 2 && !closed) {
        // By far the commonest shape in a plot: one bare segment.
        const x0 = pts[s], y0 = pts[s + 1], x1 = pts[s + 2], y1 = pts[s + 3];
        if (x0 === x1 && y0 === y1 && !capFl) { stats.dropped++; continue; }   // butt-capped point: paints nothing
        seg(x0, y0, x1, y1, w, col, capFl ? F_ROUND0 | F_ROUND1 : 0);
        stats.segments++;
        continue;
      }
      if (n === 1) {
        if (capFl) { seg(pts[s], pts[s + 1], pts[s], pts[s + 1], w, col, F_ROUND0 | F_ROUND1); stats.segments++; }
        else stats.dropped++;
        continue;
      }
      if (closed && pts[e - 2] === pts[s] && pts[e - 1] === pts[s + 1]) closed = 2;  // already back at the start
      const last = closed === 1 ? n : n - 1;       // number of segments
      for (let j = 0; j < last; j++) {
        const i0 = s + j * 2;
        const i1 = j === n - 1 ? s : i0 + 2;
        const x0 = pts[i0], y0 = pts[i0 + 1], x1 = pts[i1], y1 = pts[i1 + 1];
        if (x0 === x1 && y0 === y1) continue;
        // Joins are drawn round whatever was asked for: at plot line
        // weights the difference from a mitre is under a pixel.
        const r0 = j > 0 || closed ? F_ROUND0 : capFl ? F_ROUND0 : 0;
        const r1 = j < last - 1 || closed ? F_ROUND1 : capFl ? F_ROUND1 : 0;
        seg(x0, y0, x1, y1, w, col, r0 | r1);
        stats.segments++;
      }
    }
    if (stats.segments !== before) dirty = true;
  }

  function strokeDashed(scale, w, col, capFl) {
    const pat = st.dash;
    const m = pat.length;
    let total = 0;
    for (let i = 0; i < m; i++) total += pat[i];
    const fl = capFl ? F_ROUND0 | F_ROUND1 : 0;
    for (let k = 0; k < nsub; k++) {
      const s = subStart[k];
      const e = k + 1 < nsub ? subStart[k + 1] : np;
      const n = (e - s) >> 1;
      const count = subClosed[k] ? n : n - 1;
      // Start the pattern at its phase.
      let idx = 0, left = pat[0] * scale, on = true;
      let ph = (st.dashPhase % total) * scale;
      while (ph > 0) {
        if (ph >= left) { ph -= left; idx = (idx + 1) % m; left = pat[idx] * scale; on = !on; }
        else { left -= ph; ph = 0; }
      }
      for (let j = 0; j < count; j++) {
        const i0 = s + j * 2, i1 = j === n - 1 ? s : i0 + 2;
        let x = pts[i0], y = pts[i0 + 1];
        const x1 = pts[i1], y1 = pts[i1 + 1];
        let len = Math.hypot(x1 - x, y1 - y);
        if (!(len > 0)) continue;
        const dx = (x1 - x) / len, dy = (y1 - y) / len;
        // A pattern far finer than the line is long would explode into
        // millions of dashes nobody can see; draw it solid instead.
        if (len / (total * scale) > 20000) { seg(x, y, x1, y1, w, col, fl); stats.segments++; continue; }
        while (len > 0) {
          const step = left < len ? left : len;
          const nx = x + dx * step, ny = y + dy * step;
          if (on && (step > 0 || capFl)) { seg(x, y, nx, ny, w, col, fl); stats.segments++; }
          x = nx; y = ny; len -= step; left -= step;
          if (left <= 1e-9) { idx = (idx + 1) % m; left = pat[idx] * scale; on = !on; if (!(left > 0) && !(total > 0)) break; }
        }
      }
    }
  }

  // ---------- fills ----------
  let ys = new Float64Array(64);
  let ex = new Float64Array(64 * 5);       // x0, y0, x1, y1, dir per edge
  let ax = new Float64Array(64 * 3);       // xa, xb, dir per active edge
  let order = new Int32Array(64);

  /** True when the path was tessellated; false leaves it for pdf.js. */
  function fillPath(evenOdd) {
    syncClip();
    if (!tessellate(evenOdd, st.fCol)) return false;
    dirty = true;
    return true;
  }

  function tessellate(evenOdd, col) {
    if (nsub === 1) {
      const n = np >> 1;
      if (n < 3) return true;                                   // nothing to fill
      if (n === 3 || isConvex(0, n)) { emitFan(0, n, col); return true; }
    }
    if ((np >> 1) > MAX_FILL_POINTS) return false;
    slabFill(evenOdd, col);
    return true;
  }

  function emitFan(s, n, col) {
    const x0 = pts[s], y0 = pts[s + 1];
    for (let i = 1; i < n - 1; i++) {
      const a = s + i * 2;
      tri(x0, y0, pts[a], pts[a + 1], pts[a + 2], pts[a + 3], col);
    }
  }

  function isConvex(s, n) {
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const a = s + i * 2, b = s + ((i + 1) % n) * 2, c = s + ((i + 2) % n) * 2;
      const cross = (pts[b] - pts[a]) * (pts[c + 1] - pts[b + 1]) - (pts[b + 1] - pts[a + 1]) * (pts[c] - pts[b]);
      if (cross > 1e-12) { if (sign < 0) return false; sign = 1; }
      else if (cross < -1e-12) { if (sign > 0) return false; sign = -1; }
    }
    return true;
  }

  /** Any polygon, any winding rule: cut it into horizontal slabs at every
   *  vertex, and within a slab the edges cannot cross (barring a
   *  self-intersection, which is drawn slightly wrong rather than not at
   *  all), so the covered spans are plain trapezoids. */
  function slabFill(evenOdd, col) {
    const total = np >> 1;
    if (ys.length < total) ys = new Float64Array(total * 2);
    if (ex.length < total * 5) ex = new Float64Array(total * 10);
    let ne = 0, ny = 0;
    for (let k = 0; k < nsub; k++) {
      const s = subStart[k];
      const e = k + 1 < nsub ? subStart[k + 1] : np;
      const n = (e - s) >> 1;
      if (n < 3) continue;
      for (let j = 0; j < n; j++) {
        const i0 = s + j * 2, i1 = j === n - 1 ? s : i0 + 2;
        const x0 = pts[i0], y0 = pts[i0 + 1], x1 = pts[i1], y1 = pts[i1 + 1];
        ys[ny++] = y0;
        if (y0 === y1) continue;
        const o = ne * 5;
        if (y0 < y1) { ex[o] = x0; ex[o + 1] = y0; ex[o + 2] = x1; ex[o + 3] = y1; ex[o + 4] = 1; }
        else { ex[o] = x1; ex[o + 1] = y1; ex[o + 2] = x0; ex[o + 3] = y0; ex[o + 4] = -1; }
        ne++;
      }
    }
    if (ne < 2) return;
    const levels = ys.subarray(0, ny).sort();
    if (ax.length < ne * 3) { ax = new Float64Array(ne * 6); order = new Int32Array(ne * 2); }

    for (let li = 0; li + 1 < ny; li++) {
      const ya = levels[li], yb = levels[li + 1];
      if (yb <= ya) continue;
      let na = 0;
      for (let k = 0; k < ne; k++) {
        const o = k * 5;
        if (ex[o + 1] > ya || ex[o + 3] < yb) continue;
        const t = (ex[o + 2] - ex[o]) / (ex[o + 3] - ex[o + 1]);
        ax[na * 3] = ex[o] + (ya - ex[o + 1]) * t;
        ax[na * 3 + 1] = ex[o] + (yb - ex[o + 1]) * t;
        ax[na * 3 + 2] = ex[o + 4];
        order[na] = na;
        na++;
      }
      if (na < 2) continue;
      // Insertion sort by the midpoint: a slab rarely holds more than a
      // handful of edges.
      for (let i = 1; i < na; i++) {
        const v = order[i];
        const key = ax[v * 3] + ax[v * 3 + 1];
        let j = i - 1;
        while (j >= 0 && ax[order[j] * 3] + ax[order[j] * 3 + 1] > key) { order[j + 1] = order[j]; j--; }
        order[j + 1] = v;
      }
      let wind = 0, left = -1;
      for (let i = 0; i < na; i++) {
        const v = order[i];
        const was = wind;
        wind = evenOdd ? wind ^ 1 : wind + ax[v * 3 + 2];
        if (!was && wind) left = v;
        else if (was && !wind && left >= 0) {
          const la = ax[left * 3], lb = ax[left * 3 + 1], ra = ax[v * 3], rb = ax[v * 3 + 1];
          if (ra > la) tri(la, ya, ra, ya, rb, yb, col);
          if (rb > lb) tri(la, ya, rb, yb, lb, yb, col);
          left = -1;
        }
      }
    }
  }

  // ---------- clipping ----------
  // A rectangle rides along as a scissor; any other shape is tessellated
  // once and drawn into the stencil. Both are canonical: a plot re-declares
  // the same viewport clip around every layer, and each of those must
  // resolve to the same id or every one would end a chunk.
  const clips = [null];                // id -> { rect: [x0,y0,x1,y1] | null, polys: [id, ...] }
  const clipKeys = new Map();
  const polyKeys = new Map();
  let polyCount = 0;
  const NO_POLYS = [];

  function applyClip(evenOdd) {
    const cur = clips[st.clipId];
    let rect = cur ? cur.rect : null;
    let polys = cur ? cur.polys : NO_POLYS;

    let isRect = false, x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    if (nsub === 1) {
      let n = np >> 1;
      if (n === 5 && pts[8] === pts[0] && pts[9] === pts[1]) n = 4;
      if (n === 4) {
        const e = 1e-4;
        const h0 = Math.abs(pts[1] - pts[3]) < e, v0 = Math.abs(pts[0] - pts[2]) < e;
        const h1 = Math.abs(pts[3] - pts[5]) < e, v1 = Math.abs(pts[2] - pts[4]) < e;
        const h2 = Math.abs(pts[5] - pts[7]) < e, v2 = Math.abs(pts[4] - pts[6]) < e;
        const h3 = Math.abs(pts[7] - pts[1]) < e, v3 = Math.abs(pts[6] - pts[0]) < e;
        if ((h0 && v1 && h2 && v3) || (v0 && h1 && v2 && h3)) {
          isRect = true;
          x0 = Math.min(pts[0], pts[2], pts[4]); x1 = Math.max(pts[0], pts[2], pts[4]);
          y0 = Math.min(pts[1], pts[3], pts[5]); y1 = Math.max(pts[1], pts[3], pts[5]);
        }
      }
    }

    if (isRect) {
      if (rect) {
        x0 = Math.max(x0, rect[0]); y0 = Math.max(y0, rect[1]);
        x1 = Math.min(x1, rect[2]); y1 = Math.min(y1, rect[3]);
      }
      rect = [x0, y0, Math.max(x0, x1), Math.max(y0, y1)];
    } else {
      let key = evenOdd ? 'e' : 'n';
      for (let k = 0; k < nsub; k++) key += '/' + subStart[k];
      for (let k = 0; k < np; k++) key += ',' + Math.round(pts[k] * 100);
      let id = polyKeys.get(key);
      if (id === undefined) {
        if (polys.length >= MAX_CLIP_DEPTH) { st.clipBad = true; return; }
        triSink = [];
        const ok = tessellate(evenOdd, 0);
        const tris = triSink;
        triSink = null;
        if (!ok) { st.clipBad = true; return; }
        id = polyCount++;
        polyKeys.set(key, id);
        onClipPoly?.(id, new Float32Array(tris));
      }
      if (!polys.includes(id)) {
        if (polys.length >= MAX_CLIP_DEPTH) { st.clipBad = true; return; }
        polys = polys.concat(id);
      }
    }

    const key = (rect ? rect.map((v) => Math.round(v * 100)).join(',') : '') + '|' + polys.join(',');
    let id = clipKeys.get(key);
    if (id === undefined) {
      id = clips.length;
      clips.push({ rect, polys });
      clipKeys.set(key, id);
    }
    st.clipId = id;
  }

  // ---------- residual stream ----------
  let out = new Uint8Array(1 << 16), ol = 0;
  function need(n) {
    if (ol + n <= out.length) return;
    const g = new Uint8Array(Math.max(out.length * 2, ol + n));
    g.set(out.subarray(0, ol));
    out = g;
  }
  function wRaw(buf, a, e) {
    need(e - a + 1);
    out.set(buf.subarray(a, e), ol);
    ol += e - a;
    out[ol++] = 10;
  }
  function wStr(s) {
    need(s.length + 1);
    for (let k = 0; k < s.length; k++) out[ol++] = s.charCodeAt(k);
    out[ol++] = 10;
  }

  // Scopes in the residual: a q or a BT is written when it opens, and taken
  // back out when it closes if nothing inside it survived. That is what
  // removes the hundreds of thousands of q ... Q pairs wrapping geometry
  // the GPU now draws.
  let scopeKind = new Uint8Array(64), scopePos = new Float64Array(64), scopePainted = new Uint8Array(64);
  let sd = 0;
  function openScope(kind, text) {
    if (sd === scopeKind.length) {
      const k = new Uint8Array(sd * 2); k.set(scopeKind); scopeKind = k;
      const p = new Float64Array(sd * 2); p.set(scopePos); scopePos = p;
      const q = new Uint8Array(sd * 2); q.set(scopePainted); scopePainted = q;
    }
    scopeKind[sd] = kind; scopePos[sd] = ol; scopePainted[sd] = 0; sd++;
    wStr(text);
  }
  /** Returns false if the scope was dropped. */
  function closeScope(kind, text) {
    if (!sd || scopeKind[sd - 1] !== kind) { wStr(text); return true; }   // unbalanced; pass it through
    sd--;
    if (!scopePainted[sd]) { ol = scopePos[sd]; return false; }
    wStr(text);
    if (sd) scopePainted[sd - 1] = 1;
    return true;
  }

  /** Scalar state reaches the residual only when a surviving operator is
   *  about to depend on it — a plot sets the line width millions of times
   *  between one label and the next. Each q level remembers what it has
   *  written, so a restore re-emits whatever the Q undid. */
  function flushState() {
    const cur = st.cur, em = st.emitted;
    if (cur[S_GS] !== em[S_GS]) { wStr(st.gsList); em[S_GS] = cur[S_GS]; }
    if (cur[S_LW] !== em[S_LW]) { wStr(fmt(st.lw) + ' w'); em[S_LW] = cur[S_LW]; }
    if (cur[S_CAP] !== em[S_CAP]) { wStr(st.cap + ' J'); em[S_CAP] = cur[S_CAP]; }
    if (cur[S_JOIN] !== em[S_JOIN]) { wStr(st.join + ' j'); em[S_JOIN] = cur[S_JOIN]; }
    if (cur[S_MITER] !== em[S_MITER]) { wStr(fmt(st.miter) + ' M'); em[S_MITER] = cur[S_MITER]; }
    if (cur[S_DASH] !== em[S_DASH]) { wStr(st.dashRaw); em[S_DASH] = cur[S_DASH]; }
    if (cur[S_RI] !== em[S_RI]) { wStr(st.riRaw); em[S_RI] = cur[S_RI]; }
    if (cur[S_FLAT] !== em[S_FLAT]) { wStr(st.flatRaw); em[S_FLAT] = cur[S_FLAT]; }
    if (cur[S_STROKE] !== em[S_STROKE]) { wStr(st.sCs + st.sRaw); em[S_STROKE] = cur[S_STROKE]; }
    if (cur[S_FILL] !== em[S_FILL]) { wStr(st.fCs + st.fRaw); em[S_FILL] = cur[S_FILL]; }
    for (let k = 0; k < 7; k++) {
      if (cur[S_TEXT + k] !== em[S_TEXT + k]) { wStr(st['t' + k]); em[S_TEXT + k] = cur[S_TEXT + k]; }
    }
  }

  let hiddenCount = 0;
  let mcStack = new Uint8Array(64), mcDepth = 0;

  /** Open a residual paint operator that hides what is under it: pick its
   *  layer, bring the state up to date, and start its optional-content
   *  span. The box is what it can touch, in page space — each layer is
   *  later rendered only as large as it needs to be. */
  function beginCover(x0, y0, x1, y1) {
    const layer = dirty ? group + 1 : group;
    if (dirty) { flushChunk(); group++; dirty = false; }
    const clip = clips[st.clipId];
    if (clip && clip.rect) {
      x0 = Math.max(x0, clip.rect[0]); y0 = Math.max(y0, clip.rect[1]);
      x1 = Math.min(x1, clip.rect[2]); y1 = Math.min(y1, clip.rect[3]);
    }
    x0 = Math.max(x0, box[0]); y0 = Math.max(y0, box[1]);
    x1 = Math.min(x1, box[2]); y1 = Math.min(y1, box[3]);
    while (layerBoxes.length <= layer) layerBoxes.push(null);
    if (x1 > x0 && y1 > y0) {
      const lb = layerBoxes[layer];
      if (!lb) layerBoxes[layer] = [x0, y0, x1, y1];
      else {
        if (x0 < lb[0]) lb[0] = x0; if (y0 < lb[1]) lb[1] = y0;
        if (x1 > lb[2]) lb[2] = x1; if (y1 > lb[3]) lb[3] = y1;
      }
    }
    beginSpan(LAYER_PREFIX + layer);
  }

  /** Text, and the odd stroke pdf.js has to draw: all on the top layer. */
  function beginText() {
    hasText = true;
    beginSpan(TEXT_LAYER);
  }

  function beginSpan(name) {
    flushState();
    wStr('/OC /' + name + ' BDC');
    if (sd) scopePainted[sd - 1] = 1;
    if (++stats.rest > MAX_REST_OPS) throw new Error('too much non-vector content for the fast path');
  }

  /** Where the unit square lands — the footprint of an image. */
  function coverUnitSquare() {
    const { a, b, c, d, e, f } = st;
    beginCover(
      Math.min(e, a + e, c + e, a + c + e), Math.min(f, b + f, d + f, b + d + f),
      Math.max(e, a + e, c + e, a + c + e), Math.max(f, b + f, d + f, b + d + f),
    );
  }

  // ---------- tokenizer ----------
  const nums = new Float64Array(4096);
  let sp = 0;
  let arr0 = -1;                 // operand index where the first [ opened
  let name1 = '', name2 = '';    // the last two name operands, outside dictionaries
  let hadName = false;
  let dictDepth = 0;
  let inText = false, inInline = false;
  let carry = null;              // operand bytes left over from the previous feed
  let pathCarry = null;          // raw bytes of a path begun in a previous feed
  let done = false;

  const latin1 = (buf, a, e) => {
    let s = '';
    for (let k = a; k < e; k++) s += String.fromCharCode(buf[k]);
    return s;
  };

  function feed(b) {
    const n = b.length;
    let i = 0;
    let opStart = carry ? 0 : -1;      // where this operator's operands began, in b
    let pathStart = -1;                // where the current path began, in b (-1: none, or carried)
    let lastOpEnd = 0;

    // Raw bytes of the operator just read, including operands.
    const rawOp = (end) => {
      if (carry) { wRaw(carry, 0, carry.length); ol--; out[ol++] = 32; }
      wRaw(b, opStart < 0 ? end : opStart, end);
    };
    const opText = (end) => (carry ? latin1(carry, 0, carry.length) + ' ' : '') + latin1(b, opStart < 0 ? end : opStart, end);
    const rawPath = (end) => {
      if (pathCarry) { wRaw(pathCarry, 0, pathCarry.length); ol--; out[ol++] = 32; }
      wRaw(b, pathStart < 0 ? 0 : pathStart, end);
    };

    while (i < n) {
      let c = b[i];
      if (c <= 32) { i++; continue; }

      // ---- number ----
      if ((c >= 48 && c <= 57) || c === 45 || c === 46 || c === 43) {
        if (opStart < 0) opStart = i;
        let neg = false;
        if (c === 45) { neg = true; c = b[++i]; } else if (c === 43) { c = b[++i]; }
        let v = 0;
        while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); c = b[++i]; }
        if (c === 46) {
          let f = 0, s = 1;
          c = b[++i];
          while (c >= 48 && c <= 57) { f = f * 10 + (c - 48); s *= 10; c = b[++i]; }
          v += f / s;
        }
        if (sp === 4096) { nums.copyWithin(0, 4064, 4096); sp = 32; arr0 = -1; }
        nums[sp++] = neg ? -v : v;
        continue;
      }

      // ---- operator ----
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 39 || c === 34) {
        const t0 = i;
        let code = c;
        c = b[++i];
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 42 || (c >= 48 && c <= 57)) {
          code |= c << 8;
          c = b[++i];
          if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 42) {
            code |= c << 16;
            c = b[++i];
            while ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 42) { code = -1; c = b[++i]; }
          }
        }
        if (dictDepth) continue;                    // true / false / null inside a dictionary
        if (opStart < 0) opStart = t0;

        if (inInline) {
          if (code !== 0x4449 /* ID */) continue;   // keys and values of the image dictionary
          // Binary data follows; its end is the first EI standing alone.
          let e = i + 1;
          for (; e < n - 1; e++) {
            if (b[e] === 69 && b[e + 1] === 73 && b[e - 1] <= 32 && (e + 2 >= n || b[e + 2] <= 32)) break;
          }
          i = Math.min(n, e + 2);
          inInline = false;
          if (!hiddenCount) { coverUnitSquare(); rawOp(i); wStr('EMC'); }
        } else if (code === 109 /* m */) {
          if (pathStart < 0 && !np) pathStart = opStart;
          moveTo(nums[sp - 2], nums[sp - 1]);
        } else if (code === 108 /* l */) {
          if (pathStart < 0 && !np) pathStart = opStart;
          lineTo(nums[sp - 2], nums[sp - 1]);
        } else if (code === 83 /* S */) {
          paint(1, 0, false, i);
        } else if (code === 119 /* w */) {
          st.lw = nums[sp - 1]; st.cur[S_LW] = ++seq;
        } else if (code === 104 /* h */) {
          closePath();
        } else if (code === 113 /* q */) {
          if (gdepth === gstack.length) gstack.push(new GState());
          gstack[gdepth++].copy(st);
          openScope(K_Q, 'q');
        } else if (code === 81 /* Q */) {
          if (gdepth) st.copy(gstack[--gdepth]);
          closeScope(K_Q, 'Q');
        } else if (code === 102 /* f */ || code === 70 /* F */) {
          paint(0, 1, false, i);
        } else {
          slowOp(code, i);
        }
        carry = null; opStart = -1; sp = 0; arr0 = -1; hadName = false; name1 = name2 = '';
        lastOpEnd = i;
        continue;
      }

      // ---- everything else is an operand ----
      if (opStart < 0) opStart = i;
      if (c === 47 /* / */) {
        const a = ++i;
        while (i < n) {
          c = b[i];
          if (c <= 32 || c === 47 || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 37) break;
          i++;
        }
        if (!dictDepth) { name1 = name2; name2 = latin1(b, a, i); hadName = true; }
      } else if (c === 40 /* ( */) {
        let depth = 1;
        i++;
        while (i < n && depth) {
          c = b[i++];
          if (c === 92) i++; else if (c === 40) depth++; else if (c === 41) depth--;
        }
      } else if (c === 60 /* < */) {
        if (b[i + 1] === 60) { dictDepth++; i += 2; }
        else { while (i < n && b[i] !== 62) i++; i++; }
      } else if (c === 62 /* > */) {
        if (dictDepth) dictDepth--;
        i += b[i + 1] === 62 ? 2 : 1;
      } else if (c === 91 /* [ */) {
        if (arr0 < 0) arr0 = sp;
        i++;
      } else if (c === 37 /* % */) {
        while (i < n && b[i] !== 10 && b[i] !== 13) i++;
      } else {
        i++;                                        // ] and anything unexpected
      }
    }

    // Whatever straddles the end of this buffer is carried into the next.
    // The spec only allows a stream to break between tokens, so an
    // operator's operands may be split from it but a token never is.
    if (np && (pathStart >= 0 || pathCarry)) {
      const piece = b.slice(pathStart < 0 ? 0 : pathStart, lastOpEnd);
      pathCarry = pathCarry ? concat(pathCarry, piece) : piece;
    }
    if (opStart >= 0) {
      const piece = b.slice(opStart, n);
      carry = carry ? concat(carry, piece) : piece;
    }

    // ---- painting ----
    function paint(stroke, fill, evenOdd, end) {
      const clip = pendingClip;
      pendingClip = 0;
      if (np && !hiddenCount) {
        const sOk = !stroke || (st.sOk && !st.bmBad && !st.smBad && !st.clipBad);
        const fOk = !fill || (st.fOk && !st.bmBad && !st.smBad && !st.clipBad);
        let drawn = false;
        if (sOk && fOk) {
          drawn = true;
          if (fill && !fillPath(evenOdd)) drawn = false;
          if (drawn && stroke) strokePath();
        }
        if (!drawn && (stroke || fill)) {
          // A fill hides what is under it, so it closes the group; a
          // stroke, like text, does not.
          stats.restPaths++;
          if (fill) {
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (let k = 0; k < np; k += 2) {
              if (pts[k] < x0) x0 = pts[k]; if (pts[k] > x1) x1 = pts[k];
              if (pts[k + 1] < y0) y0 = pts[k + 1]; if (pts[k + 1] > y1) y1 = pts[k + 1];
            }
            const pad = stroke ? st.lw * Math.sqrt(Math.abs(st.a * st.d - st.b * st.c)) + 1 : 1;
            beginCover(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
          } else {
            beginText();
          }
          rawPath(end);
          wStr('EMC');
          if (clip) applyClip(clip === 2);
        } else if (clip) {
          // The path is also a clip. The residual needs it whatever
          // happened to the paint.
          rawPath(clipOpEnd);
          wStr('n');
          applyClip(clip === 2);
        }
      }
      np = 0; nsub = 0; pathStart = -1; pathCarry = null;
    }

    function slowOp(code, end) {
      switch (code) {
        // -- path construction --
        case 0x6572 /* re */: {
          if (pathStart < 0 && !np) pathStart = opStart;
          const x = nums[sp - 4], y = nums[sp - 3], w = nums[sp - 2], h = nums[sp - 1];
          moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); closePath();
          break;
        }
        case 99 /* c */:
          if (pathStart < 0 && !np) pathStart = opStart;
          curveTo(nums[sp - 6], nums[sp - 5], nums[sp - 4], nums[sp - 3], nums[sp - 2], nums[sp - 1]);
          break;
        case 118 /* v */:
          if (pathStart < 0 && !np) pathStart = opStart;
          curveTo(ux, uy, nums[sp - 4], nums[sp - 3], nums[sp - 2], nums[sp - 1]);
          break;
        case 121 /* y */:
          if (pathStart < 0 && !np) pathStart = opStart;
          curveTo(nums[sp - 4], nums[sp - 3], nums[sp - 2], nums[sp - 1], nums[sp - 2], nums[sp - 1]);
          break;

        // -- path painting --
        case 115 /* s */: closePath(); paint(1, 0, false, end); break;
        case 0x2a66 /* f* */: paint(0, 1, true, end); break;
        case 66 /* B */: paint(1, 1, false, end); break;
        case 0x2a42 /* B* */: paint(1, 1, true, end); break;
        case 98 /* b */: closePath(); paint(1, 1, false, end); break;
        case 0x2a62 /* b* */: closePath(); paint(1, 1, true, end); break;
        case 110 /* n */: paint(0, 0, false, end); break;
        case 87 /* W */: pendingClip = 1; clipOpEnd = end; break;
        case 0x2a57 /* W* */: pendingClip = 2; clipOpEnd = end; break;

        // -- transform --
        case 0x6d63 /* cm */: {
          const a = nums[sp - 6], b2 = nums[sp - 5], c2 = nums[sp - 4], d = nums[sp - 3], e = nums[sp - 2], f = nums[sp - 1];
          const { a: A, b: B, c: C, d: D, e: E, f: F } = st;
          st.a = a * A + b2 * C; st.b = a * B + b2 * D;
          st.c = c2 * A + d * C; st.d = c2 * B + d * D;
          st.e = e * A + f * C + E; st.f = e * B + f * D + F;
          rawOp(end);
          break;
        }

        // -- line style --
        case 74 /* J */: st.cap = nums[sp - 1] | 0; st.cur[S_CAP] = ++seq; break;
        case 106 /* j */: st.join = nums[sp - 1] | 0; st.cur[S_JOIN] = ++seq; break;
        case 77 /* M */: st.miter = nums[sp - 1]; st.cur[S_MITER] = ++seq; break;
        case 100 /* d */: {
          const from = arr0 < 0 ? sp - 1 : arr0;
          setDash(Array.from(nums.subarray(from, sp - 1)), nums[sp - 1]);
          break;
        }
        case 0x6972 /* ri */: st.riRaw = opText(end); st.cur[S_RI] = ++seq; break;
        case 105 /* i */: st.flatRaw = opText(end); st.cur[S_FLAT] = ++seq; break;
        case 0x7367 /* gs */: applyGs(name2); break;

        // -- colour --
        case 71 /* G */: setColor(true, 1, sp - 1, fmt(nums[sp - 1]) + ' G'); break;
        case 103 /* g */: setColor(false, 1, sp - 1, fmt(nums[sp - 1]) + ' g'); break;
        case 0x4752 /* RG */: setColor(true, 3, sp - 3, null, 'RG'); break;
        case 0x6772 /* rg */: setColor(false, 3, sp - 3, null, 'rg'); break;
        case 75 /* K */: setColor(true, 4, sp - 4, null, 'K'); break;
        case 107 /* k */: setColor(false, 4, sp - 4, null, 'k'); break;
        case 0x5343 /* CS */: setSpace(true, name2); break;
        case 0x7363 /* cs */: setSpace(false, name2); break;
        case 0x4353 /* SC */: case 0x4e4353 /* SCN */: setSpaceColor(true, opText(end)); break;
        case 0x6373 /* sc */: case 0x6e6373 /* scn */: setSpaceColor(false, opText(end)); break;

        // -- text --
        case 0x5442 /* BT */: inText = true; openScope(K_BT, 'BT'); break;
        case 0x5445 /* ET */:
          inText = false;
          // A dropped text object takes its font and spacing changes with
          // it, so anything it set has to be written again when next used.
          if (!closeScope(K_BT, 'ET')) for (let k = 0; k < 7; k++) st.emitted[S_TEXT + k] = -1;
          break;
        case 0x6a54 /* Tj */: case 0x4a54 /* TJ */: case 39 /* ' */: case 34 /* " */:
          if (!hiddenCount && inText) { beginText(); rawOp(end); wStr('EMC'); }
          break;
        case 0x6454 /* Td */: case 0x4454 /* TD */: case 0x6d54 /* Tm */: case 0x2a54 /* T* */:
          if (inText) rawOp(end);
          break;
        case 0x6354 /* Tc */: textState(0, end); break;
        case 0x7754 /* Tw */: textState(1, end); break;
        case 0x7a54 /* Tz */: textState(2, end); break;
        case 0x4c54 /* TL */: textState(3, end); break;
        case 0x6654 /* Tf */: textState(4, end); break;
        case 0x7254 /* Tr */: textState(5, end); break;
        case 0x7354 /* Ts */: textState(6, end); break;

        // -- things pdf.js draws --
        case 0x6f44 /* Do */:
          const xo = xobjRes[unescapeName(name2)];
          if (!hiddenCount && !(xo && xo.hidden)) {
            // An image fills the unit square; a form can draw anywhere.
            if (xo && xo.form) beginCover(box[0], box[1], box[2], box[3]);
            else coverUnitSquare();
            rawOp(end); wStr('EMC');
          }
          break;
        case 0x6873 /* sh */:
          if (!hiddenCount) { beginCover(box[0], box[1], box[2], box[3]); rawOp(end); wStr('EMC'); }
          break;
        case 0x4942 /* BI */: inInline = true; return;   // operands run on to ID

        // -- marked content: resolved here, never written out --
        case 0x434442 /* BDC */: case 0x434d42 /* BMC */: {
          const hide = code === 0x434442 && name1 === 'OC' && hiddenRes[unescapeName(name2)] ? 1 : 0;
          if (mcDepth === mcStack.length) { const g = new Uint8Array(mcDepth * 2); g.set(mcStack); mcStack = g; }
          mcStack[mcDepth++] = hide;
          hiddenCount += hide;
          break;
        }
        case 0x434d45 /* EMC */:
          if (mcDepth) hiddenCount -= mcStack[--mcDepth];
          break;
        case 0x504d /* MP */: case 0x5044 /* DP */: case 0x5842 /* BX */: case 0x5845 /* EX */:
        case 0x3064 /* d0 */: case 0x3164 /* d1 */:
          break;

        default:
          rawOp(end);        // not ours to interpret; pdf.js can decide
      }
    }

    function textState(k, end) {
      st['t' + k] = opText(end);
      st.cur[S_TEXT + k] = ++seq;
      // Inside a text object the order against the positioning operators
      // matters, so it is written where it stands.
      if (inText) { rawOp(end); st.emitted[S_TEXT + k] = st.cur[S_TEXT + k]; }
    }
  }

  function concat(a, b) {
    const g = new Uint8Array(a.length + 1 + b.length);
    g.set(a); g[a.length] = 32; g.set(b, a.length + 1);
    return g;
  }

  function setDash(arr, phase) {
    let any = false;
    for (const v of arr) if (v > 0) any = true;
    st.dash = any ? arr : null;
    st.dashPhase = phase || 0;
    st.dashRaw = '[' + arr.map(fmt).join(' ') + '] ' + fmt(phase || 0) + ' d';
    st.cur[S_DASH] = ++seq;
  }

  function setColor(stroke, n, at, text, op) {
    const rgb = rgbFrom(n, nums, at);
    if (!text) {
      text = '';
      for (let k = 0; k < n; k++) text += fmt(nums[at + k]) + ' ';
      text += op;
    }
    if (stroke) {
      st.sN = n; st.sOk = true; st.sCs = ''; st.sRaw = text;
      st.sCol = (rgb | (clamp255(st.sAlpha) << 24)) >>> 0;
      st.cur[S_STROKE] = ++seq;
    } else {
      st.fN = n; st.fOk = true; st.fCs = ''; st.fRaw = text;
      st.fCol = (rgb | (clamp255(st.fAlpha) << 24)) >>> 0;
      st.cur[S_FILL] = ++seq;
    }
  }

  function setSpace(stroke, name) {
    const n = CS_COMPONENTS[name] ?? csRes[unescapeName(name)] ?? 0;
    const text = '/' + name + (stroke ? ' CS ' : ' cs ');
    // Every colour space starts at black (or its nearest equivalent).
    if (stroke) {
      st.sN = n; st.sOk = n > 0; st.sCs = text; st.sRaw = '';
      st.sCol = (clamp255(st.sAlpha) << 24) >>> 0;
      st.cur[S_STROKE] = ++seq;
    } else {
      st.fN = n; st.fOk = n > 0; st.fCs = text; st.fRaw = '';
      st.fCol = (clamp255(st.fAlpha) << 24) >>> 0;
      st.cur[S_FILL] = ++seq;
    }
  }

  function setSpaceColor(stroke, text) {
    const n = stroke ? st.sN : st.fN;
    const ok = n > 0 && !hadName && sp >= n;
    if (stroke) {
      st.sOk = ok; st.sRaw = text;
      if (ok) st.sCol = (rgbFrom(n, nums, sp - n) | (clamp255(st.sAlpha) << 24)) >>> 0;
      st.cur[S_STROKE] = ++seq;
    } else {
      st.fOk = ok; st.fRaw = text;
      if (ok) st.fCol = (rgbFrom(n, nums, sp - n) | (clamp255(st.fAlpha) << 24)) >>> 0;
      st.cur[S_FILL] = ++seq;
    }
  }

  function applyGs(name) {
    // The whole history is kept, most recent last: two dictionaries can
    // each set something the other does not.
    const text = '/' + name + ' gs\n';
    st.gsList = st.gsList.split(text).join('') + text;
    st.cur[S_GS] = ++seq;
    const g = gsRes[unescapeName(name)];
    if (!g) return;
    if (g.lw !== undefined) { st.lw = g.lw; st.cur[S_LW] = ++seq; }
    if (g.cap !== undefined) { st.cap = g.cap; st.cur[S_CAP] = ++seq; }
    if (g.join !== undefined) { st.join = g.join; st.cur[S_JOIN] = ++seq; }
    if (g.miter !== undefined) { st.miter = g.miter; st.cur[S_MITER] = ++seq; }
    if (g.dash) setDash(g.dash[0], g.dash[1]);
    if (g.CA !== undefined) { st.sAlpha = g.CA; st.sCol = ((st.sCol & 0xffffff) | (clamp255(g.CA) << 24)) >>> 0; }
    if (g.ca !== undefined) { st.fAlpha = g.ca; st.fCol = ((st.fCol & 0xffffff) | (clamp255(g.ca) << 24)) >>> 0; }
    if (g.bm !== undefined) st.bmBad = g.bm;
    if (g.sm !== undefined) st.smBad = g.sm;
  }

  /** Call once after the last feed. */
  function finish() {
    if (done) return null;
    done = true;
    flushChunk();
    return {
      residual: out.slice(0, ol),
      layers: layerBoxes,         // residual layer k -> the box it draws in, or null if empty
      text: hasText,
      groups: group + 1,          // GPU groups G0 .. G(groups-1)
      stats,
    };
  }

  return { feed, finish };
}
