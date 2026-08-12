# Redline — a basic PDF markup tool
### Build guide / spec for Claude Code

Personal replacement for the handful of Bluebeam features you actually use:
page assembly (add/delete/reorder/rotate) and simple text markups (plain
boxes and boxes with a leader line). This doc is the design — hand it to
Claude Code and let it write the actual implementation.

---

## 1. Stack

- **No backend.** This is a local, single-user tool — everything happens
  in the browser tab, nothing needs a server.
- **pdf-lib** — creates/edits the output PDF (add/copy pages, set
  rotation, draw text/rectangles/lines).
- **pdf.js** (`pdfjs-dist`) — renders pages to `<canvas>` for thumbnails
  and the live preview. pdf-lib can't rasterize a page, only pdf.js can.
- Plain HTML/CSS/JS is enough — the UI is mostly canvas + absolutely
  positioned overlay `<div>`s + drag/drop. A framework (React etc.) buys
  you nothing here and adds friction around canvas refs. If you use Vite,
  the vanilla-JS template is the right pick.
- Run it with `npm run dev` (Vite) during development; for daily use it
  can just be a static folder you open or serve locally — your call.

**Version gotcha:** recent `pdfjs-dist` releases (5.x/6.x) ship ESM-only
builds, which is fine but means `<script type="module">` and importing
the worker as a module too — slightly more setup. If you want to avoid
that, `pdfjs-dist@3.11.174` is the last line with a classic UMD build
(`pdf.min.js` + `pdf.worker.min.js`, global `pdfjsLib`), which is simpler
to wire up and plenty capable for this. Either works; pick based on how
much you want to deal with the module setup.

```
npm install pdf-lib pdfjs-dist
```

Since this is local-only now (not a claude.ai artifact), you're free to
use `localStorage`/`indexedDB` if you want session persistence — that
wasn't an option in the artifact sandbox but there's no reason to avoid
it here if losing work on an accidental tab close would bug you.

---

## 2. Data model

```js
// One entry per imported PDF file
Source = {
  id, name,
  pdfLibDoc,   // PDFDocument.load(...)
  pdfjsDoc,    // pdfjsLib.getDocument(...).promise
}

// One entry per page in the OUTPUT document, in final order
Page = {
  id,
  kind: 'blank' | 'imported',
  sourceId, sourcePageIndex,   // only for kind === 'imported'
  W0, H0,        // native (unrotated) page size in points — see §3
  rotation,      // absolute total rotation to display: 0 / 90 / 180 / 270
  annotations: [Annotation],
}

Annotation = {
  id,
  type: 'text' | 'callout',
  x, y,          // top-left corner, in "visual space" points — see §3
  width,         // points; height is NOT stored, it's derived from
                 // wrapped text length (auto-grows, like most note tools)
  text, fontSize, color,
  tipX, tipY,    // only for type === 'callout' — the arrow's point
}
```

Two important simplifications, both deliberate:
- **No annotation height field.** Store width, wrap the text to that
  width, and derive height from line count wherever you need it (live
  editor: read it off the DOM; export: compute from the embedded font's
  `widthOfTextAtSize`).
- **`rotation` is absolute**, not a base+delta pair. Set it once at
  import from the source page's own `/Rotate`, then overwrite it
  directly each time the user rotates. At export you call
  `page.setRotation(degrees(rotation))` — this replaces whatever
  rotation the copied page already had, it does not add to it.

---

## 3. The one genuinely hard part: rotation math

This is worth getting right up front because it's easy to get subtly
wrong and hard to eyeball-debug afterward (a sign error just makes
rotated-page text land in the wrong place or mirrored).

**The problem:** pdf-lib's `drawText`/`drawRectangle`/`drawLine` always
place things in the page's **native content space** — origin
bottom-left, y-axis up, dimensions = the raw MediaBox (`page.getWidth()`
/ `getHeight()`). This is true *regardless of the page's `/Rotate`
value* — pdf-lib's size getters are **not rotation-aware**, they just
read the MediaBox. (This trips people up constantly; PDFBox, pypdf,
etc. all have the same behavior — it's a PDF-spec thing, not a pdf-lib
quirk.)

Meanwhile, your UI shows the user the page **as displayed** — i.e.
already rotated. If a page has `rotation = 90`, the on-screen (visual)
canvas is `H0 × W0` (width/height swapped), origin top-left, y-axis
down. When the user clicks to place a text box, that click is in this
visual space. You need to convert visual → native to draw correctly,
and you need the text itself pre-rotated so it still reads upright
after the page's own `/Rotate` is applied by whatever PDF viewer opens
the final file.

