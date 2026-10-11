/* Build the output PDF with pdf-lib, and read Redline's own markups back
 * out of one.
 *
 * This is where visual-space annotation coordinates become native PDF
 * content coordinates. Every point goes through toNative; text
 * additionally gets a counter-rotation so glyphs read upright after the
 * viewer applies the page's own /Rotate. See guide §3 and §10.
 *
 * A markup can leave in two forms. Saved normally it is a real PDF
 * annotation — its picture in an appearance stream, its meaning in the
 * annotation dictionary — so it can be moved, edited or deleted the next
 * time the file is opened, here or in any other PDF editor. Flattened, it
 * is painted into the page and is simply part of the drawing from then on.
 */
import {
  state, toNative, textCompensationDegrees, hexToRgb01, normRot,
  computeLeader, computeArrowWings, shapePolylines, isPointShape, POINT_TYPES,
  ANNO_PAD, LINE_HEIGHT_MULT, HIGHLIGHT_OPACITY,
} from './state.js';

const {
  PDFDocument, PDFPage, PDFDict, PDFName, PDFRef, PDFString, PDFHexString,
  StandardFonts, rgb, degrees, LineCapStyle, LineJoinStyle,
  pushGraphicsState, popGraphicsState, setGraphicsState, setStrokingColor,
  setLineWidth, setLineCap, setLineJoin, moveTo, lineTo, stroke,
} = PDFLib;

// Round caps and joins are what make a chain of straight segments read as
// one smooth pen stroke rather than a run of dashes.
const ROUND_CAP = LineCapStyle.Round;

/** pdf-lib does not wrap text; wrap against the real embedded font so
 *  the exported line breaks match what the editor showed. */
function wrapTextForFont(text, font, size, maxWidth) {
  const paragraphs = String(text || '').split('\n');
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [''];
}

/** WinAnsi (the StandardFonts encoding) can't represent every character
 *  a user might type — a smart quote pasted from Word throws on encode
 *  and would fail the whole export. Substitute the common ones. */
