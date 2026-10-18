/* Bootstrap: wire the DOM to the modules and boot the app. */
import { state, setStatus, onDirtyChange, activeDoc } from './state.js';
import {
  renderThumbnails, renderMainCanvas, updateToolbarState, updateTitle,
  installStageGestures, installThumbReorder,
  setZoomMode, zoomStep, setZoomLevel, setWheelZoom, isTypingTarget,
} from './view.js';
import {
  importPdfFile, addBlankPage, deletePage, rotatePage, reorderPage,
  selectPage, stepPage, clearAll,
} from './pages.js';
import {
  setActiveTool, handleLayerClick, deleteAnnotation, deselectAnnotation,
  installDrawing, duplicateSelected, copySelected, pasteMarkup,
} from './annots.js';
import {
  installChrome, doUndo, doRedo, dismissOverlays, openShortcuts, closePagesDrawer,
} from './chrome.js';
import {
  installLaunchHandler, installDragAndDrop, openViaPicker,
  openViaPickerInTabs, openInTabs, takeInputMode,
  save, saveAs, saveFlattenedCopy, downloadCopy, canUseFileSystemAccess,
} from './files.js';
import {
  installTabs, ensureInitialDoc, openDocument, renderTabs, refreshActiveTab,
} from './tabs.js';
import { loadPrefs, installPrefSaving, forgetSavedSession } from './persist.js';

const $ = (id) => document.getElementById(id);

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';

// ============================================================
// Keyboard
// ============================================================
const TOOL_KEYS = {
  v: 'select', t: 'text', q: 'callout', l: 'callout', p: 'pen',
  h: 'highlight', a: 'arrow', r: 'rect', c: 'cloud',
};
const TOOL_BUTTONS = {
  toolSelect: 'select', toolText: 'text', toolCallout: 'callout', toolPen: 'pen',
  toolHighlight: 'highlight', toolArrow: 'arrow', toolRect: 'rect', toolCloud: 'cloud',
};

/** A tool stays armed until it is put away. Picking the one already in
 *  hand is one way to do that; Esc and Select are the others. */
function toggleTool(tool) {
  setActiveTool(state.activeTool === tool ? 'select' : tool);
}

function installKeyboard() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    // Save must run from the keystroke itself: the write-permission
    // prompt is only allowed while the user gesture is still live.
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      e.shiftKey ? saveAs() : save();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      e.shiftKey ? openViaPickerInTabs() : openViaPicker();
      return;
    }
    if (mod && e.key.toLowerCase() === 't') {
      e.preventDefault();
      openDocument();
      updateTitle();
      renderThumbnails();
      renderMainCanvas();
      return;
    }

    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (mod && e.key === '0') { e.preventDefault(); setZoomMode('fit-width'); return; }
    if (mod && e.key === '9') { e.preventDefault(); setZoomMode('fit-page'); return; }

    if (isTypingTarget(e.target) && e.key !== 'Escape') return;
    // Past this point nothing is being typed into, so these belong to the
    // document. Inside a note, ⌘Z and ⌘C/⌘V are the browser's own.
    if ($('shortcutsDialog').open) return;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if (mod && key === 'y') { e.preventDefault(); doRedo(); return; }
    if (mod && key === 'd') {
      // Always claimed: letting it through would open the bookmark sheet.
      e.preventDefault();
      if (!duplicateSelected()) setStatus('Select a markup to duplicate it.');
      return;
    }
    if (mod && key === 'c') {
      // Only when there is a markup to copy and no text selected — a
      // selection anywhere on the page is still the browser's to copy.
      if (state.selectedAnnoId && !String(window.getSelection?.() || '') && copySelected()) {
        e.preventDefault();
        setStatus(`Copied. ${e.metaKey ? '⌘' : 'Ctrl+'}V pastes it on whichever page is showing.`, 'ok');
      }
      return;
    }
    if (mod && key === 'v') {
      if (pasteMarkup()) e.preventDefault();
      return;
    }

    if (e.key === 'Escape') {
      if (dismissOverlays()) return;
      setWheelZoom(false);
      setActiveTool('select');
      document.querySelectorAll('.anno-text').forEach((n) => n.blur());
      deselectAnnotation();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAnnoId) {
      e.preventDefault();
      const page = state.pages.find((p) => p.id === state.selectedPageId);
      if (page) deleteAnnotation(page, state.selectedAnnoId);
      return;
    }
    // Single-key tool shortcuts only. Without this, ⌘P switched to the pen
    // on the way to the print dialog, and ⌘Q/⌃T likewise picked up a tool.
    if (mod || e.altKey) return;

    if (e.key === '?') { openShortcuts(); return; }
    // Q is the documented callout shortcut; L still works out of habit.
    const tool = TOOL_KEYS[key];
    if (tool && state.selectedPageId) toggleTool(tool);
    // Page navigation
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
      if (stepPage(dir)) e.preventDefault();
    }
  });
}

// ============================================================
// Service worker
// ============================================================
function installServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;   // SW requires http(s)

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        // A new worker taking over while an old one was already
        // controlling means the cached app just changed under us.
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          $('updateBanner').classList.add('show');
        }
      });
    });
    // The browser only looks for a new build when the app is launched or
    // reloaded. An installed app is often left open for days, so look
    // again whenever its window comes back to the front.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => { /* offline */ });
    });
  }).catch((err) => console.warn('service worker registration failed', err));

  $('btnReload').addEventListener('click', () => location.reload());
}

