/* Shared state, constants, and the coordinate math everything else
 * depends on. This module has no imports and no side effects at load
 * time, so it can sit at the bottom of the dependency graph.
 */

// ============================================================
// Constants
// ============================================================
export const BLANK_SIZES = {
  Letter: [612, 792],
  Legal: [612, 1008],
  A4: [595.28, 841.89],
  Tabloid: [792, 1224],
};

export const COLORS = ['#b23a3a', '#1c2b36', '#1f6feb', '#1a7f37', '#8e44ad', '#e3b505'];
// What a screen reader should call each one; a hex value is not a name.
export const COLOR_NAMES = {
  '#b23a3a': 'Red', '#1c2b36': 'Black', '#1f6feb': 'Blue',
  '#1a7f37': 'Green', '#8e44ad': 'Purple', '#e3b505': 'Amber',
};

export const ANNO_PAD = 6;             // pt, padding inside a text box
export const LINE_HEIGHT_MULT = 1.28;  // multiplier of font size
export const DEFAULT_BOX_WIDTH = 170;  // pt
export const THUMB_WIDTH = 150;        // px

// Pen stroke widths in pt, and the closest distance between two recorded
// points. Anything finer than that is invisible at print size and just
// makes the exported PDF bigger.
export const PEN_SIZES = [
  { key: 'S', label: 'Fine',   width: 1.2 },
  { key: 'M', label: 'Medium', width: 2.5 },
  { key: 'L', label: 'Bold',   width: 5 },
];
export const PEN_MIN_POINT_DIST = 1.2;  // pt

// Every markup is one of two families. A note (text, callout) is a box of
// text. Everything else is a *point shape*: a colour, a line weight and a
// list of points in visual space — a pen stroke and a highlight are the
// path itself, an arrow is tail and tip, a box and a cloud are two
// opposite corners. Keeping them all as points is what lets rotation,
// moving, saving and undo treat five tools as one.
export const POINT_TYPES = new Set(['ink', 'highlight', 'arrow', 'rect', 'cloud']);
export const isPointShape = (a) => POINT_TYPES.has(a.type);

// Tool -> the markup type it makes. Select makes nothing.
export const TOOL_TYPE = {
  text: 'text', callout: 'callout', pen: 'ink',
  highlight: 'highlight', arrow: 'arrow', rect: 'rect', cloud: 'cloud',
};
export const TOOL_LABEL = {
  select: 'Select', text: 'Text', callout: 'Callout', pen: 'Pen',
  highlight: 'Highlight', arrow: 'Arrow', rect: 'Box', cloud: 'Cloud',
};
export const TYPE_LABEL = {
  text: 'Text', callout: 'Callout', ink: 'Pen', highlight: 'Highlight',
  arrow: 'Arrow', rect: 'Box', cloud: 'Cloud',
};

// A highlighter is a broad translucent stroke; the three weight presets
// mean these widths for it rather than the pen's.
const HIGHLIGHT_WIDTHS = [8, 13, 20];   // pt, for Fine / Medium / Bold
export const HIGHLIGHT_OPACITY = 0.4;

/** The stroke width a new markup of `type` gets for a pen-size preset. */
export function sizeForType(type, penSize) {
  if (type !== 'highlight') return penSize;
  const i = PEN_SIZES.findIndex((p) => p.width === penSize);
  return HIGHLIGHT_WIDTHS[i < 0 ? 1 : i];
}

// A PDF point is 1/72in; a CSS reference pixel is 1/96in. Rendering at
// this ratio makes "100%" mean actual physical size on screen, the way
// Acrobat and Bluebeam use the number.
export const PT_TO_PX = 96 / 72;

// How this platform writes its command key, for anything that names a
// shortcut on screen.
export const MOD_KEY = (typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')) ? '⌘' : 'Ctrl+';

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6];
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