function toWinAnsi(s) {
  return String(s || '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[•]/g, '*')
    // Anything still outside Latin-1 becomes '?' rather than an exception.
    .replace(/[^\x00-\xFF]/g, '?');
}

/** The lines of a note that shrinks to its text: the ones that were
 *  typed, never wrapped. (Runs of spaces collapse, as they do when a note
 *  is wrapped.) */
const fitLines = (text) => toWinAnsi(text).split('\n').map((p) => p.split(/\s+/).filter(Boolean).join(' '));

/** The note as it will be drawn.
 *
 *  One that shrinks to its text takes its width here, from the PDF font —
 *  not from the screen, where the same words in the system font are a
 *  slightly different length. Carrying the on-screen width over would
 *  leave either a gap after the text or its last word on a line of its
 *  own. Each medium hugs its own text; the left edge is what they share. */
function sized(a, font) {
  if (!a.fit || isPointShape(a)) return a;
  const widest = Math.max(0, ...fitLines(a.text).map((l) => font.widthOfTextAtSize(l, a.fontSize)));
  return { ...a, width: widest + ANNO_PAD * 2 };
}

/** How a note's text breaks in the PDF font, and so how tall its box is. */
function layoutNote(a, font) {
  const lines = a.fit
    ? fitLines(a.text)
    : wrapTextForFont(toWinAnsi(a.text), font, a.fontSize, a.width - ANNO_PAD * 2);
  const lineHeight = a.fontSize * LINE_HEIGHT_MULT;
  return { lines, lineHeight, boxHeight: lines.length * lineHeight + ANNO_PAD * 2 };
}

/** Exported for the geometry tests — everything about where a markup
 *  lands on a rotated page is decided here. */
export function drawAnnotationOnPage(pdfPage, font, a, R, W0, H0) {
  const col = hexToRgb01(a.color);
  const color = rgb(col.r, col.g, col.b);
  const pad = ANNO_PAD;

  // Ink is just a polyline: transform every point and stroke between
  // them. No counter-rotation — only glyphs have an inherent "up".
  if (a.type === 'ink') {
    const pts = (a.points || []).map((p) => toNative(R, W0, H0, p.x, p.y));
    if (!pts.length) return;
    const thickness = a.size || 2.5;
    // A single-point stroke (a tap) still deserves a dot, which a
    // zero-length round-capped segment gives us.
    if (pts.length === 1) pts.push(pts[0]);
    for (let i = 1; i < pts.length; i++) {
      pdfPage.drawLine({
        start: pts[i - 1], end: pts[i],
        thickness, color, lineCap: ROUND_CAP,
      });
    }
    return;
  }
  // The other point shapes are stroked as whole paths, from the same
  // polylines the editor draws on screen.
  if (isPointShape(a)) {
    const lines = shapePolylines(a).map((line) => line.map((p) => toNative(R, W0, H0, p.x, p.y)));
    strokePaths(pdfPage, lines, {
      thickness: a.size || 2.5, color,
      ...(a.type === 'highlight' ? { opacity: HIGHLIGHT_OPACITY, multiply: true } : {}),
    });
    return;
  }
  a = sized(a, font);
  const { lines, lineHeight, boxHeight } = layoutNote(a, font);

  // An axis-aligned box in visual space stays axis-aligned in native
  // space (the transform is only 90° rotations plus one axis flip), so
  // transforming opposite corners and taking min/max is sufficient —
  // no `rotate` option needed on the rectangle.
  const c0 = toNative(R, W0, H0, a.x, a.y);
  const c1 = toNative(R, W0, H0, a.x + a.width, a.y + boxHeight);
  const nx0 = Math.min(c0.x, c1.x), nx1 = Math.max(c0.x, c1.x);
  const ny0 = Math.min(c0.y, c1.y), ny1 = Math.max(c0.y, c1.y);

  // The fill is opaque on purpose: a note over dense linework is only
  // readable with nothing showing through it. Without one, just the frame.
  pdfPage.drawRectangle({
    x: nx0, y: ny0, width: nx1 - nx0, height: ny1 - ny0,
    ...(a.fill === false ? {} : { color: rgb(1, 1, 1) }),
    borderColor: color, borderWidth: 1.1,
  });

  // Glyphs are the only thing with an inherent "up", so they're the only
  // draw call that needs the counter-rotation.
  const textRotate = degrees(textCompensationDegrees(R));
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].length) continue;
    // pdf-lib anchors text at the baseline; fontSize * 0.82 is a
    // serviceable ascent without pulling in real font metrics.
    const baselineVisualY = a.y + pad + i * lineHeight + a.fontSize * 0.82;
    const anchor = toNative(R, W0, H0, a.x + pad, baselineVisualY);
    pdfPage.drawText(lines[i], {
      x: anchor.x, y: anchor.y, size: a.fontSize, font,
      color, rotate: textRotate,
    });
  }

  if (a.type === 'callout') {
    // Knee to tip, the head, then the level jog into the box. Round caps
    // so the two legs meet cleanly at the knee.
    const { attach, knee, tip } = computeLeader(a, boxHeight);
    const n = (p) => toNative(R, W0, H0, p.x, p.y);
    const leg = (from, to) => pdfPage.drawLine({ start: n(from), end: n(to), thickness: 1.3, color, lineCap: ROUND_CAP });
    leg(knee, tip);
    for (const w of computeArrowWings(knee, tip)) leg(tip, w);
    leg(attach, knee);
  }
}

/** Stroke polylines (already in native space) as one path, with round
 *  caps and joins.
 *
 *  One path rather than a line per segment because of the highlighter: it
 *  is translucent, and every overlap between separately stroked segments
 *  would show as a darker bead along the stroke. It multiplies with the
 *  sheet, so linework stays black under it instead of going grey. */
function strokePaths(pdfPage, lines, { thickness, color, opacity = 1, multiply = false }) {
  const ops = [pushGraphicsState()];
  if (opacity < 1 || multiply) {
    const gs = pdfPage.doc.context.obj({
      Type: 'ExtGState', CA: opacity, ...(multiply ? { BM: 'Multiply' } : {}),
    });
    ops.push(setGraphicsState(pdfPage.node.newExtGState('GS', gs)));
  }
  ops.push(
    setStrokingColor(color), setLineWidth(thickness),
    setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round),
  );
  let drew = false;
  for (const pts of lines) {
    if (!pts.length) continue;
    ops.push(moveTo(pts[0].x, pts[0].y));
    // A lone point still gets a zero-length segment, which round caps
    // turn into a dot.
    for (let i = 1; i < Math.max(2, pts.length); i++) {
      const p = pts[Math.min(i, pts.length - 1)];
      ops.push(lineTo(p.x, p.y));
    }
    drew = true;
  }
  if (!drew) return;
  ops.push(stroke(), popGraphicsState());
  pdfPage.pushOperators(...ops);
}

