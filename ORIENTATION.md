# Redline — orientation for a code reviewer

*Written against rev 0.31 (2026-10-18).*

You are about to review a codebase you have never seen. This page is the
map: what the app is, the decisions that look like bugs but are not, how
the pieces fit, and why it is fast. Read it before the code. Two files go
deeper and are authoritative where they differ from this one:

- `CLAUDE.md`: the architecture notes and gotchas, kept for the AI that
  writes most of this code. Ignore the parts addressed to "Claude"; the
  facts in it are the project's own.
- `.claude/skills/audit/references/hazards.md`: a catalogue of the bugs
  this codebase has actually shipped, grouped by kind. Each entry is a
  trap that has been fallen into once already.

---

## 1. What it is

A personal PDF markup tool for one owner, a civil engineer who reviews
drawing sets. It replaces the handful of Bluebeam features they actually
use:

- **Page assembly.** Open, merge, reorder, rotate, delete, add blank pages.
- **Markups.** Text notes, callouts (a note with a leader line), pen,
  highlighter, arrow, box and revision cloud.
- **Saving.** Save back into the same file, with the markups as ordinary
  PDF annotations that any viewer shows and Redline can edit again. Or
  save a "flattened" copy, with the markups painted into the pages.
- **Workspace.** Document tabs, undo and redo, and an optional local AI
  panel that answers questions about the open drawings.

It runs entirely in the browser: a static site on GitHub Pages
(https://strockerik.github.io/redline-pdf/), installable as a PWA. There
is no server and no account, and nothing leaves the machine. The main
platform is Chrome on a Mac, an 8 GB M3. iOS gets a reduced path.

**The workload is the point.** These are not office documents. They are
CAD plots: a single sheet can hold more than ten million stroked line
segments, and a set runs to 60–200 sheets. A real client set
(`2026-1008 Bernalillo SUP Package.pdf`, gitignored, never committed) is
the benchmark. Its first sheet has 14.7 million segments. A general PDF
renderer takes tens of seconds and gigabytes per redraw of a sheet like
that. Most of the unusual engineering here exists because of it.

## 2. Decisions that look like bugs — please don't report these

Each was chosen, usually after the alternative failed.

| Looks like | Actually |
|---|---|
| No build step, no npm, no framework, no TypeScript | Deliberate. Plain ES modules served as-is. Tests run under macOS's built-in JavaScriptCore and Python's standard library. |
| Two PDF libraries | pdf-lib 1.17.1 reads structure and writes files. pdf.js 3.11.174 renders and extracts text. Both are vendored as classic scripts that expose the globals `PDFLib` and `pdfjsLib`. Each keeps its own parse of every open file. |
| No autosave, and nothing reopens on launch | Decided. A restored session raced files opened from Finder. Storing a `FileSystemFileHandle` in IndexedDB made Chrome crash at exit. Unsaved work is guarded only by the `beforeunload` prompt. Do not suggest IndexedDB persistence. |
| Save-in-place only works in Chromium | It depends on the File System Access API and `file_handlers`, which Safari lacks. iOS falls back to downloads. |
| A tool switches back to Select after one use | The owner's decision ("one-shot tools"). It overrides an earlier UX review. |
| No "Are you sure?" on delete or Clear All | Undo covers them. Confirms appear only for what undo cannot reach: closing a tab or window with unsaved work. |
| Every path starts with `./` | Pages serves from `/redline-pdf/`. An absolute path works locally and 404s in production. |
| Thumbnails render one at a time | Concurrent pdf.js renders were flaky. The loop awaits on purpose. |
| The AI only talks to `localhost:11434` | It is optional, and local by design (Ollama). `ai.js` imports nothing, and nothing in the page, coordinate or export code imports it. |
| Version is `rev 1.0`, not semver | `rev M.N` appears both in `#buildStamp` (index.html) and in `CACHE` (sw.js), and N is bumped on every deploy. M is the owner's to change; it became 1 on 2026-10-18. |
| The plot renderer draws joins round, converts CMYK naively, and puts all text above the linework | It is a viewer's approximation, chosen for speed. Export never uses it. |

## 3. File map

```
index.html        the whole UI shell; #buildStamp near the bottom
app.css           all styles (container queries for the side rails)
sw.js             service worker: precaches the app shell, cache-first
manifest.webmanifest   PWA manifest, incl. file_handlers for .pdf

js/state.js       data model, rotation math, markup geometry, shared state.
                  No imports, no side effects — the bottom of the graph.
js/history.js     undo/redo: whole-document checkpoints, one stack per tab
js/tabs.js        the open-document list and switching
js/pages.js       import (both libraries), blank pages, delete, rotate, reorder
js/files.js       open (Finder launch, picker, drag-drop), save, Save As, download
js/export.js      writing the PDF (pdf-lib), and reading Redline's markups back in
js/view.js        page canvas, zoom, render queue, thumbnails, memory policy
js/annots.js      markup tools and their pointer interactions (SVG + DOM)
js/chrome.js      the command surface: menus, properties row, markups list,
                  save chip, save-failure alert, hover tips. Holds no state.
js/persist.js     the few preferences kept between launches (localStorage)
js/plot.js        heavy pages: worker pool, GPU records, residual PDF, budget
js/plotcompile.js content stream -> GPU instances + residual stream. Pure;
                  runs in a worker and under JavaScriptCore.
js/plotworker.js  module worker: inflate + compile
js/plotgl.js      WebGL2 renderer for compiled plots
js/ai.js          Ollama HTTP client. Networking only.
js/aitext.js      the document as text: blocks, BM25 passage retrieval
js/aipanel.js     the AI panel UI
js/main.js        wiring, keyboard, boot

vendor/           pdf-lib.min.js, pdf.min.js, pdf.worker.min.js (do not review)
tests/            see §8
docs/build-guide.md   the original design spec; §3 derives the coordinate math
```

The dependency graph has one intentional cycle: `view.js` and `annots.js`
import each other, which is safe because neither does anything when it is
first loaded. `view.js` is the only importer of `plot.js`. `tests/analyze.py`
enforces both rules.

## 4. The data model

**`state` holds the active document.** Tabs are records in `state.docs`.
Switching tabs copies the per-document fields out of `state` into the old
record, and the new record's fields in (`captureActiveDoc` /
`loadDocIntoState`). Because of that, most modules never learned that
tabs exist. Two consequences:

