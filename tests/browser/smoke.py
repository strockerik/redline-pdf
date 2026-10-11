"""Redline browser smoke test: boot, render, zoom, rotate, reorder, save.

Drives real Chrome over CDP with real input events. The only seam is
window.showSaveFilePicker, replaced with an in-page fake handle so the
save path runs to completion without a native panel nobody can click.
"""
import base64, json, os, shutil, sys, tempfile, time
import cdp

PORT = int(os.environ.get("PORT", "8000"))
URL = f"http://localhost:{PORT}/"
# Headful by default. Headless Chrome stops compositing partway through a
# long run; requestAnimationFrame stops with it, and pdf.js continues
# multi-chunk renders from rAF — so renders stall and the app looks broken
# when it is not. See KNOWN-ISSUES.md. --headless is opt-in and faster, but
# expect the session-restore check to fail spuriously.
HEADLESS = "--headless" in sys.argv
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixture.pdf")
SHOTS = os.path.join(HERE, "shots")

passed, failed = 0, 0


def ensure_fixture():
    """Build the 3-page test PDF with cupsfilter (ships with macOS), so no
    binary needs to live in the repo."""
    if os.path.exists(FIXTURE):
        return
    import subprocess
    txt = os.path.join(HERE, "fixture.txt")
    with open(txt, "w") as f:
        f.write("REDLINE SMOKE TEST FIXTURE\n\fPAGE TWO — LANDSCAPE CHECK\n"
                "\fPAGE THREE — REORDER TARGET\n")
    with open(FIXTURE, "wb") as out:
        subprocess.run(["cupsfilter", txt], stdout=out,
                       stderr=subprocess.DEVNULL, check=True)
    os.remove(txt)
    print(f"built fixture: {FIXTURE}")


HEAVY_FIXTURE = os.path.join(HERE, "heavy-fixture.pdf")
HEAVY_HEX_FIXTURE = os.path.join(HERE, "heavy-hex-fixture.pdf")


def ensure_heavy_fixture(path=HEAVY_FIXTURE, hexed=False):
    """A one-page PDF whose content stream is over the app's heavy-page
    threshold. ~200k short strokes, all in the left part of a landscape
    page — lopsided on purpose, so a rotation drawn the wrong way round is
    visible.

    Plain, it takes the GPU path a CAD plot does. Hex-encoded it is the
    same page in a filter the plot compiler declines, which is how the
    suite reaches the fallback (one pdf.js render into a cached bitmap)
    on a machine where the fast path works."""
    if os.path.exists(path):
        return
    ops = ["0.3 w"]
    for i in range(215000):
        x, y = 12 + (i * 13) % 270, 12 + (i * 7) % 588
        ops.append(f"{x} {y} m {x + 8} {y + 3} l S")
    content = "\n".join(ops).encode()
    extra = b""
    if hexed:
        content = content.hex().encode() + b">"
        extra = b"/Filter/ASCIIHexDecode"
    objs = [
        b"<</Type/Catalog/Pages 2 0 R>>",
        b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
        b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 792 612]/Contents 4 0 R/Resources<<>>>>",
        b"<</Length %d%s>>\nstream\n" % (len(content), extra) + content + b"\nendstream",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    with open(path, "wb") as f:
        f.write(out)
    print(f"built fixture: {path}")


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"ok    {label}" + (f"  ({detail})" if detail else ""))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  ({detail})" if detail else ""))


def ev(ws, expr, awaitp=False):
    r = ws.call("Runtime.evaluate", {
        "expression": expr, "returnByValue": True, "awaitPromise": awaitp,
    })
    if "exceptionDetails" in r:
        raise RuntimeError(f"JS threw: {r['exceptionDetails'].get('text')} :: "
                           f"{r['exceptionDetails'].get('exception', {}).get('description', '')}")
    return r["result"].get("value")


def wait_for(ws, expr, timeout=20, label=None):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if ev(ws, expr):
                return True
        except RuntimeError:
            pass
        time.sleep(0.15)
    if label:
        check(label, False, f"timed out waiting for: {expr}")
    return False


def shot(ws, name):
    os.makedirs(SHOTS, exist_ok=True)
    r = ws.call("Page.captureScreenshot", {"format": "png"})
    path = os.path.join(SHOTS, name + ".png")
    with open(path, "wb") as f:
        f.write(base64.b64decode(r["data"]))
    return path


def click(ws, selector):
    box = ev(ws, f"""(() => {{
      const el = document.querySelector({json.dumps(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {{x: r.left + r.width/2, y: r.top + r.height/2}};
    }})()""")
    if not box:
        raise RuntimeError(f"no element {selector}")
    for t in ("mousePressed", "mouseReleased"):
        ws.call("Input.dispatchMouseEvent", {
            "type": t, "x": box["x"], "y": box["y"],
            "button": "left", "clickCount": 1,
        })
    time.sleep(0.15)


def stage_point(ws, fx, fy):
    """A viewport point at (fx, fy) of the *visible* part of the page. The
    stage may be scrolled, so a fraction of the canvas alone can land off
    screen — on the toolbar, or outside the window entirely."""
    b = ev(ws, """(() => {
      const c = document.getElementById('pageCanvas').getBoundingClientRect();
      const s = document.getElementById('canvasStage').getBoundingClientRect();
      const l = Math.max(c.left, s.left), r = Math.min(c.right, s.right);
      const t = Math.max(c.top, s.top), b2 = Math.min(c.bottom, s.bottom);
      return {l, t, w: r - l, h: b2 - t};
    })()""")
    return b["l"] + b["w"] * fx, b["t"] + b["h"] * fy


def wheel(ws, dy, ctrl=False, meta=False, pinch=False):
    """A real Ctrl+wheel means the Ctrl key is physically down, so hold it
    for the duration — that is exactly what the app uses to tell a keyboard
    Ctrl from a trackpad pinch (which sets ctrlKey with no key press, i.e.
    pinch=True here)."""
    mods = (2 if (ctrl or pinch) else 0) | (4 if meta else 0)
    box = ev(ws, """(() => {
      const r = document.getElementById('canvasStage').getBoundingClientRect();
      return {x: r.left + r.width/2, y: r.top + r.height/2};
    })()""")
    if ctrl:
        ws.call("Input.dispatchKeyEvent", {
            "type": "rawKeyDown", "key": "Control", "code": "ControlLeft",
            "windowsVirtualKeyCode": 17, "nativeVirtualKeyCode": 17, "modifiers": 2})
        time.sleep(0.05)
    ws.call("Input.dispatchMouseEvent", {
        "type": "mouseWheel", "x": box["x"], "y": box["y"],
        "deltaX": 0, "deltaY": dy, "modifiers": mods,
    })
    if ctrl:
        time.sleep(0.05)
        ws.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "key": "Control", "code": "ControlLeft",
            "windowsVirtualKeyCode": 17, "nativeVirtualKeyCode": 17, "modifiers": 0})
    time.sleep(0.5)


RAF_PROBE = r"""
// Is the page still producing frames? pdf.js continues multi-chunk renders
// from requestAnimationFrame, so a page that has stopped compositing stops
// rendering — while promises still resolve, which makes a stalled renderer
// look like a deadlock. Headless Chrome does this partway through a long
// run; see KNOWN-ISSUES.md.
window.__rafAlive = () => Promise.race([
  new Promise(r => requestAnimationFrame(() => r('fires'))),
  new Promise(r => setTimeout(() => r('STARVED'), 2500)),
]);
"""


def sel(ws):
    """Index of the selected thumbnail, or -1."""
    return ev(ws, "[...document.querySelectorAll('#thumbList .thumb')]"
                  ".findIndex(t => t.classList.contains('selected'))")


def key(ws, k, code, vk, meta=False, shift=False):
    mods = (4 if meta else 0) | (8 if shift else 0)
    for t in ("rawKeyDown", "keyUp"):
        ws.call("Input.dispatchKeyEvent", {
            "type": t, "key": k, "code": code,
            "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk,
            "modifiers": mods,
        })
    time.sleep(0.1)


