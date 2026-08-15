# Hazard catalogue

Nine categories. Every example is a bug that actually shipped in this repo,
which is why they are here and generic lint rules are not.

Work down the list against the change under review. Most entries are
questions rather than rules — the answer is usually "not applicable", and
saying so is a result.

---

## 1. The event model

The richest source of bugs in this app, because the failures are silent.

- **`preventDefault()` on `pointerdown` suppresses the compatibility
  `mousedown`, and with it the focus change.** Drag-to-pan did this. An
  open note therefore never blurred: typing kept landing in the note you
  thought you had left, and every single-key shortcut stayed dead because
  `isTypingTarget` still saw a focused contenteditable. Nothing on screen
  said so. If you need to stop text selection during a drag, do it from
  `pointermove` once the drag is real, not from `pointerdown`.
- **A `click` still fires after your `pointerdown` handler acted on the
  press.** Selecting an ink stroke on `pointerdown` worked, then the
  trailing `click` bubbled to the layer handler and immediately deselected
  it. Ask what else is listening for the click that ends your gesture.
- **Pointer capture retargets the following `click` to the capturing
  element.** Capturing on every press broke click-to-deselect on a child.
  Capture only once movement passes the slop threshold.
- **`{ once: true }` listeners armed at the end of a gesture leak.** A
  drag ended by `pointercancel` never produces the click the listener was
  waiting for, so it sits armed and eats an unrelated click later. Prefer
  a flag cleared on the next press.
- **Filter `e.button`.** A right- or middle-click reaching the pen
  committed a permanent one-point dot on the way to the context menu.
- **Track `e.pointerId`.** A gesture must ignore movement from a pointer
  that is not its own.
- **`stopPropagation()` blocks more than you meant.** The pen's
  unconditional call prevented Space-drag panning while it was active —
  contradicting the comment that said panning always worked.

## 2. Latched and modal state

- What tells the user they are in this mode? A mode with no visible marker
  reads as a bug when the wheel or the cursor suddenly behaves differently.
  Wheel-zoom needed both a cursor change and a lit-up readout.
- How do they get out? Give at least two ways — the same gesture again,
  and `Esc`.
- What strands it? A `keyup` is delivered to whoever has focus, so
  switching apps mid-hold can leave a held-key mode stuck on forever.
  There is a `window.blur` reset in `view.js` for exactly this.
- Does a mode flag survive a reload when it should not? Transient mouse
  modes are deliberately excluded from the snapshot.

## 3. Cross-module invariants

- **Capture before you read.** `state` holds the *active* document; each
  tab's record is stale between switches. `snapshot()` calls
  `captureActiveDoc()` first, or the visible tab autosaves whatever it held
  at the last switch.
- **Caches keyed by ids that are not globally unique.** Page ids restart
  per document, and the thumbnail cache is keyed by page id — a tab switch
  must invalidate it or the new tab shows the old tab's pages.
- **Flags that must ride along in persistence.** `combined` marks a
  document with no single file to save back to. Left out of the snapshot, a
  restore hands it back its overwrite target and the data-loss bug returns.
- **A guard that runs per item must not undo itself.** `openFromHandle`
  runs once per handle in a multi-select; without a `!state.combined`
  check, the second file re-adopts a save target the first just gave up.

## 4. Destructive actions

**There is no undo in this app.** That raises the bar on anything that
discards work.

- `deletePage` and `clearAll` confirm. `deleteAnnotation` does not — a
  deliberate call, but revisit it if notes get more expensive to recreate.
- **Anything that writes to disk needs an unambiguous target.** ⌘S once
  overwrote the *first* file of a merged document with the merged result:
  no dialog, no warning, original gone. A document with no single source
  file must route to Save As.
- **Build the bytes before truncating the destination.** `createWritable`
  truncates on open, so a failed export after that point leaves the user's
  original at zero length. `writeToHandle` completes the export into
  memory first, on purpose.

## 5. The deploy contract

- **Bump `CACHE` in `sw.js`** whenever a precached file changes, or the
  installed app serves the previous version out of cache indefinitely.
- **Keep PRECACHE complete.** `js/tabs.js` shipped missing from it: fine
  online, dead offline. `cache.addAll` is atomic, so a listed-but-missing
  file is just as bad — it fails the whole install.
