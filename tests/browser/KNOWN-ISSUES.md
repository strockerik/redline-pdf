# Known issues found by the browser suite

## Render pipeline deadlocks on session restore

**Status:** open, pre-existing (reproduces identically on `7956179`, before
the scroll/shortcut work). Currently the one red check in `run.sh`.

**Symptom.** After restoring a session, the main canvas stays blank and the
thumbnails never paint. The app is not obviously broken otherwise — the page
count, order and toolbar are all correct, so it reads as "my document lost
its pages".

**It is not the detached-ArrayBuffer trap.** The restored data is completely
intact; only rendering is stuck. The probe printed on failure shows:

```
sourceBytes: 13872      <- source PDF intact
numPages: 3             <- pdf.js document alive
getPage: resolved       <- pdf.js still answers
thumbCanvases: 0        <- thumbnail painter never got started
render: HUNG            <- renderMainCanvas() never resolves
```

`renderMainCanvas` hangs at `await task.promise` — the RenderTask never
settles, and `paintAllThumbs` is stuck the same way. In the worst runs the
renderer stops answering CDP evaluates at all.

**Reproduce** (`repro_race.py` in the scratchpad, or by hand):

1. Open a PDF with 3+ pages.
2. Drag page 1 to the end of the rail.
3. Click the first thumbnail in the new order.
4. Reload.

The trigger appears to be the main-canvas render racing the sequential
thumbnail painter over the *same* pdf.js page — after that reorder, the
selected page and the first thumbnail are the same source page. `boot()`
calls `renderThumbnails()` and then `renderMainCanvas()` without awaiting,
so the two run concurrently. `CLAUDE.md` already notes that concurrent
pdf.js renders are flaky, which is why `paintAllThumbs` awaits in a loop —
but the main canvas was never serialised against that loop.

It does not reproduce every time or from every starting state (a fresh
import with page 1 selected renders fine), which fits a race.

**Second trigger, found while adding the pen.** Anything that changes the
toolbar's height re-enters the same deadlock, because the `resize`
listener in `main.js` fires `renderMainCanvas()` while a render may
already be in flight. The pen's size presets were originally shown only
while the pen was active; toggling them wrapped the toolbar to two rows
at 1440px, and that reflow was enough to wedge the renderer — after
which the canvas kept its old size and the annotation layer kept its
pre-zoom coordinates, so nothing on the page was clickable any more.

Mitigated by making the pen size presets permanent toolbar furniture
(`app.css`, `.pen-dot`) so switching tools never reflows anything. That
removes the trigger, not the underlying race: **any** real resize — a
window drag, an orientation change — can still hit it.

**The concurrent-render theory is wrong — tried and disproved.** The
obvious fix was implemented and reverted: a promise chain keyed by
`sourceId:pageIndex`, taken by both `renderMainCanvas` and
`paintThumbCanvas`, so the two can never render the same page proxy at
once. The probe was unchanged with it in place:

```
getPage: resolved   thumbCanvases: 0   render: HUNG
```

So it is not two renders racing over one page. Serialising them only
makes the thumbnail loop queue up behind the main canvas, which is
itself already stuck — `thumbCanvases: 0` is a *consequence* of the main
render hanging, not independent evidence of a race.

What that leaves: the first `pjPage.render()` after a restore never
settles on its own, while `getPage` on the same document still answers.
Worth investigating next, roughly in order of cheapness —

1. Whether the RenderTask is being cancelled by the `activeRenderTask`
   cancel path just before it is awaited, so nothing ever settles it
   (add logging around `task.promise` and the cancel call).
2. Whether the restored `pdfjsDoc` is built on bytes another consumer
   has since detached — `getPage` resolving from cached structure would
   not prove the data is still there, but rasterising needs it.
3. Whether it reproduces with the thumbnail rail disabled entirely; if
   it does, the thumbnails are irrelevant and this note's title is
   wrong.

This touches the render core, so it wants `tests/run.sh` plus this suite
run before and after.
