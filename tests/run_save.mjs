/* The save path (js/files.js), and the three ways it used to lose work.
 *
 * All three are about *when* something is read: a note's text is taken on
 * blur, the document being written is read across awaits that let another
 * tab come forward, and a merge decides whether ⌘S still has a file to
 * write to. Each one is only visible end to end — what bytes reached
 * which handle — so this suite drives the real save() and saveAs()
 * against fake file handles and reads the PDF back out.
 */
import { APP, VENDOR } from './paths.mjs';
import './shim.mjs';

globalThis.self = globalThis;
globalThis.console = {
  log: (...a) => print(a.join(' ')),
  error: () => {},                  // the save paths log their own failures
  warn: () => {},
};
load(VENDOR + '/pdf-lib.min.js');
const { PDFDocument } = globalThis.PDFLib;

// pdf.js is only ever asked for a document object here; nothing in this
// suite renders. A fake worker keeps pages.js's lazy pdfWorker() happy.
globalThis.pdfjsLib = {
  GlobalWorkerOptions: {},
  PDFWorker: function PDFWorker() { /* a message pump nobody messages */ },
  getDocument: () => ({ promise: Promise.resolve({ numPages: 1, destroy: () => Promise.resolve() }) }),
};
// files.js reads this at module load to decide whether the save panel
// exists; both halves of saveAs() are exercised below.
globalThis.showSaveFilePicker = async () => { throw new Error('no picker in this test'); };

const stateMod = await import(`${APP}/state.js`);
const H = await import(`${APP}/history.js`);
const { buildPdfBytes, takeMarkups } = await import(`${APP}/export.js`);
const files = await import(`${APP}/files.js`);
const { importPdfBytes } = await import(`${APP}/pages.js`);
const { state: S, blankDoc, loadDocIntoState, captureActiveDoc } = stateMod;

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};

// ============================================================
// Fixtures
// ============================================================
/** A one-page source document, and a Redline source record for it. */
async function source(id = 1, name = 'source.pdf') {
  const src = await PDFDocument.create();
  src.addPage([612, 792]);
  const bytes = await src.save();
  return {
    record: { id, name, pdfLibDoc: await PDFDocument.load(bytes.slice(0)), pdfjsDoc: null },
    bytes,
  };
}

const page = (id, sourceId, annotations = []) => ({
  id, kind: 'imported', sourceId, sourcePageIndex: 0,
  W0: 612, H0: 792, rotation: 0, annotations,
});
const note = (id, text) => ({
  id, type: 'text', x: 40, y: 60, width: 170, text, fontSize: 12, color: '#b23a3a',
});

/** A FileSystemFileHandle as much as the save path needs one: it grants
 *  permission, and it remembers the last bytes written to it. */
function handleFor(name) {
  const h = {
    name,
    written: null,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (bytes) => { h.written = bytes; },
      close: async () => {},
    }),
  };
  return h;
}

/** The text of every markup in a written PDF, by page. */
function markupTexts(bytes) {
  return PDFDocument.load(bytes).then((doc) => {
    const out = [];
    const found = takeMarkups(doc);
    for (const [index, list] of found) out.push([index, list.map((e) => e.markup.text)]);
    return out;
  });
}

/** A document with one page and one note, as the active tab. */
async function docWith(text, { name = 'A.pdf', sourceId = 1 } = {}) {
  const { record } = await source(sourceId, name);
  const doc = blankDoc();
  S.docs.push(doc);
  captureActiveDoc();
  loadDocIntoState(doc);
  S.sources = [record];
  const a = note(1, text);
  S.pages = [page(1, sourceId, [a])];
  S.selectedPageId = 1;
  S.docName = name;
  S.nextAnnoId = 2;
  H.startFresh();
  return { doc, anno: a };
}

function reset() {
  S.docs.length = 0;
  S.activeDocId = null;
  document.activeElement = null;
}

// ============================================================
// 1. ⌘S finishes the note that is being typed into
//
// A note's text is committed in the textarea's blur handler and nowhere
// else. ⌘S runs straight off the keydown, and with a file handle already
// granted nothing takes the focus away — so the save used to write the
// text from before the edit and then mark the document clean, after which
// beforeunload no longer warned about it.
// ============================================================
{
  reset();
  const { doc, anno } = await docWith('before the edit');
  const handle = handleFor('A.pdf');
  S.fileHandle = handle;
  stateMod.markDirty(true);

  // What the editor looks like mid-edit: the note's box has focus, and
  // its blur handler is what commits the typed text (annots.js).
  let blurred = 0;
  document.activeElement = {
    classList: { contains: (c) => c === 'anno-text' },
    blur() { blurred++; anno.text = 'typed, not yet blurred'; },
  };

  await files.save();
  check('⌘S takes the focus off the note being typed into', blurred === 1, `${blurred} blurs`);
  check('and writes bytes to the open file', handle.written && handle.written.length > 1000);
  const texts = await markupTexts(handle.written);
  check('with the text as typed, not as it was before the edit',
    texts.length === 1 && texts[0][1].join() === 'typed, not yet blurred', JSON.stringify(texts));
  check('and only then is the document clean', S.dirty === false && doc.dirty === false,
    `S.dirty=${S.dirty} doc.dirty=${doc.dirty}`);
}