**Point transform.** `R` is the page's total rotation (0/90/180/270,
always clockwise, matching the PDF spec's own convention). `W0, H0` are
the native (unrotated) page dimensions.

```js
function toNative(R, W0, H0, vx, vy) {
  switch (R) {
    case 90:  return { x: vy,      y: vx };
    case 180: return { x: W0 - vx, y: vy };
    case 270: return { x: W0 - vy, y: H0 - vx };
    default:  return { x: vx,      y: H0 - vy };  // R = 0
  }
}
function toVisual(R, W0, H0, nx, ny) {  // exact inverse of toNative
  switch (R) {
    case 90:  return { x: ny,      y: nx };
    case 180: return { x: W0 - nx, y: ny };
    case 270: return { x: H0 - ny, y: W0 - nx };
    default:  return { x: nx,      y: H0 - ny };  // R = 0
  }
}
```

Use `toNative` for **every point** you hand to pdf-lib: text baseline
anchors, rectangle corners (transform both opposite corners of a box
and take min/max — this is safe because the transform only ever
involves 90°-rotations and one axis flip, so an axis-aligned box in
visual space always maps to an axis-aligned box in native space; you
never need pdf-lib's `rotate` option for rectangles or lines).

**Text needs one more thing.** A box's *position* transforms fine with
just `toNative`, but text has an inherent direction (which way is
"up" for the glyphs), and that doesn't come along for free — you also
need to counter-rotate the glyphs themselves so they cancel out the
page's own rotation and end up reading horizontally:

```js
function textCompensationDegrees(R) { return (360 - R) % 360; }
// pass this as the `rotate` option on drawText, in addition to
// transforming the anchor point with toNative as usual.
```

This is the only place `rotate:` is needed on a draw call. Everything
else (rectangle corners, leader-line endpoints, arrowhead points) is
just points through `toNative` — no rotation option needed, because
lines and axis-aligned boxes don't have an inherent "up" direction the
way glyphs do.

**Do all directional geometry (arrowhead angles, which box edge a
leader attaches to, etc.) in plain visual-space coordinates first** —
it's normal, intuitive 2D screen math there. Only run the final points
through `toNative` right before the pdf-lib draw call. Don't try to do
trig in native space; it's more error-prone and there's no need to.

**When the user rotates a page that already has annotations on it**,
remap each annotation's position so it stays with the content instead
of jumping. Take the box's center point (needs a height — estimate it
with a canvas `measureText`-based word wrap, doesn't need to be exact,
it's just for repositioning) and the callout tip point, run each
through `toNative(oldR, ...)` then `toVisual(newR, ...)`, and rewrite
`x`/`y`/`tipX`/`tipY` from the result. Width stays as-is; height
re-derives naturally at the new width.

**Self-test before you trust this anywhere in the app:** round-trip
every `(R, point)` through `toNative` then `toVisual` and confirm you
get the original point back for all four rotations. That alone catches
the majority of sign-error bugs in this kind of code.

---

## 4. Import

- Read the file as `ArrayBuffer`. **Slice a fresh copy for pdf.js** —
  `getDocument({data})` transfers the buffer to a worker thread and
  detaches it, so if you hand pdf-lib the same buffer afterward it'll
  be empty. `buf.slice(0)` for each consumer is the simple fix.
- Load with both `PDFDocument.load()` (pdf-lib) and
  `pdfjsLib.getDocument()` (pdf.js) — you need both, for different
  reasons (pdf-lib to eventually copy pages into the output; pdf.js to
  render previews).
- For each page, pull `W0, H0` from pdf-lib's `page.getSize()`
  (raw MediaBox, confirmed not rotation-adjusted — see §3) and
  `rotation` from `page.getRotation().angle`, normalized to 0/90/180/270.
- `PDFDocument.load(bytes, { ignoreEncryption: true })` lets you at
  least open PDFs with owner-password restrictions; real
  user-password encryption still won't decrypt.

## 5. Blank pages

Small fixed size list is enough: Letter `612×792`, Legal `612×1008`,
A4 `595.28×841.89`, Tabloid `792×1224` (all in points). New blank page
= `rotation: 0`, no source.

## 6. Thumbnails + reorder

- Render each page via `pdfjsPage.getViewport({ scale, rotation })`
  then `page.render({canvasContext, viewport})`. **`rotation` here is
  absolute**, not added to the page's own stored rotation — pass your
  tracked `page.rotation` directly, it overrides.
- Render thumbnails sequentially (`await` in a loop), not with
  `Promise.all` — concurrent renders can be flaky depending on pdf.js
  version/page reuse. Not a bottleneck at personal-document scale.
- Reorder via native HTML5 drag/drop (`draggable="true"`,
  `dragstart`/`dragover`/`drop`) is the least-code path and works fine;
  no library needed.

## 7. Rotate button

Rotate is a 90° increment on `page.rotation` (see §3 for remapping any
existing annotations when you do this).

## 8. Text box tool

- Click on the canvas → new annotation at that point, default width
  (~170pt), empty text, immediately focused for typing.
- Represent the box as a `contenteditable` div positioned over the
  canvas (`left/top = x*scale, y*scale`, `width = width*scale`); let
  the browser handle wrapping/height naturally — you don't need to
  reimplement word-wrap for the live editor, only for export (§10).
- Selection vs. editing are different states: single click selects
  (shows a border/handles), double-click enters text editing. This
  keeps drag-to-move and click-to-edit from fighting each other.
- Resize handle on the right edge only, width-only (height is
  content-driven, not user-resizable).
- On blur, if the text is empty, just delete the annotation — no point
  keeping empty notes around.

## 9. Text + leader (callout) tool

- Two clicks: first click sets the arrow tip (the thing being pointed
  at), second click places the box, which then behaves exactly like a
  text box tool placement (focused, editable).
- The leader attaches to whichever edge-midpoint of the box (top,
  bottom, left, right) is closest to the tip direction — compare
  `|dx|` vs `|dy|` from box-center to tip, pick the dominant axis. This
  is the same simple rule Bluebeam-style callouts use.
- Optional but worth it: make the tip point itself draggable (small
  circle handle, only visible when the annotation is selected) so the
  user can fine-tune what it's pointing at after placing it.
- Arrowhead: two short line segments near the tip, computed as a small
  angle off the tip→attach direction — plain 2D vector math in visual
  space (see §3's note on doing geometry in visual space, not native).

## 10. Export

```js
const outDoc = await PDFDocument.create();
const font = await outDoc.embedFont(StandardFonts.Helvetica);

for (const page of pages) {
  let newPage;
  if (page.kind === 'blank') {
    newPage = outDoc.addPage([page.W0, page.H0]);
  } else {
    const src = sources.find(s => s.id === page.sourceId);
    const [copied] = await outDoc.copyPages(src.pdfLibDoc, [page.sourcePageIndex]);
    newPage = outDoc.addPage(copied);
  }
  newPage.setRotation(degrees(page.rotation));  // overwrites, not additive
  for (const a of page.annotations) drawAnnotation(newPage, font, a, page);
}

const bytes = await outDoc.save();
// Blob + <a download> to trigger a save dialog.
```

`copyPages` + `addPage` is pdf-lib's standard "merge PDFs" pattern —
reliable, well-trodden, don't reach for `embedPage`/`drawPage` for this
part, it's solving a different problem (stamping one page onto
another) and adds rotation-math risk you don't need here.

For each annotation: wrap the text yourself first —
`font.widthOfTextAtSize(text, size)` against `width - padding*2`,
pdf-lib does not wrap for you — then draw the background rectangle,
then each line of text (baseline, not top-left, is the anchor pdf-lib
expects — roughly `topOfLine + fontSize*0.82` gets you a reasonable
baseline without pulling in real font-metrics ascent data), then for
callouts the leader line + arrowhead. All positions go through
`toNative` from §3; text additionally gets
`rotate: degrees(textCompensationDegrees(page.rotation))`.

## 11. Suggested build order

Roughly in dependency order, each step independently testable:

1. Import a PDF, list page count/sizes in the console — no UI yet.
2. Thumbnail strip rendering (validates pdf.js wiring).
3. Main canvas preview of a selected page.
4. Add/delete/reorder pages, rotate button (no annotations yet) —
   export at this point should already produce a valid reordered/
   rotated PDF with zero markups. Good checkpoint.
5. Text box placement + edit + move + resize, still not exported.
6. Export text boxes — this is where §3's math gets exercised for
   real. Test specifically on a page you've rotated 90° and 270°, not
   just 0°, since that's where a sign error would show up.
7. Callout/leader tool, live preview, export.
8. Rotate-with-existing-annotations remap.
9. Polish: color/size options, drag-reorder styling, empty states.

Steps 1–4 are low-risk. Step 6 is the one to slow down on.

---

**Reference:** I built and tested this exact design as a working
artifact earlier in this conversation — the math above is what came
out of that (including a round-trip self-test that passed for all four
rotations). If you want to compare notes against a working
implementation instead of building blind, I can pull that version back
up.