# The save-panel stub. Installed before any app code runs.
STUB = r"""
window.__nativeSavePicker = ('showSaveFilePicker' in window);
window.__saved = [];
window.showSaveFilePicker = async (opts) => {
  const name = (opts && opts.suggestedName) || 'untitled.pdf';
  const rec = { name, chunks: [], closed: 0 };
  window.__saved.push(rec);
  // Methods are non-enumerable, so the stand-in is a plain data object
  // with behaviour attached, as a real FileSystemFileHandle is.
  const handle = { kind: 'file', name };
  const def = (k, v) => Object.defineProperty(handle, k, { value: v, enumerable: false });
  def('queryPermission', async () => 'granted');
  def('requestPermission', async () => 'granted');
  def('createWritable', async () => ({
    write: async (d) => {
      const buf = d instanceof Blob ? new Uint8Array(await d.arrayBuffer())
                                    : new Uint8Array(d.buffer || d);
      rec.chunks.push(Array.from(buf));
    },
    close: async () => { rec.closed++; },
  }));
  return handle;
};
window.__savedInfo = () => window.__saved.map(r => {
  const flat = [].concat(...r.chunks);
  return {
    name: r.name, bytes: flat.length, closed: r.closed,
    head: String.fromCharCode(...flat.slice(0, 8)),
  };
});
// Read a saved page's content stream and count stroking operations in the
// pen colour. Proves the ink is in the *file*, not just on screen —
// reading the operator list rather than rasterising, so this never
// competes with the app's own pdf.js renders.
window.__strokeOpsInSaved = async (i, pageNum, hex) => {
  const flat = Uint8Array.from([].concat(...window.__saved[i].chunks));
  const doc = await pdfjsLib.getDocument({ data: flat }).promise;
  const pg = await doc.getPage(pageNum);
  const ops = await pg.getOperatorList();
  const want = [1, 3, 5].map((k) => parseInt(hex.substr(k, 2), 16) / 255);
  const near = (a, b) => Math.abs(a - b) < 0.02;
  let strokes = 0, colourHits = 0;
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    if (fn === pdfjsLib.OPS.stroke) strokes++;
    if (fn === pdfjsLib.OPS.setStrokeRGBColor) {
      const a = ops.argsArray[k];
      // pdf.js hands this back as a '#rrggbb' string or as a *typed* array
      // of 0-255 components. Array.from first: mapping a Uint8ClampedArray
      // clamps each result straight back to an integer, so v/255 would
      // silently become 0.
      let rgb = typeof a[0] === 'string'
        ? [1, 3, 5].map((z) => parseInt(a[0].substr(z, 2), 16) / 255)
        : Array.from(a).slice(0, 3);
      if (rgb.some((v) => v > 1.5)) rgb = rgb.map((v) => v / 255);
      if (rgb.length === 3 && rgb.every((v, z) => near(v, want[z]))) colourHits++;
    }
  }
  // Any stroke-colour-ish operator, with its args, for diagnosis.
  const names = {};
  for (const [n, v] of Object.entries(pdfjsLib.OPS)) names[v] = n;
  const colourOps = [];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const n = names[ops.fnArray[k]] || String(ops.fnArray[k]);
    if (/stroke/i.test(n) && !/^stroke$/.test(n)) {
      colourOps.push(n + ':' + JSON.stringify(ops.argsArray[k]).slice(0, 60));
    }
  }
  return { strokes, colourHits, colourOps: colourOps.slice(0, 6) };
};
// pdf-lib writes object streams, so the page tree is compressed and a
// text grep can't see it. Reopen the bytes with pdf.js instead — which
// also proves the export is a file something else can actually read.
window.__reopenSaved = async (i) => {
  const flat = Uint8Array.from([].concat(...window.__saved[i].chunks));
  const doc = await pdfjsLib.getDocument({ data: flat }).promise;
  const sizes = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const [, , w, h] = pg.view;
    sizes.push({ w: Math.round(w), h: Math.round(h), rot: pg.rotate });
  }
  return { numPages: doc.numPages, sizes };
};
"""


# Stub for the Open in Tabs picker. Same shape as the save-panel stub: the
# handle's methods are non-enumerable so it stays structured-cloneable, or
# the autosave that this section exists to test would fail on the handle
# rather than on anything real.
TABS_STUB = r"""
window.showOpenFilePicker = async () => {
  const res = await fetch('./tests/browser/fixture.pdf');
  const buf = await res.arrayBuffer();
  const mk = (name) => {
    const h = { kind: 'file', name };
    Object.defineProperty(h, 'getFile', {
      enumerable: false,
      value: async () => new File([buf.slice(0)], name, { type: 'application/pdf' }),
    });
    return h;
  };
  return [mk('alpha.pdf'), mk('beta.pdf')];
};
"""


# Chrome hands launch files only to an installed app opened from the OS,
# which no harness can arrange. This stands in for the queue: the app's
# consumer is captured, and `__launch(name)` delivers a file to it the way
# a double-click in Finder would.
LAUNCH_STUB = r"""
(() => {
  const mk = (name, buf) => {
    const h = { kind: 'file', name };
    Object.defineProperty(h, 'getFile', {
      enumerable: false,
      value: async () => new File([buf.slice(0)], name, { type: 'application/pdf' }),
    });
    return h;
  };
  let consumer = null;
  const fire = async (name) => {
    const buf = await (await fetch('./tests/browser/fixture.pdf')).arrayBuffer();
    await consumer({ files: [mk(name, buf)] });
  };
  Object.defineProperty(window, 'launchQueue', { configurable: true, value: {
    setConsumer(fn) {
      consumer = fn;
      // A launch *from* Finder: the file is already waiting when the app
      // boots, so it arrives before the saved session has been read back.
      if (localStorage.getItem('redlineTestLaunch')) {
        localStorage.removeItem('redlineTestLaunch');
        window.__bootLaunch = fire('launched.pdf');
      }
    },
  }});
  window.__launch = fire;
})();
"""


def launch_checks(ws):
    """Double-clicking a PDF in Finder, with Redline as its handler.

    The file has to open, as itself, and be the only thing there: every
    launch starts empty. When sessions were saved, the file raced the
    restore for the live document and lost — the session is what appeared.
    A second file, opened while the app is running, gets a tab of its own
    rather than being merged into the first.
    """
    print("\n=== opened from Finder ===")

    def docs():
        return ev(ws, """(async () => {
          const s = await import('./js/state.js');
          return {
            n: s.state.docs.length,
            active: s.state.docName,
            pages: s.state.pages.length,
            // The active document's name and pages live in `state`; its
            // record is stale until the next capture.
            all: s.state.docs.map(d => d.id === s.state.activeDocId
              ? s.state.docName + ':' + s.state.pages.length
              : d.docName + ':' + d.pages.length),
          };
        })()""", awaitp=True)

    before = docs()
    check("documents are open before the relaunch", any(not x.endswith(":0") for x in before["all"]), str(before["all"]))
    ev(ws, """(async () => {
      (await import('./js/state.js')).markDirty(false);     // or beforeunload blocks the navigation
      localStorage.setItem('redlineTestLaunch', '1');
    })()""", awaitp=True)

    ws.call("Page.navigate", {"url": URL})
    wait_for(ws, "!!window.__bootLaunch", timeout=30, label="relaunched with a file waiting")
    ev(ws, "window.__bootLaunch.then(() => true)", awaitp=True)
    wait_for(ws, "document.querySelectorAll('#thumbList canvas').length === 3", timeout=30)
    d = docs()
    check("the file opened from Finder is the document on screen",
          d["active"] == "launched.pdf" and d["pages"] == 3, str(d))
    check("and the only one — nothing from the last run came back", d["all"] == ["launched.pdf:3"], str(d["all"]))
    target = ev(ws, """(async () => {
      const { state } = await import('./js/state.js');
      return { name: state.fileHandle && state.fileHandle.name, combined: state.combined, dirty: state.dirty };
    })()""", awaitp=True)
    check("it keeps its own save target", target == {"name": "launched.pdf", "combined": False, "dirty": False}, str(target))
    check("the title says which file this is",
          ev(ws, "document.getElementById('docTitle').textContent") == "launched.pdf")
    shot(ws, "10-launched")

    # A second double-click, with the app already open.
    ev(ws, "document.querySelectorAll('#thumbList canvas').forEach((c) => { c.dataset.seen = '1'; })")
    ev(ws, "window.__launch('second.pdf').then(() => true)", awaitp=True)
    wait_for(ws, "document.querySelectorAll('#thumbList canvas').length === 3", timeout=30)
    time.sleep(0.5)
    d2 = docs()
    check("a file opened while Redline is running gets another tab",
          d2["n"] == 2 and d2["active"] == "second.pdf" and d2["pages"] == 3, str(d2))
    check("rather than being merged into the one before", "launched.pdf:3" in d2["all"], str(d2["all"]))
    # Both documents number their pages from 1. A cache keyed by that
    # number hands the first document's thumbnails to the second.
    fresh = ev(ws, "[...document.querySelectorAll('#thumbList canvas')].every((c) => !c.dataset.seen)")
    check("its thumbnails are its own, not the previous document's", fresh is True)

    # Nothing may be written to IndexedDB on the way: a file handle saved
    # there as the browser shuts down is what crashed Chrome at exit.
    dbs = ev(ws, "(async () => (await indexedDB.databases()).map((d) => d.name))()", awaitp=True)
    check("no database holds the session or its file handles", dbs == [], str(dbs))