// A note placed and left empty is taken away by its blur handler, and the
// step that added it with it — so finishTyping can empty the document.
// That is why it runs before the "nothing to save" check.
{
  reset();
  const { } = await docWith('x');
  S.fileHandle = handleFor('A.pdf');
  document.activeElement = {
    classList: { contains: (c) => c === 'anno-text' },
    blur() { S.pages = []; },
  };
  await files.save();
  check('a save that is left with nothing to write writes nothing',
    S.fileHandle.written === null);
}

// ============================================================
// 2. A save belongs to the document it started on
//
// buildPdfBytes yields every SAVE_PACE objects, and save() used to read
// state.fileHandle after it. Turn to another tab while a drawing set is
// being serialised and one document's pages went into another document's
// file — and the wrong tab was marked clean.
// ============================================================
{
  reset();
  const a = await docWith('document A', { name: 'A.pdf', sourceId: 1 });
  const handleA = handleFor('A.pdf');
  S.fileHandle = handleA;
  stateMod.markDirty(true);

  const b = await docWith('document B', { name: 'B.pdf', sourceId: 2 });
  const handleB = handleFor('B.pdf');
  S.fileHandle = handleB;
  stateMod.markDirty(true);

  // Back to A, and save it.
  captureActiveDoc();
  loadDocIntoState(a.doc);
  const saving = files.save();
  // The user turns to B while the export is still running — which is
  // exactly what the pauses in buildPdfBytes are for.
  captureActiveDoc();
  loadDocIntoState(b.doc);
  await saving;

  check('the save writes to the file of the document it began on', handleA.written !== null);
  check('and not to the one that came forward meanwhile', handleB.written === null);
  const texts = await markupTexts(handleA.written);
  check('the bytes are that document\'s pages', texts[0][1].join() === 'document A', JSON.stringify(texts));
  check('it is that document that is now clean', a.doc.dirty === false);
  check('the tab in front keeps its unsaved work', S.dirty === true && S.activeDocId === b.doc.id);
}

// Save As aims ⌘S at the file the panel chose — for the document that was
// saved, not for whichever tab is in front when the panel closes.
{
  reset();
  const a = await docWith('document A', { name: 'A.pdf', sourceId: 1 });
  stateMod.markDirty(true);
  const b = await docWith('document B', { name: 'B.pdf', sourceId: 2 });
  const handleB = handleFor('B.pdf');
  S.fileHandle = handleB;

  captureActiveDoc();
  loadDocIntoState(a.doc);
  const chosen = handleFor('Chosen.pdf');
  globalThis.showSaveFilePicker = async () => chosen;
  const saving = files.saveAs();
  captureActiveDoc();
  loadDocIntoState(b.doc);
  await saving;

  check('Save As writes the document it was asked for', chosen.written !== null);
  check('the handle it chose becomes that document\'s', a.doc.fileHandle === chosen, String(a.doc.fileHandle && a.doc.fileHandle.name));
  check('and its name too', a.doc.docName === 'Chosen.pdf', a.doc.docName);
  check('the tab in front keeps its own file', S.fileHandle === handleB && S.docName === 'B.pdf');
  // And it is that document's history the save counted against, not the
  // one that came forward (history.js, noteClean).
  captureActiveDoc();
  loadDocIntoState(a.doc);
  check('the document that was saved reports no unsaved changes',
    H.historyStatus().changes === 0, String(H.historyStatus().changes));
}

// A flattened copy is of the document it was asked for as well, and the
// open document keeps its own name and target either way.
{
  reset();
  const a = await docWith('document A', { name: 'A.pdf', sourceId: 1 });
  const handleA = handleFor('A.pdf');
  S.fileHandle = handleA;
  const b = await docWith('document B', { name: 'B.pdf', sourceId: 2 });

  captureActiveDoc();
  loadDocIntoState(a.doc);
  const flat = handleFor('A - flattened.pdf');
  globalThis.showSaveFilePicker = async () => flat;
  const saving = files.saveFlattenedCopy();
  captureActiveDoc();
  loadDocIntoState(b.doc);
  await saving;

  check('a flattened copy holds the pages of the document it was asked for',
    flat.written !== null && flat.written.length > 1000);
  const back = await markupTexts(flat.written);
  check('with the markups painted in, so none come back as markups', back.length === 0, JSON.stringify(back));
  check('and the open document keeps its own save target', a.doc.fileHandle === handleA && a.doc.docName === 'A.pdf');
}

