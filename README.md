# Redline

A small PDF markup tool — page assembly and text notes, the handful of
Bluebeam features worth having on a phone and in a dock icon.

Everything runs on your device. Nothing is uploaded, there is no backend,
and it works with no network connection once installed.

**Live:** https://strockerik.github.io/redline/

---

## What it does

- **Assemble** — open one or more PDFs, insert blank pages (Letter /
  Legal / A4 / Tabloid), reorder by dragging thumbnails, rotate, delete.
- **Mark up** — plain text boxes, and text boxes with a leader line
  pointing at something. Five colors, six sizes.
- **Zoom** — fit width, fit page, 25–600% in steps, pinch on trackpad
  and touchscreen.
- **Save** — write back over the file you opened (⌘S), or save a copy
  somewhere else (⇧⌘S).
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
| ⌘O | Open |
| ⌘S | Save over the opened file |
| ⇧⌘S | Save As |
| ⌘+ / ⌘− | Zoom in / out |
| ⌘0 / ⌘9 | Fit width / fit page |
| T / L | Text box / text with leader |
| Esc | Cancel tool, deselect |
| Delete | Delete selected note |
| ← → ↑ ↓ | Previous / next page |
| Space + drag | Pan |

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
tests/run.sh
```

Runs under JavaScriptCore, which ships with macOS — no node, no
install. It covers the parts that are painful to verify by eye:

- the visual ↔ native coordinate round-trip for all four rotations
- where annotation rectangles, text baselines and leader lines actually
  land in native PDF space at each rotation
- that rotating a page carries its annotations along, reversibly and
  without accumulating drift
- export: page counts, rotations, duplicated source pages, blank pages,
  non-WinAnsi characters, and that batched `copyPages` really is smaller
  than copying per page

Rendering, gestures and DOM interaction are not covered and still need a
browser. `?selftest` in the URL runs the rotation-math suite in-page and
reports to the console.

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

All paths are relative (`./`) because Pages serves from `/redline/`, not
the domain root.
