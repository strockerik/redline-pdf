/* Verify where annotations actually land in native PDF space for every
 * page rotation — the part guide §3 warns is easy to get subtly wrong
 * and hard to eyeball afterward. A recording stand-in for the pdf-lib
 * page captures each draw call's geometry.
 */
import { APP, VENDOR } from './paths.mjs';
import './shim.mjs';

globalThis.self = globalThis;
globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: () => {} };

load(VENDOR + '/pdf-lib.min.js');
const { PDFDocument, StandardFonts } = globalThis.PDFLib;


const { drawAnnotationOnPage } = await import(`${APP}/export.js`);
const { LINE_HEIGHT_MULT, ANNO_PAD } = await import(`${APP}/state.js`);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};

function recorder() {
  const calls = { rects: [], texts: [], lines: [] };
  return {
    calls,
    drawRectangle: (o) => calls.rects.push(o),
    drawText: (t, o) => calls.texts.push({ text: t, ...o }),
    drawLine: (o) => calls.lines.push(o),
  };
}

const W0 = 612, H0 = 792;
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

// A one-line note so the box height is predictable.
const anno = {
  id: 1, type: 'text', x: 40, y: 60, width: 170,
  text: 'Short', fontSize: 12, color: '#b23a3a',
};
const boxH = 1 * 12 * LINE_HEIGHT_MULT + ANNO_PAD * 2;

// --- 1. Rectangle geometry per rotation, computed independently here ---
// R=0   visual(40,60) -> native(40, 792-60)         box extends downward in visual = down in native y
// R=90  visual(x,y)   -> native(y, x)               so the box's w/h swap in native space
// R=180 visual(x,y)   -> native(612-x, y)
// R=270 visual(x,y)   -> native(612-y, 792-x)
const expected = {
  0:   { x: 40,          y: H0 - 60 - boxH, w: 170,  h: boxH },
  90:  { x: 60,          y: 40,             w: boxH, h: 170  },
  180: { x: W0 - 210,    y: 60,             w: 170,  h: boxH },
  270: { x: W0 - 60 - boxH, y: H0 - 210,    w: boxH, h: 170  },
};

for (const R of [0, 90, 180, 270]) {
  const page = recorder();
  drawAnnotationOnPage(page, font, anno, R, W0, H0);
  const r = page.calls.rects[0];
  const e = expected[R];
  const ok = near(r.x, e.x) && near(r.y, e.y) && near(r.width, e.w) && near(r.height, e.h);
  check(`rect geometry R=${R}`, ok,
    `got (${r.x.toFixed(1)},${r.y.toFixed(1)},${r.width.toFixed(1)}x${r.height.toFixed(1)}) ` +
    `want (${e.x.toFixed(1)},${e.y.toFixed(1)},${e.w.toFixed(1)}x${e.h.toFixed(1)})`);

  // Everything must sit inside the native page box.
  const inside = r.x >= -0.01 && r.y >= -0.01 &&
                 r.x + r.width <= W0 + 0.01 && r.y + r.height <= H0 + 0.01;
  check(`rect inside page R=${R}`, inside,
    `(${r.x.toFixed(1)},${r.y.toFixed(1)}) ${r.width.toFixed(1)}x${r.height.toFixed(1)} on ${W0}x${H0}`);
}

// --- 2. Text counter-rotation cancels the page rotation ---
for (const R of [0, 90, 180, 270]) {
  const page = recorder();
  drawAnnotationOnPage(page, font, anno, R, W0, H0);
  const t = page.calls.texts[0];
  const deg = t.rotate.angle !== undefined ? t.rotate.angle : t.rotate;
  check(`text counter-rotation R=${R}`, (R + deg) % 360 === 0, `rotate=${deg}`);
  check(`text anchor inside page R=${R}`,
    t.x >= -0.01 && t.x <= W0 + 0.01 && t.y >= -0.01 && t.y <= H0 + 0.01,
    `(${t.x.toFixed(1)},${t.y.toFixed(1)})`);
}

// --- 3. Text baseline sits inside its own box ---
// A sign error in the baseline term shows up as text drawn outside the
// rectangle that is supposed to contain it.
for (const R of [0, 90, 180, 270]) {
  const page = recorder();
  drawAnnotationOnPage(page, font, anno, R, W0, H0);
  const r = page.calls.rects[0];
  const t = page.calls.texts[0];
  const pad = 1.0;
  const inBox = t.x >= r.x - pad && t.x <= r.x + r.width + pad &&
                t.y >= r.y - pad && t.y <= r.y + r.height + pad;
  check(`text baseline within its box R=${R}`, inBox,
    `text(${t.x.toFixed(1)},${t.y.toFixed(1)}) box(${r.x.toFixed(1)},${r.y.toFixed(1)} ` +
    `${r.width.toFixed(1)}x${r.height.toFixed(1)})`);
}

// --- 4. Callout leader terminates at the tip, in native space ---
for (const R of [0, 90, 180, 270]) {
  const callout = { ...anno, type: 'callout', tipX: 300, tipY: 500 };
  const page = recorder();
  drawAnnotationOnPage(page, font, callout, R, W0, H0);
  check(`callout draws leader + 2 wings R=${R}`, page.calls.lines.length === 3,
    `${page.calls.lines.length} lines`);

  // The leader's far end and both wing origins must all be the tip.
  const [leader, w1, w2] = page.calls.lines;
  const tipMatches = near(leader.end.x, w1.start.x) && near(leader.end.y, w1.start.y) &&
                     near(leader.end.x, w2.start.x) && near(leader.end.y, w2.start.y);
  check(`arrowhead anchored at tip R=${R}`, tipMatches,
    `leader end (${leader.end.x.toFixed(1)},${leader.end.y.toFixed(1)})`);

  // Wings must be shorter than the leader — a wing longer than the whole
  // leader means the angle math blew up.
  const leaderLen = Math.hypot(leader.end.x - leader.start.x, leader.end.y - leader.start.y);
  const wingLen = Math.hypot(w1.end.x - w1.start.x, w1.end.y - w1.start.y);
  check(`wing shorter than leader R=${R}`, wingLen < leaderLen, `wing ${wingLen.toFixed(1)} leader ${leaderLen.toFixed(1)}`);
  check(`wing length is the 9pt default R=${R}`, near(wingLen, 9, 0.5), `${wingLen.toFixed(2)}`);
}

