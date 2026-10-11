# Redline — notes for Claude Code

A personal PDF markup tool: page assembly plus text notes. Installable
PWA, hosted on GitHub Pages, runs entirely client-side.

- **Live:** https://strockerik.github.io/redline-pdf/
- **Repo:** https://github.com/strockerik/redline-pdf (public, Pages from `main` / root)

## Commands

```sh
python3 -m http.server 8000     # must be http — ES modules and service
                                # workers do not run from file://
tests/run.sh                    # unit checks under JavaScriptCore (ships
                                # with macOS; no node, no npm)
tests/browser/run.sh            # integration checks driving a real Chrome
                                # window over CDP; --headless is faster but
                                # stalls pdf.js renders (KNOWN-ISSUES.md).
                                # Owns its own server.
tests/analyze.py                # static checks: import cycles, dead exports,
                                # missing DOM ids, absolute paths, service-
                                # worker precache drift, tab field leaks.
                                # Python 3, stdlib only.
```

There is no build step and no package.json. Deliberate — see below.

Counts drift, so they are not written down here; each script prints its
own total. `/audit` runs all three and reviews the result against
`.claude/skills/audit/references/hazards.md`, a catalogue of the traps
this codebase has actually fallen into.

## Architecture

Plain ES modules loaded directly by the browser. The two PDF libraries
are vendored in `vendor/` as classic scripts and expose globals
(`PDFLib`, `pdfjsLib`) before the module graph loads.

```
js/state.js     data model, rotation math, shared state — no imports, no
                side effects; sits at the bottom of the dep graph
js/files.js     open / save / launchQueue file handler
js/persist.js   the few preferences kept between launches (localStorage)
js/pages.js     import, blank pages, delete, rotate, reorder
js/view.js      page canvas, zoom, thumbnails, reorder gesture
js/annots.js    the markup tools and their pointer interactions
js/export.js    pdf-lib output, and reading Redline's markups back in
js/plot.js      heavy vector pages: worker jobs, residual PDF, draw calls
js/plotcompile.js   content stream -> GPU instances + residual stream; pure,
                    no DOM (runs in the worker and under JavaScriptCore)
js/plotworker.js    module worker: inflate + compile
js/plotgl.js    WebGL2 renderer for the above
js/history.js   undo / redo: one stack of checkpoints per document
js/tabs.js      document tabs: the open-document list and switching
js/chrome.js    the command surface: file menu, properties row, page
                field, markups list, save chip, save-failure alert
js/main.js      wiring, keyboard, boot
```

`view.js` is the only module that imports `plot.js`, and nothing in the
plot files knows about zoom modes, tabs or annotations.

`view.js` and `annots.js` import each other. That cycle is fine because
nothing runs at module-evaluation time — but don't add top-level side
effects to either.

**Every markup is one of two families.** A *note* (`text`, `callout`) is
a box of text. Everything else — `ink`, `highlight`, `arrow`, `rect`,
`cloud` — is a *point shape*: a colour, a weight and a list of points in
visual space. `shapePolylines()` in state.js turns one into the lines to
stroke, and the editor (SVG) and the exporter (pdf-lib) both draw from
it, so a shape cannot look one way on screen and another in the file. A
new shape tool is a case in `shapePolylines`, an annotation subtype in
`attachMarkup`, and a button; rotation, moving, saving and undo already
handle it.

**Undo is a checkpoint taken before each change** (`checkpoint(label)` in
history.js) — the page list, each page's rotation and markups, the
sources and the document's identity. Any new code that changes the
document must take one first; see hazards.md §3. Identity is in there so
that undoing a merge gives the name and handle back — which means a save
has to rewrite it in every checkpoint (`noteClean`), or stepping back past
a Save As re-aims ⌘S at the file that was saved away from. `chrome.js` redraws the
whole command surface from `state` and the history and holds no state of
its own; view.js calls it through `onToolbarUpdate` because chrome.js
imports view.js and the reverse would be a cycle.