- Assets referenced only by string literal (`vendor/pdf.worker.min.js`) or
  only by the manifest (the maskable icons) are the ones that get
  forgotten, because no import mentions them.
- **All paths stay relative (`./`).** Pages serves from `/redline-pdf/`,
  so a root-absolute path works locally and 404s in production.

`tests/analyze.py` checks all four. Trust it over reading.

## 6. Test validity

- **Would this check pass for the same reason in real Chrome?** Headless
  has no browser zoom, so a Ctrl+wheel handler that wrongly let the event
  through still "scrolled" in the harness and would have zoomed the whole
  page for a real user. The check was green the entire time.
- **Is the assertion measuring the thing, or a proxy that happens to
  agree?** Prefer reading the exported PDF's content stream over counting
  pixels; prefer `getScreenCTM` over hand-rolled coordinate arithmetic that
  drifts the moment the stage scrolls.
- **Is the failure the harness's fault?** A stub that is not
  structured-cloneable, a screenshot taken after the state changed, a
  coordinate computed against a scrolled canvas — all produced convincing
  false findings here.
- **A red check can be an environment artifact, and the expensive one
  already happened.** Headless Chrome stops compositing an unattended page
  partway through a long run. `requestAnimationFrame` stops firing with
  it, and pdf.js continues multi-chunk canvas renders from rAF — so every
  render stalls forever while promises keep resolving, because microtasks
  do not need a frame. That looked exactly like an app-level render
  deadlock, and was treated as one for months: it shaped the pen's toolbar
  layout and pushed whole sections of the suite into a second browser
  instance. The tell was that `getOperatorList` resolved while a
  *throwaway* canvas would not paint. **Before theorising about any render
  stall, run it headful.** The suite defaults to a real window for this
  reason.
- New behaviour with no coverage is itself a finding.

## 7. Coordinate space

The rule `CLAUDE.md` calls the part that breaks if you are careless.

- Annotation coordinates are **visual** (origin top-left, y down, page
  already rotated). pdf-lib draws in **native** (origin bottom-left, y up,
  raw MediaBox, ignoring `/Rotate`).
- Every point handed to pdf-lib goes through `toNative`.
- Text alone gets `rotate: degrees(textCompensationDegrees(R))` — glyphs
  are the only thing with an inherent "up". Rectangles and lines never do.
- Do directional geometry in visual space; convert once, at the draw call.
- `page.rotation` is absolute. `setRotation()` overwrites, never adds.

Anything here without a matching case in `tests/run_geometry.mjs` or
`tests/run_rotate.mjs` is a finding — sign errors only show up at 90°/270°
and are miserable to spot by eye.

## 8. Persistence

- **Is everything structured-cloneable?** A plain object carrying methods
  is not, and the autosave fails silently with a console warning.
- **Is transient state leaking into the snapshot?** A `pointerId` used for
  drag bookkeeping reached the saved annotation before it was stripped.
- **Does a restore rebuild every derived object?** pdf.js detaches the
  ArrayBuffer it is handed, so each consumer needs its own `bytes.slice(0)`
  — including the restore path.
- **Schema changes need a fallback.** Snapshots written before tabs are
  read as a single-tab session rather than discarded.

## 9. Design, empathy, simplicity

- **Does the UI still tell the truth?** After the change, do the cursor,
  label, tooltip, status line — and the *comments* — still describe what
  happens? A grab cursor that does not grab is a lie; so was the comment
  claiming Space-pan worked while the pen swallowed it.
- **What happens the second time?** After a reload, a restore, a tab
  switch, a repeated gesture, a second file. Nearly every bug in this
  repo's recent history was a second-time bug, not a first-time one.
- **What happens on the phone?** Touch has no hover, the rail becomes a
  drawer, and iOS has neither the File System Access API nor file
  handlers. Does the feature degrade, or just break?
- **What happens offline?** It is an installable PWA; that is the point.
- **Is there less state that would do?** A derived value beats a stored
  one that can disagree. A field added to `state` should be per-document or
  app-wide by conscious decision — `tests/analyze.py` will refuse to guess
  for you.
- **Does this earn its complexity?** The tab feature swaps fields on
  `state` precisely so that four other modules did not have to change.
  Prefer the version that leaves the rest of the app alone.