// ============================================================
// 3. Every merge drops the save target, not only the first
//
// A Save As after a merge gives the document a new handle and leaves
// `combined` set. The next merge used to keep that handle, so ⌘S quietly
// overwrote the file the save panel had just written with a document that
// had another file in it.
// ============================================================
{
  reset();
  const { bytes } = await source(1, 'A.pdf');
  const doc = blankDoc();
  S.docs.push(doc);
  loadDocIntoState(doc);

  // Open A from a handle: the file becomes the document, and ⌘S aims at it.
  const opened = handleFor('A.pdf');
  await importPdfBytes(bytes.slice(0), 'A.pdf', { handle: opened, into: doc });
  check('opening a file into an empty document adopts its handle', S.fileHandle === opened);
  check('and its name', S.docName === 'A.pdf', S.docName);

  // Merge B: the document is no longer that file.
  await importPdfBytes(bytes.slice(0), 'B.pdf', { handle: handleFor('B.pdf'), into: doc });
  check('the first merge drops the handle', S.fileHandle === null);
  check('and names the document for what it now is', S.docName === 'Combined.pdf', S.docName);
  check('both files\' pages are in it', S.pages.length === 2, String(S.pages.length));

  // Save As to C. ⌘S aims at C from here on.
  const c = handleFor('C.pdf');
  globalThis.showSaveFilePicker = async () => c;
  await files.saveAs();
  check('Save As gives the combined document a file again', S.fileHandle === c);

  // Merge D. This is the one that used to overwrite C.
  const wasWritten = c.written;
  await importPdfBytes(bytes.slice(0), 'D.pdf', { handle: handleFor('D.pdf'), into: doc });
  check('a merge after a Save As drops that handle too', S.fileHandle === null,
    String(S.fileHandle && S.fileHandle.name));
  check('all three files are in the document', S.pages.length === 3, String(S.pages.length));
  check('the name chosen in the save panel is kept as the suggestion',
    S.docName === 'C.pdf', S.docName);

  // Undo gives the file back: the checkpoint taken before the merge holds
  // the document's identity (history.js).
  H.undo();
  check('undoing the merge gives the file back', S.fileHandle === c, String(S.fileHandle && S.fileHandle.name));
  check('with the pages it had before it', S.pages.length === 2, String(S.pages.length));
  H.redo();
  check('and redoing it takes the file away again', S.fileHandle === null && S.pages.length === 3);

  // So the next ⌘S asks where to put it instead of replacing C.
  const e = handleFor('E.pdf');
  let panels = 0;
  globalThis.showSaveFilePicker = async () => { panels++; return e; };
  await files.save();
  check('⌘S after that merge asks where to put it', panels === 1, `${panels} panels`);
  check('and the file the save panel chose before is left as it was',
    c.written === wasWritten && e.written !== null);
}

// ⌘S on a document with no file goes through the save panel — which is
// what dropping the handle is for.
{
  reset();
  const { bytes } = await source(1, 'A.pdf');
  const doc = blankDoc();
  S.docs.push(doc);
  loadDocIntoState(doc);
  await importPdfBytes(bytes.slice(0), 'A.pdf', { handle: handleFor('A.pdf'), into: doc });
  await importPdfBytes(bytes.slice(0), 'B.pdf', { into: doc });
  const asked = handleFor('Asked.pdf');
  let panels = 0;
  globalThis.showSaveFilePicker = async () => { panels++; return asked; };
  await files.save();
  check('a merged document\'s ⌘S asks where to put it', panels === 1, `${panels} panels`);
  check('and writes where it was told', asked.written !== null && S.fileHandle === asked);
}

// ============================================================
// 4. buildPdfBytes without tabs at all
//
// The export tests drive it with nothing but `state`; that has to go on
// working, so the document it reads defaults to the active one and falls
// back to state when there is none.
// ============================================================
{
  reset();
  const { record } = await source(1, 'loose.pdf');
  S.sources = [record];
  S.pages = [page(1, 1, [note(1, 'no tabs here')])];
  S.docName = 'loose.pdf';
  const bytes = await buildPdfBytes();
  const texts = await markupTexts(bytes);
  check('an export with no open documents reads state', texts[0][1].join() === 'no tabs here', JSON.stringify(texts));
}

print(failures ? `\n${failures} FAILURE(S)` : '\nAll save checks passed');
if (failures) throw new Error('save checks failed');
