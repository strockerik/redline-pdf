/* Undo and redo (js/history.js): what a checkpoint holds, what stepping
 * back restores, and — the part with consequences — when the document is
 * allowed to call itself saved.
 */
import { APP } from './paths.mjs';
import './shim.mjs';

globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: () => {} };

const stateMod = await import(`${APP}/state.js`);
const H = await import(`${APP}/history.js`);
const { state: S, blankDoc, captureActiveDoc, loadDocIntoState } = stateMod;

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};

function freshDoc() {
  const doc = blankDoc();
  S.docs.push(doc);
  loadDocIntoState(doc);
  return doc;
}
const page = (id, annotations = []) => ({ id, kind: 'blank', W0: 612, H0: 792, rotation: 0, annotations });
const note = (id, text) => ({ id, type: 'text', x: 10, y: 10, width: 100, text, fontSize: 12, color: '#b23a3a' });
const ink = (id) => ({ id, type: 'ink', color: '#000000', size: 2, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });

// --- 1. A checkpoint is the document before the change ---
{
  freshDoc();
  const p1 = page(1, [note(1, 'first')]), p2 = page(2);
  S.pages = [p1, p2];
  S.selectedPageId = 1;

  H.checkpoint('Edit note');
  p1.annotations[0].text = 'changed';
  check('undo says what it undid', H.undo() === 'Edit note');
  check('and puts the text back', S.pages[0].annotations[0].text === 'first');
  check('redo says what it redid', H.redo() === 'Edit note');
  check('and puts the change back', S.pages[0].annotations[0].text === 'changed');
  check('nothing further to redo', H.redo() === null);

  // Thumbnails and GPU plots are cached against the page object; undo
  // must hand back the same object, not a copy.
  H.checkpoint('Delete page');
  S.pages = [p2];
  H.undo();
  check('a deleted page comes back', S.pages.length === 2 && S.pages[0].id === 1);
  check('as the very same object', S.pages[0] === p1 && S.pages[1] === p2);

  H.checkpoint('Move page');
  S.pages = [p2, p1];
  H.undo();
  check('page order is restored', S.pages.map((p) => p.id).join() === '1,2');

  H.checkpoint('Rotate page');
  p1.rotation = 90;
  H.undo();
  check('rotation is restored', p1.rotation === 0);
}

// --- 2. A checkpoint survives being restored and edited again ---
{
  freshDoc();
  const p = page(1, [ink(1)]);
  S.pages = [p];
  H.checkpoint('Move markup');
  p.annotations[0].points[0].x = 500;
  H.undo();
  check('points are restored', S.pages[0].annotations[0].points[0].x === 1);
  // What is on screen after a restore is a copy. Scribbling on it in
  // place must not reach back into the checkpoint it came from.
  H.redo();
  check('redo gives the moved stroke', S.pages[0].annotations[0].points[0].x === 500);
  S.pages[0].annotations[0].points[0].x = 777;
  H.undo();
  check('undo still gives the original', S.pages[0].annotations[0].points[0].x === 1,
    String(S.pages[0].annotations[0].points[0].x));
  S.pages[0].annotations[0].points[0].x = 888;
  H.redo(); H.undo();
  check('however many times it is restored and scribbled on', S.pages[0].annotations[0].points[0].x === 888
    && (H.redo(), S.pages[0].annotations[0].points[0].x === 777));
}

// --- 3. Doing something new throws away what could have been redone ---
{
  freshDoc();
  const p = page(1);
  S.pages = [p];
  H.checkpoint('Add note'); p.annotations.push(note(1, 'a'));
  H.checkpoint('Add note'); S.pages[0].annotations.push(note(2, 'b'));
  H.undo();
  H.checkpoint('Add pen stroke'); S.pages[0].annotations.push(ink(3));
  const st = H.historyStatus();
  check('redo is empty after a new action', !st.canRedo && H.redo() === null);
  check('undo names the latest action', st.canUndo && st.undoLabel === 'Add pen stroke');
}

// --- 4. Saved means saved: the count, and the dirty flag ---
{
  freshDoc();
  const p = page(1);
  S.pages = [p];
  const add = (id) => { H.checkpoint('Add note'); S.pages[0].annotations.push(note(id, 'x')); stateMod.markDirty(); };
  add(1); add(2); add(3);
  check('three changes since opening', H.historyStatus().changes === 3 && S.dirty);
  check('never saved, so no time to show', H.historyStatus().savedAt === null);

  H.noteClean({ saved: true });
  stateMod.markDirty(false);
  check('saving resets the count and records when', H.historyStatus().changes === 0 && H.historyStatus().savedAt > 0);

  add(4);
  check('one change after the save', H.historyStatus().changes === 1 && S.dirty);
  H.undo();
  check('undoing back to the save is clean again', !S.dirty && H.historyStatus().changes === 0);
  H.undo();
  check('undoing past it is not', S.dirty && H.historyStatus().changes === 1);
  H.redo();
  check('redoing back to it is clean', !S.dirty);

  // The trap: undo past the save, then do something else. The saved
  // state is no longer reachable, and no arithmetic may say otherwise.
  H.undo();
  add(9);
  check('undo past a save then a new edit: still unsaved', S.dirty && H.historyStatus().changes > 0);
  H.undo();
  check('and no amount of undoing makes it clean', S.dirty && H.historyStatus().changes > 0, `changes ${H.historyStatus().changes}`);
  H.undo(); H.undo();
  check('all the way back', S.dirty && !H.historyStatus().canUndo);
  H.noteClean({ saved: true });
  stateMod.markDirty(false);
  add(10);
  H.undo();
  check('until the next save, after which it can be again', !S.dirty);
}

