/* What Redline keeps between launches: a few preferences, and nothing
 * else. Documents close with the app.
 *
 * It used to keep the whole session — every open document, its bytes and
 * its file handle — in IndexedDB, written after each edit and again as
 * the window closed. That was dropped, for three reasons that all pointed
 * the same way:
 *
 *   - Nobody wanted it. Opening the app to find last week's drawing still
 *     there was a nuisance, not a feature.
 *   - It raced everything that arrives at launch. A PDF opened from Finder
 *     was overwritten by the restore finishing a moment later.
 *   - It crashed Chrome. With a file handle from the current session in
 *     the saved snapshot — a dropped file, or one opened from Finder —
 *     Chrome 154 died at exit on a fatal check in its own code ("dangling
 *     raw_ptr in unretained"), and a launch that landed on the dying
 *     process got an app with no window. In a clean profile: 2 crashes in
 *     2 quits with session saving, none in 4 without. See hazards.md §8.
 *
 * So nothing is written at unload beyond one short string, and a file
 * handle never goes anywhere near storage.
 */
import { state, COLORS, PEN_SIZES } from './state.js';

const KEY = 'redline.prefs';

/** Apply stored preferences to `state`. Call before the toolbar is built,
 *  so it is built from them. Anything unreadable is simply ignored. */
export function loadPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* corrupt or blocked */ }
  if (!p || typeof p !== 'object') return;

  // The fit mode is a preference; a zoom level is not. It belonged to a
  // document that is gone, and would open the next one at 600%.
  if (p.fitMode === 'fit-width' || p.fitMode === 'fit-page') {
    state.lastFitMode = p.fitMode;
    state.zoomMode = p.fitMode;
  }
  if (COLORS.includes(p.color)) state.currentColor = p.color;
  if (Number.isFinite(p.fontSize) && p.fontSize >= 4 && p.fontSize <= 144) state.currentFontSize = p.fontSize;
  if (PEN_SIZES.some((s) => s.width === p.penSize)) state.currentPenSize = p.penSize;
}

function savePrefs() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      fitMode: state.lastFitMode,
      color: state.currentColor,
      fontSize: state.currentFontSize,
      penSize: state.currentPenSize,
    }));
  } catch { /* private mode, storage full: preferences are not worth an error */ }
}

/** Save on the way out. visibilitychange is the one that fires reliably
 *  on iOS; pagehide covers desktop closes. */
export function installPrefSaving() {
  window.addEventListener('pagehide', savePrefs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePrefs();
  });
}

/** Delete the session database older versions left behind. It can hold
 *  hundreds of megabytes of PDFs nobody will ever read back. */
export function forgetSavedSession() {
  try { indexedDB.deleteDatabase('redline'); } catch { /* no IndexedDB here */ }
}
