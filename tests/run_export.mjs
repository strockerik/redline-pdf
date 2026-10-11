/* End-to-end exercise of the real export path (js/export.js) under JSC. */
import { APP, VENDOR } from './paths.mjs';
import './shim.mjs';

globalThis.self = globalThis;
globalThis.console = {
  log: (...a) => print(a.join(' ')),
  error: (...a) => print('ERR ' + a.join(' ')),
  warn: (...a) => print('WARN ' + a.join(' ')),
};

load(VENDOR + '/pdf-lib.min.js');
const { PDFDocument, degrees } = globalThis.PDFLib;


const stateMod = await import(`${APP}/state.js`);
const { buildPdfBytes, takeMarkups } = await import(`${APP}/export.js`);
const S = stateMod.state;

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};

// --- Build a source document: portrait + landscape ---
const src = await PDFDocument.create();
src.addPage([612, 792]);
src.addPage([792, 612]);
const srcBytes = await src.save();
const pdfLibDoc = await PDFDocument.load(srcBytes.slice(0));

S.sources = [{ id: 1, name: 'test.pdf', bytes: srcBytes.buffer, pdfLibDoc, pdfjsDoc: null }];

const mkAnnots = () => ([
  { id: 1, type: 'text', x: 40, y: 60, width: 170,
    text: 'Plain note with a long line that must wrap across several lines',
    fontSize: 12, color: '#b23a3a' },
  { id: 2, type: 'callout', x: 200, y: 300, width: 170,
    text: 'Callout note', fontSize: 12, color: '#1f6feb', tipX: 90, tipY: 420 },
]);

// --- 1. Every rotation exports, and rotation is written through ---
S.pages = [0, 90, 180, 270].map((rotation, i) => ({
  id: i + 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0,
  W0: 612, H0: 792, rotation, annotations: mkAnnots(),
}));
let bytes = await buildPdfBytes();
check('export produces bytes', bytes.length > 1000, `got ${bytes.length}`);

let out = await PDFDocument.load(bytes);
check('page count', out.getPageCount() === 4, `got ${out.getPageCount()}`);
const rots = out.getPages().map((p) => p.getRotation().angle);
check('rotations written through', rots.join(',') === '0,90,180,270', rots.join(','));
const sizes = out.getPages().map((p) => `${Math.round(p.getWidth())}x${Math.round(p.getHeight())}`);
check('MediaBox unchanged by rotation', sizes.every((s) => s === '612x792'), sizes.join(' '));

// --- 2. Landscape source + blank pages + mixed kinds ---
S.pages = [
  { id: 1, kind: 'imported', sourceId: 1, sourcePageIndex: 1, W0: 792, H0: 612, rotation: 270, annotations: mkAnnots() },
  { id: 2, kind: 'blank', W0: 612, H0: 792, rotation: 0, annotations: mkAnnots() },
  { id: 3, kind: 'blank', W0: 595.28, H0: 841.89, rotation: 90, annotations: [] },
];
bytes = await buildPdfBytes();
out = await PDFDocument.load(bytes);
check('mixed blank/imported page count', out.getPageCount() === 3, `got ${out.getPageCount()}`);
check('blank A4 size preserved',
  Math.abs(out.getPage(2).getWidth() - 595.28) < 0.1, `${out.getPage(2).getWidth()}`);

// --- 3. The same source page used twice (the copyPages batching path) ---
S.pages = [
  { id: 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 0, annotations: [] },
  { id: 2, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 90, annotations: [] },
  { id: 3, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 180, annotations: [] },
];
bytes = await buildPdfBytes();
out = await PDFDocument.load(bytes);
check('duplicate source page count', out.getPageCount() === 3, `got ${out.getPageCount()}`);
check('duplicate pages keep distinct rotations',
  out.getPages().map((p) => p.getRotation().angle).join(',') === '0,90,180',
  out.getPages().map((p) => p.getRotation().angle).join(','));