- The active tab's record is stale until you capture it.
- Page ids restart at 1 in every document. Caches are keyed by object
  (`WeakMap`), never by id.

**A page** is `{ id, kind: 'imported'|'blank', sourceId, sourcePageIndex,
W0, H0, rotation, annotations }`. `W0`/`H0` is the raw MediaBox.
`rotation` is absolute: it replaces the file's `/Rotate` rather than
adding to it.

**A source** is one opened file: `{ id, name, pdfLibDoc, pdfjsDoc }`.
Pages point at sources, so merging two files gives one document with two
sources.

**A markup** belongs to one of two families:

- *Notes* (`text`, `callout`) are boxes of text with a position, width,
  font size, colour and fill. A callout adds a tip, and its leader always
  leaves the side of the box on a short level jog
  (`computeLeader` in state.js).
- *Point shapes* (`ink`, `highlight`, `arrow`, `rect`, `cloud`) are a
  colour, a weight and a list of points. `shapePolylines()` in state.js
  turns any of them into the lines to stroke. The SVG editor and the PDF
  exporter both draw from it, so a shape cannot look different on screen
  and in the saved file.

**Coordinates are the part most likely to be wrong.** Markups live in
*visual space*: origin top-left, y down, the page already rotated. pdf-lib
draws in *native space*: origin bottom-left, y up, raw MediaBox, ignoring
`/Rotate`. Every point handed to pdf-lib goes through `toNative`,
including annotation `/Rect`, `/CL` and `/InkList` entries. Text also
gets a compensating rotation. Directional geometry (arrowheads, which
edge a leader leaves from) is done in visual space and converted last.
Sign errors appear only on 90° and 270° pages, which is why the unit
tests cover every rotation.

**Undo** (history.js) is a snapshot taken *before* each change, not an
inverse operation per action. A snapshot holds:

- the page list, with each page's rotation and a copy of its markups;
- the sources;
- the document's identity (name, file handle, whether it is a merge).

Page objects are kept by reference, so undo never invalidates
thumbnails. Each tab has its own stack, capped at 200 steps. A successful
save rewrites the name and handle in every checkpoint. Without that,
undoing past a Save As would aim ⌘S back at the file that was saved away
from.

