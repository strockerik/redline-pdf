/* The open document as text the local model can read.
 *
 * pdf.js hands back a drawing's words as scattered fragments, each with a
 * position. Here they are put back into lines, top to bottom, cleared of
 * the map tags a plan repeats hundreds of times ("VLT VLT VLT", "X X"),
 * and labelled by sheet. A sheet is read once and kept for the session.
 *
 * Words that a CAD program drew as lines — whole tables of them, on the
 * Bernalillo cover sheet — are not text to pdf.js and cannot be read
 * here. The prompt says so, so the model admits it rather than guessing.
 */
import { state } from './state.js';
import { textPageFor } from './view.js';

const texts = new WeakMap();          // page -> Promise<[{ text }]>, its blocks

/** How tall a fragment's letters are, in page units. */
const sizeOf = (it) => Math.max(2, Math.hypot(it.transform[2], it.transform[3]) || it.height || 8);

/** Fragments into blocks of text: a note, a table cell, a label.
 *
 *  A drawing is not a page of prose. Reading its fragments row by row
 *  across the whole sheet glued unrelated things together — on the
 *  Bernalillo cover, the project's 3,567 acres came out on one line with a
 *  map label and the PRELIMINARY stamp. So a row is first split wherever
 *  there is a wide gap, and the pieces are then stacked into blocks: a
 *  piece starts a new block unless it sits just under the last line of
 *  one, at the same left edge and letter size — which is how a wrapped note
 *  or a stack of table cells reads. Blocks come out top to bottom, left to
 *  right; turned text (a title up the side of the title block) last.
 *
 *  → [ { text, y } ] in reading order. */
export function textBlocks(items) {
  const level = [], turned = [];
  for (const it of items) {
    const s = String(it.str || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const t = it.transform;
    (Math.abs(t[1]) > Math.abs(t[0]) ? turned : level).push({ s, x: t[4], y: t[5], w: it.width || s.length * sizeOf(it) * 0.5, h: sizeOf(it) });
  }

  // Rows, then pieces of rows split at wide gaps.
  level.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of level) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) < Math.min(row.h, it.h) * 0.5) row.items.push(it);
    else rows.push({ y: it.y, h: it.h, items: [it] });
  }
  const pieces = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const it of row.items) {
      if (cur && it.x - cur.right < Math.max(cur.h, it.h) * 3) {
        cur.s += ' ' + it.s;
        cur.right = it.x + it.w;
      } else {
        cur = { s: it.s, x: it.x, y: it.y, h: it.h, right: it.x + it.w };
        pieces.push(cur);
      }
    }
  }

  // Pieces into blocks: under the last line of an open block, same left
  // edge, same letter size.
  const blocks = [];
  for (const p of pieces) {
    const b = blocks.find((k) => !k.closed
      && Math.abs(k.x - p.x) < k.h * 1.5
      && Math.abs(k.h - p.h) < k.h * 0.3
      && k.lastY - p.y > 0 && k.lastY - p.y < k.h * 2.4);
    if (b) { b.lines.push(p.s); b.lastY = p.y; }
    else blocks.push({ x: p.x, y: p.y, h: p.h, lastY: p.y, lines: [p.s] });
  }
  const out = blocks
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((b) => ({ text: tidy(b.lines), y: b.y }))
    .filter((b) => b.text);
  for (const it of turned) {
    const text = tidy([it.s]);
    if (text) out.push({ text, y: -Infinity });
  }
  return out;
}

/** Map tags repeated along a line say nothing the first one doesn't, and
 *  cost the model's attention all the same. */
function tidy(lines) {
  const out = [];
  for (const line of lines) {
    const words = line.split(/\s+/);
    const kept = words.filter((w, i) => i === 0 || w !== words[i - 1]);
    // A line that is one short tag (X, LoD, VLT) and nothing else is a
    // symbol on the plan, not something written.
    if (kept.length === 1 && kept[0].length <= 3 && !/\d/.test(kept[0])) continue;
    const text = kept.join(' ');
    if (text !== out[out.length - 1]) out.push(text);
  }
  return out.join('\n');
}

/** A page's blocks of text, read once. */
export function pageBlocks(page) {
  if (!texts.has(page)) {
    texts.set(page, (async () => {
      const pj = await textPageFor(page);
      if (!pj) return [];
      const { items } = await pj.getTextContent();
      return textBlocks(items);
    })().catch((err) => { texts.delete(page); throw err; }));
  }
  return texts.get(page);
}

const STOP = new Set(('the and for are was with this that what where which who how many much does from have has into '
  + 'its their there they them than then when will would could should can not any all per our you your about '
  + 'sheet sheets page pages drawing drawings plan plans show shown tell give list is it of in on to a an do me').split(' '));

