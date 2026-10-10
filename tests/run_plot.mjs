/* The plot compiler: content stream in, GPU instances and a residual
 * stream out. Everything here is checked on what comes back — decoded
 * coordinates, triangle areas, the residual's bytes — because a compiler
 * that draws the wrong thing still draws something, and on a real sheet
 * nobody would spot one stroke in ten million.
 */
import { APP } from './paths.mjs';
import './shim.mjs';

globalThis.console = { log: (...a) => print(a.join(' ')), error: (...a) => print(a.join(' ')), warn: () => {} };

const { createCompiler, STRIDE, F_TRI, F_ROUND0, F_ROUND1, LAYER_PREFIX, TEXT_LAYER } =
  await import(`${APP}/plotcompile.js`);

let failures = 0;
const check = (name, cond, detail = '') => {
  print(`${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Compile `parts` (one feed each) and decode everything that came out. */
function run(parts, opts = {}) {
  const chunks = [], polys = [], prims = [];
  const c = createCompiler({
    box: [0, 0, 100, 100], ...opts,
    onChunk: (ch) => chunks.push(ch),
    onClipPoly: (id, tris) => polys.push({ id, tris }),
  });
  for (const p of [].concat(parts)) c.feed(bytes(p));
  const r = c.finish();
  for (const ch of chunks) {
    const u16 = new Uint16Array(ch.buffer), u8 = new Uint8Array(ch.buffer);
    const unit = ch.span / 65535;
    for (let i = 0; i < ch.count; i++) {
      const o = i * (STRIDE / 2), b = i * STRIDE;
      prims.push({
        group: ch.group, clip: ch.clip,
        p: [0, 1, 2, 3, 4, 5].map((k) => (k % 2 ? ch.y0 : ch.x0) + u16[o + k] * unit),
        rgba: [u8[b + 12], u8[b + 13], u8[b + 14], u8[b + 15]],
        width: u16[o + 8] / 64, flags: u16[o + 9],
      });
    }
  }
  const text = String.fromCharCode(...r.residual);
  const segs = prims.filter((p) => !(p.flags & F_TRI));
  const tris = prims.filter((p) => p.flags & F_TRI);
  const area = tris.reduce((a, t) => a + Math.abs(
    (t.p[2] - t.p[0]) * (t.p[5] - t.p[1]) - (t.p[4] - t.p[0]) * (t.p[3] - t.p[1])) / 2, 0);
  return { r, chunks, polys, segs, tris, area, text };
}

// ---- strokes ----
{
  const { segs, r, text } = run('0 0 m 100 0 l S 10 10 m 10 10 l S');
  check('a line is one segment', segs.length === 1, `${segs.length}`);
  check('at its coordinates', near(segs[0].p[0], 0) && near(segs[0].p[2], 100) && near(segs[0].p[3], 0), segs[0].p.join(','));
  check('default width 1 pt, black, opaque', segs[0].width === 1 && segs[0].rgba.join() === '0,0,0,255', `${segs[0].width} ${segs[0].rgba}`);
  check('a butt-capped point paints nothing', r.stats.dropped === 1, `${r.stats.dropped}`);
  check('nothing left for pdf.js', text === '' && r.layers.length === 0 && !r.text, JSON.stringify(text));
}
{
  const { segs } = run('1 J 10 10 m 10 10 l S');
  check('a round-capped point is a dot', segs.length === 1 && segs[0].flags === (F_ROUND0 | F_ROUND1), JSON.stringify(segs));
}
{
  const { segs } = run('0.5 0 0 0.5 10 20 cm 4 w 0 0 m 100 0 l S');
  check('cm moves and scales the geometry', near(segs[0].p[0], 10) && near(segs[0].p[1], 20) && near(segs[0].p[2], 60), segs[0].p.join(','));
  check('and scales the line width', segs[0].width === 2, `${segs[0].width}`);
}
{
  const { segs } = run('0 0 m 10 0 l 10 10 l h S');
  check('a closed path strokes its closing edge', segs.length === 3, `${segs.length}`);
  check('with every corner joined', segs.every((s) => s.flags === (F_ROUND0 | F_ROUND1)));
}
{
  const { segs } = run('[5 5] 0 d 0 0 m 20 0 l S');
  check('a dash pattern is cut into dashes', segs.length === 2 && near(segs[0].p[2], 5) && near(segs[1].p[0], 10) && near(segs[1].p[2], 15),
    segs.map((s) => s.p.slice(0, 4)).join(' | '));
}
{
  const { segs } = run('0 0 m 0 10 10 10 10 0 c S');
  const last = segs[segs.length - 1];
  check('a curve is flattened end to end', segs.length >= 3 && near(segs[0].p[0], 0) && near(last.p[2], 10) && near(last.p[3], 0), `${segs.length}`);
}

// ---- colour and state ----
{
  const { segs, text } = run('q 1 0 0 RG 0 0 m 5 5 l S Q 0 0 m 1 1 l S');
  check('stroke colour', segs[0].rgba.join() === '255,0,0,255', `${segs[0].rgba}`);
  check('Q restores it', segs[1].rgba.join() === '0,0,0,255', `${segs[1].rgba}`);
  check('a q...Q around GPU geometry leaves no trace', text === '', JSON.stringify(text));
}
{
  const { segs, tris } = run('/G gs 0 0 m 1 1 l S 0 0 4 4 re f', { res: { gs: { G: { CA: 0.5, ca: 0.25 } } } });
  check('ExtGState stroke alpha', segs[0].rgba[3] === 128, `${segs[0].rgba}`);
  check('ExtGState fill alpha', tris[0].rgba[3] === 64, `${tris[0].rgba}`);
}
{
  const { segs } = run('/OC /oc1 BDC 0 0 m 5 5 l S EMC 0 0 m 1 1 l S', { res: { hidden: { oc1: true } } });
  check('a switched-off layer is not drawn', segs.length === 1 && near(segs[0].p[2], 1), `${segs.length}`);
}

// ---- fills ----
{
  check('a rectangle is two triangles', run('0 0 10 10 re f').tris.length === 2);
  check('convex fill covers its area', near(run('0 0 10 10 re f').area, 100, 0.1));
  check('concave fill covers its area', near(run('0 0 m 10 0 l 10 10 l 5 5 l 0 10 l h f').area, 75, 0.1),
    `${run('0 0 m 10 0 l 10 10 l 5 5 l 0 10 l h f').area}`);
  check('even-odd leaves the hole', near(run('0 0 10 10 re 2 2 6 6 re f*').area, 64, 0.1), `${run('0 0 10 10 re 2 2 6 6 re f*').area}`);
  check('nonzero fills it', near(run('0 0 10 10 re 2 2 6 6 re f').area, 100, 0.1), `${run('0 0 10 10 re 2 2 6 6 re f').area}`);
  const b = run('0 0 10 10 re B');
  check('fill-and-stroke does both, fill first', b.tris.length === 2 && b.segs.length === 4 && b.chunks.length === 1);
}

// ---- clipping ----
{
  const { chunks, text } = run('q 10 10 50 50 re W n 0 0 m 100 100 l S Q');
  check('a rectangular clip becomes a scissor', chunks[0].clip && chunks[0].clip.rect.join() === '10,10,60,60' && !chunks[0].clip.polys.length,
    JSON.stringify(chunks[0].clip));
  check('and its q...Q still vanishes', text === '', JSON.stringify(text));
}
{
  const { chunks, polys } = run('q 0 0 m 100 0 l 50 100 l h W n 0 0 m 100 100 l S Q q 0 0 m 100 0 l 50 100 l h W n 5 5 m 6 6 l S Q');
  check('any other clip is tessellated once', polys.length === 1 && polys[0].tris.length === 6, JSON.stringify(polys.map((p) => p.tris.length)));
  check('and shared by every use of it', chunks.length === 1 && chunks[0].clip.polys.join() === '0', `${chunks.length} chunks`);
}

// ---- what is left to pdf.js ----
{
  const { text, r, segs } = run('3 w BT /F1 12 Tf 10 10 Td (Hi) Tj ET 0 0 m 9 9 l S');
  check('text goes to the text layer', r.text && text.includes(`/OC /${TEXT_LAYER} BDC\n(Hi) Tj\nEMC`), JSON.stringify(text));
  check('with the state it depends on', text.indexOf('3 w') >= 0 && text.indexOf('3 w') < text.indexOf('BDC') && text.includes('/F1 12 Tf'), JSON.stringify(text));
  check('and the line still goes to the GPU', segs.length === 1);
}
{
  const { text } = run('0 w 1 w 2 w 0 0 m 1 1 l S BT ET');
  check('state nothing depends on is never written', text === '', JSON.stringify(text));
}
{
  const { r, chunks, text } = run('5 0 0 5 20 30 cm /Im0 Do 0 0 m 5 5 l S /Im1 Do 1 1 m 2 2 l S');
  check('an image before any geometry is layer 0', text.includes(`/OC /${LAYER_PREFIX}0 BDC\n/Im0 Do`), JSON.stringify(text));
  check('its layer is as big as the image', r.layers[0] && r.layers[0].join() === '20,30,25,35', JSON.stringify(r.layers));
  check('an image after geometry starts a new group', r.groups === 2 && text.includes(`/OC /${LAYER_PREFIX}1 BDC\n/Im1 Do`), `${r.groups} ${JSON.stringify(text)}`);
  check('so later lines draw over it', chunks.map((c) => c.group).join() === '0,1', chunks.map((c) => c.group).join());
}
{
  const { r, tris, text } = run('/Pattern cs /P1 scn 0 0 10 10 re f');
  check('a pattern fill is left to pdf.js', tris.length === 0 && r.stats.restPaths === 1 && text.includes('/P1 scn') && text.includes('re f'),
    JSON.stringify(text));
}
{
  const { text } = run('BI /W 2 /H 1 /BPC 8 /CS /G ID \x00EI\xff EI 0 0 m 1 1 l S');
  check('an inline image is passed through whole', text.includes('ID \x00EI\xff EI'), JSON.stringify(text));
}

// ---- stream boundaries ----
{
  check('a path may span content streams', run(['0 0 m 10 0 l', 'S']).segs.length === 1);
  const { segs } = run(['0 0 m 10', '0 l S']);
  check('and so may an operator and its operands', segs.length === 1 && near(segs[0].p[2], 10) && near(segs[0].p[3], 0), JSON.stringify(segs));
  const t = run(['BT (Hi)', 'Tj ET']).text;
  check('a split operator reaches the residual intact', t.includes('(Hi) Tj'), JSON.stringify(t));
}

// ---- scale ----
{
  let s = '';
  for (let i = 0; i < 70000; i++) s += `${i % 90} ${i % 70} m ${(i % 90) + 3} ${i % 70} l S\n`;
  const { chunks, segs } = run(s);
  check('a long stream is cut into chunks', chunks.length === 3 && segs.length === 70000, `${chunks.length} chunks, ${segs.length} segs`);
}

print(failures ? `\n${failures} plot check(s) failed` : '\nAll plot checks passed');
if (failures) throw new Error('plot checks failed');
