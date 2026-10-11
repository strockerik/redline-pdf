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
- **A tool is used once, then goes back to Select** — the pen included.
  (Rev 0.20 had every tool stay armed; the owner reversed it in 0.24.)
  The trap is the click that *ends* the gesture: by the time it arrives
  the tool is already Select, where a click on bare page means
  "deselect" — so the markup just drawn, which is left selected on
  purpose, would be deselected by its own mouse-up. `swallowClick` in
  annots.js is the guard; `wasEditing` is its sibling for a click that
  only ends typing. A new tool needs to honour both.
- **Controls that come and go must not move the page.** The properties
  row shows only what applies to the tool in hand, in a row of fixed
  height. The same controls in a toolbar that grew resized the stage, and
  that resize raced the thumbnail painter. The browser suite pins the
  heights before and after arming a tool.

## 3. Cross-module invariants

- **Capture before you read.** `state` holds the *active* document; each
  tab's record is stale between switches. Anything that walks `state.docs`
  must take the active one's name and pages from `state`, or call
  `captureActiveDoc()` first. The browser suite's own helper got this
  wrong and reported a correctly opened file as "Untitled.pdf".
- **Caches keyed by ids that are not globally unique.** Page ids restart
  per document, and the thumbnail cache was keyed by page id — so it had
  to be flushed on every path that replaces the live document, and one
  was missed twice: opening in a new tab, and (when sessions were saved) a
  restore landing on top of a file opened from Finder, which left that
  file's thumbnail on page 1 of a different document. It is keyed by the
  page object now.
  Prefer identity to an id plus a flush you have to remember.
- **Two things written to `state` during boot.** The launch handler and
  the session restore were both asynchronous and both replaced the live
  document. Whichever finished second won: the double-clicked file was
  either overwritten or merged into the session. The restore is gone, but
  the rule stands — anything that can arrive before boot is over must wait
  for it (`booted` in main.js).
- **Two canvases can be showing the page.** Heavy vector pages are drawn
  by WebGL into `#plotCanvas`; `#pageCanvas` stays in the layout at full
  size because annots.js measures against it, but is blank. Anything that
  reads pixels, or assumes the page canvas's backing store is the page,
  needs to ask which one is live (`shownPlotImage` in view.js).
- **A guard that runs per item must not undo itself.** Opening runs once
  per handle in a multi-select; the second file must not re-adopt a save
  target the first just gave up. `importPdfBytes` decides in one place:
  a file landing in an *empty* document becomes it (name, handle, clean,
  history starts here); landing among pages it is an edit, and no handle
  is adopted.
- **Checkpoint before you change the document.** Undo is a snapshot taken
  *before* each change (`checkpoint` in history.js). A mutation with no
  checkpoint is not just un-undoable — the next undo silently takes it
  away along with the step before it. Drags checkpoint on first movement,
  not on press, so a click leaves nothing to undo.
- **Finish typing before swapping what is on screen.** A note's text is
  taken on blur, and a note removed from the DOM while focused may never
  get one — or gets it late, when another document is active, and commits
  there. `finishTyping()` runs before a page change, a tab change, and a
  step through history. `hold()` also remembers its document, so a late
  commit still lands on the right stack.
- **Identity, again.** Markup ids restart per document just as page ids
  do; the set of freshly placed notes is a WeakSet of objects for the same
  reason the thumbnail cache is keyed by page object. And undo hands back
  the *same* page objects, so nothing cached against them is rebuilt.

## 4. Destructive actions

**Undo is the safety net, so there are no "are you sure?" dialogs** on
anything it covers: page delete, Clear All and markup delete all just
happen, and say that ⌘Z brings it back. A confirm is still right for what
undo cannot reach — closing a tab or the window with unsaved work.

- **"Saved" has to be true.** The save chip and the close-guard read
  `state.dirty`, which undo and redo recompute from how far the document
  is from its last save. The trap: undo past a save, then make a new edit.
  The saved state was on the redo side, which is now gone, so no amount of
  undoing may report clean again (`adrift` in history.js).
- **Undo may change the document, never which file ⌘S writes.** A
  checkpoint holds the name and file handle, because undoing a merge has
  to bring them back. Rev 0.20 shipped with the consequence nobody traced:
  open A, mark up, Save As B, mark up, undo twice — the second undo
  restored a checkpoint from before the Save As, and with it A's handle.
  ⌘S then overwrote A with a half-undone document. The only sign was the
  title changing, which looks like undo doing its job. A successful save
  now rewrites the name and handle in every checkpoint on both stacks
  (`noteClean` in history.js). Anything else that changes a document's
  identity outside a checkpointed action owes the stacks the same.
- **A failed save must not fade.** It raises `#saveAlert`, which stays
  until dismissed or a save succeeds, says the work is still open, and
  offers Save As and Download. Never route a save failure to `setStatus`.
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
- **Bump the build stamp with it.** `#buildStamp` in index.html shows
  `rev 0.N · date · what changed` in the footer, the same number CACHE
  carries. A deploy raises N by one; the 0 changes only on the owner's word.
  It is how a stale installed copy is told from a current one, so a stamp
  left behind is worse than none.