// ============================================================
// State
// ============================================================
export const state = {
  sources: [],        // {id, name, bytes, pdfLibDoc, pdfjsDoc}
  pages: [],          // page objects, in output order
  nextSourceId: 1,
  nextPageId: 1,
  nextAnnoId: 1,

  selectedPageId: null,
  selectedAnnoId: null,
  activeTool: 'select',     // a key of TOOL_LABEL
  // Space forces pan, whatever the active tool. Shared so the pen can
  // stand aside for it instead of swallowing the press.
  spaceHeld: false,
  // Double-click the page to latch the wheel into zooming, Bluebeam-style,
  // whatever the fit mode would otherwise make it do. Deliberately not
  // persisted: it is a transient mouse mode, not a document preference.
  wheelZoom: false,
  pendingCalloutTip: null,  // {x,y} in pt, while placing a callout

  currentColor: COLORS[0],
  currentHighlightColor: '#e3b505',   // a highlighter keeps its own colour
  currentFontSize: 12,
  currentPenSize: PEN_SIZES[1].width,
  currentFill: true,                  // new notes get a white box behind the text

  zoomMode: 'fit-width',    // 'fit-width' | 'fit-page' | 'custom'
  // The last fit mode the user actually chose. Zooming flips zoomMode to
  // 'custom', so this is what the scroll wheel keys off — otherwise one
  // wheel-zoom in fit-width would silently change what the wheel does.
  lastFitMode: 'fit-width', // 'fit-width' | 'fit-page'
  zoomLevel: 1,             // 1 = 100%
  currentScale: 1,          // logical px per pt, derived from the above

  domRefs: {},              // annoId -> {boxEl, textEl, lineEl, wing1, wing2, tipHandle}

  // Document identity, for the save path
  docName: 'Untitled.pdf',
  fileHandle: null,         // FileSystemFileHandle when opened via Finder/picker
  // True once pages from a second file have been merged in. Such a
  // document has no single file on disk to save back to, so ⌘S must ask
  // where to put it rather than overwrite whichever file came first.
  combined: false,
  dirty: false,

  // Tabs. `docs` holds every open document; the one whose id is
  // activeDocId owns the live fields above.
  docs: [],
  activeDocId: null,
  nextDocId: 1,
};

// ============================================================
// Open documents (tabs)
//
// `state` always holds the *active* document's fields, so every other
// module goes on reading state.pages / state.docName exactly as before
// and switching a tab just swaps those fields out. The alternative —
// threading a document argument through view, annots, pages and export —
// would touch nearly every function in the app for no behavioural gain.
// ============================================================
const DOC_FIELDS = [
  'sources', 'pages', 'nextSourceId', 'nextPageId', 'nextAnnoId',
  'selectedPageId', 'selectedAnnoId', 'docName', 'fileHandle',
  'combined', 'dirty',
];

export function blankDoc() {
  return {
    id: state.nextDocId++,
    sources: [], pages: [],
    nextSourceId: 1, nextPageId: 1, nextAnnoId: 1,
    selectedPageId: null, selectedAnnoId: null,
    docName: 'Untitled.pdf', fileHandle: null,
    combined: false, dirty: false,
  };
}

/** Copy the live fields back into the active document's record. Call
 *  before switching away, or the edits since the last switch are lost. */
export function captureActiveDoc() {
  const doc = state.docs.find((d) => d.id === state.activeDocId);
  if (!doc) return null;
  for (const k of DOC_FIELDS) doc[k] = state[k];
  return doc;
}

export function loadDocIntoState(doc) {
  for (const k of DOC_FIELDS) state[k] = doc[k];
  state.activeDocId = doc.id;
  // Per-document DOM bookkeeping; the layer is rebuilt for the new doc.
  state.pendingCalloutTip = null;
  state.domRefs = {};
}

export function activeDoc() {
  return state.docs.find((d) => d.id === state.activeDocId) || null;
}

/** Reset everything except UI preferences (color, font size, zoom). */
export function resetDocument() {
  state.sources = [];
  state.pages = [];
  state.selectedPageId = null;
  state.selectedAnnoId = null;
  state.pendingCalloutTip = null;
  state.domRefs = {};
  state.docName = 'Untitled.pdf';
  state.fileHandle = null;
  state.combined = false;
  state.dirty = false;
}

