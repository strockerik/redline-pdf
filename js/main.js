/* Bootstrap: wire the DOM to the modules and boot the app. */
import {
  state, COLORS, resetDocument, setStatus, onDirtyChange,
} from './state.js';
import {
  renderThumbnails, renderMainCanvas, updateToolbarState, updateTitle,
  installStageGestures, installThumbReorder, invalidateAllThumbs,
  setZoomMode, zoomStep, setZoomLevel, isTypingTarget,
} from './view.js';
import {
  importPdfFile, addBlankPage, deletePage, rotatePage, reorderPage,
  selectPage, clearAll,
} from './pages.js';
import {
  setActiveTool, handleLayerClick, deleteAnnotation, deselectAnnotation,
  applyAnnoStyle,
} from './annots.js';
import {
  installLaunchHandler, installDragAndDrop, openViaPicker,
  save, saveAs, downloadCopy, canUseFileSystemAccess,
} from './files.js';
import {
  scheduleSave, clearSession, loadSession, restoreSession,
  installAutosaveTriggers,
} from './persist.js';

const $ = (id) => document.getElementById(id);

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js';

// ============================================================
// Toolbar: colors and font size
// ============================================================
function buildColorSwatches() {
  const grp = $('colorGrp');
  for (const c of COLORS) {
    const sw = document.createElement('button');
    sw.className = 'swatch' + (c === state.currentColor ? ' selected' : '');
    sw.style.background = c;
    sw.title = c;
    sw.setAttribute('aria-label', `Color ${c}`);
    sw.addEventListener('click', () => {
      applyAnnoStyle({ color: c });
      grp.querySelectorAll('.swatch').forEach((n) => n.classList.remove('selected'));
      sw.classList.add('selected');
    });
    grp.appendChild(sw);
  }
}

// ============================================================
// Pages drawer (narrow screens)
// ============================================================
function installPagesDrawer() {
  const sidebar = $('sidebar');
  const toggle = $('btnPages');
  const scrim = $('drawerScrim');

  const close = () => {
    sidebar.classList.remove('open');
    scrim.classList.remove('show');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('open');
    scrim.classList.toggle('show', open);
    toggle.setAttribute('aria-expanded', String(open));
  });
  scrim.addEventListener('click', close);
  return { close };
}

// ============================================================
// Keyboard
// ============================================================
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
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openViaPicker(); return; }

    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomStep(1); return; }
    if (mod && e.key === '-') { e.preventDefault(); zoomStep(-1); return; }
    if (mod && e.key === '0') { e.preventDefault(); setZoomMode('fit-width'); return; }
    if (mod && e.key === '9') { e.preventDefault(); setZoomMode('fit-page'); return; }

    if (isTypingTarget(e.target) && e.key !== 'Escape') return;

    if (e.key === 'Escape') {
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
    if (e.key === 't' || e.key === 'T') {
      setActiveTool(state.activeTool === 'text' ? 'select' : 'text');
    }
    if (e.key === 'l' || e.key === 'L') {
      setActiveTool(state.activeTool === 'callout' ? 'select' : 'callout');
    }
    // Page navigation
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' ||
        e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      const idx = state.pages.findIndex((p) => p.id === state.selectedPageId);
      if (idx < 0) return;
      const dir = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
      const next = state.pages[idx + dir];
      if (next) { e.preventDefault(); selectPage(next.id); }
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
  }).catch((err) => console.warn('service worker registration failed', err));

  $('btnReload').addEventListener('click', () => location.reload());
}

// ============================================================
// Wire-up
// ============================================================
function wireUi() {
  const drawer = installPagesDrawer();

  buildColorSwatches();
  $('fontSizeSelect').value = String(state.currentFontSize);
  $('fontSizeSelect').addEventListener('change', (e) => {
    applyAnnoStyle({ fontSize: parseInt(e.target.value, 10) });
  });

  // --- Open ---
  $('btnOpen').addEventListener('click', openViaPicker);
  $('fileInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) await importPdfFile(f);
    e.target.value = '';
  });

  // --- Save ---
  $('btnSave').addEventListener('click', save);
  $('btnSaveAs').addEventListener('click', saveAs);
  $('btnDownload').addEventListener('click', downloadCopy);
  // Where there's no save panel, "Save" and "Download" are the same
  // action, so don't show both.
  if (!canUseFileSystemAccess) {
    $('btnSave').style.display = 'none';
    $('btnSaveAs').style.display = 'none';
  } else {
    $('btnDownload').style.display = 'none';
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

  $('btnClearAll').addEventListener('click', async () => {
    if (!clearAll()) return;
    resetDocument();
    invalidateAllThumbs();
    await clearSession();
    updateTitle();
    renderThumbnails();
    renderMainCanvas();
    setStatus('Cleared.', 'ok');
  });

  installThumbReorder(
    (movedId, targetId, before) => reorderPage(movedId, targetId, before),
    (pageId) => { selectPage(pageId); drawer.close(); },
    (pageId, delta) => rotatePage(pageId, delta),
    (pageId) => deletePage(pageId),
  );

  // --- Tools ---
  $('toolText').addEventListener('click', () =>
    setActiveTool(state.activeTool === 'text' ? 'select' : 'text'));
  $('toolCallout').addEventListener('click', () =>
    setActiveTool(state.activeTool === 'callout' ? 'select' : 'callout'));
  $('btnDeleteAnno').addEventListener('click', () => {
    if (!state.selectedAnnoId) return;
    const page = state.pages.find((p) => p.id === state.selectedPageId);
    if (page) deleteAnnotation(page, state.selectedAnnoId);
  });
  $('annoLayer').addEventListener('click', handleLayerClick);

  // --- Zoom ---
  $('btnZoomIn').addEventListener('click', () => zoomStep(1));
  $('btnZoomOut').addEventListener('click', () => zoomStep(-1));
  $('btnFitWidth').addEventListener('click', () => setZoomMode('fit-width'));
  $('btnFitPage').addEventListener('click', () => setZoomMode('fit-page'));
  $('zoomReadout').addEventListener('click', () => setZoomLevel(1));

  installStageGestures();
  installDragAndDrop();
  installLaunchHandler();
  installKeyboard();
  installAutosaveTriggers();
  installServiceWorker();

  // Re-fit on resize (and on orientation change, which fires resize).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderMainCanvas(), 120);
  });

  // Autosave and the title dot both hang off the dirty flag.
  onDirtyChange((dirty) => {
    updateTitle();
    if (dirty) scheduleSave();
  });

  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty || !state.pages.length) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// ============================================================
// Boot
// ============================================================
async function boot() {
  wireUi();
  updateTitle();
  updateToolbarState();

  if (new URLSearchParams(location.search).has('selftest')) {
    const { runRotMathTests } = await import('./rotmath.test.js');
    const r = runRotMathTests();
    setStatus(
      r.failed ? `Self-test: ${r.failed} FAILED (see console)` : `Self-test: ${r.total} passed ✓`,
      r.failed ? 'err' : 'ok'
    );
  }

  try {
    const snap = await loadSession();
    if (snap && await restoreSession(snap)) {
      renderThumbnails();
      renderMainCanvas();
      updateTitle();
      const when = new Date(snap.savedAt || Date.now());
      setStatus(`Restored your last session (${when.toLocaleString()})`, 'ok');
      return;
    }
  } catch (err) {
    console.error('session restore failed', err);
  }

  renderThumbnails();
  renderMainCanvas();
}

boot();