// ============================================================
// Markups that stay editable
//
// Each one is written as a standard annotation (FreeText, FreeText with a
// callout line, Ink, Line, Square or a cloudy Polygon) whose appearance
// stream is the very drawing that
// flattening would have put on the page. So it looks the same either way,
// and any viewer shows it.
//
// What Redline itself reads back is not the annotation's standard fields
// but one private entry, /RedlineMarkup: the markup exactly as the editor
// holds it. Reconstructing a note from /Rect, /DA and /CL would be lossy,
// and guessing at another program's FreeText is not something to do by
// accident.
// ============================================================
const MARKUP_KEY = 'RedlineMarkup';
const BOUNDS_PAD = 2;          // pt around the geometry: stroke width and antialiasing
const r2 = (v) => Math.round(v * 100) / 100;

/** The box a markup draws inside, in native page space. */
function markupBounds(a, font, R, W0, H0) {
  a = sized(a, font);
  const pts = [];
  let pad = BOUNDS_PAD;
  let inner = null;                       // the note's own box, for callouts
  if (isPointShape(a)) {
    // The polylines, not the raw points: an arrow's head and a cloud's
    // scallops reach beyond the two points that define them.
    for (const line of shapePolylines(a)) for (const p of line) pts.push(p);
    pad += (a.size || 2.5) / 2;
  } else {
    const { boxHeight } = layoutNote(a, font);
    pts.push({ x: a.x, y: a.y }, { x: a.x + a.width, y: a.y + boxHeight });
    inner = nativeBox(pts, R, W0, H0);
    if (a.type === 'callout') {
      const { knee, tip } = computeLeader(a, boxHeight);
      pts.push(tip, knee, ...computeArrowWings(knee, tip));
    }
  }
  if (!pts.length) return null;
  const b = nativeBox(pts, R, W0, H0);
  return {
    box: { left: b.left - pad, bottom: b.bottom - pad, right: b.right + pad, top: b.top + pad },
    inner,
  };
}

function nativeBox(pts, R, W0, H0) {
  let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
  for (const p of pts) {
    const n = toNative(R, W0, H0, p.x, p.y);
    if (n.x < left) left = n.x; if (n.x > right) right = n.x;
    if (n.y < bottom) bottom = n.y; if (n.y > top) top = n.y;
  }
  return { left, bottom, right, top };
}