**Tabs hold whole documents, and `state` holds the active one.** Every
per-document field (`pages`, `sources`, `docName`, `fileHandle`,
`combined`, the `next*Id` counters) lives on `state` as it always did;
`state.docs` holds the records and switching swaps the fields in and out
via `captureActiveDoc` / `loadDocIntoState` in state.js. So view.js,
annots.js, pages.js and export.js never learned about tabs. Two
consequences worth knowing: **capture before you read a doc record** —
the active tab's record is stale between switches — and **page ids restart
per document**, so nothing may be cached by page id alone. The thumbnail
cache is keyed by the page object for exactly that reason.

**Documents close with the app. Nothing is reopened, and nothing about a
document is ever stored.** Every launch starts empty; only the fit mode,
colours, text size, line weight, note fill and whether the Finder set-up
note has been dealt with are kept (persist.js, localStorage). This
is a decision, not an omission: the saved session nobody wanted raced
every file opened from Finder, and — with a file handle in it — made
Chrome crash at exit. Don't bring back autosave, and above all don't put
a `FileSystemFileHandle` into IndexedDB. Unsaved work is guarded by the
`beforeunload` prompt alone, which iOS does not show.

**A saved markup is a PDF annotation, not paint — until it is flattened.**
Save writes each markup as a standard annotation (FreeText, Ink, Line,
Square, or a cloudy Polygon) and Redline reads them back as editable
markups on open;
"Flatten…" saves a copy with them painted into the pages instead. Three
things hold this together (export.js, "Markups that stay editable"):
- The annotation's appearance stream is drawn by `drawAnnotationOnPage`,
  the same function that flattens, onto a scratch page that is then lifted
  into a form XObject whose BBox *is* the annotation's Rect. So both forms
  look identical and every rotation rule below applies unchanged. Don't
  grow a second way of drawing a markup.
- Redline reads back only its private `/RedlineMarkup` entry, never the
  standard fields. That payload comes from a file someone else may have
  written: `readPayload` checks every field and builds the markup fresh.
- On open the annotations are *removed* from the pdf-lib document, and
  pdf.js is given the document re-serialised without them. Leave them in
  and each markup is drawn twice — once by pdf.js, once by the editor —
  and written twice on the next save.

**Anything that arrives from outside waits for boot.** A file opened from
Finder reaches the launch handler while boot is still running. The handler
awaits `booted` (main.js) and opens each file in its own tab — never into
whatever document happens to be live.

## The part that breaks if you're careless

Annotation coordinates live in **visual space** (what the user sees:
origin top-left, y down, page already rotated). pdf-lib draws in
**native space** (origin bottom-left, y up, raw MediaBox, *ignoring*
`/Rotate` — its size getters are not rotation-aware).

- Every point handed to pdf-lib goes through `toNative` — including an
  annotation's `/Rect`, `/CL` and `/InkList`.
- Text additionally gets `rotate: degrees(textCompensationDegrees(R))`,
  because glyphs are the only thing with an inherent "up". Rectangles
  and lines never need it.
- Do all directional geometry (arrowhead angles, which edge a leader
  attaches to) in visual space, where it's ordinary 2D math. Convert
  only at the final draw call.
- `page.rotation` is **absolute**, not a base+delta pair.
  `setRotation()` overwrites; it does not add.

Changing any of this without running `tests/run.sh` is asking for a sign
error that only shows up on 90°/270° pages and is miserable to eyeball.
`docs/build-guide.md` §3 has the full derivation.

## Other gotchas

- **pdf.js detaches the ArrayBuffer** it's handed. Every consumer needs
  its own `bytes.slice(0)`.
- **Bump `CACHE` in `sw.js` on every deploy, and the build stamp with
  it.** Otherwise the installed app keeps serving the previous version
  from cache. The stamp is the `#buildStamp` line in index.html — `rev N ·
  date · what changed`, where N is the CACHE number — and is what the user
  compares against the repo to see whether a running copy is current.
  `tests/analyze.py` fails if the two numbers disagree.
- **All paths must stay relative (`./`).** Pages serves from
  `/redline-pdf/`, so an absolute `/js/...` works locally and 404s in
  production.
- **Render thumbnails sequentially.** Concurrent pdf.js renders are
  flaky; `paintAllThumbs` awaits in a loop on purpose.
- **`renderMainCanvas` cancels the previous RenderTask** and guards with
  a token. pdf.js rejects two renders against one canvas.
