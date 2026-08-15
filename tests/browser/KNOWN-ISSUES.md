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
default**. `--headless` is still there and is faster; expect the
session-restore check to fail spuriously under it.

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

## Mostly closed: pdf.js document lifetime

pdf.js used to start a dedicated Web Worker per `getDocument()` call, and
since nothing here calls `.destroy()`, a moderate session left **27 live
worker threads**. `js/pages.js` now exports a lazily-created shared
`PDFWorker` that both it and `js/persist.js` pass to every `getDocument`.
Re-measured with the same 24-document probe: **27 worker targets -> 4**,
and that 4 includes the service worker.

Still open, but bounded: the *documents* are still never destroyed, so
their parsed structures and byte copies stay in memory until the tab goes
away. That grows with what the user actually opens rather than with every
render, which is why it is logged rather than fixed — adding `destroy()`
calls to the re-import, tab-close and restore paths is real complexity in
the load path for a leak nobody has hit.
