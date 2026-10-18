# Known issues found by the browser suite

## RESOLVED — the "render deadlock" was never an app bug

**Status:** closed. The suite runs green; it has no expected failures.

For a long time this file described a render deadlock in the app: after a
session restore the main canvas stayed blank and the thumbnails never
painted, so it read as "my document lost its pages". It was the suite's one
permanent red check, and it shaped a lot of decisions — the pen's size
presets were made permanent toolbar furniture to avoid a reflow "trigger",
and the wheel-zoom checks were exiled to a second browser instance to stay
clear of a supposed render-capacity limit. That isolation has since been
undone; the checks run in the main pass again.

**All of that was chasing a headless-Chrome artifact.**

### What it actually was

Probing the page while it was stuck gave this:

```
sourceBytes: 13872     <- data intact
numPages:    3         <- document alive
getPage:     resolved  <- worker answering
oplist:      resolved  <- worker fully healthy
rAF:         STARVED   <- requestAnimationFrame never fires
freshCanvas: HUNG      <- even a throwaway canvas will not paint
render:      HUNG
```

pdf.js continues a multi-chunk canvas render from
`requestAnimationFrame`. Headless Chrome stops compositing an unattended
page partway through a long run, rAF stops firing with it, and every render
stalls forever — while promises keep resolving, because microtasks do not
need a frame. That last detail is what made it look like a deadlock instead
of a stalled renderer.

The same suite in a real window: green, every check. No app change was
needed to get there.

Instrumenting each section showed rAF dying between the reorder and pen
sections, consistently. Neither
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`,
`--disable-features=CalculateNativeWinOcclusion`, nor a permanent
`Page.startScreencast` brought it back, so the suite now **runs headful by
default**. `--headless` is still there and is faster; expect checks that
wait on a page render late in the run to fail spuriously under it. (The
session restore this was first seen on no longer exists — documents close
with the app — but the stall is headless Chrome's, not that feature's.)

### Hypotheses that were tried and are wrong

Recorded so nobody spends another session on them:

1. **Two renders racing over the same pdf.js page.** A promise chain keyed
   by `sourceId:pageIndex`, taken by both `renderMainCanvas` and
   `paintThumbCanvas`, changed nothing. `thumbCanvases: 0` is a
   *consequence* of the main render stalling, not evidence of a race.
2. **The cancel path wedging it.** Awaiting the cancelled task's promise
   before starting the next render changed nothing.
3. **Leaked pdf.js workers.** 27 live workers in one measurement — real,
   and since fixed by sharing one `PDFWorker` (below). But not the cause
   of this: 24 documents created back-to-back all rendered fine.
4. **The detached-ArrayBuffer trap.** `sourceBytes` was always intact.

### What was a real bug, found on the way

`renderMainCanvas` cancelled the in-flight `RenderTask` and immediately
started the next one on the same canvas. `cancel()` is **not synchronous** —
the task holds the canvas until its promise settles — so pdf.js throws:

```
Cannot use the same canvas during multiple render() operations.
```

That aborts the function before it reaches the sizing code, leaving the
canvas at its old dimensions and the annotation overlay on pre-zoom
coordinates. Reproduced deterministically by driving 40 overlapping renders
at one canvas.

Fixed by serialising everything that touches `#pageCanvas` through a queue.
Note the earlier per-page lock could never have worked: rapid page switches
and zooms render *different* pages to the *same* canvas, so a lock keyed by
page provides no mutual exclusion. The constraint pdf.js enforces is one
render per **canvas**.

## Closed: pdf.js document lifetime

pdf.js used to start a dedicated Web Worker per `getDocument()` call, and
since nothing here calls `.destroy()`, a moderate session left **27 live
worker threads**. `js/pages.js` now keeps a lazily-created shared
`PDFWorker` and passes it to every `getDocument`.
Re-measured with the same 24-document probe: **27 worker targets -> 4**,
and that 4 includes the service worker.

The *documents* were still never destroyed, and that turned out to be
far from bounded: pdf.js keeps the operator list of every page it has
drawn, and every thumbnail is a draw. Eight 60-sheet sets took 231 MB of
heap, 211 MB of it operator lists for pages nobody was looking at — and
closing all eight gave back none of it (218 MB after). Rev 0.31 fixed
both halves (view.js):
- only the page on screen keeps its operator list (`keepOnly` /
  `letGo`): eight open sets now take ~30 MB;
- `sweepSources` destroys the pdf.js document of any source no open
  document and no undo or redo step can reach: closing all eight returns
  the heap to where it started (8 MB).

Undo still keeps sources alive on purpose: a checkpoint holds the source
documents it refers to, so Clear All, or undoing a merge, lets them go
only when the tab closes or 200 further steps push the checkpoint out.
GPU plots are swept sooner — when their document leaves the page list —
and recompiled if undo brings it back. The browser suite checks both: a
source only redo can reach keeps its document; a closed tab's are
destroyed.
