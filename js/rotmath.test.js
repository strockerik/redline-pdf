/* Round-trip self-test for the visual <-> native coordinate transforms.
 *
 * Guide §3: "round-trip every (R, point) through toNative then toVisual
 * and confirm you get the original point back for all four rotations.
 * That alone catches the majority of sign-error bugs in this kind of
 * code." Run it with ?selftest in the URL.
 */
import { toNative, toVisual, visualSize, textCompensationDegrees, normRot } from './state.js';

export function runRotMathTests() {
  const results = [];
  const pass = (name) => results.push({ name, ok: true });
  const fail = (name, detail) => results.push({ name, ok: false, detail });

  const PAGE_SIZES = [
    [612, 792],       // Letter portrait
    [792, 612],       // Letter landscape
    [595.28, 841.89], // A4, non-integer dimensions
  ];
  const ROTATIONS = [0, 90, 180, 270];
  const EPS = 1e-9;

  // --- 1. Round-trip: visual -> native -> visual is the identity ---
  for (const [W0, H0] of PAGE_SIZES) {
    for (const R of ROTATIONS) {
      const { w: Wv, h: Hv } = visualSize(R, W0, H0);
      // Sample the corners, the center, and a deliberately asymmetric
      // point — a symmetric-only sample set passes even with an axis swap.
      const pts = [
        [0, 0], [Wv, 0], [0, Hv], [Wv, Hv],
        [Wv / 2, Hv / 2], [Wv * 0.17, Hv * 0.83], [Wv * 0.91, Hv * 0.04],
      ];
      let worst = 0;
      for (const [vx, vy] of pts) {
        const n = toNative(R, W0, H0, vx, vy);
        const v = toVisual(R, W0, H0, n.x, n.y);
        worst = Math.max(worst, Math.abs(v.x - vx), Math.abs(v.y - vy));
      }
      const name = `round-trip R=${R} on ${W0}x${H0}`;
      worst <= EPS ? pass(name) : fail(name, `max drift ${worst}`);
    }
  }

  // --- 2. Native points must land inside the native page box ---
  // Catches transforms that round-trip consistently but map off-page.
  for (const [W0, H0] of PAGE_SIZES) {
    for (const R of ROTATIONS) {
      const { w: Wv, h: Hv } = visualSize(R, W0, H0);
      let ok = true, bad = null;
      for (const [vx, vy] of [[0, 0], [Wv, 0], [0, Hv], [Wv, Hv], [Wv / 2, Hv / 3]]) {
        const n = toNative(R, W0, H0, vx, vy);
        if (n.x < -EPS || n.x > W0 + EPS || n.y < -EPS || n.y > H0 + EPS) {
          ok = false; bad = `(${vx},${vy}) -> (${n.x},${n.y})`;
        }
      }
      const name = `in-bounds R=${R} on ${W0}x${H0}`;
      ok ? pass(name) : fail(name, bad);
    }
  }

  // --- 3. Visual top-left maps to the corner a viewer shows top-left ---
  // R=0: visual (0,0) is native (0, H0) — top-left in a y-up space.
  {
    const n = toNative(0, 612, 792, 0, 0);
    const name = 'R=0 origin maps to native top-left';
    (Math.abs(n.x) < EPS && Math.abs(n.y - 792) < EPS)
      ? pass(name) : fail(name, `got (${n.x},${n.y}), want (0,792)`);
  }

  // --- 4. Text compensation cancels the page rotation ---
  for (const R of ROTATIONS) {
    const total = (R + textCompensationDegrees(R)) % 360;
    const name = `text compensation cancels R=${R}`;
    total === 0 ? pass(name) : fail(name, `R + comp = ${total}, want 0`);
  }

  // --- 5. Rotation normalization ---
  {
    const cases = [[0, 0], [90, 90], [360, 0], [-90, 270], [450, 90], [89, 90], [271, 270]];
    let ok = true, bad = null;
    for (const [input, want] of cases) {
      if (normRot(input) !== want) { ok = false; bad = `normRot(${input})=${normRot(input)}, want ${want}`; }
    }
    ok ? pass('normRot') : fail('normRot', bad);
  }

  // --- Report ---
  const failed = results.filter((r) => !r.ok);
  const style = failed.length ? 'color:#b23a3a;font-weight:bold' : 'color:#1a7f37;font-weight:bold';
  console.log(
    `%cRedline rotation math: ${results.length - failed.length}/${results.length} passed`,
    style
  );
  for (const f of failed) console.error(`  FAIL ${f.name}: ${f.detail}`);

  return { total: results.length, failed: failed.length, results };
}