// --- 5. Rotation is rigid: distances are preserved through toNative ---
// Two annotations a known distance apart must stay that far apart at
// every rotation. Catches any accidental scaling in the transform.
for (const R of [0, 90, 180, 270]) {
  const a1 = { ...anno, x: 100, y: 100 };
  const a2 = { ...anno, x: 100, y: 300 };
  const p1 = recorder(); drawAnnotationOnPage(p1, font, a1, R, W0, H0);
  const p2 = recorder(); drawAnnotationOnPage(p2, font, a2, R, W0, H0);
  const d = Math.hypot(
    p1.calls.rects[0].x - p2.calls.rects[0].x,
    p1.calls.rects[0].y - p2.calls.rects[0].y
  );
  check(`distance preserved R=${R}`, near(d, 200, 0.01), `${d.toFixed(3)} (want 200)`);
}

// --- 6. Multi-line text stacks downward in visual space ---
for (const R of [0, 90, 180, 270]) {
  const multi = { ...anno, text: 'one two three four five six seven eight nine ten eleven twelve' };
  const page = recorder();
  drawAnnotationOnPage(page, font, multi, R, W0, H0);
  check(`wraps to multiple lines R=${R}`, page.calls.texts.length > 1,
    `${page.calls.texts.length} line(s)`);
  // Consecutive baselines must be exactly one line-height apart.
  const t0 = page.calls.texts[0], t1 = page.calls.texts[1];
  const gap = Math.hypot(t1.x - t0.x, t1.y - t0.y);
  check(`line spacing R=${R}`, near(gap, 12 * LINE_HEIGHT_MULT, 0.01), `${gap.toFixed(3)}`);
}

// --- 7. Ink: every point lands where toNative says it should ---
// Computed independently here, the same way the rect expectations above
// are, so an error in state.js's transform can't hide behind itself.
const nativeOf = {
  0:   (x, y) => ({ x,          y: H0 - y }),
  90:  (x, y) => ({ x: y,       y: x }),
  180: (x, y) => ({ x: W0 - x,  y }),
  270: (x, y) => ({ x: W0 - y,  y: H0 - x }),
};
const inkPts = [{ x: 100, y: 120 }, { x: 140, y: 180 }, { x: 260, y: 150 }];
const ink = { id: 9, type: 'ink', color: '#1f6feb', size: 2.5, points: inkPts };

for (const R of [0, 90, 180, 270]) {
  const page = recorder();
  drawAnnotationOnPage(page, font, ink, R, W0, H0);
  const lines = page.calls.lines;

  check(`ink draws one segment per gap R=${R}`, lines.length === inkPts.length - 1,
    `${lines.length} segments for ${inkPts.length} points`);
  check(`ink draws no text or boxes R=${R}`,
    page.calls.texts.length === 0 && page.calls.rects.length === 0,
    `${page.calls.texts.length} texts, ${page.calls.rects.length} rects`);

  // Endpoints must match the independent transform, in order.
  let worst = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = nativeOf[R](inkPts[i].x, inkPts[i].y);
    const e = nativeOf[R](inkPts[i + 1].x, inkPts[i + 1].y);
    worst = Math.max(worst,
      Math.abs(lines[i].start.x - s.x), Math.abs(lines[i].start.y - s.y),
      Math.abs(lines[i].end.x - e.x), Math.abs(lines[i].end.y - e.y));
  }
  check(`ink points land in native space R=${R}`, worst < 0.01, `max error ${worst}`);

  check(`ink keeps its stroke width R=${R}`,
    lines.every((l) => near(l.thickness, 2.5)), `${lines[0].thickness}`);
  check(`ink inside the page R=${R}`,
    lines.every((l) => l.start.x >= -0.01 && l.start.x <= W0 + 0.01 &&
                       l.start.y >= -0.01 && l.start.y <= H0 + 0.01),
    'a point fell outside the MediaBox');

  // Rigid: on-screen segment lengths must survive the transform.
  const visLen = Math.hypot(inkPts[1].x - inkPts[0].x, inkPts[1].y - inkPts[0].y);
  const natLen = Math.hypot(lines[0].end.x - lines[0].start.x,
                            lines[0].end.y - lines[0].start.y);
  check(`ink segment length preserved R=${R}`, near(visLen, natLen), `${visLen} vs ${natLen}`);
}

// A tap makes a dot, not nothing.
{
  const page = recorder();
  drawAnnotationOnPage(page, font, { ...ink, points: [{ x: 50, y: 50 }] }, 0, W0, H0);
  const l = page.calls.lines[0];
  check('single-point ink still draws a dot', page.calls.lines.length === 1 &&
    near(l.start.x, l.end.x) && near(l.start.y, l.end.y));
}

// An empty stroke must be a no-op rather than an exception.
{
  const page = recorder();
  drawAnnotationOnPage(page, font, { ...ink, points: [] }, 0, W0, H0);
  check('empty ink draws nothing', page.calls.lines.length === 0);
}

print(failures ? `\n${failures} FAILURE(S)` : '\nAll geometry checks passed');