// --- 4. Batching actually reduces size vs. per-page copyPages ---
// The source needs real embedded resources for this to mean anything:
// an empty page has nothing to duplicate, so both paths would tie.
{
  const { StandardFonts } = globalThis.PDFLib;
  const rich = await PDFDocument.create();
  const f1 = await rich.embedFont(StandardFonts.Helvetica);
  const f2 = await rich.embedFont(StandardFonts.TimesRomanBoldItalic);
  const f3 = await rich.embedFont(StandardFonts.Courier);
  const rp = rich.addPage([612, 792]);
  for (let i = 0; i < 40; i++) {
    rp.drawText(`Specification note line ${i} — drawing sheet reference`,
      { x: 40, y: 740 - i * 17, size: 11, font: [f1, f2, f3][i % 3] });
  }
  const richBytes = await rich.save();
  const richDoc = await PDFDocument.load(richBytes.slice(0));

  const naive = await PDFDocument.create();
  for (let i = 0; i < 20; i++) {
    const [c] = await naive.copyPages(richDoc, [0]);
    naive.addPage(c);
  }
  const naiveBytes = await naive.save();

  const batched = await PDFDocument.create();
  const copies = await batched.copyPages(richDoc, new Array(20).fill(0));
  copies.forEach((c) => batched.addPage(c));
  const batchedBytes = await batched.save();

  const saved = naiveBytes.length - batchedBytes.length;
  check('batched copyPages is smaller than per-page copying', saved > 0,
    `batched ${batchedBytes.length} vs per-page ${naiveBytes.length}`);
  print(`      (batched ${batchedBytes.length} B, per-page ${naiveBytes.length} B, ` +
        `saved ${(100 * saved / naiveBytes.length).toFixed(1)}%)`);
}

// --- 5. Characters outside WinAnsi must not throw ---
S.pages = [{
  id: 1, kind: 'blank', W0: 612, H0: 792, rotation: 0,
  annotations: [{
    id: 1, type: 'text', x: 40, y: 60, width: 200,
    text: 'Smart “quotes”, em—dash, ellipsis…, café, emoji 🔧, bullet •',
    fontSize: 12, color: '#1c2b36',
  }],
}];
try {
  bytes = await buildPdfBytes();
  check('non-WinAnsi text exports without throwing', bytes.length > 500, `${bytes.length}`);
} catch (e) {
  check('non-WinAnsi text exports without throwing', false, e.message);
}

// --- 6. Empty document is rejected cleanly ---
S.pages = [];
try {
  await buildPdfBytes();
  check('empty document throws', false, 'no error raised');
} catch (e) {
  check('empty document throws', /Nothing to export/.test(e.message), e.message);
}

// --- 7. A missing source is reported, not silently dropped ---
S.pages = [{ id: 1, kind: 'imported', sourceId: 99, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 0, annotations: [] }];
try {
  await buildPdfBytes();
  check('missing source throws', false, 'no error raised');
} catch (e) {
  check('missing source throws', /Missing source/.test(e.message), e.message);
}