// A question is asked in plain words; a drawing answers in its own. These
// are the drawing's words for what people ask about, so that "how big is
// it" also looks for AC and ACRES, and "who drew it" for the engineer.
const SYNONYMS = [
  [/\b(big|size|large|area|acreage|acres?|land|footprint)\b/, ['area', 'acres', 'acre', 'ac', 'sf', 'square']],
  [/\b(power|capacity|mw|megawatts?|output|generate|kw)\b/, ['mw', 'kw', 'capacity', 'megawatt', 'kv']],
  [/\b(where|located|location|address|site|situated)\b/, ['county', 'located', 'township', 'range', 'section', 'road', 'interstate', 'nm', 'city', 'tract']],
  [/\b(own|owner|owns|owned)\b/, ['owner', 'record', 'llc', 'inc']],
  [/\b(prepared|engineer|engineers|designer|designed|drew|drawn|consultant|firm|made|company)\b/, ['prepared', 'engineer', 'designed', 'drawn', 'checked', 'associates', 'inc']],
  [/\b(when|date|dated|revision|revised|issued|submitted|submittal)\b/, ['date', 'rev', 'revision', 'issued', 'submittal']],
  [/\b(zoning|zoned|zone)\b/, ['zoning', 'zone', 'jurisdiction', 'a-1']],
  [/\b(fence|fencing|gate)\b/, ['fence', 'gate', 'chain', 'barbed']],
  [/\b(road|access|roads)\b/, ['road', 'access', 'easement', 'drive']],
];

/** The words of a question worth looking for, each with a weight. */
function termsOf(question) {
  const q = question.toLowerCase();
  const words = (q.match(/[a-z0-9][a-z0-9'.,&-]*[a-z0-9]|[a-z0-9]/g) || [])
    .filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w));
  const terms = new Map(words.map((w) => [w, 1]));
  for (const [ask, look] of SYNONYMS) {
    if (ask.test(q)) for (const w of look) if (!terms.has(w)) terms.set(w, 0.7);
  }
  return terms;
}

/** How often `term` appears in `text` as a word of its own. */
function hits(text, term) {
  let n = 0, i = 0;
  while ((i = text.indexOf(term, i)) >= 0) {
    const before = i ? text[i - 1] : ' ', after = text[i + term.length] || ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) n++;
    i += term.length;
  }
  return n;
}

/** The passages of the document that bear on the question, within
 *  `budget` characters.
 *
 *  A small model does far better with a short excerpt that holds the
 *  answer than with whole sheets around it: given four Bernalillo sheets
 *  (20,000 characters) it took 20 s and invented figures; given the
 *  passages that matter it is quicker and keeps to them.
 *
 *  Each block is scored BM25-fashion: the question's words it contains,
 *  rarer words counting for more, and a long block (a sheet's legend,
 *  which mentions every ROAD and AREA on the plan) not winning merely by
 *  being long. A block repeated on several sheets — the legend again —
 *  is sent once. The best go first, each tagged with its sheet: a small
 *  model reads the top of what it is given most carefully.
 *
 *  A question with nothing to look for ("summarise this") gets the page on
 *  screen from the top instead.
 *
 *  → { passages: [{ n, text }], pages: [n], empty: [n] } */
export async function chooseText(question, { scope, budget }) {
  const current = state.pages.find((p) => p.id === state.selectedPageId);
  const pool = scope === 'page' ? (current ? [current] : []) : state.pages.slice();
  const read = await Promise.all(pool.map(async (p) => ({ n: state.pages.indexOf(p) + 1, page: p, blocks: await pageBlocks(p) })));
  const empty = read.filter((r) => !r.blocks.length).map((r) => r.n);

  const all = [], seen = new Set();
  for (const r of read) {
    r.blocks.forEach((b, k) => {
      if (seen.has(b.text)) return;                 // the same legend on the next sheet
      seen.add(b.text);
      all.push({ n: r.n, k, page: r.page, text: b.text, lower: b.text.toLowerCase() });
    });
  }
  const terms = termsOf(question);
  const df = new Map([...terms.keys()].map((t) => [t, all.filter((b) => hits(b.lower, t)).length]));
  const avgLen = all.reduce((s, b) => s + b.text.length, 0) / Math.max(1, all.length);
  const K1 = 1.2, B = 0.75;
  for (const b of all) {
    let score = 0;
    const norm = K1 * (1 - B + B * b.text.length / avgLen);
    for (const [t, weight] of terms) {
      const d = df.get(t);
      if (!d) continue;
      const c = hits(b.lower, t);
      if (c) score += weight * (c * (K1 + 1)) / (c + norm) * Math.log(1 + (all.length - d + 0.5) / (d + 0.5));
    }
    // Numbers are what most questions about a drawing are after.
    if (score && /\d/.test(b.text)) score *= 1.15;
    if (b.page === current) score *= 1.3;
    b.score = score;
  }

  let picked = all.filter((b) => b.score > 0).sort((a, b) => b.score - a.score);
  if (!picked.length) picked = all.filter((b) => b.page === (current || read[0]?.page));
  const passages = [];
  let used = 0;
  for (const b of picked) {
    const cost = b.text.length + 10;
    if (used + cost > budget) continue;
    passages.push({ n: b.n, text: b.text });
    used += cost;
  }
  return { passages, pages: [...new Set(passages.map((p) => p.n))].sort((a, b) => a - b), empty };
}