/** Add one markup to `pdfPage` as an annotation. */
async function attachMarkup(outDoc, pdfPage, font, a, R, W0, H0, serial) {
  const bounds = markupBounds(a, font, R, W0, H0);
  if (!bounds) return;
  const { box, inner } = bounds;
  const ctx = outDoc.context;

  // The appearance is drawn by the same code as a flattened markup, onto a
  // page of its own, and that page is then lifted into a form XObject. Two
  // ways of drawing a note would sooner or later be two different notes.
  //
  // The form's BBox is the annotation's Rect, in page coordinates, so a
  // viewer maps one onto the other without moving anything: every rule
  // about rotation above holds unchanged.
  const scratch = PDFPage.create(outDoc);
  scratch.setSize(W0, H0);
  drawAnnotationOnPage(scratch, font, a, R, W0, H0);
  if (!scratch.contentStreamRef) { ctx.delete(scratch.ref); return; }   // drew nothing
  const form = await outDoc.embedPage(scratch, box);
  await form.embed();               // now, so the scratch page can go
  ctx.delete(scratch.contentStreamRef);
  ctx.delete(scratch.ref);

  const col = hexToRgb01(a.color);
  const rgbArr = [r2(col.r), r2(col.g), r2(col.b)];
  const dict = {
    Type: 'Annot',
    Rect: [r2(box.left), r2(box.bottom), r2(box.right), r2(box.top)],
    F: 4,                                              // print
    P: pdfPage.ref,
    NM: PDFString.of(`redline-${serial}`),
    M: PDFString.fromDate(new Date()),
    AP: { N: form.ref },
    [MARKUP_KEY]: PDFHexString.fromText(JSON.stringify(markupPayload(a, R))),
  };

  if (isPointShape(a)) {
    // The standard fields say what kind of markup this is to any other
    // program; what it looks like is the appearance stream above.
    const flat = (points) => points.flatMap((p) => {
      const n = toNative(R, W0, H0, p.x, p.y);
      return [r2(n.x), r2(n.y)];
    });
    Object.assign(dict, { C: rgbArr, BS: { W: a.size || 2.5 } });
    const first = a.points[0], last = a.points[a.points.length - 1];
    if (a.type === 'arrow') {
      Object.assign(dict, { Subtype: 'Line', L: flat([first, last]), LE: ['None', 'OpenArrow'] });
    } else if (a.type === 'rect') {
      Object.assign(dict, { Subtype: 'Square' });
    } else if (a.type === 'cloud') {
      const corners = [first, { x: last.x, y: first.y }, last, { x: first.x, y: last.y }];
      Object.assign(dict, { Subtype: 'Polygon', Vertices: flat(corners), IT: 'PolygonCloud', BE: { S: 'C', I: 1 } });
    } else {
      Object.assign(dict, { Subtype: 'Ink', InkList: [flat(a.points)] });
      if (a.type === 'highlight') dict.CA = HIGHLIGHT_OPACITY;
    }
  } else {
    Object.assign(dict, {
      Subtype: 'FreeText',
      Contents: PDFHexString.fromText(a.text || ''),
      DA: PDFString.of(`${rgbArr.join(' ')} rg /Helv ${a.fontSize} Tf`),
      ...(a.fill === false ? {} : { C: [1, 1, 1] }),   // a FreeText's /C is its background
      BS: { W: 1.1 },
      // How far the note's own box sits inside the Rect.
      RD: [r2(inner.left - box.left), r2(inner.bottom - box.bottom), r2(box.right - inner.right), r2(box.top - inner.top)],
    });
    if (a.type === 'callout') {
      const drawn = sized(a, font);
      const { boxHeight } = layoutNote(drawn, font);
      // A callout line with a knee is six numbers: tip, knee, end.
      const leader = computeLeader(drawn, boxHeight);
      const cl = [leader.tip, leader.knee, leader.attach].flatMap((p) => {
        const q = toNative(R, W0, H0, p.x, p.y);
        return [r2(q.x), r2(q.y)];
      });
      Object.assign(dict, { IT: 'FreeTextCallout', CL: cl, LE: 'OpenArrow' });
    }
  }
  pdfPage.node.addAnnot(ctx.register(ctx.obj(dict)));
}

/** A markup as the editor holds it, plus the rotation its coordinates
 *  are relative to — visual space moves when the page is turned. */
function markupPayload(a, R) {
  const p = { v: 1, R: normRot(R), type: a.type, color: a.color };
  if (isPointShape(a)) {
    p.size = a.size || 2.5;
    p.points = a.points.map((q) => [r2(q.x), r2(q.y)]);
  } else {
    Object.assign(p, { x: r2(a.x), y: r2(a.y), width: r2(a.width), text: a.text || '', fontSize: a.fontSize });
    if (a.type === 'callout') { p.tipX = r2(a.tipX); p.tipY = r2(a.tipY); }
    // Written only when it is off, so a file saved before notes had the
    // option reads back the way it was drawn: filled.
    if (a.fill === false) p.fill = false;
    if (a.fit) p.fit = true;
  }
  return p;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const TWO_POINT = new Set(['arrow', 'rect', 'cloud']);
const LIMIT = 1e5;                 // pt; no page is this large
const fin = (v, lo = -LIMIT, hi = LIMIT) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Turn a payload back into a markup, or null. A PDF is someone else's
 *  file: every field is checked and the result is built fresh, so nothing
 *  the payload carries reaches the editor unexamined. */
function readPayload(p) {
  if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.color !== 'string' || !HEX_COLOR.test(p.color)) return null;
  if (!fin(p.R, 0, 360)) return null;
  const R = normRot(p.R);

  if (POINT_TYPES.has(p.type)) {
    if (!Array.isArray(p.points) || !p.points.length || p.points.length > 200000 || !fin(p.size, 0.05, 100)) return null;
    // An arrow, a box and a cloud are exactly two points; anything else
    // under those names is not something this editor drew.
    if (TWO_POINT.has(p.type) && p.points.length !== 2) return null;
    const points = [];
    for (const q of p.points) {
      if (!Array.isArray(q) || !fin(q[0]) || !fin(q[1])) return null;
      points.push({ x: q[0], y: q[1] });
    }
    return { R, markup: { type: p.type, color: p.color, size: p.size, points } };
  }

  if (p.type !== 'text' && p.type !== 'callout') return null;
  if (!fin(p.x) || !fin(p.y) || !fin(p.width, 1) || !fin(p.fontSize, 2, 400)) return null;
  if (typeof p.text !== 'string' || p.text.length > 50000) return null;
  const markup = { type: p.type, x: p.x, y: p.y, width: p.width, text: p.text, fontSize: p.fontSize, color: p.color, fill: p.fill !== false, fit: p.fit === true };
  if (p.type === 'callout') {
    if (!fin(p.tipX) || !fin(p.tipY)) return null;
    markup.tipX = p.tipX;
    markup.tipY = p.tipY;
  }
  return { R, markup };
}

