# Redline — notes for Claude Code

A personal PDF markup tool: page assembly plus text notes. Installable
PWA, hosted on GitHub Pages, runs entirely client-side.

- **Live:** https://strockerik.github.io/redline-pdf/
- **Repo:** https://github.com/strockerik/redline-pdf (public, Pages from `main` / root)

## Commands

```sh
python3 -m http.server 8000     # must be http — ES modules and service
                                # workers do not run from file://
tests/run.sh                    # 78 checks under JavaScriptCore (ships
                                # with macOS; no node, no npm)
```

There is no build step and no package.json. Deliberate — see below.

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
js/main.js      wiring and boot
```

`view.js` and `annots.js` import each other. That cycle is fine because
nothing runs at module-evaluation time — but don't add top-level side
effects to either.

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
- **Bump `CACHE` in `sw.js` on every deploy.** Otherwise the installed
  app keeps serving the previous version from cache.
- **All paths must stay relative (`./`).** Pages serves from
  `/redline-pdf/`, so an absolute `/js/...` works locally and 404s in
  production.
- **Render thumbnails sequentially.** Concurrent pdf.js renders are
  flaky; `paintAllThumbs` awaits in a loop on purpose.
- **`renderMainCanvas` cancels the previous RenderTask** and guards with
  a token. pdf.js rejects two renders against one canvas.
- Canvas backing store is at `scale * devicePixelRatio`; layout stays in
  logical px so the overlay's `pt * currentScale` math is unaffected.

## Platform constraints

Finder double-click and the native save panel need `file_handlers` and
the File System Access API — **Chromium only**. Safari implements
neither, so the Mac install path is Chrome, not Safari "Add to Dock".
iOS gets the download fallback. Don't "fix" this by reaching for Safari.

macOS assigns `.pdf` to Preview; making double-click reach Redline
requires Get Info → Open with → Change All once, from Finder. No
app-side code can override it.

## Scope

Deferred, by decision: highlight / ink / arrow / shape tools, undo-redo,
multi-select, text search. The module split is what makes adding them a
contained change.