def tab_checks(ws):
    """Open in Tabs: each file its own document, with its own pages, name
    and save target, and nothing one tab does reaching into another.

    Runs in its own browser instance — tabs change what a "document" is, so
    the single-document assumptions of the main flow do not survive it.
    """
    print("\n=== document tabs ===")

    def docs():
        return ev(ws, """(async () => {
          const s = await import('./js/state.js');
          return {
            n: s.state.docs.length,
            active: s.state.docName,
            pages: s.state.pages.length,
            // The active document's name and pages live in `state`; its
            // record is stale until the next capture.
            all: s.state.docs.map(d => d.id === s.state.activeDocId
              ? s.state.docName + ':' + s.state.pages.length
              : d.docName + ':' + d.pages.length),
          };
        })()""", awaitp=True)

    check("starts as a single document", docs()["n"] == 1, str(docs()))
    check("tab strip hidden with one document",
          ev(ws, "document.getElementById('tabBar').classList.contains('show')") is False)

    click(ws, "#btnOpenTabs")
    wait_for(ws, "document.querySelectorAll('#tabStrip .tab').length === 2",
             timeout=30, label="two files opened as two tabs")
    time.sleep(1.5)
    d = docs()
    check("two files become two documents, not one merge", d["n"] == 2, str(d))
    check("each keeps its own pages — 3 and 3, not 6",
          d["all"] == ["alpha.pdf:3", "beta.pdf:3"], str(d["all"]))
    check("the empty starting tab was reused",
          ev(ws, "document.querySelectorAll('#tabStrip .tab').length") == 2)
    check("tab strip appears with a second document",
          ev(ws, "document.getElementById('tabBar').classList.contains('show')") is True)
    check("the active document is the last opened", d["active"] == "beta.pdf", d["active"])

    # Make the two documents differ, so a restore that mixes them up is
    # visible rather than a coincidence.
    click(ws, "#btnAddBlank")
    time.sleep(1.2)
    check("editing affects only the active document",
          docs()["all"] == ["alpha.pdf:3", "beta.pdf:4"], str(docs()["all"]))

    click(ws, "#tabStrip .tab:first-child")
    time.sleep(1.5)
    d = docs()
    check("switching tabs swaps the document", d["active"] == "alpha.pdf", d["active"])
    check("and swaps the page list", d["pages"] == 3, f"{d['pages']} pages")
    check("the title follows the tab",
          ev(ws, "document.getElementById('docTitle').textContent") == "alpha.pdf")
    check("thumbnails belong to the newly active document",
          ev(ws, "document.querySelectorAll('#thumbList .thumb').length") == 3,
          f"{ev(ws, 'document.querySelectorAll(\'#thumbList .thumb\').length')} thumbs")
    shot(ws, "09-tabs")

    # Clear All empties the active document, and only that one.
    active = ev(ws, "(async()=>(await import('./js/state.js')).state.docName)()", awaitp=True)
    other = "beta.pdf:4" if active == "alpha.pdf" else "alpha.pdf:3"
    ev(ws, "window.confirm = () => true")
    click(ws, "#btnClearAll")
    time.sleep(1.5)
    d = docs()
    check("Clear All leaves the other tab alone", other in d["all"] and d["n"] == 2, f"cleared {active}; now {d['all']}")
    check("Clear All did empty the active document", d["pages"] == 0, str(d))

    close = ev(ws, "!!document.querySelector('#tabStrip .tab .tab-close')")
    check("tabs offer a close control", close is True)
    if close:
        click(ws, "#tabStrip .tab:first-child .tab-close")
        time.sleep(1.2)
        check("closing a document leaves the other", docs()["n"] == 1, str(docs()))
        check("tab strip hides again at one document",
              ev(ws, "document.getElementById('tabBar').classList.contains('show')") is False)

    # --- the shared <input type=file> fallback (iOS / Safari path) ---
    # Both open modes drive the same hidden input, so the mode is armed just
    # before the click. A cancelled dialog fires no change event, so an
    # armed flag used to survive and decide the *next* open instead.
    ev(ws, "delete window.showOpenFilePicker")
    before = docs()
    click(ws, "#btnOpenTabs")      # arms 'tabs', opens the input
    time.sleep(0.4)
    click(ws, "#btnOpen")          # user cancelled; now they want a merge
    time.sleep(0.4)
    d0 = ws.call("DOM.getDocument")["root"]["nodeId"]
    f0 = ws.call("DOM.querySelector", {"nodeId": d0, "selector": "#fileInput"})["nodeId"]
    ws.call("DOM.setFileInputFiles", {"nodeId": f0, "files": [FIXTURE, FIXTURE]})
    time.sleep(3)
    after = docs()
    check("a cancelled 'Open in Tabs' does not hijack the next 'Open'",
          after["n"] == before["n"] and after["pages"] == before["pages"] + 6,
          f"{before['n']} tab/{before['pages']} pages -> {after['n']} tab/{after['pages']} pages")