// ============================================================
// Rotation / coordinate transforms
//
// "Native" space = the PDF page's own unrotated content coordinates
//   (origin bottom-left, x right, y up) — this is what pdf-lib's
//   drawText/drawRectangle/drawLine expect, regardless of /Rotate.
// "Visual" space = what the user sees on screen for a page whose
//   total rotation is R (origin top-left, x right, y down).
// Verified rigid mapping for R = 0 / 90 / 180 / 270. Round-tripping
// these is what js/rotmath.test.js checks.
// ============================================================
export function normRot(a) {
  return ((Math.round(a / 90) * 90 % 360) + 360) % 360;
}

export function visualSize(R, W0, H0) {
  return (normRot(R) === 90 || normRot(R) === 270) ? { w: H0, h: W0 } : { w: W0, h: H0 };
}

export function toNative(R, W0, H0, vx, vy) {
  switch (normRot(R)) {
    case 90:  return { x: vy,      y: vx };
    case 180: return { x: W0 - vx, y: vy };
    case 270: return { x: W0 - vy, y: H0 - vx };
    default:  return { x: vx,      y: H0 - vy };
  }
}

export function toVisual(R, W0, H0, nx, ny) {
  switch (normRot(R)) {
    case 90:  return { x: ny,      y: nx };
    case 180: return { x: W0 - nx, y: ny };
    case 270: return { x: H0 - ny, y: W0 - nx };
    default:  return { x: nx,      y: H0 - ny };
  }
}

/** Clockwise degrees to apply to drawn text so it still reads upright
 *  after the page's own rotation R is applied by a viewer. */
export function textCompensationDegrees(R) {
  return (360 - normRot(R)) % 360;
}

// ============================================================
// Geometry helpers
// ============================================================
const measureCanvas = document.createElement('canvas');

/** Word-wrap using canvas 2D metrics. Used only for the on-screen
 *  height estimate needed when repositioning notes during a page
 *  rotate; export wraps against the real embedded PDF font instead. */
function measureWrapCanvas(text, maxWidth, fontSize) {
  const ctx = measureCanvas.getContext('2d');
  ctx.font = `${fontSize}px ${getComputedStyle(document.body).fontFamily}`;
  const paragraphs = String(text || '').split('\n');
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [''];
}

export function estimateBoxHeight(anno) {
  const lines = measureWrapCanvas(anno.text || '', anno.width - ANNO_PAD * 2, anno.fontSize);
  return Math.max(1, lines.length) * anno.fontSize * LINE_HEIGHT_MULT + ANNO_PAD * 2;
}

/** Which edge-midpoint of the box a leader line attaches to, based on
 *  which side of the box the tip is on. */
export function computeAttachPoint(anno, boxHeight) {
  const cx = anno.x + anno.width / 2;
  const cy = anno.y + boxHeight / 2;
  const dx = anno.tipX - cx, dy = anno.tipY - cy;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { x: anno.x + anno.width, y: cy } : { x: anno.x, y: cy };
  }
  return dy >= 0 ? { x: cx, y: anno.y + boxHeight } : { x: cx, y: anno.y };
}

export function computeArrowWings(attach, tip, len = 9, angleDeg = 27) {
  const dx = tip.x - attach.x, dy = tip.y - attach.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bx = -dx / dist, by = -dy / dist;  // unit vector: tip back toward attach
  const ang = angleDeg * Math.PI / 180;
  const rot = (vx, vy, a) => ({
    x: vx * Math.cos(a) - vy * Math.sin(a),
    y: vx * Math.sin(a) + vy * Math.cos(a),
  });
  const w1 = rot(bx, by, ang), w2 = rot(bx, by, -ang);
  return [
    { x: tip.x + w1.x * len, y: tip.y + w1.y * len },
    { x: tip.x + w2.x * len, y: tip.y + w2.y * len },
  ];
}

/** The lines that draw a point shape, as polylines in visual space. The
 *  editor strokes these on screen and the exporter strokes the same ones
 *  into the PDF, so a shape cannot look one way here and another there. */
