/* The document as the local model reads it (js/aitext.js): fragments into
 * blocks, and the passages chosen for a question. No model here — this is
 * the part that decides what the model is given, which is where the
 * Bernalillo answers went wrong before they went right.
 */
import { APP, VENDOR } from './paths.mjs';
import './shim.mjs';

globalThis.self = globalThis;
globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: () => {} };
load(VENDOR + '/pdf-lib.min.js');
globalThis.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({}) }) };

const { textBlocks, chooseText } = await import(`${APP}/aitext.js`);
const { state } = await import(`${APP}/state.js`);

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};

// A fragment as pdf.js gives it: text, a transform (size, angle, x, y), a width.
const frag = (str, x, y, { size = 10, turned = false, width } = {}) => ({
  str, width: width ?? str.length * size * 0.5,
  transform: turned ? [0, size, -size, 0, x, y] : [size, 0, 0, size, x, y],
});

// --- 1. Rows split at wide gaps; wrapped lines stack into one block ---
{
  const blocks = textBlocks([
    // A note wrapping over three lines, at x = 100.
    frag('3. THE PROJECT AREA WILL HAVE MINOR', 100, 700),
    frag('GRADING AND MOWING AROUND', 100, 688),
    frag('EQUIPMENT.', 100, 676),
    // On the same rows, far to the right: a map label and a table value.
    frag('LOST HORIZON ROAD', 900, 700),
    frag('3,567 AC ±', 1500, 688),
  ]).map((b) => b.text);
  check('a wrapped note is one block', blocks.includes('3. THE PROJECT AREA WILL HAVE MINOR\nGRADING AND MOWING AROUND\nEQUIPMENT.'), JSON.stringify(blocks));
  check('things far apart on the same row stay apart', blocks.includes('LOST HORIZON ROAD') && blocks.includes('3,567 AC ±')
    && !blocks.some((b) => b.includes('ROAD') && b.includes('MOWING')), JSON.stringify(blocks));
  check('blocks come out top to bottom', blocks.indexOf('LOST HORIZON ROAD') < blocks.indexOf('3,567 AC ±'));
}

// --- 2. Words close together on a row are one phrase ---
{
  const blocks = textBlocks([frag('BERNALILLO', 100, 500, { width: 50 }), frag('COUNTY,', 155, 500, { width: 35 }), frag('NM', 195, 500, { width: 10 })]).map((b) => b.text);
  check('a phrase set in separate fragments reads as one', blocks.length === 1 && blocks[0] === 'BERNALILLO COUNTY, NM', JSON.stringify(blocks));
}

// --- 3. Map tags are not words ---
{
  const blocks = textBlocks([
    frag('VLT VLT VLT VLT', 100, 600), frag('X', 300, 500), frag('LoD', 500, 400),
    frag('A-1', 700, 300), frag('PR. FENCE', 900, 200), frag('LoD LoD LoD 24\' ROAD', 1100, 100),
  ]).map((b) => b.text);
  check('a run of one repeated tag collapses to one, and goes like a lone tag', !blocks.some((b) => b.includes('VLT')), JSON.stringify(blocks));
  check('a repeated tag beside real words keeps one copy', blocks.includes("LoD 24' ROAD"), JSON.stringify(blocks));
  check('a lone short tag on its own is dropped', !blocks.includes('X') && !blocks.includes('LoD'), JSON.stringify(blocks));
  check('but not a short code with a digit in it', blocks.includes('A-1'), JSON.stringify(blocks));
}

// --- 4. Turned text is kept whole, not shredded into rows ---
{
  const blocks = textBlocks([frag('BERNALILLO SOLAR', 2000, 300, { turned: true }), frag('NOTES', 100, 700)]).map((b) => b.text);
  check('a title turned up the sheet is kept as written', blocks.includes('BERNALILLO SOLAR') && blocks.at(-1) === 'BERNALILLO SOLAR', JSON.stringify(blocks));
}

// --- 5. Passages chosen for a question ---
{
  // Three small pages whose text pdf.js would give back as these fragments.
  const pageItems = [
    [frag('LEGEND', 100, 700), frag('PR. 24\' SITE ACCESS ROAD', 100, 680), frag('PR. 16\' SITE ACCESS ROAD', 100, 668), frag('PR. BESS AREA', 100, 656),
     frag('ESTRELLA WEST LLC', 900, 500), frag('BERNALILLO COUNTY, NM', 900, 300)],
    [frag('LEGEND', 100, 700), frag('PR. 24\' SITE ACCESS ROAD', 100, 680), frag('PR. 16\' SITE ACCESS ROAD', 100, 668), frag('PR. BESS AREA', 100, 656),
     frag('PROPOSED BESS AREA: 27.5 AC', 900, 400)],
    [frag('4. ALL PROPOSED IMPROVEMENTS WILL BE FENCED WITH A', 100, 700), frag('MINIMUM 6\' TALL CHAIN LINK FENCE.', 100, 688)],
  ];
  const { PDFDocument } = globalThis.PDFLib;
  const lib = await PDFDocument.create();
  for (let i = 0; i < 3; i++) lib.addPage([612, 792]);
  state.sources = [{ id: 1, name: 't.pdf', pdfLibDoc: lib,
    pdfjsDoc: { getPage: async (n) => ({ getTextContent: async () => ({ items: pageItems[n - 1] }) }) } }];
  state.pages = [0, 1, 2].map((i) => ({ id: i + 1, kind: 'imported', sourceId: 1, sourcePageIndex: i, W0: 612, H0: 792, rotation: 0, annotations: [] }));
  state.selectedPageId = 1;

  let c = await chooseText('What is the BESS area?', { scope: 'all', budget: 2000 });
  check('the passage with the answer comes first', c.passages[0] && c.passages[0].n === 2 && c.passages[0].text.includes('27.5 AC'), JSON.stringify(c.passages));
  const legends = c.passages.filter((p) => p.text.startsWith('LEGEND'));
  check('a legend repeated on two sheets is sent once', legends.length <= 1, JSON.stringify(c.passages));

  c = await chooseText('How tall is the fence?', { scope: 'all', budget: 2000 });
  check('a question finds its note by the drawing\'s own words', c.passages[0] && c.passages[0].n === 3 && /6' TALL/.test(c.passages[0].text), JSON.stringify(c.passages));

  c = await chooseText('Where is this project located?', { scope: 'all', budget: 2000 });
  check('"where" also looks for COUNTY', c.passages.some((p) => p.text === 'BERNALILLO COUNTY, NM'), JSON.stringify(c.passages));

  c = await chooseText('Who owns it?', { scope: 'all', budget: 2000 });
  check('"who owns" finds the LLC', c.passages[0] && c.passages[0].text === 'ESTRELLA WEST LLC', JSON.stringify(c.passages));

  c = await chooseText('What is the BESS area?', { scope: 'page', budget: 2000 });
  check('"this page" reads only the page on screen', c.passages.every((p) => p.n === 1) && c.pages.join() === '1', JSON.stringify(c));

  c = await chooseText('What is the BESS area?', { scope: 'all', budget: 40 });
  check('the budget is kept', c.passages.reduce((s, p) => s + p.text.length + 10, 0) <= 40, JSON.stringify(c.passages));

  c = await chooseText('Summarise it', { scope: 'all', budget: 2000 });
  check('a question with nothing to look for gets the page on screen', c.passages.length > 0 && c.passages.every((p) => p.n === 1), JSON.stringify(c.passages));
}

print(failures ? `\n${failures} FAILURE(S)` : '\nAll AI text checks passed');
if (failures) throw new Error('AI text checks failed');