## 5. How a file moves through the app

1. **Open** (files.js). There are four ways in, all ending in
   `importPdfBytes(bytes, name, { handle, into })`:
   - a Finder double-click, via `launchQueue`, which waits for boot to finish;
   - the file picker;
   - drag-and-drop;
   - the `<input type=file>` fallback.

   `into` is the tab the open was started in, taken *before* any await.
   A file that finishes loading while a different tab is in front lands
   in its own tab out of sight (`withDoc` in state.js). If its tab was
   closed meanwhile, it opens nowhere.
2. **Read** (pages.js). pdf-lib parses the file. Markups Redline saved
   earlier are taken out of the document (`takeMarkups`, export.js) and
   become editable again. They are rebuilt only from Redline's private
   `/RedlineMarkup` entry, which is validated field by field because the
   file may come from anyone. pdf.js is then given the document
   re-serialised *without* them; otherwise every markup would be drawn
   twice. Any failure during this phase is reported as "isn't a PDF
   Redline can read".
3. **Land.** The pages are appended. A file opening into an empty tab
   *becomes* that document: it takes the file's name and save handle and
   starts with empty history. A file added to an existing document is an
   undoable edit, and the document stops having a single file to save
   back to (⌘S then routes to Save As).
4. **Show** (view.js). See §6.
5. **Mark up** (annots.js). Pointer gestures draw into an SVG and DOM
   overlay sized in CSS pixels; each markup is stored in page points
   (`pt × currentScale`).
6. **Save** (files.js and export.js).
   - `buildPdfBytes` creates a new pdf-lib document and copies pages with
     one `copyPages` call per source, so shared fonts aren't duplicated.
   - It writes each markup as a standard annotation (FreeText, Ink, Line,
     Square, or a cloudy Polygon) with an appearance stream.
   - That appearance stream is drawn by the same function that flattens
     (`drawAnnotationOnPage`), so the two forms cannot look different.
   - The bytes are built completely *before* the destination is opened,
     because `createWritable` truncates the file.
   - A locked (encrypted) source is refused before anything is written:
     pdf-lib cannot decrypt, and would write blank pages.
   - A failed save raises `#saveAlert`, which stays on screen until it is
     dealt with.

## 6. Why it is fast

### Ordinary pages (pdf.js)

- **One render queue per canvas.** Every draw into `#pageCanvas` is
  serialised (`renderQueue`) and checked against a token. pdf.js throws
  if two renders share a canvas, and a lock per page gave no protection,
  because rapid page changes render *different* pages to the *same*
  canvas.
- **A zoom is laid out before it is drawn.** When the canvas already
  holds the page, a size change is applied at once: CSS stretches the
  existing pixels and the markup layer is rebuilt at the new scale.
  Wheel, button and keyboard zooms ease toward a moving target. Once the
  sizes stop arriving (90 ms), the sharp render happens off-screen and is
  swapped in whole. Drawing straight onto the visible canvas would blank
  it at every step.
- **The neighbouring pages are drawn ahead.** Once a page is up, the
  pages either side are rendered out of sight at the size they will be
  shown, so the arrow key copies a finished bitmap in: about 4–5 ms
  instead of 75–200 ms. This stops the moment anything else is asked
  for, waits for the thumbnails, and is skipped at zooms where each copy
  would be a large share of memory.
- **Backing stores are capped** at what Chrome will actually allocate
  (`clampBackingScale`). Past that, CSS alone carries the zoom.
- **pdf.js is made to forget.** After drawing a page, pdf.js keeps its
  whole operator list until told to let go, and every thumbnail counts
  as a draw. Only the page on screen keeps its list (`keepOnly`/`letGo`).
  A closed tab's pdf.js documents are destroyed once no open document and
  no undo step can reach them (`sweepSources`). Before rev 0.31, eight
  60-sheet sets held 231 MB, and closing them freed nothing. Now they
  hold about 29 MB open and about 8 MB after closing.
- **pdf-lib runs at full pace** (`ParseSpeeds.Fastest`, and `SAVE_PACE`
  objects between pauses). Its defaults pause on a timer every 50–100
  objects. A 3,600-object set opened 3× faster without them.

