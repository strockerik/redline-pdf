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
js/persist.js   IndexedDB autosave and restore
js/pages.js     import, blank pages, delete, rotate, reorder
js/view.js      page canvas, zoom, thumbnails, reorder gesture
js/annots.js    text box + callout tools, pointer interactions
js/export.js    pdf-lib output
js/plot.js      heavy vector pages: worker jobs, residual PDF, draw calls
js/plotcompile.js   content stream -> GPU instances + residual stream; pure,
                    no DOM (runs in the worker and under JavaScriptCore)
js/plotworker.js    module worker: inflate + compile
js/plotgl.js    WebGL2 renderer for the above
js/tabs.js      document tabs: the open-document list and switching
js/main.js      wiring and boot
```

`view.js` is the only module that imports `plot.js`, and nothing in the
plot files knows about zoom modes, tabs or annotations.

`view.js` and `annots.js` import each other. That cycle is fine because
nothing runs at module-evaluation time — but don't add top-level side
effects to either.

**Tabs hold whole documents, and `state` holds the active one.** Every
per-document field (`pages`, `sources`, `docName`, `fileHandle`,
`combined`, the `next*Id` counters) lives on `state` as it always did;
`state.docs` holds the records and switching swaps the fields in and out
via `captureActiveDoc` / `loadDocIntoState` in state.js. So view.js,
annots.js, pages.js and export.js never learned about tabs. Two
consequences worth knowing: **capture before you read a doc record** —
the active tab's record is stale between switches, which is why
`snapshot()` calls `captureActiveDoc()` first — and **page ids restart
per document**, so nothing may be cached by page id alone. The thumbnail
cache is keyed by the page object for exactly that reason.

**Anything that arrives from outside waits for boot.** A file opened from
Finder reaches the launch handler before the saved session has been read
back; importing it straight away meant the restore then overwrote it. The
handler awaits `booted` (main.js) and opens each file in its own tab —
never into whatever document happens to be live.

## The part that breaks if you're careless

Annotation coordinates live in **visual space** (what the user sees:
origin top-left, y down, page already rotated). pdf-lib draws in
**native space** (origin bottom-left, y up, raw MediaBox, *ignoring*
`/Rotate` — its size getters are not rotation-aware).

- Every point handed to pdf-lib goes through `toNative`.
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
  its own `bytes.slice(0)` — including session restore.
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

Deferred, by decision: highlight / arrow / shape tools, undo-redo,
multi-select, text search. The module split is what keeps adding any of
them a contained change.

Shipped since: freehand ink (`type: 'ink'`, a point list in visual space;
it takes its own branch in `drawAnnotationOnPage`,
`remapAnnotationsForRotation` and `buildAnnoDom`, having no box, text or
font size) and document tabs (see the architecture note above — the rest
of the app never learned about them).
