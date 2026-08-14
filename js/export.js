/* Build the output PDF with pdf-lib.
 *
 * This is where visual-space annotation coordinates become native PDF
 * content coordinates. Every point goes through toNative; text
 * additionally gets a counter-rotation so glyphs read upright after the
 * viewer applies the page's own /Rotate. See guide §3 and §10.
 */
import {
  state, toNative, textCompensationDegrees, hexToRgb01,
  computeAttachPoint, computeArrowWings, ANNO_PAD, LINE_HEIGHT_MULT,
} from './state.js';

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = PDFLib;

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
  const lines = wrapTextForFont(toWinAnsi(a.text), font, a.fontSize, a.width - pad * 2);
  const lineHeight = a.fontSize * LINE_HEIGHT_MULT;
  const boxHeight = lines.length * lineHeight + pad * 2;

  // An axis-aligned box in visual space stays axis-aligned in native
  // space (the transform is only 90° rotations plus one axis flip), so
  // transforming opposite corners and taking min/max is sufficient —
  // no `rotate` option needed on the rectangle.
  const c0 = toNative(R, W0, H0, a.x, a.y);
  const c1 = toNative(R, W0, H0, a.x + a.width, a.y + boxHeight);
  const nx0 = Math.min(c0.x, c1.x), nx1 = Math.max(c0.x, c1.x);
  const ny0 = Math.min(c0.y, c1.y), ny1 = Math.max(c0.y, c1.y);

  pdfPage.drawRectangle({
    x: nx0, y: ny0, width: nx1 - nx0, height: ny1 - ny0,
    color: rgb(1, 1, 1), opacity: 0.88,
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
    const attach = computeAttachPoint(a, boxHeight);
    const tip = { x: a.tipX, y: a.tipY };
    const p1 = toNative(R, W0, H0, attach.x, attach.y);
    const p2 = toNative(R, W0, H0, tip.x, tip.y);
    pdfPage.drawLine({ start: p1, end: p2, thickness: 1.3, color });
    for (const w of computeArrowWings(attach, tip)) {
      const wp = toNative(R, W0, H0, w.x, w.y);
      pdfPage.drawLine({ start: p2, end: wp, thickness: 1.3, color });
    }
  }
}

/** Build the output document and return its bytes. */
export async function buildPdfBytes() {
  if (!state.pages.length) throw new Error('Nothing to export yet.');

  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);

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
      drawAnnotationOnPage(newPage, font, a, page.rotation, page.W0, page.H0);
    }
  }

  return outDoc.save();
}