// --- 5. An abandoned action leaves nothing to step over ---
{
  freshDoc();
  const p = page(1);
  S.pages = [p];
  H.checkpoint('Add note');
  p.annotations.push(note(1, ''));
  stateMod.markDirty();
  p.annotations.pop();                 // placed, never typed into
  H.discardLast();
  check('discarding the last checkpoint empties the stack', !H.historyStatus().canUndo);
  check('and the document is clean again', !S.dirty && H.historyStatus().changes === 0);

  const held = H.hold();
  check('holding a checkpoint is not a change', !H.historyStatus().canUndo);
  p.annotations.push(note(2, 'typed'));
  H.commit(held, 'Edit note');
  check('committing it is', H.historyStatus().undoLabel === 'Edit note');
  H.undo();
  check('and undo returns to when it was held', S.pages[0].annotations.length === 0);
}

// --- 6. Each document has its own history ---
{
  const a = freshDoc();
  S.pages = [page(1)];
  H.checkpoint('Add note'); S.pages[0].annotations.push(note(1, 'in A'));
  captureActiveDoc();

  const b = freshDoc();
  S.pages = [page(1)];
  check('a new document starts with nothing to undo', !H.historyStatus().canUndo);
  H.checkpoint('Add blank page'); S.pages.push(page(2));
  captureActiveDoc();

  loadDocIntoState(a);
  check('switching back finds the first document\'s own step', H.historyStatus().undoLabel === 'Add note');
  H.undo();
  check('undo there leaves the other alone', S.pages[0].annotations.length === 0 && b.pages.length === 2);
  captureActiveDoc();
  loadDocIntoState(b);
  check('and the other still has its own', H.historyStatus().undoLabel === 'Add blank page');
}

// A checkpoint held in one document and committed after another has
// become active — a note still being typed when ⌘T is pressed — belongs
// to the document it was taken of. On the wrong stack, undo there would
// replace that document's pages with this one's.
{
  const a = freshDoc();
  S.pages = [page(1, [note(1, 'typing…')])];
  const held = H.hold();
  captureActiveDoc();
  const b = freshDoc();
  S.pages = [page(7)];
  H.commit(held, 'Edit note');
  check('a held checkpoint is committed to its own document', !H.historyStatus().canUndo);
  captureActiveDoc();
  loadDocIntoState(a);
  check('not to whichever is active by then', H.historyStatus().undoLabel === 'Edit note');
  H.undo();
  check('and undoing it there restores that document', S.pages.length === 1 && S.pages[0].id === 1 && b.pages[0].id === 7);
}

// --- 7. Opening a file is where history starts ---
{
  freshDoc();
  S.pages = [page(1)];
  H.checkpoint('Add note');
  H.startFresh();
  const st = H.historyStatus();
  check('a fresh start has nothing to undo or redo', !st.canUndo && !st.canRedo && st.changes === 0 && st.savedAt === null);
}

// --- 8. Identity travels with the pages ---
{
  freshDoc();
  S.pages = [page(1)];
  S.docName = 'A.pdf'; S.fileHandle = { name: 'A.pdf' }; S.combined = false;
  const src = { id: 1, name: 'A.pdf' };
  S.sources = [src];
  H.checkpoint('Add B.pdf');
  S.sources = [src, { id: 2, name: 'B.pdf' }];
  S.pages.push(page(2));
  S.docName = 'Combined.pdf'; S.fileHandle = null; S.combined = true;
  H.undo();
  check('undoing a merge gives back the file it was', S.docName === 'A.pdf' && S.fileHandle && !S.combined
    && S.sources.length === 1 && S.sources[0] === src && S.pages.length === 1);
  H.redo();
  check('and redoing it makes it a combined document again', S.docName === 'Combined.pdf' && S.fileHandle === null && S.combined && S.sources.length === 2);
}

// --- 9. Undo goes to where the change was made ---
{
  freshDoc();
  const p1 = page(1), p2 = page(2), p3 = page(3);
  S.pages = [p1, p2, p3];
  S.selectedPageId = 3;
  H.checkpoint('Delete page');
  S.pages = [p1, p2];
  S.selectedPageId = 2;
  H.undo();
  check('undoing a page delete shows the page that came back', S.selectedPageId === 3);

  // A change undone on a page that is not showing would look like nothing.
  S.selectedPageId = 1;
  H.checkpoint('Add note');
  p1.annotations.push(note(1, 'on page one'));
  S.selectedPageId = 3;
  H.undo();
  check('undoing a markup goes to its page', S.selectedPageId === 1);

  S.selectedPageId = 2;
  H.checkpoint('Clear all');
  S.pages = []; S.selectedPageId = null;
  H.undo();
  check('and a cleared document comes back on the page it was on', S.selectedPageId === 2, String(S.selectedPageId));
  S.selectedAnnoId = 5;
  H.redo();
  check('with no page to show, none is selected', S.selectedPageId === null && S.selectedAnnoId === null);
}

print(failures ? `\n${failures} FAILURE(S)` : '\nAll history checks passed');
if (failures) throw new Error('history checks failed');