- **A cache must contain the build it is named for.** Rev 0.24's worker
  filled its cache with `cache.addAll`, which is answered by whatever
  copy is nearest — the browser's HTTP cache or the host's CDN, both of
  which hold a file for ten minutes. A Chrome that was open as the deploy
  landed installed the new worker inside that window and stored 0.23's
  files in a cache called v0.24. Cache-first, it then served 0.23 for
  good: the worker script was already current, so nothing ever triggered
  another install. Safari, opened later, was fine — which is what made it
  look like a browser problem. `precache()` in sw.js now fetches every
  file with `no-store` and the build number in the query, and refuses to
  install if the page that comes back does not carry its own stamp.
  `tests/run_sw.mjs` pins all three. Related: checking a deploy with
  `curl …?t=123` goes round the CDN too, so it says "live" before the
  plain URLs are.
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
- **A WebGL canvas cannot be read back after the frame it was drawn in.**
  `drawImage` or `getImageData` on it later returns blank, which reads as
  "nothing rendered". Render again into a framebuffer and read that.
- **Is the fixture what you think it is?** The heavy-page fixture was
  meant to be 215,000 strokes and is — but only 3,780 distinct ones, the
  rest drawn on top of each other. A "page is dark" threshold tuned
  against one renderer failed against another that was drawing it
  correctly.
- **Can this suite fail?** Four of the JavaScriptCore suites printed
  `FAIL` and exited 0, so `run.sh` reported "All suites passed" over real
  failures. A check that cannot turn the run red is a comment.
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

## 7a. Markups in the saved file

- **One drawing routine, two destinations.** A markup's annotation
  appearance and its flattened form both come from
  `drawAnnotationOnPage`. A fix made to one that does not reach the other
  means a note that changes shape when flattened.
- **Rect and BBox are the same box.** The appearance stream is in page
  coordinates and its BBox equals the annotation's Rect, so a viewer maps
  one onto the other as the identity. Pad the Rect without the BBox, or
  the reverse, and every viewer scales the markup slightly.
- **Take them out on the way in.** A Redline annotation left in the
  loaded document is drawn by pdf.js *under* the editable copy — invisible
  until the copy is moved or deleted and a ghost stays behind — and is
  written a second time on save. pdf.js must be given the document
  re-serialised after `takeMarkups`, not the original bytes.
- **The payload is untrusted.** `/RedlineMarkup` arrives in a file anyone
  could have made. Colours go into `style`, numbers into geometry; a new
  field needs a check in `readPayload`, and an unreadable markup is left
  in the file, not deleted.
- **Flatten must never be the only copy.** It saves elsewhere and leaves
  the open document, its name and its save target alone.

## 8. Persistence

There is almost none, on purpose. Documents close with the app; every
launch starts empty; `persist.js` keeps four preferences in localStorage.

- **Do not bring back the saved session.** It existed (IndexedDB, every
  open document with its bytes and file handle, rewritten after each edit
  and again as the window closed) and it was removed for cause:
  - it reopened drawings nobody wanted reopened;
  - it raced whatever arrived at launch (see §3);
  - **it crashed Chrome.** With a `FileSystemFileHandle` from the current
    session in the snapshot — a dropped file, a file opened from Finder —
    Chrome 154 hit a fatal check in its own code at exit (`Detected
    dangling raw_ptr in unretained`, browser process, `shutdown-type:
    close`). The crash itself is invisible, but a launch that lands while
    that Chrome is dying leaves the app running with no window, which the
    user reported as "Redline isn't opening". Measured in a clean profile:
    2 crashes in 2 quits with session saving, 0 in 4 without. A bare page
    that stored a handle mid-session and then sat idle did *not* crash, so
    the write on the way out is the likely trigger; that last step is
    inference, not measurement.
- **A file handle never goes into storage,** and nothing but one short
  string is written at unload. If a feature seems to need either, it
  needs a different design.
- **Is transient state leaking into what is kept?** Preferences only. A
  zoom level is not one — it belonged to a document that is gone, and
  restoring it opened the next file at 600%.
- **The guard has to cover every tab.** It once looked only at the
  active document, so notes in a background tab went with the window and
  nothing said so. While sessions were saved that was survivable; once
  they were not, it was plain data loss.
- **Unsaved work has one guard: `beforeunload`.** It prompts on desktop.
  iOS shows no such prompt and evicts backgrounded web apps without
  warning, so on a phone unsaved notes can be lost. That trade was made
  knowingly.
- **pdf.js detaches the ArrayBuffer it is handed,** so each consumer needs
  its own `bytes.slice(0)`.

## 9. Design, empathy, simplicity

- **Does the UI still tell the truth?** After the change, do the cursor,
  label, tooltip, status line — and the *comments* — still describe what
  happens? A grab cursor that does not grab is a lie; so was the comment
  claiming Space-pan worked while the pen swallowed it.
- **What happens the second time?** After a reload, a relaunch, a tab
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