export function shapePolylines(a) {
  const p = a.points || [];
  if (!p.length) return [];
  if (a.type === 'arrow') {
    const tail = p[0], tip = p[p.length - 1];
    const [w1, w2] = computeArrowWings(tail, tip, Math.max(9, (a.size || 2) * 4));
    return [[tail, tip], [w1, tip, w2]];
  }
  if (a.type === 'rect' || a.type === 'cloud') {
    const q = p[p.length - 1];
    const x0 = Math.min(p[0].x, q.x), x1 = Math.max(p[0].x, q.x);
    const y0 = Math.min(p[0].y, q.y), y1 = Math.max(p[0].y, q.y);
    if (a.type === 'rect') {
      return [[{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }]];
    }
    return [cloudOutline(x0, y0, x1, y1)];
  }
  return [p];
}

/** A revision cloud around a rectangle: a closed run of arcs, each
 *  bulging outward, flattened to points so it is the same shape wherever
 *  it is drawn and whichever way the page is turned. */
function cloudOutline(x0, y0, x1, y1) {
  const CHORD = 16, STEPS = 6;             // pt per scallop; segments per arc
  const out = [];
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  // Outward normals for the four sides, walking clockwise in visual space.
  const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let s = 0; s < 4; s++) {
    const [ax, ay] = corners[s], [bx, by] = corners[(s + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.round(len / CHORD));
    const c = len / n;
    if (!(c > 0)) continue;
    const tx = (bx - ax) / len, ty = (by - ay) / len;
    const [nx, ny] = normals[s];
    const R = c * 0.62;
    const d = Math.sqrt(R * R - (c / 2) * (c / 2));
    const alpha = Math.asin((c / 2) / R);
    for (let k = 0; k < n; k++) {
      const mx = ax + tx * c * (k + 0.5), my = ay + ty * c * (k + 0.5);
      const cx = mx - nx * d, cy = my - ny * d;
      for (let i = (out.length ? 1 : 0); i <= STEPS; i++) {
        const th = -alpha + (2 * alpha * i) / STEPS;
        out.push({
          x: cx + R * (Math.sin(th) * tx + Math.cos(th) * nx),
          y: cy + R * (Math.sin(th) * ty + Math.cos(th) * ny),
        });
      }
    }
  }
  if (out.length) out.push({ ...out[0] });
  return out;
}

export function hexToRgb01(hex) {
  const m = hex.replace('#', '');
  return {
    r: parseInt(m.substr(0, 2), 16) / 255,
    g: parseInt(m.substr(2, 2), 16) / 255,
    b: parseInt(m.substr(4, 2), 16) / 255,
  };
}

// ============================================================
// UI feedback
// ============================================================
let statusTimer = null;

export function setStatus(msg, kind) {
  const el = document.getElementById('statusMsg');
  if (!el) return;
  el.textContent = msg || '';
  // The strip is one line and clips; the whole message is a hover away.
  el.title = msg || '';
  el.className = kind || '';
  clearTimeout(statusTimer);
  if (msg) {
    statusTimer = setTimeout(() => {
      if (el.textContent === msg) { el.textContent = ''; el.className = ''; }
    }, 5000);
  }
}

/** Commit a note that is being typed into, by taking focus off it.
 *
 *  Call before anything that swaps out what is on screen — another page,
 *  another document, a step back in history. A note's text is only taken
 *  on blur, and a note removed from the DOM while it still has focus may
 *  never get one: the typing is lost, or worse, is committed a moment
 *  later against whichever document has become the active one. */
export function finishTyping() {
  const el = document.activeElement;
  if (el && el.classList && el.classList.contains('anno-text')) el.blur();
}

const dirtyListeners = [];
export function onDirtyChange(fn) { dirtyListeners.push(fn); }

/** Call after any change that would be lost on close. Drives the title
 *  bar dot and the beforeunload guard. */
export function markDirty(isDirty = true) {
  state.dirty = isDirty;
  for (const fn of dirtyListeners) fn(isDirty);
}