/** Lift Redline's markups out of a loaded document, removing their
 *  annotations from it. Returns a Map of page index -> [{ markup, R }],
 *  R being the page rotation the coordinates were saved against.
 *
 *  They have to come out, not just be read: left in, pdf.js would draw
 *  each one under the editable copy, and the next save would write it
 *  twice. One that cannot be read is left where it is — still visible,
 *  just not editable — rather than quietly deleted from someone's file. */
export function takeMarkups(pdfLibDoc) {
  const ctx = pdfLibDoc.context;
  const key = PDFName.of(MARKUP_KEY);
  const byPage = new Map();
  pdfLibDoc.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const found = [];
    for (let i = annots.size() - 1; i >= 0; i--) {
      const dict = annots.lookupMaybe(i, PDFDict);
      const raw = dict && dict.lookup(key);
      if (!raw || typeof raw.decodeText !== 'function') continue;
      let parsed = null;
      try { parsed = readPayload(JSON.parse(raw.decodeText())); } catch { /* not ours to read */ }
      if (!parsed) continue;
      found.unshift(parsed);

      const ref = annots.get(i);
      const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
      const normal = ap && ap.get(PDFName.of('N'));
      annots.remove(i);
      if (normal instanceof PDFRef) ctx.delete(normal);
      if (ref instanceof PDFRef) ctx.delete(ref);
    }
    if (found.length) byPage.set(index, found);
  });
  return byPage;
}

/** Build the output document and return its bytes. Markups are written as
 *  editable annotations unless `flatten` asks for them to be painted in. */
export async function buildPdfBytes({ flatten = false } = {}) {
  if (!state.pages.length) throw new Error('Nothing to export yet.');

  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  let serial = 0;

  // Copy every page needed from a given source in one copyPages call.
  // Calling it once per output page re-embeds that source's shared
  // resources (fonts, images) for every copy and bloats the output
  // badly on long documents.
  //
  // A copied page object can only be added once, so a source page that
  // appears twice in the output needs two copies — hence the request
  // list holds one entry per *use*, not per unique page.
  const requests = new Map();          // sourceId -> [pageIndex, ...] with repeats
  for (const page of state.pages) {
    if (page.kind !== 'imported') continue;
    if (!requests.has(page.sourceId)) requests.set(page.sourceId, []);
    requests.get(page.sourceId).push(page.sourcePageIndex);
  }

  const queues = new Map();            // "sourceId:pageIndex" -> [copied, ...]
  for (const [sourceId, indices] of requests) {
    const src = state.sources.find((s) => s.id === sourceId);
    if (!src) throw new Error(`Missing source file for one of the pages`);
    const copies = await outDoc.copyPages(src.pdfLibDoc, indices);
    indices.forEach((srcIdx, i) => {
      const key = `${sourceId}:${srcIdx}`;
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(copies[i]);
    });
  }

  for (const page of state.pages) {
    let newPage;
    if (page.kind === 'blank') {
      newPage = outDoc.addPage([page.W0, page.H0]);
    } else {
      const copied = queues.get(`${page.sourceId}:${page.sourcePageIndex}`)?.shift();
      if (!copied) throw new Error(`Missing source for page ${state.pages.indexOf(page) + 1}`);
      newPage = outDoc.addPage(copied);
    }

    // setRotation overwrites whatever the copied page carried; it is not
    // additive, which is why `rotation` is stored as an absolute value.
    newPage.setRotation(degrees(page.rotation));

    for (const a of page.annotations) {
      if (flatten) drawAnnotationOnPage(newPage, font, a, page.rotation, page.W0, page.H0);
      else await attachMarkup(outDoc, newPage, font, a, page.rotation, page.W0, page.H0, ++serial);
    }
  }

  return outDoc.save();
}