// ============================================================
// Markups that stay editable
// ============================================================
{
  const { PDFName, PDFDict, PDFArray, PDFHexString, decodePDFRawStream } = globalThis.PDFLib;
  const N = (k) => PDFName.of(k);
  const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;
  const text = (u8) => { let t = ''; for (let i = 0; i < u8.length; i++) t += String.fromCharCode(u8[i]); return t; };
  /** Everything painted on a page itself, decoded. */
  const pageContent = (page) => {
    const c = page.node.Contents();
    if (!c) return '';
    const streams = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, i) => c.lookup(i)) : [c];
    return streams.map((st) => text(st.contents && st.dict.has(N('Filter')) ? decodePDFRawStream(st).decode() : (st.contents || st.getUnencodedContents()))).join('\n');
  };
  const ours = (page) => {
    const an = page.node.Annots();
    return an ? Array.from({ length: an.size() }, (_, i) => an.lookup(i, PDFDict)).filter((d) => d.has(N('RedlineMarkup'))) : [];
  };
  const marks = () => ([
    { id: 1, type: 'text', x: 40, y: 60, width: 170, text: 'Naïve — “quoted” 測試\nsecond line', fontSize: 12, color: '#b23a3a' },
    { id: 2, type: 'callout', x: 200, y: 300, width: 170, text: 'Callout note', fontSize: 14, color: '#1f6feb', tipX: 90, tipY: 420 },
    { id: 3, type: 'ink', color: '#1a7f37', size: 5, points: [{ x: 300, y: 100 }, { x: 320.25, y: 130.5 }, { x: 360, y: 90 }] },
  ]);
  const same = (got, want) => {
    if (got.type !== want.type || got.color !== want.color) return false;
    if (want.type === 'ink') {
      return got.size === want.size && got.points.length === want.points.length
        && got.points.every((p, i) => near(p.x, want.points[i].x) && near(p.y, want.points[i].y));
    }
    return got.text === want.text && got.fontSize === want.fontSize && near(got.x, want.x) && near(got.y, want.y)
      && near(got.width, want.width) && (want.type !== 'callout' || (near(got.tipX, want.tipX) && near(got.tipY, want.tipY)));
  };

  // --- 8. Saved normally, a markup is an annotation, not paint ---
  S.pages = [0, 90, 180, 270].map((rotation, i) => ({
    id: i + 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation, annotations: marks(),
  }));
  const editable = await buildPdfBytes();
  let doc = await PDFDocument.load(editable);
  check('each markup becomes one annotation', doc.getPages().every((p) => ours(p).length === 3),
    doc.getPages().map((p) => ours(p).length).join(','));
  check('nothing is painted onto the page itself', doc.getPages().every((p) => pageContent(p).trim() === ''),
    JSON.stringify(pageContent(doc.getPage(0)).slice(0, 80)));
  const kinds = ours(doc.getPage(0)).map((d) => String(d.get(N('Subtype'))) + (d.has(N('IT')) ? '+callout' : ''));
  check('as standard annotation types', kinds.join() === '/FreeText,/FreeText+callout,/Ink', kinds.join());
  check('a note carries its text for other programs', ours(doc.getPage(0))[0].lookup(N('Contents')).decodeText() === marks()[0].text);

  // Every one must draw itself: an appearance stream whose box is the
  // annotation's own rectangle, so no viewer has to move or scale it.
  let apOk = true, apDetail = '';
  for (const p of doc.getPages()) for (const d of ours(p)) {
    const ap = d.lookup(N('AP'), PDFDict).lookup(N('N'));
    const rect = d.lookup(N('Rect')).asArray().map((n) => n.asNumber());
    const bbox = ap.dict.lookup(N('BBox')).asArray().map((n) => n.asNumber());
    const body = text(decodePDFRawStream(ap).decode());
    if (String(ap.dict.get(N('Subtype'))) !== '/Form' || !rect.every((v, k) => near(v, bbox[k])) || !/\bl\b/.test(body)) {
      apOk = false; apDetail = `${rect} vs ${bbox}`;
    }
  }
  check('each has an appearance stream that fills its rectangle exactly', apOk, apDetail);

  // The rectangle has to contain the markup wherever the page is turned.
  const { toNative } = stateMod;
  let inside = true;
  doc.getPages().forEach((p, i) => {
    const R = [0, 90, 180, 270][i];
    const rect = ours(p)[0].lookup(N('Rect')).asArray().map((n) => n.asNumber());
    for (const [vx, vy] of [[40, 60], [210, 60], [40, 100], [210, 100]]) {
      const n = toNative(R, 612, 792, vx, vy);
      if (n.x < rect[0] || n.x > rect[2] || n.y < rect[1] || n.y > rect[3]) inside = false;
    }
  });
  check('the rectangle encloses the note at every rotation', inside);

  const flat = text(editable);
  check('the scratch pages used to draw them are not left in the file',
    (flat.match(/\/Type\s*\/Page\b/g) || []).length <= 4 || (await PDFDocument.load(editable)).getPageCount() === 4);

  // --- 9. Opening it again gives the markups back, and takes them out ---
  const taken = takeMarkups(doc);
  check('every page gives its markups back', [0, 1, 2, 3].every((i) => (taken.get(i) || []).length === 3),
    [0, 1, 2, 3].map((i) => (taken.get(i) || []).length).join(','));
  let exact = true;
  for (let i = 0; i < 4; i++) (taken.get(i) || []).forEach((t, k) => {
    if (!same(t.markup, marks()[k]) || t.R !== [0, 90, 180, 270][i]) exact = false;
  });
  check('unchanged: text, position, size, colour, leader, ink — at every rotation', exact, JSON.stringify(taken.get(1)));
  check('restored markups carry no id of their own', (taken.get(0) || []).every((t) => !('id' in t.markup)));
  check('and they are gone from the document', doc.getPages().every((p) => ours(p).length === 0));
  const stripped = text(await doc.save({ useObjectStreams: false }));
  check('with their appearance streams', !/RedlineMarkup/.test(stripped) && !/\/Subtype\s*\/Form/.test(stripped),
    `${(stripped.match(/\/Subtype\s*\/Form/g) || []).length} forms left`);
  check('taking them twice finds nothing more', takeMarkups(doc).size === 0);

  // --- 10. Save, reopen, save again: one copy, not two ---
  {
    const reopened = await PDFDocument.load(editable);
    const again = takeMarkups(reopened);
    S.sources = [{ id: 1, name: 'test.pdf', pdfLibDoc: reopened, pdfjsDoc: null }];
    S.pages = [0, 90, 180, 270].map((rotation, i) => ({
      id: i + 1, kind: 'imported', sourceId: 1, sourcePageIndex: i, W0: 612, H0: 792, rotation,
      annotations: again.get(i).map((t, k) => ({ id: k + 1, ...t.markup })),
    }));
    const second = await PDFDocument.load(await buildPdfBytes());
    check('a second save does not duplicate markups', second.getPages().every((p) => ours(p).length === 3),
      second.getPages().map((p) => ours(p).length).join(','));
    S.sources = [{ id: 1, name: 'test.pdf', pdfLibDoc, pdfjsDoc: null }];
  }

  // --- 11. Flattened, a markup is paint and nothing else ---
  S.pages = [{ id: 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 0, annotations: marks() }];
  doc = await PDFDocument.load(await buildPdfBytes({ flatten: true }));
  check('flattening leaves no annotation behind', doc.getPage(0).node.Annots().size() === 0,
    `${doc.getPage(0).node.Annots().size()} annotations`);
  // Text, and the straight segments of a box and a pen stroke.
  check('and paints the markups into the page', /\bTj\b/.test(pageContent(doc.getPage(0))) && /\bl\b/.test(pageContent(doc.getPage(0))));
  check('so there is nothing to give back', takeMarkups(doc).size === 0);

  // --- 12. Other programs' annotations are not ours to take ---
  {
    const other = await PDFDocument.create();
    const pg = other.addPage([612, 792]);
    const link = other.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], Border: [0, 0, 0] });
    const note = other.context.obj({ Type: 'Annot', Subtype: 'FreeText', Rect: [100, 100, 200, 140], Contents: PDFHexString.fromText('from elsewhere') });
    pg.node.addAnnot(other.context.register(link));
    pg.node.addAnnot(other.context.register(note));
    const loaded = await PDFDocument.load(await other.save());
    check('annotations from other programs are left alone', takeMarkups(loaded).size === 0 && loaded.getPage(0).node.Annots().size() === 2);
    S.sources = [{ id: 1, name: 'other.pdf', pdfLibDoc: loaded, pdfjsDoc: null }];
    S.pages = [{ id: 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 0, annotations: marks().slice(0, 1) }];
    const out2 = await PDFDocument.load(await buildPdfBytes());
    check('and survive a save alongside ours', out2.getPage(0).node.Annots().size() === 3 && ours(out2.getPage(0)).length === 1,
      `${out2.getPage(0).node.Annots().size()} annotations`);
    S.sources = [{ id: 1, name: 'test.pdf', pdfLibDoc, pdfjsDoc: null }];
  }

  // --- 13. A PDF is someone else's file ---
  {
    const hostile = [
      'not json at all',
      JSON.stringify({ v: 1, R: 0, type: 'text', color: 'red;background:url(x)', x: 1, y: 1, width: 100, text: 'x', fontSize: 12 }),
      JSON.stringify({ v: 1, R: 0, type: 'text', color: '#000000', x: 'NaN', y: 1, width: 100, text: 'x', fontSize: 12 }),
      JSON.stringify({ v: 1, R: 0, type: 'text', color: '#000000', x: 1, y: 1, width: 100, text: { toString: 1 }, fontSize: 12 }),
      JSON.stringify({ v: 1, R: 0, type: 'text', color: '#000000', x: 1e12, y: 1, width: 100, text: 'x', fontSize: 12 }),
      JSON.stringify({ v: 1, R: 0, type: 'script', color: '#000000' }),
      JSON.stringify({ v: 1, R: 0, type: 'ink', color: '#000000', size: 2, points: [[1, 2], ['a', 3]] }),
      JSON.stringify({ v: 2, R: 0, type: 'ink', color: '#000000', size: 2, points: [[1, 2]] }),
      '{"v":1,"R":0,"type":"text","color":"#000000","x":1,"y":1,"width":100,"text":"ok","fontSize":12,"__proto__":{"polluted":true},"onclick":"alert(1)"}',
    ];
    const bad = await PDFDocument.create();
    const pg = bad.addPage([612, 792]);
    for (const h of hostile) {
      pg.node.addAnnot(bad.context.register(bad.context.obj({
        Type: 'Annot', Subtype: 'FreeText', Rect: [0, 0, 10, 10], RedlineMarkup: PDFHexString.fromText(h),
      })));
    }
    const loaded = await PDFDocument.load(await bad.save());
    const got = takeMarkups(loaded).get(0) || [];
    check('malformed markups are refused', got.length === 1, `${got.length} accepted`);
    check('and left in the file rather than deleted', loaded.getPage(0).node.Annots().size() === hostile.length - 1);
    const m = got[0] ? got[0].markup : {};
    check('an accepted one carries only the fields a markup has',
      Object.keys(m).sort().join() === 'color,fill,fontSize,text,type,width,x,y' && ({}).polluted === undefined, Object.keys(m).join());
  }

  // --- 14. Highlight, arrow, box and cloud are point shapes like ink ---
  {
    const { shapePolylines } = stateMod;
    const shapes = () => ([
      { id: 1, type: 'highlight', color: '#e3b505', size: 13, points: [{ x: 60, y: 80 }, { x: 120, y: 82 }, { x: 200, y: 79.5 }] },
      { id: 2, type: 'arrow', color: '#b23a3a', size: 2.5, points: [{ x: 100, y: 300 }, { x: 240, y: 220 }] },
      { id: 3, type: 'rect', color: '#1f6feb', size: 1.2, points: [{ x: 300, y: 400 }, { x: 420, y: 470 }] },
      { id: 4, type: 'cloud', color: '#b23a3a', size: 2.5, points: [{ x: 80, y: 500 }, { x: 260, y: 600 }] },
    ]);
    S.pages = [0, 90, 180, 270].map((rotation, i) => ({
      id: i + 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation, annotations: shapes(),
    }));
    const bytes = await buildPdfBytes();
    const d = await PDFDocument.load(bytes);
    const kinds2 = ours(d.getPage(0)).map((x) => String(x.get(N('Subtype'))));
    check('new shapes are standard annotation types too', kinds2.join() === '/Ink,/Line,/Square,/Polygon', kinds2.join());
    check('a cloud says it is one', String(ours(d.getPage(0))[3].get(N('IT'))) === '/PolygonCloud');

    // The rectangle must hold everything drawn — an arrow's head and a
    // cloud's scallops reach past the two points that define them.
    const { toNative } = stateMod;
    let holds = true, why = '';
    d.getPages().forEach((p, i) => {
      const R = [0, 90, 180, 270][i];
      ours(p).forEach((an, k) => {
        const rect = an.lookup(N('Rect')).asArray().map((n) => n.asNumber());
        const a = shapes()[k];
        for (const line of shapePolylines(a)) for (const q of line) {
          const n = toNative(R, 612, 792, q.x, q.y);
          const h = a.size / 2;
          if (n.x - h < rect[0] - 0.02 || n.x + h > rect[2] + 0.02 || n.y - h < rect[1] - 0.02 || n.y + h > rect[3] + 0.02) {
            holds = false; why = `${a.type} at R=${R}`;
          }
        }
      });
    });
    check('each rectangle holds the whole shape at every rotation', holds, why);

    // A highlight is one translucent path that multiplies with the sheet.
    const hl = ours(d.getPage(0))[0].lookup(N('AP'), PDFDict).lookup(N('N'));
    const hlBody = text(decodePDFRawStream(hl).decode());
    const gs = hl.dict.lookup(N('Resources'), PDFDict).lookup(N('ExtGState'), PDFDict);
    const gsDict = gs.lookup(gs.keys()[0], PDFDict);
    check('a highlight is stroked once, as one path', (hlBody.match(/\bS\b/g) || []).length === 1, hlBody.slice(0, 120));
    check('translucent, and multiplied with what is under it',
      gsDict.lookup(N('CA')).asNumber() === stateMod.HIGHLIGHT_OPACITY && String(gsDict.get(N('BM'))) === '/Multiply');
    check('with round joins', /\b1 j\b/.test(hlBody) && /\b1 J\b/.test(hlBody), hlBody.slice(0, 120));

    const back = takeMarkups(d);
    let exact2 = true;
    for (let i = 0; i < 4; i++) (back.get(i) || []).forEach((t, k) => {
      if (!same({ ...t.markup, type: 'ink' }, { ...shapes()[k], type: 'ink' }) || t.markup.type !== shapes()[k].type) exact2 = false;
    });
    check('and all four come back as they were', [0, 1, 2, 3].every((i) => (back.get(i) || []).length === 4) && exact2,
      JSON.stringify(back.get(1)));

    S.pages = [S.pages[0]];
    const flatDoc = await PDFDocument.load(await buildPdfBytes({ flatten: true }));
    const painted = pageContent(flatDoc.getPage(0));
    check('flattened, they are painted into the page', flatDoc.getPage(0).node.Annots().size() === 0
      && (painted.match(/\bS\b/g) || []).length === 4, `${(painted.match(/\bS\b/g) || []).length} strokes`);

    // An arrow, a box and a cloud are two points. Anything else under
    // those names did not come from this editor.
    const odd = await PDFDocument.create();
    const pg = odd.addPage([612, 792]);
    for (const h of [
      { v: 1, R: 0, type: 'arrow', color: '#000000', size: 2, points: [[1, 2], [3, 4], [5, 6]] },
      { v: 1, R: 0, type: 'cloud', color: '#000000', size: 2, points: [[1, 2]] },
      { v: 1, R: 0, type: 'rect', color: '#000000', size: 2, points: [[1, 2], [30, 40]] },
    ]) {
      pg.node.addAnnot(odd.context.register(odd.context.obj({
        Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 10, 10], RedlineMarkup: PDFHexString.fromText(JSON.stringify(h)),
      })));
    }
    const got = takeMarkups(await PDFDocument.load(await odd.save())).get(0) || [];
    check('a two-point shape with the wrong number of points is refused', got.length === 1 && got[0].markup.type === 'rect', `${got.length} accepted`);
  }

  // --- 15. A note's white fill is a choice, and the choice is kept ---
  {
    const note = (fill) => ({ id: 1, type: 'text', x: 40, y: 60, width: 170, text: 'Over linework', fontSize: 12, color: '#b23a3a', fill });
    const paint = async (fill) => {
      S.pages = [{ id: 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 0, annotations: [note(fill)] }];
      return pageContent((await PDFDocument.load(await buildPdfBytes({ flatten: true }))).getPage(0));
    };
    const filled = await paint(true), bare = await paint(false);
    check('a filled note paints an opaque white box', /1 1 1 rg/.test(filled) && /\bB\b/.test(filled) && !/\/GS/.test(filled), filled.slice(0, 160));
    check('an unfilled one paints only its frame', !/1 1 1 rg/.test(bare) && !/\bB\b/.test(bare) && /\bS\b/.test(bare), bare.slice(0, 160));

    const trip = async (fill) => {
      S.pages = [{ id: 1, kind: 'imported', sourceId: 1, sourcePageIndex: 0, W0: 612, H0: 792, rotation: 0, annotations: [note(fill)] }];
      return takeMarkups(await PDFDocument.load(await buildPdfBytes())).get(0)[0].markup.fill;
    };
    check('the choice survives a save', (await trip(false)) === false && (await trip(true)) === true);
    check('a note saved before the option existed comes back filled', marks().every((m) => m.fill === undefined)
      && (takeMarkups(await PDFDocument.load(editable)).get(0) || []).filter((t) => t.markup.type !== 'ink').every((t) => t.markup.fill === true));
  }
}

print(failures ? `\n${failures} FAILURE(S)` : '\nAll export checks passed');
// A printed FAIL that leaves the exit status at 0 is a suite that cannot fail.
if (failures) throw new Error('export checks failed');