### Heavy pages (the plot path)

A page with more than 4 MB of compressed content
(`HEAVY_CONTENT_BYTES`) never goes through pdf.js's normal render. That
path cost about 2 GB of operator list and around 30 s per redraw on the
benchmark sheet. Native engines are no cure: Apple's takes 5 s per
redraw, MuPDF in WASM 10 s.

1. **Prepare** (plot.js, main thread). The page's raw content streams
   and a reduced resource dictionary are pulled out with pdf-lib.
2. **Compile** (plotworker.js and plotcompile.js, in a worker pool of up
   to 3).
   - The worker inflates the streams with `DecompressionStream`.
   - A hand-written byte-level tokenizer walks the content stream once,
     tracking the graphics state (transform, colour, line width, `q`/`Q`,
     clipping).
   - Plain stroked and filled paths become 20-byte GPU instances, sent
     back in chunks of 32,768. Each instance is a line segment or a
     tessellated triangle.
   - Everything else (text, images, shadings, soft masks) goes into a
     much smaller *residual* content stream. Each residual paint is
     wrapped in its own optional-content span, so pdf.js can draw any one
     layer by switching only that layer on.
   - An image or opaque fill that pdf.js must draw closes the current GPU
     group, which keeps paint order correct: residual 0, GPU group 0,
     residual 1, GPU group 1, … and text on top.
3. **Draw** (plotgl.js, WebGL2).
   - One instanced draw call per chunk. The vertex shader expands each
     segment to a quad whose width is set in screen pixels.
   - Multisampling handles antialiasing.
   - Rectangular clips are scissor rectangles; other clips use the
     stencil buffer.
   - Residual layers and the text layer are pdf.js renders of the
     residual document, uploaded as textures.
   - A whole-page overview texture stands in while the view moves.
   - `#plotCanvas` only ever covers the visible part of the page, so a
     redraw takes milliseconds at any zoom.
4. **Budget and scheduling.**
   - GPU memory is capped per device (`geometryBudget`), and the least
     recently used sheets are evicted.
   - Background sheets do not start compiling until the sheet on screen
     is fully ready. Starting them earlier made that sheet 1–1.5 s later.
5. **Fallback ("master").** No WebGL2, an unsupported filter, or the
   bulk of the page inside a form XObject: the page gets one unrotated
   pdf.js render into a capped offscreen canvas, blitted from then on,
   and `cleanup()` releases its operator list.

Measured on the benchmark sheet: 14.7 M segments compiled in 1.6–1.9 s,
about 110 ns per segment. Linework is visible about 1.8–2.0 s after
opening, and labels follow 0.8–1.0 s later. Profiling shows the tokenizer
(`feed` in plotcompile.js) is the largest share of worker time, and it is
already a tight byte loop. The remaining lever would be splitting one
sheet across several workers, which has not been attempted.

### Numbers (rev 0.31, synthetic 60-sheet set, headful Chrome, M3 8 GB)

| | |
|---|---|
| First page drawn after open | ~85–105 ms |
| All 60 thumbnails | ~1.1 s |
| Step to the next page (pre-drawn copy) | 4–5 ms |
| Zoom with 300 markups on the page | 16.7 ms per frame (p50 and p95) |
| Zoom, click to sharp | ~280 ms (includes the 90 ms settle and the ease) |
| Save, with 300 markups | ~85 ms |
| Pen stroke, cost per pointer move at 1,500 points | ~0.16 ms |
| Open / save a 200-sheet, 3,600-object set | 84 ms / 28 ms |
| 600 markups, save then reopen | 140 ms / 50 ms, all identical to 0.01 pt |

## 7. Reliability mechanisms worth knowing

- **Service worker** (sw.js).
  - The shell is cached first. `CACHE` is bumped on every deploy, and
    `activate` deletes every other cache.
  - `precache()` fetches each file with `cache: 'no-store'` and a
    `?v=VERSION` query, and refuses to install if index.html doesn't
    carry the matching stamp. Without this, for about ten minutes after a
    deploy, the HTTP cache or CDN filled the new cache with the *previous*
    build under the new name, and the installed app stayed on the old
    build indefinitely.
  - `tests/run_sw.mjs` covers this.