def heavy_page_checks(ws, plot):
    """A page too big to hand to pdf.js on every redraw.

    plot=True   the fast path: linework compiled once and drawn by the GPU
                into #plotCanvas.
    plot=False  the fallback: one pdf.js render into a cached bitmap, shown
                through #pageCanvas.

    Either way pdf.js must never be asked to draw the page again for a
    zoom, a rotation or a thumbnail — that is the whole point of both.

    The fixture merges into whatever document is open, as its last page.
    """
    print(f"\n=== heavy page ({'GPU plot' if plot else 'bitmap fallback'}) ===")
    fixture = HEAVY_FIXTURE if plot else HEAVY_HEX_FIXTURE
    ensure_heavy_fixture(fixture, hexed=not plot)
    before = ev(ws, "document.querySelectorAll('#thumbList .thumb').length")
    doc = ws.call("DOM.getDocument")["root"]["nodeId"]
    node = ws.call("DOM.querySelector", {"nodeId": doc, "selector": "#fileInput"})["nodeId"]
    ws.call("DOM.setFileInputFiles", {"nodeId": node, "files": [fixture]})
    wait_for(ws, f"document.querySelectorAll('#thumbList .thumb').length === {before + 1}",
             timeout=30, label="heavy fixture imported")
    ev(ws, "document.querySelector('#thumbList .thumb:last-child').scrollIntoView()")
    click(ws, "#thumbList .thumb:last-child .thumb-canvas")

    # Where the ink is, as [left, right, top, bottom] halves of a canvas.
    # Anything visibly off-white counts: a thumbnail is a sheet scaled far
    # down, and thin linework at that size is grey, not black.
    halves = """((c) => {
      if (!c) return [0, 0, 0, 0];
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const out = [0, 0, 0, 0];
      for (let y = 0; y < c.height; y += 4) for (let x = 0; x < c.width; x += 4) {
        if (d[(y * c.width + x) * 4] > 235) continue;
        out[x < c.width / 2 ? 0 : 1]++;
        out[y < c.height / 2 ? 2 : 3]++;
      }
      return out;
    })"""
    thumb_halves = f"{halves}(document.querySelector('#thumbList .thumb:last-child canvas'))"

    def page_halves():
        # A WebGL canvas cannot be read back after its frame, so the plot
        # is asked to draw itself again into something that can.
        if plot:
            return ev(ws, f"(async () => {halves}((await import('./js/view.js')).shownPlotImage(1600)))()", awaitp=True)
        return ev(ws, f"{halves}(document.getElementById('pageCanvas'))")

    badge = "document.getElementById('pageStack').classList.contains('rendering')"
    shown = "document.getElementById('plotCanvas').style.display"
    # The badge clearing is the app saying the page is all there.
    wait_for(ws, f"!{badge}", timeout=90, label="heavy page finished and the progress badge cleared")
    check("took the intended path", (ev(ws, shown) == "block") == plot, f"#plotCanvas display: {ev(ws, shown)}")
    l, r, t, b = page_halves()
    check("heavy page drawn the right way up", l > 500 and r < l / 20, f"left {l}, right {r}")

    wait_for(ws, f"{thumb_halves}[0] > 20", timeout=30, label="heavy page thumbnail painted from the same result")

    # From here on pdf.js must not be asked to draw this page. Count the
    # calls rather than timing them: a fast machine would re-render this
    # fixture quickly enough to hide the regression.
    ev(ws, """(async () => {
      const { state } = await import('./js/state.js');
      const page = state.pages[state.pages.length - 1];
      const src = state.sources.find((s) => s.id === page.sourceId);
      const pj = await src.pdfjsDoc.getPage(page.sourcePageIndex + 1);
      const render = pj.render.bind(pj);
      window.__heavyRenders = 0;
      pj.render = (o) => { window.__heavyRenders++; return render(o); };
    })()""", awaitp=True)
    settle = "new Promise((r) => setTimeout(r, 500))"

    for _ in range(12):
        ev(ws, "document.getElementById('btnZoomIn').click()")
    ev(ws, settle, awaitp=True)
    big = ev(ws, """(() => {
      const c = document.getElementById('%s'), s = document.getElementById('canvasStage');
      const dpr = window.devicePixelRatio || 1;
      return { px: c.width * c.height, page: parseFloat(document.getElementById('pageStack').style.width),
               stage: (s.clientWidth + 320) * (s.clientHeight + 320) * dpr * dpr,
               zoom: document.getElementById('zoomReadout').textContent }; })()""" % ("plotCanvas" if plot else "pageCanvas"))
    if plot:
        # Only ever as large as the part of the page on screen.
        check("deep zoom draws only what is visible", 0 < big["px"] <= big["stage"] * 1.01,
              f"{big['px'] / 1e6:.1f} MP canvas at {big['zoom']}")
    else:
        check("deep zoom keeps the backing store within budget", 0 < big["px"] <= 32.2e6,
              f"{big['px'] / 1e6:.1f} MP at {big['zoom']}")
    check("deep zoom still grows the page on screen", big["page"] > 5000, f"{big['page']}px wide")
    l, r, t, b = page_halves()
    check("zoomed page still has its content", l > 500 and r < l / 20, f"left {l}, right {r}")

    # A page wider than the stage must still scroll to its own left edge.
    # Centring the stage's content used to push half the overflow off the
    # left, where no scroll position reaches.
    ev(ws, "document.getElementById('canvasStage').scrollLeft = 0")
    edge = ev(ws, """(() => {
      const k = document.getElementById('pageStack').getBoundingClientRect();
      const s = document.getElementById('canvasStage').getBoundingClientRect();
      return k.left - s.left; })()""")
    check("the left edge of a zoomed page can be reached", edge >= 0, f"page starts {edge:.0f}px in from the stage's left")

    if plot:
        # The plot canvas covers the visible part of the page, so it has
        # to move when the page is scrolled under it.
        pos = "parseFloat(document.getElementById('plotCanvas').style.left)"
        ev(ws, "document.getElementById('canvasStage').scrollLeft = 0")
        ev(ws, settle, awaitp=True)
        x0 = ev(ws, pos)
        ev(ws, "document.getElementById('canvasStage').scrollLeft = 3000")
        ev(ws, settle, awaitp=True)
        x1 = ev(ws, pos)
        check("plot canvas follows the scroll", x0 == 0 and x1 > 2000, f"left {x0}px -> {x1}px")
        ink = ev(ws, """(() => {
          const c = document.getElementById('plotCanvas').getBoundingClientRect();
          const s = document.getElementById('canvasStage').getBoundingClientRect();
          return c.left <= s.left + 1 && c.right >= Math.min(s.right, document.getElementById('pageStack').getBoundingClientRect().right) - 1;
        })()""")
        check("and still covers the visible page", ink is True)

    ev(ws, "document.getElementById('btnFitWidth').click()")
    ev(ws, "document.getElementById('btnRotateCW').click()")
    ev(ws, settle, awaitp=True)
    dims = ev(ws, "(() => { const k = document.getElementById('pageStack'); return [k.offsetWidth, k.offsetHeight]; })()")
    l, r, t, b = page_halves()
    check("rotated heavy page is portrait", dims[1] > dims[0], f"{dims[0]}x{dims[1]}")
    # Clockwise: what was on the left is now at the top.
    check("rotation turns the page clockwise", t > 500 and b < t / 20, f"top {t}, bottom {b}")
    tl, tr, tt, tb = ev(ws, thumb_halves)
    check("thumbnail follows the rotation", tt > 20 and tb < tt / 20, f"top {tt}, bottom {tb}")

    n = ev(ws, "window.__heavyRenders")
    check("zoom and rotation never sent the page back through pdf.js", n == 0, f"{n} pdf.js render(s)")
    shot(ws, "heavy-page-plot" if plot else "heavy-page-fallback")


def zoom_mode_checks(ws):
    """Double-click latches the wheel into zooming, Bluebeam style.

    These once ran in a browser instance of their own: the extra renders
    appeared to push a "render deadlock" forward and cost ~45 later
    checks. That deadlock turned out to be headless Chrome dropping
    requestAnimationFrame (KNOWN-ISSUES.md), so the isolation was
    protecting against nothing. Back in the main run.
    """
    print("\n=== double-click wheel zoom ===")
    time.sleep(1.0)

    def dbl(fx, fy):
        x, y = stage_point(ws, fx, fy)
        for n in (1, 2):
            for t in ("mousePressed", "mouseReleased"):
                ws.call("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y,
                                                     "button": "left", "clickCount": n})
        time.sleep(0.4)

    # Fit Pg is where the wheel normally turns pages, so latching it to
    # zoom is an observable change rather than a no-op.
    click(ws, "#btnFitPage")
    time.sleep(2.0)
    check("wheel zoom starts off", ev(ws, "(async()=>(await import('./js/state.js')).state.wheelZoom)()",
                                      awaitp=True) is False)
    dbl(0.5, 0.5)
    check("double-click latches wheel zoom on",
          ev(ws, "(async()=>(await import('./js/state.js')).state.wheelZoom)()", awaitp=True) is True)
    check("the page shows the zoom cursor",
          ev(ws, "getComputedStyle(document.getElementById('canvasStage')).cursor") == "zoom-in")
    check("the readout marks the mode",
          ev(ws, "document.getElementById('zoomReadout').classList.contains('toggled')") is True)

    pg_before = sel(ws)
    z_before = ev(ws, "document.getElementById('zoomReadout').textContent")
    wheel(ws, -120)
    z_after = ev(ws, "document.getElementById('zoomReadout').textContent")
    check("wheel now zooms in Fit Pg, where it would have paged",
          z_before != z_after, f"{z_before} -> {z_after}")
    check("and does not turn the page", sel(ws) == pg_before, f"page index {sel(ws)}")

    # Ctrl still scrolls, so a zoomed page stays navigable in the mode.
    ev(ws, "document.getElementById('canvasStage').scrollTop = 0")
    time.sleep(0.3)
    t0 = ev(ws, "document.getElementById('canvasStage').scrollTop")
    wheel(ws, 120, ctrl=True)
    check("ctrl+wheel still scrolls while zoom mode is on",
          ev(ws, "document.getElementById('canvasStage').scrollTop") > t0,
          f"scrollTop {t0} -> {ev(ws, 'document.getElementById(\"canvasStage\").scrollTop')}")

    dbl(0.5, 0.5)
    check("double-click again releases it",
          ev(ws, "(async()=>(await import('./js/state.js')).state.wheelZoom)()", awaitp=True) is False)
    check("cursor goes back to grab",
          ev(ws, "getComputedStyle(document.getElementById('canvasStage')).cursor") == "grab")

    # Esc is the other way out.
    dbl(0.5, 0.5)
    key(ws, "Escape", "Escape", 27)
    time.sleep(0.3)
    check("Esc also leaves zoom mode",
          ev(ws, "(async()=>(await import('./js/state.js')).state.wheelZoom)()", awaitp=True) is False)

    time.sleep(2.0)
    time.sleep(0.5)