- **Heavy pages never go through the ordinary render path.** A CAD plot
  can be ten million strokes: ~2 GB of operator list and half a minute per
  pdf.js render, whatever the canvas size. Native engines are no cure —
  Apple's takes 5 s a redraw on the same sheet, MuPDF in WASM 10 s. A page
  whose content passes `HEAVY_CONTENT_BYTES` takes one of two paths
  (view.js, "Heavy pages"):
  - **plot** — `plotcompile.js` reads the content stream once, in a
    worker, and turns plain strokes and fills into GPU instances;
    `plotgl.js` draws them into `#plotCanvas`, which only ever covers the
    visible part of the page. Text, images and anything else go back out
    as a small *residual* content stream that pdf.js draws into textures.
    Opening is ~2 s and a redraw is milliseconds.
  - **master** — the fallback (no WebGL2, an unsupported filter, the bulk
    inside a form XObject): one pdf.js render, unrotated, into a capped
    offscreen canvas, blitted from thereafter, and `pjPage.cleanup()` to
    release the operator list.
  Don't route such a page back through `pjPage.render` for a thumbnail or
  a re-zoom — that is the out-of-memory crash both paths exist to prevent.
  Records are keyed by source object, not page id, so they survive tab
  switches.
- **The plot path is a viewer's approximation; export never touches it.**
  Text is drawn above all linework, joins are round, CMYK is converted
  naively, image layers are not re-rendered as you zoom. If a sheet looks
  wrong on screen, compare against the bitmap fallback (set
  `plotFailed` on its record) before suspecting the file.
- **`#pageCanvas` stays in the layout at full page size even when the
  plot canvas is doing the drawing.** annots.js measures against it. On a
  plot page it has a 2x2 backing store and nothing to show.
- **The stage does not use `justify-content:center`.** Page and empty
  state centre themselves with auto margins. Centring from the container
  overflows a zoomed page to *both* sides, and the left half of that
  cannot be scrolled to.
- Canvas backing store is at `scale * devicePixelRatio`, clamped to what
  the browser will allocate (`clampBackingScale`); layout stays in
  logical px so the overlay's `pt * currentScale` math is unaffected.
- **`state.lastFitMode` is not `state.zoomMode`.** The wheel keys off the
  fit mode the user last *chose*; `zoomMode` flips to `'custom'` the moment
  anything zooms, so reading it there would make one wheel-zoom in Fit W
  silently change what the wheel does next.
- **Tools stay armed** until Esc, Select, or the same tool again. A click
  that only ends typing in a note must not place another one.
- **The properties row has a fixed height** and shows only what applies.
  Don't let a control that comes and goes change the height of anything
  above the stage — it re-fits the page.
- **A failed save goes to `#saveAlert`, never `setStatus`.** It must stay
  on screen until dealt with.
- **A trackpad pinch is a `wheel` event with `ctrlKey` set** and is
  otherwise identical to a real Ctrl+wheel. `installStageGestures` tracks
  whether Ctrl is physically down to tell them apart — needed because
  Ctrl+wheel scrolls in Fit W, and without this pinch-to-zoom would break
  in the default mode. Discrete wheels are also clamped and damped before
  hitting the zoom curve; a raw `deltaY` of 120 through `exp(-Δ/100)` is a
  3x jump per notch.

## Platform constraints

Finder double-click and the native save panel need `file_handlers` and
the File System Access API — **Chromium only**. Safari implements
neither, so the Mac install path is Chrome, not Safari "Add to Dock".
iOS gets the download fallback. Don't "fix" this by reaching for Safari.

macOS assigns `.pdf` to Preview; making double-click reach Redline
requires Get Info → Open with → Change All once, from Finder. No
app-side code can override it.

## Scope

Deferred, by decision: measurement (it needs a scale per sheet and its
own schedule), stamps, text search, multi-select, marquee zoom, page
extraction. The module split is what keeps adding any of them a contained
change.

Shipped since: freehand ink, then document tabs (see the architecture
note above — the rest of the app never learned about them), then the
rev 20 redesign from the UX review in `.ux-review/` (gitignored): undo
and redo, tools that stay armed, highlight / arrow / box / cloud, one
Save with the other file commands behind it, the page field, the markups
list, note fill, duplicate and copy/paste, and the save chip and alert.

Kept through that review, on purpose: no autosave, documents close with
the app, Chromium-only for save-in-place.