// ============================================================
// Wire-up
// ============================================================
function wireUi() {
  // --- Open ---
  $('btnOpen').addEventListener('click', openViaPicker);
  $('btnEmptyOpen').addEventListener('click', openViaPicker);
  $('btnOpenTabs').addEventListener('click', openViaPickerInTabs);
  $('fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    // The same input serves both open modes; whichever asked for it says so.
    if (takeInputMode() === 'tabs') {
      await openInTabs(files.map((file) => ({ file })));
    } else {
      const into = activeDoc();
      for (const f of files) await importPdfFile(f, { into });
    }
  });

  // --- Save ---
  $('btnSave').addEventListener('click', save);
  $('btnSaveAs').addEventListener('click', saveAs);
  $('btnDownload').addEventListener('click', downloadCopy);
  $('btnFlatten').addEventListener('click', saveFlattenedCopy);
  // Where there's no save panel, Save *is* a download, and Save As and
  // Download would be two more names for it.
  if (!canUseFileSystemAccess) {
    $('btnSaveAs').hidden = true;
    $('btnDownload').hidden = true;
    $('btnSave').dataset.tip = 'Downloads the edited PDF — this browser has no save panel. Markups stay editable.';
  }

  // --- Pages ---
  $('btnAddBlank').addEventListener('click', () => addBlankPage($('blankSizeSelect').value));
  $('btnRotateCCW').addEventListener('click', () => {
    if (state.selectedPageId) rotatePage(state.selectedPageId, -90);
  });
  $('btnRotateCW').addEventListener('click', () => {
    if (state.selectedPageId) rotatePage(state.selectedPageId, 90);
  });
  $('btnDeletePage').addEventListener('click', () => {
    if (state.selectedPageId) deletePage(state.selectedPageId);
  });

  $('btnClearAll').addEventListener('click', () => {
    // Clear All empties *this* document. The other tabs are not its to touch.
    if (!clearAll()) return;
    renderTabs();
    updateTitle();
    renderThumbnails();
    renderMainCanvas();
  });

  installThumbReorder(
    (movedId, targetId, before) => reorderPage(movedId, targetId, before),
    (pageId) => { selectPage(pageId); closePagesDrawer(); },
    (pageId, delta) => rotatePage(pageId, delta),
    (pageId) => deletePage(pageId),
  );

  // --- Tools ---
  for (const [id, tool] of Object.entries(TOOL_BUTTONS)) {
    $(id).addEventListener('click', () => toggleTool(tool));
  }
  $('annoLayer').addEventListener('click', handleLayerClick);
  installDrawing();
  installChrome();

  // --- Zoom ---
  $('btnZoomIn').addEventListener('click', () => zoomStep(1));
  $('btnZoomOut').addEventListener('click', () => zoomStep(-1));
  $('btnFitWidth').addEventListener('click', () => setZoomMode('fit-width'));
  $('btnFitPage').addEventListener('click', () => setZoomMode('fit-page'));
  $('zoomReadout').addEventListener('click', () => setZoomLevel(1));

  installStageGestures(stepPage);
  installTabs();
  installDragAndDrop();
  installLaunchHandler(booted);
  installKeyboard();
  installPrefSaving();
  installServiceWorker();

  // Re-fit on resize (and on orientation change, which fires resize).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderMainCanvas(), 120);
  });

  // The title dot and the tab's dot both hang off the dirty flag.
  onDirtyChange(() => {
    updateTitle();
    refreshActiveTab();
  });

  // Every open document, not only the one on screen. Nothing is kept
  // between launches, so this prompt is all that stands between a
  // background tab's unsaved notes and the window closing on them. The
  // active document's truth is in `state`; the others' is in their records.
  window.addEventListener('beforeunload', (e) => {
    const unsaved = (state.dirty && state.pages.length > 0)
      || state.docs.some((d) => d.id !== state.activeDocId && d.dirty && d.pages.length > 0);
    if (!unsaved) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ============================================================
// Boot
// ============================================================
// Resolved once boot has finished. Anything that arrives from outside in
// the meantime — a file from Finder — waits on it rather than writing to
// `state` while boot is still setting it up.
let bootDone;
const booted = new Promise((resolve) => { bootDone = resolve; });

async function boot() {
  // Before the toolbar exists, so that it is built from them.
  loadPrefs();
  wireUi();
  setActiveTool('select');
  updateTitle();
  updateToolbarState();
  // One stamp in index.html, shown in two places.
  $('emptyStamp').textContent = $('buildStamp').textContent;

  if (new URLSearchParams(location.search).has('selftest')) {
    const { runRotMathTests } = await import('./rotmath.test.js');
    const r = runRotMathTests();
    setStatus(
      r.failed ? `Self-test: ${r.failed} FAILED (see console)` : `Self-test: ${r.total} passed ✓`,
      r.failed ? 'err' : 'ok'
    );
  }

  // Every launch starts empty: documents close with the app (persist.js).
  forgetSavedSession();
  ensureInitialDoc();
  renderTabs();
  renderThumbnails();
  renderMainCanvas();
}

boot().finally(bootDone);