- **Boot gating.** Anything arriving from outside, such as a Finder
  launch, waits for the `booted` promise in main.js.
- **Events and await.** A drop's file handles are all requested before
  the first await. After the handler yields they are gone; requesting
  them one at a time silently lost every file after the first.
- **Untrusted input.**
  - Saved markups are rebuilt from a validated payload, never from the
    standard annotation fields.
  - Damaged and non-PDF files are refused with a plain message.
  - Password-protected files are refused.
  - Owner-locked files (permissions password only) open but cannot be
    saved. Real decryption is not implemented.
- **Unsaved work.** `beforeunload` checks every tab, not only the active
  one. iOS does not show this prompt — a known platform gap.

## 8. Tests

```sh
tests/analyze.py        # static: import cycles, dead exports, missing DOM ids,
                        # absolute paths, precache drift, stamp = CACHE,
                        # per-tab state fields that would leak across tabs
tests/run.sh            # unit checks under JavaScriptCore: rotation math,
                        # geometry, rotate remap, view math, plot compiler,
                        # history, service worker, AI text, export round trips
tests/browser/run.sh    # ~2 min, real Chrome window over CDP, owns its own
                        # server; boot, render, zoom, gestures, tools, tabs,
                        # save/reopen, heavy pages (plot and master), Finder
                        # launch, a fake Ollama, and the document lifecycle
```

At rev 0.31: analyze 10 passed, unit 358 checks, browser 359 passed and
0 failed. The browser suite must run headful. Headless Chrome stops
compositing partway through a long run, `requestAnimationFrame` stops
with it, and pdf.js renders stall: a false failure that looks like an
app deadlock (`tests/browser/KNOWN-ISSUES.md`).

Fixtures are generated, not committed: `cupsfilter` for the small PDF,
Python for the heavy and the encrypted ones.

## 9. Known limits (already understood)

- Owner-locked PDFs open but cannot be saved; password-protected ones do
  not open. Fixing this means decrypting RC4/AES before pdf-lib parses
  the file.
- Some CAD tables are drawn as lines rather than text, so the AI and
  text extraction cannot read them.
- The plot path's visual approximations (§2).
- Making the AI panel work from the deployed site needs an `OLLAMA_ORIGINS`
  setting that doesn't survive a reboot.
- Undo snapshots copy every markup of every page. This is cheap so far
  (under a millisecond per step in a 180-edit test on 60 pages), but it
  grows with markup count × 200 steps.
- The heavy-sheet compile has not been profiled for a sheet-level
  parallel split (§6).

## 10. What would make the review useful

**Most valuable places to look:**

1. `js/export.js` together with the rotation helpers in `js/state.js`:
   anything that reaches pdf-lib without `toNative`, and round-trip
   fidelity (save → reopen) on rotated pages.
2. `js/view.js`: the render queue and token logic, zoom settle and
   ahead-drawing interleavings, and the memory policies (`keepOnly`,
   `sweepSources`). Look for a page shown with the wrong pixels, a render
   that never settles, or a resource never released.
3. `js/plotcompile.js` against the PDF content-stream spec: operators,
   graphics state, clipping, inline images, operands split across chunk
   boundaries. A misread here silently drops or misplaces linework.
4. `js/files.js` and `js/history.js`: anything that could write to the
   wrong file, truncate one, report "saved" when it isn't, or let
   undo/redo change which file ⌘S writes.
5. `js/tabs.js`, `js/pages.js` and `js/state.js` (`withDoc`): state read
   from the wrong document, or kept across an await.
6. `sw.js`: any path to serving a stale or mixed build.

**How to report.** For each finding, give:

- the file and line;
- a one-sentence statement of the defect;
- a concrete failure scenario: steps or inputs, and the wrong result
  the user sees;
- whether you **confirmed** it (reproduced, or traced end to end) or it
  is **plausible** (reasoned but not traced). Please don't present
  plausible as confirmed. Two confident-sounding hypotheses about this
  codebase have been wrong on contact with the browser.

Rank by consequence: **data loss** (a file overwritten or blanked, work
lost) > **silent breakage** (a control that stops working with nothing on
screen) > **visible bugs** > **cleanups**. Say so when an area comes up
clean. Before filing anything against §2, read its reason; if you think a
decision is wrong, argue it as a decision, not as a bug.