def main():
    global failed
    ensure_fixture()
    profile = tempfile.mkdtemp(prefix="redline-smoke-")
    proc = cdp.launch("about:blank", 9222, profile, headless=HEADLESS)
    try:
        target = cdp.page_target(9222)
        ws = cdp.WS(target["webSocketDebuggerUrl"])
        ws.call("Runtime.enable")
        ws.call("Page.enable")
        ws.call("Log.enable")
        ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": STUB + RAF_PROBE})

        # ---------------------------------------------- 1. boot
        print("\n=== boot ===")
        ws.call("Page.navigate", {"url": URL + "?selftest"})
        wait_for(ws, "!!document.getElementById('pageCanvas')", label="DOM present")
        wait_for(ws, "document.getElementById('statusMsg').textContent.includes('Self-test')",
                 label="in-page self-test ran")
        status = ev(ws, "document.getElementById('statusMsg').textContent")
        check("rot-math self-test passes in the browser", "passed" in status, status.strip())
        check("File System Access API present natively", ev(ws, "window.__nativeSavePicker") is True)
        check("empty state visible", ev(ws, "getComputedStyle(document.getElementById('emptyState')).display") != "none")
        check("page stack hidden while empty", ev(ws, "document.getElementById('pageStack').style.display") == "none")
        wait_for(ws, "navigator.serviceWorker.controller || navigator.serviceWorker.getRegistration()", timeout=8)
        reg = ev(ws, "(async()=>!!(await navigator.serviceWorker.getRegistration()))()", awaitp=True)
        check("service worker registered", reg is True)
        # The stamp is how a stale installed copy gets noticed, so it has
        # to be on screen and has to name the cache the worker really uses.
        stamp = ev(ws, """(async () => {
          const el = document.getElementById('buildStamp');
          const sw = await (await fetch('./sw.js')).text();
          return { text: el.textContent.trim(), shown: el.getBoundingClientRect().width > 0,
                   empty: document.getElementById('emptyStamp').textContent.trim(),
                   cache: (sw.match(/const CACHE = 'redline-v(\\d+)'/) || [])[1] };
        })()""", awaitp=True)
        check("build stamp on screen", stamp["shown"] and stamp["text"].startswith("rev "), stamp["text"])
        check("build stamp names the service worker's cache", stamp["text"].startswith(f"rev {stamp['cache']} "),
              f"{stamp['text']!r} vs redline-v{stamp['cache']}")
        check("build stamp repeated on the empty sheet", stamp["empty"] == stamp["text"], stamp["empty"])
        shot(ws, "01-boot")

        # ---------------------------------------------- 2. save guard
        print("\n=== save with nothing open ===")
        key(ws, "s", "KeyS", 83, meta=True)
        time.sleep(0.3)
        msg = ev(ws, "document.getElementById('statusMsg').textContent")
        check("cmd-S on empty doc is refused, not crashed", "Nothing to save" in msg, msg.strip())

        # ---------------------------------------------- 3. import + render
        print("\n=== import + render ===")
        doc = ws.call("DOM.getDocument")["root"]["nodeId"]
        node = ws.call("DOM.querySelector", {"nodeId": doc, "selector": "#fileInput"})["nodeId"]
        ws.call("DOM.setFileInputFiles", {"nodeId": node, "files": [FIXTURE]})
        wait_for(ws, "document.querySelectorAll('#thumbList .thumb').length === 3",
                 timeout=30, label="3 pages imported")
        n = ev(ws, "document.querySelectorAll('#thumbList .thumb').length")
        check("thumbnail per page", n == 3, f"{n} thumbs")
        check("page count label", "3" in (ev(ws, "document.getElementById('pageCountLabel').textContent") or ""),
              ev(ws, "document.getElementById('pageCountLabel').textContent"))
        check("page stack shown", ev(ws, "document.getElementById('pageStack').style.display") != "none")

        # Real pixels on the main canvas, not just a sized element.
        ink = ev(ws, """(() => {
          const c = document.getElementById('pageCanvas');
          const g = c.getContext('2d');
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4)
            if (d[i] < 200 && d[i+3] > 0) dark++;
          return {w: c.width, h: c.height, dark};
        })()""")
        check("main canvas has a backing store", ink["w"] > 0 and ink["h"] > 0, f"{ink['w']}x{ink['h']}")
        check("page actually rasterised (dark pixels present)", ink["dark"] > 500, f"{ink['dark']} dark px")

        thumb_ink = ev(ws, """(() => {
          const cs = [...document.querySelectorAll('#thumbList canvas')];
          return cs.map(c => {
            const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
            let dark = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] < 200 && d[i+3] > 0) dark++;
            return dark;
          });
        })()""")
        check("every thumbnail painted", len(thumb_ink) == 3 and all(v > 20 for v in thumb_ink), str(thumb_ink))
        shot(ws, "02-imported")

        # ---------------------------------------------- 4. zoom
        print("\n=== zoom ===")
        base = ev(ws, "document.getElementById('pageCanvas').width")
        read0 = ev(ws, "document.getElementById('zoomReadout').textContent")
        click(ws, "#btnZoomIn")
        click(ws, "#btnZoomIn")
        time.sleep(0.8)
        up = ev(ws, "document.getElementById('pageCanvas').width")
        read1 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("zoom in grows the canvas", up > base, f"{base} -> {up} px, {read0} -> {read1}")
        click(ws, "#btnZoomOut")
        time.sleep(0.6)
        down = ev(ws, "document.getElementById('pageCanvas').width")
        check("zoom out shrinks it back", down < up, f"{up} -> {down} px")
        key(ws, "0", "Digit0", 48, meta=True)
        time.sleep(0.6)
        fitw = ev(ws, "document.getElementById('zoomReadout').textContent")
        key(ws, "9", "Digit9", 57, meta=True)
        time.sleep(0.6)
        fitp = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("cmd-0 / cmd-9 fit modes change zoom", fitw != fitp or fitw != read1, f"fitW={fitw} fitPg={fitp}")
        click(ws, "#zoomReadout")
        time.sleep(0.6)
        check("clicking the readout resets to 100%",
              "100" in ev(ws, "document.getElementById('zoomReadout').textContent"),
              ev(ws, "document.getElementById('zoomReadout').textContent"))
        shot(ws, "03-zoom")

        # ---------------------------------------------- 5. rotate
        print("\n=== rotate ===")
        before = ev(ws, "(c=>({w:c.width,h:c.height}))(document.getElementById('pageCanvas'))")
        click(ws, "#btnRotateCW")
        time.sleep(1.0)
        after = ev(ws, "(c=>({w:c.width,h:c.height}))(document.getElementById('pageCanvas'))")
        portrait_before = before["h"] > before["w"]
        portrait_after = after["h"] > after["w"]
        check("90° rotate flips the rendered aspect", portrait_before != portrait_after,
              f"{before['w']}x{before['h']} -> {after['w']}x{after['h']}")
        shot(ws, "04-rotated")
        click(ws, "#btnRotateCCW")
        time.sleep(0.8)

        # ---------------------------------------------- 6. reorder
        print("\n=== reorder (pointer drag) ===")
        order0 = ev(ws, "[...document.querySelectorAll('#thumbList .thumb')].map(t=>t.dataset.pageId)")
        rects = ev(ws, """[...document.querySelectorAll('#thumbList .thumb')].map(t => {
          const r = t.getBoundingClientRect();
          return {x: r.left + r.width/2, y: r.top + r.height/2,
                  low: r.top + r.height*0.8, id: t.dataset.pageId};
        })""")
        src, dst = rects[0], rects[2]
        ws.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": src["x"], "y": src["y"],
                                             "button": "left", "clickCount": 1})
        # Past the 6px threshold, then in steps so elementFromPoint tracks.
        for i in range(1, 11):
            ws.call("Input.dispatchMouseEvent", {
                "type": "mouseMoved",
                "x": src["x"] + (dst["x"] - src["x"]) * i / 10,
                "y": src["y"] + (dst["low"] - src["y"]) * i / 10,
                "button": "left", "buttons": 1})
            time.sleep(0.04)
        marker = ev(ws, "!!document.querySelector('#thumbList .drop-before, #thumbList .drop-after')")
        check("drop indicator appears mid-drag", marker is True)
        ws.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": dst["x"], "y": dst["low"],
                                             "button": "left", "buttons": 0, "clickCount": 1})
        time.sleep(1.0)
        order1 = ev(ws, "[...document.querySelectorAll('#thumbList .thumb')].map(t=>t.dataset.pageId)")
        check("page order changed after drag", order0 != order1, f"{order0} -> {order1}")
        check("no pages lost or duplicated", sorted(order0) == sorted(order1), str(order1))
        check("dragged page landed last", order1[-1] == order0[0], f"moved {order0[0]} to end")
        # The selected page follows the drag; make sure the main canvas
        # actually re-rendered it rather than going blank.
        moved_ink = ev(ws, """(() => {
          const c = document.getElementById('pageCanvas');
          const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] < 200 && d[i+3] > 0) dark++;
          const st = document.getElementById('canvasStage');
          return {dark, scrollTop: st.scrollTop, scrollH: st.scrollHeight, clientH: st.clientHeight};
        })()""")
        check("moved page still rasterised after reorder", moved_ink["dark"] > 500,
              f"{moved_ink['dark']} dark px, stage scrollTop={moved_ink['scrollTop']}")
        # Scroll to the top so the screenshot shows the page head, not the
        # blank middle of a page taller than the stage.
        ev(ws, "document.getElementById('canvasStage').scrollTop = 0")
        time.sleep(0.4)
        shot(ws, "05-reordered")

        # ---------------------------------------------- 6b. wheel modes
        print("\n=== scroll wheel behaviour ===")

        # --- Fit Pg: wheel turns pages, ctrl+wheel zooms ---
        click(ws, "#btnFitPage")
        time.sleep(0.6)
        click(ws, "#thumbList .thumb")
        time.sleep(0.6)
        start = sel(ws)
        wheel(ws, 120)
        after = sel(ws)
        check("Fit Pg: wheel down goes to the next page", after == start + 1,
              f"page index {start} -> {after}")
        wheel(ws, -120)
        back = sel(ws)
        check("Fit Pg: wheel up goes back", back == start, f"-> {back}")

        z0 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(ws, -120, ctrl=True)
        z1 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit Pg: ctrl+wheel zooms instead", z0 != z1, f"{z0} -> {z1}")
        check("Fit Pg: ctrl+wheel did not also turn the page", sel(ws) == back,
              f"page index {sel(ws)}")

        # --- Fit W: wheel zooms, ctrl+wheel scrolls ---
        click(ws, "#btnFitWidth")
        time.sleep(0.6)
        pg0 = sel(ws)
        z2 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(ws, -120)
        z3 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit W: wheel zooms in", z2 != z3, f"{z2} -> {z3}")
        check("Fit W: wheel did not change page", sel(ws) == pg0, f"page index {sel(ws)}")

        # Zooming flips zoomMode to 'custom' — the wheel must keep zooming.
        z4 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(ws, -120)
        z5 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit W: wheel still zooms after leaving the fit mode", z4 != z5,
              f"{z4} -> {z5}")

        ev(ws, "document.getElementById('canvasStage').scrollTop = 0")
        time.sleep(0.3)
        top0 = ev(ws, "document.getElementById('canvasStage').scrollTop")
        z6 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(ws, 120, ctrl=True)
        top1 = ev(ws, "document.getElementById('canvasStage').scrollTop")
        z7 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit W: ctrl+wheel scrolls the stage", top1 > top0, f"scrollTop {top0} -> {top1}")
        check("Fit W: ctrl+wheel did not zoom", z6 == z7, f"{z6} -> {z7}")

        # Cmd+wheel is the always-zoom escape hatch.
        z8 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(ws, -120, meta=True)
        z9 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("cmd+wheel zooms regardless of mode", z8 != z9, f"{z8} -> {z9}")

        # A trackpad pinch is a ctrlKey wheel with no key press. It must
        # still zoom in Fit W, where a real Ctrl+wheel now scrolls.
        # Real pinch deltas are small. Not asserting scrollTop here: zooming
        # at an anchor moves the scroll position by design, so it would prove
        # nothing either way — the meaningful pairing is that this zooms
        # while the real Ctrl+wheel above scrolled.
        ev(ws, "document.getElementById('canvasStage').scrollTop = 0")
        time.sleep(0.3)
        za = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(ws, -20, pinch=True)
        zb = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("trackpad pinch still zooms in Fit W", za != zb, f"{za} -> {zb}")

        # --- Tool shortcuts ---
        zoom_mode_checks(ws)

        print("\n=== tool shortcuts ===")
        key(ws, "q", "KeyQ", 81)
        check("Q activates the callout tool",
              ev(ws, "document.getElementById('toolCallout').classList.contains('toggled')") is True,
              ev(ws, "document.getElementById('toolCallout').className"))
        key(ws, "q", "KeyQ", 81)
        check("Q toggles it back off",
              ev(ws, "document.getElementById('toolCallout').classList.contains('toggled')") is False)
        key(ws, "t", "KeyT", 84)
        check("T activates the text tool",
              ev(ws, "document.getElementById('toolText').classList.contains('toggled')") is True,
              ev(ws, "document.getElementById('toolText').className"))
        key(ws, "Escape", "Escape", 27)
        check("Esc clears the active tool",
              ev(ws, "document.getElementById('toolText').classList.contains('toggled')") is False)
        # Shortcuts must not fire while typing in the filename field.
        ev(ws, "document.getElementById('filenameInput').focus()")
        key(ws, "q", "KeyQ", 81)
        check("Q is inert while typing in a text field",
              ev(ws, "document.getElementById('toolCallout').classList.contains('toggled')") is False)
        ev(ws, "document.getElementById('filenameInput').blur()")
        click(ws, "#btnFitWidth")
        time.sleep(0.5)

        # ---------------------------------------------- 6b2. pan
        print("\n=== pan (default tool) ===")
        check("stage shows the grab cursor at rest",
              ev(ws, "getComputedStyle(document.getElementById('canvasStage')).cursor") == "grab")
        check("the page inherits it",
              ev(ws, "getComputedStyle(document.getElementById('annoLayer')).cursor") == "grab")

        # Zoom in so there is somewhere to pan to.
        click(ws, "#btnZoomIn")
        time.sleep(0.8)
        before = ev(ws, "(s=>({l:s.scrollLeft,t:s.scrollTop}))(document.getElementById('canvasStage'))")
        x0, y0 = stage_point(ws, 0.6, 0.6)
        ws.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0,
                                             "button": "left", "clickCount": 1})
        for i in range(1, 7):
            ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0 - i * 20,
                                                 "y": y0 - i * 12, "button": "left", "buttons": 1})
            time.sleep(0.03)
        mid = ev(ws, "document.getElementById('canvasStage').classList.contains('panning')")
        cur = ev(ws, "getComputedStyle(document.getElementById('canvasStage')).cursor")
        ws.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x0 - 120,
                                             "y": y0 - 72, "button": "left", "buttons": 0,
                                             "clickCount": 1})
        time.sleep(0.4)
        after = ev(ws, "(s=>({l:s.scrollLeft,t:s.scrollTop}))(document.getElementById('canvasStage'))")
        check("dragging the page pans it", after["l"] > before["l"] or after["t"] > before["t"],
              f"{before} -> {after}")
        check("cursor becomes grabbing mid-drag", mid is True and cur == "grabbing", f"{mid}, {cur}")
        check("pan releases cleanly",
              ev(ws, "document.getElementById('canvasStage').classList.contains('panning')") is False)

        # Regression: pan used to preventDefault on pointerdown, which
        # suppresses the compat mousedown and with it the focus change. An
        # open note then never blurred — typing kept landing in it and every
        # single-key shortcut stayed dead, with nothing on screen to say so.
        ev(ws, """(() => {
          const el = document.createElement('div');
          el.id = 'focusProbe';
          el.contentEditable = 'true';
          el.style.cssText = 'position:absolute;left:4px;top:4px;width:60px;height:20px;z-index:9';
          document.getElementById('annoLayer').appendChild(el);
          el.focus();
        })()""")
        check("probe holds focus", ev(ws, "document.activeElement.id") == "focusProbe")
        px, py = stage_point(ws, 0.5, 0.5)
        for t in ("mousePressed", "mouseReleased"):
            ws.call("Input.dispatchMouseEvent", {"type": t, "x": px, "y": py,
                                                 "button": "left", "clickCount": 1})
        time.sleep(0.3)
        check("clicking the page blurs an open note",
              ev(ws, "document.activeElement.id") != "focusProbe",
              f"activeElement = {ev(ws, 'document.activeElement.id || document.activeElement.tagName')}")
        ev(ws, "document.getElementById('focusProbe')?.remove()")

        # (Ctrl+wheel in Fit W is covered by "Fit W: ctrl+wheel scrolls the
        # stage" above. Note that check passed even while the handler was
        # letting the event through: headless Chrome has no browser zoom, so
        # the stage scrolled natively. A real Chrome would have zoomed the
        # whole page instead — the handler now scrolls explicitly.)

        # ---------------------------------------------- 6c. pen
        print("\n=== pen ===")
        TOOLBAR_H = ev(ws, "document.getElementById('pageToolbar').getBoundingClientRect().height")
        # Always present: toggling this group reflows the toolbar, and that
        # resize triggers a re-render that trips the known renderer race.
        check("pen size presets are always in the toolbar",
              ev(ws, "getComputedStyle(document.getElementById('penSizeGrp')).display") != "none")
        key(ws, "p", "KeyP", 80)
        check("P activates the pen",
              ev(ws, "document.getElementById('toolPen').classList.contains('toggled')") is True)
        check("activating the pen does not reflow the toolbar",
              ev(ws, "document.getElementById('pageToolbar').getBoundingClientRect().height") == TOOLBAR_H,
              f"{ev(ws, 'document.getElementById(\'pageToolbar\').getBoundingClientRect().height')} vs {TOOLBAR_H}")
        check("three pen sizes offered",
              ev(ws, "document.querySelectorAll('#penSizeGrp .pen-dot').length") == 3,
              str(ev(ws, "document.querySelectorAll('#penSizeGrp .pen-dot').length")))

        # Blue, so the stroke is separable from the fixture's black text.
        click(ws, "#colorGrp .swatch[title='#1f6feb']")
        click(ws, "#penSizeGrp .pen-dot:last-child")     # Bold
        time.sleep(0.3)

        def drag_stroke(pts):
            # Fractions are of the *visible* part of the page: the stage may
            # be scrolled, and a point 30% down a canvas taller than the
            # viewport can land on the toolbar instead of the page.
            box = ev(ws, """(() => {
              const c = document.getElementById('pageCanvas').getBoundingClientRect();
              const s = document.getElementById('canvasStage').getBoundingClientRect();
              const l = Math.max(c.left, s.left), r = Math.min(c.right, s.right);
              const t = Math.max(c.top, s.top), b = Math.min(c.bottom, s.bottom);
              return {l, t, w: r - l, h: b - t};
            })()""")
            xy = [(box["l"] + box["w"] * fx, box["t"] + box["h"] * fy) for fx, fy in pts]
            ws.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": xy[0][0],
                    "y": xy[0][1], "button": "left", "clickCount": 1})
            for x, y in xy[1:]:
                ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y,
                        "button": "left", "buttons": 1})
                time.sleep(0.03)
            ws.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": xy[-1][0],
                    "y": xy[-1][1], "button": "left", "buttons": 0, "clickCount": 1})
            time.sleep(0.6)

        drag_stroke([(0.2, 0.25), (0.35, 0.45), (0.5, 0.25), (0.65, 0.45), (0.8, 0.25)])
        strokes = ev(ws, "document.querySelectorAll('#leaderSvg .ink-stroke').length")
        check("dragging with the pen leaves a stroke", strokes == 1, f"{strokes} strokes")
        pcount = ev(ws, """(() => {
          const el = document.querySelector('#leaderSvg .ink-stroke');
          return el ? el.getAttribute('points').trim().split(/\\s+/).length : 0;
        })()""")
        check("stroke followed the pointer", pcount >= 4, f"{pcount} points")
        check("stroke uses the selected colour",
              ev(ws, "document.querySelector('#leaderSvg .ink-stroke').getAttribute('stroke')")
              == "#1f6feb",
              ev(ws, "document.querySelector('#leaderSvg .ink-stroke').getAttribute('stroke')"))

        # The pen must stay armed for a second stroke, unlike the one-shot
        # text tools which revert to select after placing.
        drag_stroke([(0.25, 0.65), (0.45, 0.78), (0.7, 0.65)])
        check("pen stays active for repeated strokes",
              ev(ws, "document.querySelectorAll('#leaderSvg .ink-stroke').length") == 2,
              f"{ev(ws, 'document.querySelectorAll(\"#leaderSvg .ink-stroke\").length')} strokes")
        check("ink counts toward the page's annotations",
              ev(ws, """(async()=>{const s=await import('./js/state.js');
                 const p=s.state.pages.find(p=>p.id===s.state.selectedPageId);
                 return p.annotations.filter(a=>a.type==='ink').length;})()""", awaitp=True) == 2)

        # Centre the stroke in the stage so it is on screen for both the
        # screenshot and the click below. getScreenCTM maps SVG units to
        # viewport coordinates exactly, across scroll and zoom — deriving
        # that by hand from the points string and the canvas rect drifts
        # off-screen as soon as either is non-trivial.
        ON_STROKE = """(() => {
          const el = document.querySelector('#leaderSvg .ink-stroke');
          // Let the browser do the scrolling: it clamps to the scrollable
          // range and handles the nested container, which hand-computed
          // scrollLeft/scrollTop deltas silently fail to do once the
          // stage is already at its limit.
          el.scrollIntoView({block: 'center', inline: 'center'});
          const at = (f) => {
            const p = el.getPointAtLength(el.getTotalLength() * f);
            const m = el.getScreenCTM();
            return {x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f};
          };
          const name = (n) => n ? n.tagName + '.' + (n.getAttribute('class') || n.id) : 'NONE';
          let last = null;
          // Several points along the line: one may land on a bend or just
          // outside the visible slice.
          for (const f of [0.25, 0.5, 0.75, 0.1, 0.9]) {
            const s = at(f);
            const hit = document.elementFromPoint(s.x, s.y);
            last = {x: s.x, y: s.y, hit: name(hit), f};
            if (hit && (hit.getAttribute('class') || '').includes('ink-stroke')) return last;
          }
          return last;
        })()"""
        onstroke = ev(ws, ON_STROKE)
        time.sleep(0.4)
        # While the pen is active the layer deliberately swallows hits, so
        # that drawing over an existing stroke works. Hence hit-testing the
        # stroke itself is checked below, after Esc.
        check("the pen layer takes the pointer while drawing",
              "tool-pen" in str(onstroke["hit"]), str(onstroke))
        shot(ws, "06-pen")

        key(ws, "Escape", "Escape", 27)
        # Deliberately no zoom change between drawing and selecting: while
        # the renderer race in KNOWN-ISSUES.md is open, a zoom can leave
        # renderMainCanvas hung, and then the annotation layer keeps its
        # pre-zoom coordinates and nothing on it is clickable.
        time.sleep(0.5)
        check("Esc puts the pen away",
              ev(ws, "document.getElementById('toolPen').classList.contains('toggled')") is False)

        # A stray stroke has to be removable, or the tool is a trap.
        #
        # The event is dispatched on the element rather than at screen
        # coordinates. Only the stroke's own painted line is hit-testable,
        # and locating it on screen means trusting the stage scroll — which
        # is exactly what the open renderer race makes unreliable. So:
        # assert the CSS that makes it hittable, then drive the handler.
        check("a finished stroke is hit-testable once the pen is put away",
              ev(ws, "getComputedStyle(document.querySelector('#leaderSvg .ink-stroke')).pointerEvents")
              == "stroke")
        ev(ws, """document.querySelector('#leaderSvg .ink-stroke').dispatchEvent(
             new PointerEvent('pointerdown', {bubbles: true, cancelable: true}))""")
        time.sleep(0.5)
        check("selecting a stroke shows its halo",
              ev(ws, "document.querySelectorAll('#leaderSvg .ink-halo').length") == 1)
        check("Delete Note is enabled for a selected stroke",
              ev(ws, "document.getElementById('btnDeleteAnno').disabled") is False)
        click(ws, "#btnDeleteAnno")
        time.sleep(0.5)
        check("a selected stroke can be deleted",
              ev(ws, "document.querySelectorAll('#leaderSvg .ink-stroke').length") == 1,
              f"{ev(ws, 'document.querySelectorAll(\"#leaderSvg .ink-stroke\").length')} left")

        # ---------------------------------------------- 7. save
        print("\n=== save path ===")
        ev(ws, "document.getElementById('filenameInput').value = 'smoke-out.pdf'")
        key(ws, "s", "KeyS", 83, meta=True, shift=True)   # Save As
        wait_for(ws, "document.getElementById('statusMsg').textContent.includes('Saved')",
                 timeout=30, label="shift-cmd-S completes")
        info = ev(ws, "window.__savedInfo()")
        check("save panel was invoked once", len(info) == 1, str([i["name"] for i in info]))
        if info:
            s = info[0]
            check("suggested filename honoured", s["name"] == "smoke-out.pdf", s["name"])
            check("bytes written and stream closed", s["bytes"] > 1000 and s["closed"] == 1,
                  f"{s['bytes']} B, closed={s['closed']}")
            check("output is a real PDF", s["head"].startswith("%PDF"), repr(s["head"]))
            reopened = ev(ws, "window.__reopenSaved(0)", awaitp=True)
            check("saved bytes reopen in pdf.js", bool(reopened), str(reopened))
            check("all 3 pages exported", reopened["numPages"] == 3,
                  f"{reopened['numPages']} pages: {reopened['sizes']}")
            inked = ev(ws, "window.__strokeOpsInSaved(0, 1, '#1f6feb')", awaitp=True)
            clean = ev(ws, "window.__strokeOpsInSaved(0, 2, '#1f6feb')", awaitp=True)
            check("pen stroke is present in the exported PDF",
                  inked["strokes"] >= 2 and inked["colourHits"] >= 1, str(inked))
            check("un-inked pages carry no pen colour", clean["colourHits"] == 0, str(clean))
        check("dirty dot cleared after save",
              ev(ws, "document.getElementById('dirtyDot').style.display") == "none")
        title = ev(ws, "document.getElementById('docTitle').textContent")
        check("title tracks the saved file", "smoke-out.pdf" in title, title)

        # Second ⌘S must reuse the retained handle, not re-prompt.
        key(ws, "s", "KeyS", 83, meta=True)
        wait_for(ws, "document.getElementById('statusMsg').textContent.includes('Saved')", timeout=30)
        time.sleep(0.5)
        info2 = ev(ws, "window.__savedInfo()")
        check("plain cmd-S writes back without re-prompting", len(info2) == 1,
              f"{len(info2)} picker invocations total")
        check("second write produced bytes", info2 and info2[0]["closed"] == 2,
              f"closed={info2[0]['closed'] if info2 else 'n/a'}")
        shot(ws, "06-saved")

        # ---------------------------------------------- 8. autosave restore
        print("\n=== a relaunch starts empty ===")
        # Documents close with the app; only preferences are kept. Plant a
        # session database of the kind older versions left behind, change
        # every preference, and come back.
        ev(ws, """(async () => {
          await new Promise((res, rej) => {
            const r = indexedDB.open('redline', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('session');
            r.onsuccess = () => { const t = r.result.transaction('session', 'readwrite');
              t.objectStore('session').put({ version: 2, docs: [] }, 'current');
              t.oncomplete = () => { r.result.close(); res(); }; };
            r.onerror = () => rej(r.error);
          });
          document.getElementById('btnFitPage').click();
          document.querySelectorAll('#colorGrp .swatch')[2].click();
          document.querySelectorAll('#penSizeGrp .pen-dot')[2].click();
          const sel = document.getElementById('fontSizeSelect');
          sel.value = [...sel.options].map((o) => o.value).filter((v) => v !== sel.value).pop();
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          window.__font = sel.value;
          (await import('./js/state.js')).markDirty(false);   // or beforeunload blocks the navigation
        })()""", awaitp=True)
        font = ev(ws, "window.__font")
        had = ev(ws, "document.querySelectorAll('#thumbList .thumb').length")
        ws.call("Page.navigate", {"url": URL})
        wait_for(ws, "document.querySelectorAll('#colorGrp .swatch').length > 0", timeout=30, label="relaunched")
        time.sleep(1.5)
        now = ev(ws, """(async () => {
          const { state } = await import('./js/state.js');
          return {
            thumbs: document.querySelectorAll('#thumbList .thumb').length,
            pages: state.pages.length, docs: state.docs.length,
            empty: getComputedStyle(document.getElementById('emptyState')).display,
            dbs: (await indexedDB.databases()).map((d) => d.name),
            fit: state.zoomMode, fitBtn: document.getElementById('btnFitPage').classList.contains('toggled'),
            color: state.currentColor,
            swatch: [...document.querySelectorAll('#colorGrp .swatch')].findIndex((n) => n.classList.contains('selected')),
            pen: state.currentPenSize,
            dot: [...document.querySelectorAll('#penSizeGrp .pen-dot')].findIndex((n) => n.classList.contains('toggled')),
            font: String(state.currentFontSize), fontSel: document.getElementById('fontSizeSelect').value,
          };
        })()""", awaitp=True)
        check("there was a document open before", had == 3, f"{had} pages")
        check("nothing is reopened after a relaunch",
              now["thumbs"] == 0 and now["pages"] == 0 and now["docs"] == 1 and now["empty"] != "none", str(now))
        check("a session database left by an older version is removed", "redline" not in now["dbs"], str(now["dbs"]))
        check("the fit mode is remembered", now["fit"] == "fit-page" and now["fitBtn"] is True, f"{now['fit']}")
        check("the colour is remembered, and the toolbar shows it", now["color"] == "#1f6feb" and now["swatch"] == 2,
              f"{now['color']}, swatch {now['swatch']}")
        check("the pen size is remembered, and the toolbar shows it", now["pen"] == 5 and now["dot"] == 2,
              f"{now['pen']}, dot {now['dot']}")
        check("the text size is remembered, and the toolbar shows it", now["font"] == font and now["fontSel"] == font,
              f"{now['font']} / {now['fontSel']} vs {font}")
        shot(ws, "07-relaunched")

        print("\n=== console ===")
        ws.drain(0.6)
        bad = []
        for e in ws.events:
            if e["method"] == "Runtime.exceptionThrown":
                d = e["params"]["exceptionDetails"]
                bad.append("EXCEPTION: " + (d.get("exception", {}).get("description") or d.get("text", "")))
            elif e["method"] == "Runtime.consoleAPICalled" and e["params"]["type"] in ("error", "warning"):
                txt = " ".join(str(a.get("value", a.get("description", ""))) for a in e["params"]["args"])
                bad.append(f"{e['params']['type']}: {txt}")
        for b in bad:
            print("      " + b[:200])
        errs = [b for b in bad if b.startswith("EXCEPTION") or b.startswith("error")]
        check("no uncaught exceptions or console errors", not errs, f"{len(errs)} error(s)")

    except TimeoutError:
        failed += 1
        print("\nFAIL  the renderer stopped answering — pdf.js is wedged")
        print("      This is the deadlock in KNOWN-ISSUES.md. Everything after")
        print("      this point was skipped; the checks above still stand.")
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        shutil.rmtree(profile, ignore_errors=True)

    # --- tabs, in a second instance --------------------------------
    # This isolation is real: tabs change what "a document" means, and the
    # single-document assumptions above do not survive it.
    profile3 = tempfile.mkdtemp(prefix="redline-smoke-")
    proc3 = cdp.launch("about:blank", 9223, profile3, headless=HEADLESS)
    try:
        ws3 = cdp.WS(cdp.page_target(9223)["webSocketDebuggerUrl"])
        ws3.call("Runtime.enable")
        ws3.call("Page.enable")
        ws3.call("Page.addScriptToEvaluateOnNewDocument", {"source": TABS_STUB + LAUNCH_STUB + RAF_PROBE})
        ws3.call("Page.navigate", {"url": URL})
        wait_for(ws3, "document.querySelectorAll('#colorGrp .swatch').length > 0",
                 timeout=30, label="tabs app booted")
        time.sleep(1)
        tab_checks(ws3)
        heavy_page_checks(ws3, plot=True)
        heavy_page_checks(ws3, plot=False)
        launch_checks(ws3)
    except TimeoutError:
        failed += 1
        print("FAIL  the renderer stopped answering during the tab checks")
    finally:
        try:
            proc3.terminate()
        except Exception:
            pass
        shutil.rmtree(profile3, ignore_errors=True)

    print(f"\n{passed} passed, {failed} failed")
    print(f"screenshots: {SHOTS}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
