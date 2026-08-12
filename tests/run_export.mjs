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
const { buildPdfBytes } = await import(`${APP}/export.js`);
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

print(failures ? `\n${failures} FAILURE(S)` : '\nAll export checks passed');
