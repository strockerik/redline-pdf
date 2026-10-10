/* Canvas sizing for large pages. A canvas past the browser's limits does
 * not throw — it just stays blank — so the arithmetic that keeps one
 * inside them is checked here rather than discovered on a 36x24 sheet.
 */
import { APP, VENDOR } from './paths.mjs';
import './shim.mjs';

globalThis.self = globalThis;
globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: () => {} };
load(VENDOR + '/pdf-lib.min.js');

const { masterScale, clampBackingScale } = await import(`${APP}/view.js`);
const { MAX_ZOOM, PT_TO_PX } = await import(`${APP}/state.js`);

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const SIDE = 16384;

// An ARCH D sheet, the size the heavy-page path was written for.
{
  const s = masterScale(2592, 1728);
  const px = Math.round(2592 * s) * Math.round(1728 * s);
  check('ARCH D master uses its pixel budget', px > 31.5e6 && px < 32.5e6, `${px}`);
  check('ARCH D master is finer than 150 dpi', s * 72 > 150, `${s * 72} dpi`);
}
// A heavy page that is physically small must not be blown up for nothing.
{
  const s = masterScale(100, 100);
  check('small master stops at the deepest zoom', s === MAX_ZOOM * PT_TO_PX * 2, `${s}`);
}
// A long strip runs out of side length before it runs out of area.
{
  const s = masterScale(20000, 200);
  check('long master respects the side limit', Math.round(20000 * s) <= SIDE, `${20000 * s}`);
}
// The ordinary path: untouched until the browser would refuse the canvas.
{
  check('modest zoom is not clamped', clampBackingScale(4, 612, 792) === 4);
  const s = clampBackingScale(MAX_ZOOM * PT_TO_PX * 2, 2592, 1728);
  check('deep zoom on a large sheet fits a side', Math.round(2592 * s) <= SIDE, `${2592 * s}`);
  const q = clampBackingScale(1000, 3000, 3000);
  check('deep zoom fits the area limit', (3000 * q) ** 2 <= SIDE * SIDE * 1.0001, `${(3000 * q) ** 2}`);
}

print(failures ? `\n${failures} view check(s) failed` : '\nAll view checks passed');
if (failures) throw new Error('view checks failed');
