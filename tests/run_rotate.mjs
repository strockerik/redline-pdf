/* Rotating a page must move its annotations with the content, and four
 * 90-degree rotations must land everything back where it started. */
import { APP, VENDOR } from './paths.mjs';
import './shim.mjs';

globalThis.self = globalThis;
globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: () => {} };
load(VENDOR + '/pdf-lib.min.js');


const { remapAnnotationsForRotation } = await import(`${APP}/pages.js`);
const { normRot, visualSize, estimateBoxHeight } = await import(`${APP}/state.js`);

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const mkPage = () => ({
  W0: 612, H0: 792, rotation: 0,
  annotations: [
    { id: 1, type: 'text', x: 40, y: 60, width: 170, text: 'Alpha', fontSize: 12, color: '#000' },
    { id: 2, type: 'callout', x: 300, y: 400, width: 170, text: 'Beta note here',
      fontSize: 12, color: '#000', tipX: 120, tipY: 520 },
  ],
});

// --- 1. Four rotations return to the original positions ---
{
  const page = mkPage();
  const before = JSON.stringify(page.annotations);
  let R = 0;
  for (let i = 0; i < 4; i++) {
    const next = normRot(R + 90);
    remapAnnotationsForRotation(page, R, next);
    R = next;
    page.rotation = R;
  }
  check('rotation returns to 0 after 4 steps', R === 0, `R=${R}`);
  const after = page.annotations;
  const orig = JSON.parse(before);
  let worst = 0;
  for (let i = 0; i < orig.length; i++) {
    worst = Math.max(worst, Math.abs(after[i].x - orig[i].x), Math.abs(after[i].y - orig[i].y));
    if (orig[i].type === 'callout') {
      worst = Math.max(worst, Math.abs(after[i].tipX - orig[i].tipX), Math.abs(after[i].tipY - orig[i].tipY));
    }
  }
  check('annotations return to start after 4 rotations', worst < 1e-6, `max drift ${worst}`);
}

// --- 2. Counter-rotating immediately undoes a rotation ---
for (const R0 of [0, 90, 180, 270]) {
  const page = mkPage();
  page.rotation = R0;
  const before = JSON.parse(JSON.stringify(page.annotations));
  const R1 = normRot(R0 + 90);
  remapAnnotationsForRotation(page, R0, R1);
  remapAnnotationsForRotation(page, R1, R0);
  let worst = 0;
  for (let i = 0; i < before.length; i++) {
    worst = Math.max(worst, Math.abs(page.annotations[i].x - before[i].x),
                            Math.abs(page.annotations[i].y - before[i].y));
  }
  check(`CW then CCW is identity at R=${R0}`, worst < 1e-6, `drift ${worst}`);
}

// --- 3. Annotations stay on the page after rotating ---
// The box center must land inside the new visual page box, or the note
// has been flung off-sheet.
for (const [from, to] of [[0, 90], [90, 180], [180, 270], [270, 0], [0, 270]]) {
  const page = mkPage();
  page.rotation = from;
  remapAnnotationsForRotation(page, from, to);
  const { w: Wv, h: Hv } = visualSize(to, page.W0, page.H0);
  let ok = true, detail = '';
  for (const a of page.annotations) {
    const h = estimateBoxHeight(a);
    const cx = a.x + a.width / 2, cy = a.y + h / 2;
    if (cx < 0 || cx > Wv || cy < 0 || cy > Hv) {
      ok = false;
      detail = `center (${cx.toFixed(1)},${cy.toFixed(1)}) outside ${Wv.toFixed(0)}x${Hv.toFixed(0)}`;
    }
  }
  check(`annotations stay on page ${from}->${to}`, ok, detail);
}

// --- 4. Relative geometry is preserved: box-to-tip distance is rigid ---
for (const [from, to] of [[0, 90], [0, 180], [0, 270], [90, 270]]) {
  const page = mkPage();
  page.rotation = from;
  const a = page.annotations[1];
  const h0 = estimateBoxHeight(a);
  const d0 = Math.hypot(a.tipX - (a.x + a.width / 2), a.tipY - (a.y + h0 / 2));
  remapAnnotationsForRotation(page, from, to);
  const h1 = estimateBoxHeight(a);
  const d1 = Math.hypot(a.tipX - (a.x + a.width / 2), a.tipY - (a.y + h1 / 2));
  check(`callout tip distance preserved ${from}->${to}`, near(d0, d1, 1e-6),
    `${d0.toFixed(4)} -> ${d1.toFixed(4)}`);
}

// --- 5. A no-op rotation changes nothing ---
{
  const page = mkPage();
  const before = JSON.stringify(page.annotations);
  remapAnnotationsForRotation(page, 90, 90);
  check('same-rotation remap is a no-op', JSON.stringify(page.annotations) === before);
}

// --- 6. Repeated rotation does not accumulate drift ---
// 40 full turns; anything that leaks error per step shows up here.
{
  const page = mkPage();
  const orig = JSON.parse(JSON.stringify(page.annotations));
  let R = 0;
  for (let i = 0; i < 160; i++) {
    const next = normRot(R + 90);
    remapAnnotationsForRotation(page, R, next);
    R = next;
  }
  let worst = 0;
  for (let i = 0; i < orig.length; i++) {
    worst = Math.max(worst, Math.abs(page.annotations[i].x - orig[i].x),
                            Math.abs(page.annotations[i].y - orig[i].y));
  }
  check('no drift after 40 full turns', worst < 1e-9, `max drift ${worst}`);
}

print(failures ? `\n${failures} FAILURE(S)` : '\nAll rotate-remap checks passed');
