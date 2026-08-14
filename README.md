# Redline

A small PDF markup tool — page assembly and text notes, the handful of
Bluebeam features worth having on a phone and in a dock icon.

Everything runs on your device. Nothing is uploaded, there is no backend,
and it works with no network connection once installed.

**Live:** https://strockerik.github.io/redline-pdf/

---

## What it does

- **Assemble** — open one or more PDFs, insert blank pages (Letter /
  Legal / A4 / Tabloid), reorder by dragging thumbnails, rotate, delete.
- **Tabs** — **Open** merges the files you pick into the current
  document; **Open in Tabs…** (⇧⌘O) gives each its own tab instead, with
  its own pages, notes and save target. ⌘T opens an empty one. The strip
  appears only once a second document is open.
- **Mark up** — plain text boxes, text boxes with a leader line pointing
  at something, and a freehand pen. Five colors, six text sizes, three
  pen widths.
- **Zoom** — fit width, fit page, 25–600% in steps, pinch on trackpad
  and touchscreen.
- **Save** — write back over the file you opened (⌘S), or save a copy
  somewhere else (⇧⌘S). Opening a second file merges it in, and a merged
  document has no single file to save back to, so ⌘S asks where to put
  it rather than overwriting whichever file happened to be first.
- **Autosave** — the session is kept in IndexedDB, so closing the window
  or having iOS evict the app doesn't lose work.

## Install

**Mac (Chrome).** Open the live URL, then **Install Redline** from the
address-bar icon or the ⋮ menu. You get a standalone window, a dock
icon, and offline use.

To make Finder double-click open PDFs in Redline: select any PDF →
**Get Info** → **Open with: Redline** → **Change All…** once. macOS gives
`.pdf` to Preview by default and nothing in the app can override that —
it has to be set from Finder.

> Chrome specifically, not Safari. Safari implements neither the file
> handler nor the save panel, so "Add to Dock" there gives you a nice
> window with no double-click-to-open and downloads instead of saves.

**iPhone (Safari).** Open the URL → Share → **Add to Home Screen**. No
file handler on iOS; open PDFs through the Open button or the share
sheet, and saving downloads to the Files app.

## Keyboard

| | |
|---|---|
| ⌘O / ⇧⌘O | Open merged / open in tabs |
| ⌘T | New tab |
| ⌘S | Save over the opened file |
| ⇧⌘S | Save As |
| ⌘+ / ⌘− | Zoom in / out |
| ⌘0 / ⌘9 | Fit width / fit page |
| T / Q | Text box / text with leader |
| P | Pen (freehand) |
| Esc | Cancel tool, deselect |
| Delete | Delete selected note |
| ← → ↑ ↓ | Previous / next page |
| double-click | Latch the wheel into zoom (Esc or double-click to exit) |
| drag | Pan the page (default) |
| Space + drag | Pan without leaving the current tool |

`L` still works as an alias for `Q`.

## Scrolling

**Double-click the page** to latch the wheel into zooming — Bluebeam's
dynamic zoom. The cursor turns into a magnifier and the percentage
readout lights up while it is on; Ctrl+wheel still scrolls, so a
zoomed-in page stays navigable. Double-click again or press Esc to
leave. It is a transient mouse mode, so it does not survive a reload.

Otherwise the **Fit W** / **Fit Pg** buttons choose what the scroll wheel does:

| | wheel | Ctrl + wheel |
|---|---|---|
| **Fit Pg** | previous / next page | zoom |
| **Fit W** | zoom | scroll the page |

⌘ + wheel always zooms, in either mode. A trackpad pinch always zooms too —
it arrives as a Ctrl+wheel but is told apart from the real key, so
pinch-to-zoom still works in Fit W where Ctrl+wheel scrolls.

The choice sticks until you press the other button. Zooming drops you out of
the fit itself (the button stops being lit), but the wheel keeps behaving the
way you picked — otherwise one notch of wheel-zoom in Fit W would silently
change what the wheel does next.

## Development

No build step, no npm. The app is plain ES modules and the two PDF
libraries are vendored in `vendor/`.

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

It has to be served over http — ES modules and service workers don't run
from `file://`.

```
index.html              markup and module bootstrap
app.css                 all styles
js/state.js             data model, rotation math, shared state
js/files.js             open / save / file-handler launch queue
js/persist.js           IndexedDB autosave and restore
js/pages.js             import, blank pages, delete, rotate, reorder
js/view.js              page canvas, zoom, thumbnails, reorder gesture
js/annots.js            text box + callout tools, pointer interactions
js/export.js            pdf-lib output
js/main.js              wiring and boot
vendor/                 pdf-lib 1.17.1, pdf.js 3.11.174 (pinned)
tests/                  headless checks — see below
docs/build-guide.md     the original design spec
```

### Tests

```sh
tests/run.sh        # unit — JavaScriptCore, ships with macOS
tests/analyze.py    # static — Python 3, stdlib only
```

`run.sh` needs no install at all. `analyze.py` reads the source rather
than running it, and catches the class of mistake a behavioural test
cannot see: import cycles, exports nobody imports, DOM ids that do not
exist, root-absolute paths that would 404 on Pages, files missing from the
service worker's precache list, and `state` fields that would leak from
one document tab into another. It covers the parts that are painful to verify by eye:

- the visual ↔ native coordinate round-trip for all four rotations
- where annotation rectangles, text baselines and leader lines actually
  land in native PDF space at each rotation
- that rotating a page carries its annotations along, reversibly and
  without accumulating drift
- export: page counts, rotations, duplicated source pages, blank pages,
  non-WinAnsi characters, and that batched `copyPages` really is smaller
  than copying per page

`?selftest` in the URL runs the rotation-math suite in-page and reports to
the console.

Rendering, gestures and DOM interaction need a real browser:

```sh
tests/browser/run.sh            # add --headful to watch it
```

Checks driving headless Chrome over the DevTools Protocol — boot, import,
rasterisation, zoom, rotate, drag-reorder, the wheel modes, tool shortcuts,
save (⇧⌘S then ⌘S) and session restore, with screenshots at each stage in
`tests/browser/shots/`. Needs Chrome and stdlib Python; no node, no npm. The
only stubbed seam is `showSaveFilePicker`, so the export still runs for real
and the bytes are reopened with pdf.js to prove they parse.

One check is currently red against a known pre-existing bug — see
`tests/browser/KNOWN-ISSUES.md`.

### The one genuinely hard part

Annotation coordinates live in "visual" space (what you see: origin
top-left, y down, page already rotated). pdf-lib draws in "native" space
(origin bottom-left, y up, raw MediaBox, *ignoring* `/Rotate`). Every
point handed to pdf-lib goes through `toNative`, and text additionally
gets a counter-rotation so glyphs read upright after a viewer applies
the page's own rotation.

Do all directional geometry — arrowhead angles, which edge a leader
attaches to — in visual space, where it's ordinary 2D math. Convert only
at the final draw call. `docs/build-guide.md` §3 has the full reasoning.

### Deploying

Push to `main`; GitHub Pages serves the repo root. Bump `CACHE` in
`sw.js` on every deploy or the service worker will keep serving the old
version.

All paths are relative (`./`) because Pages serves from `/redline-pdf/`, not
the domain root.
