"""Redline browser smoke test: boot, render, zoom, rotate, reorder, save.

Drives real Chrome over CDP with real input events. The only seam is
window.showSaveFilePicker, replaced with an in-page fake handle so the
save path runs to completion without a native panel nobody can click.
"""
import base64, json, os, re, shutil, sys, tempfile, time
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


LOCKED_FIXTURE = os.path.join(HERE, "locked-fixture.pdf")


def ensure_locked_fixture():
    """A one-page PDF locked by its author: the standard security handler
    (RC4, revision 2) with an owner password and an empty user password —
    so every viewer opens it without asking, as issued drawing sets often
    are. Built here, stdlib only, because nothing on a stock Mac writes one."""
    if os.path.exists(LOCKED_FIXTURE):
        return
    import hashlib, struct
    pad = bytes.fromhex("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A")

    def rc4(key, data):
        S, j = list(range(256)), 0
        for i in range(256):
            j = (j + S[i] + key[i % len(key)]) % 256
            S[i], S[j] = S[j], S[i]
        i = j = 0
        out = bytearray()
        for b in data:
            i = (i + 1) % 256
            j = (j + S[i]) % 256
            S[i], S[j] = S[j], S[i]
            out.append(b ^ S[(S[i] + S[j]) % 256])
        return bytes(out)

    P, ID0 = -3904, hashlib.md5(b"redline-locked").digest()
    O = rc4(hashlib.md5((b"owner" + pad)[:32]).digest()[:5], pad)
    key = hashlib.md5(pad + O + struct.pack("<i", P) + ID0).digest()[:5]
    U = rc4(key, pad)
    content = b"BT /F1 48 Tf 72 400 Td (LOCKED SHEET) Tj ET\n2 w 72 300 m 540 300 l S\n"
    enc = rc4(hashlib.md5(key + struct.pack("<I", 4)[:3] + b"\0\0").digest()[:10], content)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(enc) + enc + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Filter /Standard /V 1 /R 2 /O <" + O.hex().encode() + b"> /U <" + U.hex().encode() + b"> /P %d >>" % P,
    ]
    out, offs = bytearray(b"%PDF-1.4\n"), []
    for n, body in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs:
        out += b"%010d 00000 n \n" % o
    out += (b"trailer\n<< /Size %d /Root 1 0 R /Encrypt 6 0 R /ID [<%s> <%s>] >>\nstartxref\n%d\n%%%%EOF\n"
            % (len(objs) + 1, ID0.hex().encode(), ID0.hex().encode(), xref))
    with open(LOCKED_FIXTURE, "wb") as f:
        f.write(out)
    print(f"built fixture: {LOCKED_FIXTURE}")


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
    # Every file command but Save lives in the menu behind its chevron;
    # reaching one means opening that first, as a person would.
    if selector != "#btnFileMenu" and ev(ws, f"!!document.querySelector({json.dumps(selector)})?.closest('#fileMenu[hidden]')"):
        click(ws, "#btnFileMenu")
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


def markup_checks(ws):
    """Markups stay editable across a save and reopen, until flattened.

    Saved normally, a note is a real PDF annotation; opening the file again
    gives it back as a note. Flattened, it is paint. The thing most likely
    to go wrong quietly is a markup drawn twice — once by pdf.js from the
    file, once by the editor on top — which looks right until it is moved.
    """
    print("\n=== markups stay editable ===")

    made = ev(ws, """(async () => {
      const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
      const { state } = await import('./js/state.js'), view = await import('./js/view.js');
      tabs.openDocument();
      const buf = await (await fetch('./tests/browser/fixture.pdf')).arrayBuffer();
      await pages.importPdfBytes(buf, 'marked.pdf');
      const p = state.pages[0];
      p.annotations.push(
        { id: state.nextAnnoId++, type: 'text', x: 60, y: 80, width: 170, text: 'Naïve note — “quoted”', fontSize: 12, color: '#b23a3a' },
        { id: state.nextAnnoId++, type: 'callout', x: 250, y: 300, width: 170, text: 'Check this', fontSize: 12, color: '#1f6feb', tipX: 120, tipY: 420 },
        { id: state.nextAnnoId++, type: 'ink', color: '#1a7f37', size: 5, points: [{ x: 300, y: 500 }, { x: 340, y: 540 }, { x: 380, y: 500 }] });
      await view.renderMainCanvas();
      const { buildPdfBytes } = await import('./js/export.js');
      window.__marked = await buildPdfBytes();
      return { notes: document.querySelectorAll('.anno-box').length, strokes: document.querySelectorAll('.ink-stroke').length };
    })()""", awaitp=True)
    check("three markups on the page", made == {"notes": 2, "strokes": 1}, str(made))

    # What any other PDF program would make of the saved file.
    BLUE = "(d, i) => Math.abs(d[i] - 31) < 45 && Math.abs(d[i + 1] - 111) < 45 && Math.abs(d[i + 2] - 235) < 45"
    outside = ev(ws, """(async (bytes) => {
      const blue = %s;
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const page = await doc.getPage(1);
      const annots = await page.getAnnotations();
      const vp = page.getViewport({ scale: 1.5 });
      const draw = async (annotationMode) => {
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode }).promise;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0; for (let i = 0; i < d.length; i += 4) if (blue(d, i)) n++;
        return n;
      };
      return { kinds: annots.map((a) => a.subtype).sort(), text: annots.map((a) => a.contentsObj && a.contentsObj.str).filter(Boolean).sort(),
               withAnnots: await draw(pdfjsLib.AnnotationMode.ENABLE), pageOnly: await draw(pdfjsLib.AnnotationMode.DISABLE) };
    })(window.__marked)""" % BLUE, awaitp=True)
    check("saved as standard annotations", outside["kinds"] == ["FreeText", "FreeText", "Ink"], str(outside["kinds"]))
    check("carrying their text", outside["text"] == ["Check this", "Naïve note — “quoted”"], str(outside["text"]))
    check("another viewer draws them", outside["withAnnots"] > 50, f"{outside['withAnnots']} px of the callout's blue")
    check("and they are not part of the page itself", outside["pageOnly"] == 0, f"{outside['pageOnly']} px with annotations off")

    # Reopen it.
    page_blue = """(() => {
      const blue = %s;
      const c = document.getElementById('pageCanvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (blue(d, i)) n++;
      return n; })()""" % BLUE
    back = ev(ws, """(async () => {
      const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
      const { state } = await import('./js/state.js'), view = await import('./js/view.js');
      tabs.openDocument();
      await pages.importPdfBytes(window.__marked.slice().buffer, 'reopened.pdf');
      await view.renderMainCanvas();
      const p = state.pages[0];
      const pj = await state.sources[0].pdfjsDoc.getPage(1);
      return {
        status: document.getElementById('statusMsg').textContent,
        kinds: p.annotations.map((a) => a.type), text: p.annotations.map((a) => a.text || ''),
        ids: new Set(p.annotations.map((a) => a.id)).size,
        notes: document.querySelectorAll('.anno-box').length, strokes: document.querySelectorAll('.ink-stroke').length,
        inFile: (await pj.getAnnotations()).length,
        at: p.annotations.map((a) => a.type === 'ink' ? a.points[0].x : a.x),
      };
    })()""", awaitp=True)
    check("reopened, they are markups again", back["kinds"] == ["text", "callout", "ink"], str(back["kinds"]))
    check("with their text intact", back["text"][:2] == ["Naïve note — “quoted”", "Check this"], str(back["text"]))
    check("where they were put", back["at"] == [60, 250, 300], str(back["at"]))
    check("each one selectable on the page", back["notes"] == 2 and back["strokes"] == 1 and back["ids"] == 3, str(back))
    check("the status line says so", "3 editable markups" in back["status"], back["status"])
    check("pdf.js is not given a second copy to draw", back["inFile"] == 0, f"{back['inFile']} annotations left in the file")
    time.sleep(0.5)
    check("so nothing is drawn underneath the editable one", ev(ws, page_blue) == 0, f"{ev(ws, page_blue)} px of blue on the page canvas")
    shot(ws, "11-markups-reopened")

    # Edit one, delete one, save, reopen.
    again = ev(ws, """(async () => {
      const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
      const { state } = await import('./js/state.js'), annots = await import('./js/annots.js');
      const { buildPdfBytes } = await import('./js/export.js');
      const p = state.pages[0];
      p.annotations[0].text = 'Edited after reopening';
      p.annotations[0].x = 90;
      annots.deleteAnnotation(p, p.annotations[1].id);
      const bytes = await buildPdfBytes();
      tabs.openDocument();
      await pages.importPdfBytes(bytes.slice().buffer, 'third.pdf');
      const q = state.pages[0];
      return { kinds: q.annotations.map((a) => a.type), text: q.annotations[0].text, x: q.annotations[0].x };
    })()""", awaitp=True)
    check("an edit and a delete both survive the next save", again == {"kinds": ["text", "ink"], "text": "Edited after reopening", "x": 90}, str(again))

    # Flatten, through the button.
    ev(ws, """(() => {
      window.__flat = null;
      window.__realPicker = window.showSaveFilePicker;
      window.showSaveFilePicker = async (opts) => {
        const chunks = [];
        window.__flatName = opts && opts.suggestedName;
        return { name: 'flat.pdf', createWritable: async () => ({
          write: async (b) => { chunks.push(b); },
          close: async () => { window.__flat = new Uint8Array(await new Blob(chunks).arrayBuffer()); },
        }) };
      };
    })()""")
    before = ev(ws, "(async () => { const { state } = await import('./js/state.js'); return { name: state.docName, n: state.pages[0].annotations.length, handle: !!state.fileHandle }; })()", awaitp=True)
    stem = ev(ws, "(async()=>(await import('./js/state.js')).state.docName.replace(/\\.pdf$/i, ''))()", awaitp=True)
    click(ws, "#btnFlatten")
    wait_for(ws, "!!window.__flat", timeout=20, label="Flatten wrote a file")
    flat = ev(ws, """(async () => {
      const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
      const { state } = await import('./js/state.js'), view = await import('./js/view.js');
      const keep = { name: state.docName, n: state.pages[0].annotations.length, handle: !!state.fileHandle,
                     status: document.getElementById('statusMsg').textContent, suggested: window.__flatName };
      const doc = await pdfjsLib.getDocument({ data: window.__flat.slice() }).promise;
      const inFile = (await (await doc.getPage(1)).getAnnotations()).length;
      tabs.openDocument();
      await pages.importPdfBytes(window.__flat.slice().buffer, 'flat.pdf');
      await view.renderMainCanvas();
      window.showSaveFilePicker = window.__realPicker;
      return { keep, inFile, editable: state.pages[0].annotations.length, notes: document.querySelectorAll('.anno-box').length };
    })()""", awaitp=True)
    check("Flatten offers a name of its own, beside the original's",
          flat["keep"]["suggested"] == f"{stem} - flattened.pdf", str(flat["keep"]["suggested"]))
    check("the flattened copy holds no annotations", flat["inFile"] == 0, f"{flat['inFile']}")
    check("reopened, nothing in it can be edited", flat["editable"] == 0 and flat["notes"] == 0, str(flat))
    time.sleep(0.5)
    red = """(() => { const c = document.getElementById('pageCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 178) < 45 && Math.abs(d[i + 1] - 58) < 45 && Math.abs(d[i + 2] - 58) < 45) n++; return n; })()"""
    check("but the markups are there, painted into the page", ev(ws, red) > 50, f"{ev(ws, red)} px of the note's red")
    check("the open document kept its markups and its identity",
          {k: flat["keep"][k] for k in ("name", "n", "handle")} == before, f"{flat['keep']} vs {before}")
    shot(ws, "12-flattened")


def typing_checks(ws):
    """⌘S while a note is still being typed into.

    A note's text is committed when its box loses focus and nowhere else,
    and ⌘S runs straight off the keystroke (main.js) — with a file handle
    already granted, nothing in the save path takes the focus away. So the
    bytes written were the text from before the edit, and the document was
    then marked clean: work gone, and beforeunload no longer warning about
    it. The other half is the same gap on screen: until the first
    keystroke marked the document dirty, an edit to a note on a clean
    document was work the save chip did not count.
    """
    print("\n=== a note being typed into, and the save ===")

    def mouse(kind, x, y):
        ws.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left",
                                             "buttons": 0 if kind == "mouseReleased" else 1, "clickCount": 1})

    def tap(x, y):
        mouse("mousePressed", x, y)
        mouse("mouseReleased", x, y)
        time.sleep(0.25)

    def typed(text):
        ws.call("Input.insertText", {"text": text})
        time.sleep(0.2)

    def to_client(x, y):
        g = ev(ws, """(async()=>{const {state}=await import('./js/state.js');
          const r=document.getElementById('pageCanvas').getBoundingClientRect();
          return {l:r.left,t:r.top,s:state.currentScale}})()""", awaitp=True)
        return g["l"] + x * g["s"], g["t"] + y * g["s"]

    ST = """(async () => {
      const { state } = await import('./js/state.js');
      const p = state.pages.find((x) => x.id === state.selectedPageId);
      const box = document.querySelector('.anno-box .anno-text');
      return {
        dirty: state.dirty,
        texts: p ? p.annotations.map((a) => a.text) : [],
        onScreen: box ? box.innerText : '',
        editing: !!document.querySelector('.anno-box.editing'),
        focused: document.activeElement.classList.contains('anno-text'),
        chip: document.getElementById('saveChipText').textContent,
        warns: document.getElementById('saveChip').classList.contains('unsaved'),
        status: document.getElementById('statusMsg').textContent,
        writes: window.__w.writes,
      };
    })()"""
    st = lambda: ev(ws, ST, awaitp=True)

    # One document, from a file, with somewhere to save to. The sections
    # before this one leave tabs open with work in them, and the chip
    # answers for every tab there is.
    ev(ws, """(() => {
      window.confirm = () => true;
      let guard = 0;
      while (guard++ < 40) {
        const close = document.querySelector('#tabStrip .tab .tab-close');
        if (!close) break;
        close.click();
        if (document.querySelectorAll('#tabStrip .tab').length === 1
            && !document.querySelector('#tabStrip .tab-dot')) break;
      }
    })()""")
    time.sleep(0.6)

    # A save panel of this section's own, and the bytes of each write kept
    # apart: what matters here is what the *last* one holds.
    ev(ws, """(async () => {
      window.__w = { writes: 0, bytes: null };
      window.__realPicker = window.showSaveFilePicker;
      window.showSaveFilePicker = async () => {
        const h = { kind: 'file', name: 'typed.pdf' };
        const def = (k, v) => Object.defineProperty(h, k, { value: v, enumerable: false });
        def('queryPermission', async () => 'granted');
        def('requestPermission', async () => 'granted');
        def('createWritable', async () => {
          const chunks = [];
          return {
            write: async (d) => { chunks.push(d instanceof Blob ? new Uint8Array(await d.arrayBuffer()) : new Uint8Array(d.buffer || d)); },
            close: async () => {
              window.__w.bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
              window.__w.writes++;
            },
          };
        });
        return h;
      };
      window.__textsInWritten = async () => {
        const doc = await pdfjsLib.getDocument({ data: window.__w.bytes.slice() }).promise;
        const pg = await doc.getPage(1);
        return (await pg.getAnnotations()).map((a) => a.contentsObj && a.contentsObj.str).filter(Boolean);
      };
      const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
      const view = await import('./js/view.js');
      tabs.openDocument();
      const buf = await (await fetch('./tests/browser/fixture.pdf')).arrayBuffer();
      await pages.importPdfBytes(buf, 'typed.pdf');
      view.setZoomMode('fit-width');
      await view.renderMainCanvas();
    })()""", awaitp=True)
    time.sleep(0.8)

    # Place a note, finish it, and save: from here the document has a file
    # and ⌘S writes straight back to it, which is the case that lost work.
    click(ws, "#toolText")
    tap(*stage_point(ws, 0.25, 0.2))
    typed("first draft")
    key(ws, "Enter", "Enter", 13, meta=True)
    key(ws, "s", "KeyS", 83, meta=True)
    wait_for(ws, "window.__w.writes === 1", label="the first save wrote the file")
    s = st()
    check("a note typed and saved is on disk", s["texts"] == ["first draft"] and s["dirty"] is False
          and s["chip"].startswith("Saved ") and s["warns"] is False, f"{s['texts']} {s['chip']!r}")

    # Open it again and type into it, without clicking away afterwards.
    note = ev(ws, """(async () => { const { state } = await import('./js/state.js');
      const a = state.pages.find((p) => p.id === state.selectedPageId).annotations[0];
      return { x: a.x, y: a.y }; })()""", awaitp=True)
    nx, ny = to_client(note["x"] + 8, note["y"] + 8)
    tap(nx, ny)                      # select it
    tap(nx, ny)                      # already selected: this opens it for typing
    check("a note on the page opens for typing", st()["editing"] is True and st()["focused"] is True)
    typed(" — revised on site")
    s = st()
    check("the first keystroke makes the document unsaved", s["dirty"] is True
          and "unsaved" in s["chip"].lower() and s["warns"] is True, f"{s['dirty']} {s['chip']!r}")
    check("while the typed text is still only on screen", s["texts"] == ["first draft"]
          and s["onScreen"] == "first draft — revised on site", f"{s['texts']} / {s['onScreen']!r}")

    # ⌘S with the caret still in the box.
    key(ws, "s", "KeyS", 83, meta=True)
    wait_for(ws, "window.__w.writes === 2", label="⌘S wrote the file again")
    s = st()
    check("⌘S finishes the note before it writes", s["editing"] is False and s["focused"] is False
          and s["texts"] == ["first draft — revised on site"], f"{s['editing']} {s['texts']}")
    written = ev(ws, "window.__textsInWritten()", awaitp=True)
    check("so the file holds the text as typed, not as it was before the edit",
          written == ["first draft — revised on site"], str(written))
    s = st()
    check("and only then is the document clean again",
          s["dirty"] is False and s["chip"].startswith("Saved ") and s["warns"] is False,
          f"{s['dirty']} {s['chip']!r}")
    shot(ws, "26-typed-then-saved")
    ev(ws, "window.showSaveFilePicker = window.__realPicker")


def surface_checks(ws):
    """The command surface, driven the way a person drives it: undo for
    every action, tools that are used once, the four shape tools, one Save,
    a save state said in words, and a failed save that does not fade."""
    print("\n=== undo, one-shot tools and the command surface ===")

    ST = """(async () => {
      const { state } = await import('./js/state.js');
      const { historyStatus } = await import('./js/history.js');
      const p = state.pages.find((x) => x.id === state.selectedPageId);
      return {
        tool: state.activeTool, sel: state.selectedAnnoId, dirty: state.dirty,
        pages: state.pages.length, page: state.pages.indexOf(p), rot: p ? p.rotation : null,
        annos: p ? p.annotations.map((a) => ({ id: a.id, type: a.type, text: a.text, x: a.x, y: a.y,
          width: a.width, fill: a.fill, fit: a.fit, size: a.size, color: a.color, points: a.points })) : [],
        hist: historyStatus(), name: state.docName,
        chip: document.getElementById('saveChipText').textContent,
        chipShown: !document.getElementById('saveChip').hidden,
        label: document.getElementById('propsLabel').textContent,
        status: document.getElementById('statusMsg').textContent,
      };
    })()"""
    st = lambda: ev(ws, ST, awaitp=True)
    shown = lambda i: ev(ws, f"getComputedStyle(document.getElementById('{i}')).display") != "none"

    def mouse(kind, x, y):
        ws.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left",
                                             "buttons": 0 if kind == "mouseReleased" else 1, "clickCount": 1})

    def tap(x, y):
        mouse("mousePressed", x, y)
        mouse("mouseReleased", x, y)
        time.sleep(0.2)

    def drag(a, b, steps=8):
        mouse("mousePressed", *a)
        for i in range(1, steps + 1):
            mouse("mouseMoved", a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps)
            time.sleep(0.015)
        mouse("mouseReleased", *b)
        time.sleep(0.25)

    def typed(text):
        ws.call("Input.insertText", {"text": text})
        time.sleep(0.15)

    def to_client(x, y):
        """Page points -> viewport pixels."""
        g = ev(ws, """(async()=>{const {state}=await import('./js/state.js');
          const r=document.getElementById('pageCanvas').getBoundingClientRect();
          return {l:r.left,t:r.top,s:state.currentScale}})()""", awaitp=True)
        return g["l"] + x * g["s"], g["t"] + y * g["s"]

    esc = lambda: key(ws, "Escape", "Escape", 27)
    undo = lambda: key(ws, "z", "KeyZ", 90, meta=True)
    redo = lambda: key(ws, "z", "KeyZ", 90, meta=True, shift=True)

    # The markup section left its documents open, each with unsaved edits.
    # This one is about the command surface of a single document — and the
    # save chip now answers for every tab there is — so they are closed
    # first, through the close button, the way a person would.
    ev(ws, """(() => {
      window.confirm = () => true;
      // Every one of them: closing the last leaves a fresh empty
      // document behind, which is what this section wants to start from.
      let guard = 0;
      while (guard++ < 40) {
        const close = document.querySelector('#tabStrip .tab .tab-close');
        if (!close) break;
        close.click();
        if (document.querySelectorAll('#tabStrip .tab').length === 1
            && !document.querySelector('#tabStrip .tab-dot')) break;
      }
      return document.querySelectorAll('#tabStrip .tab').length;
    })()""")
    time.sleep(0.6)

    ev(ws, """(async () => {
      const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
      const view = await import('./js/view.js');
      tabs.openDocument();
      const buf = await (await fetch('./tests/browser/fixture.pdf')).arrayBuffer();
      await pages.importPdfBytes(buf, 'surface.pdf');
      view.setZoomMode('fit-width');
      await view.renderMainCanvas();
      // Nothing here may ask "are you sure?": undo is the way back.
      window.__confirms = 0;
      window.confirm = () => { window.__confirms++; return true; };
    })()""", awaitp=True)
    time.sleep(0.8)

    # --- opening a file is not a change to it ---
    s = st()
    check("a file opened into an empty document takes its name", s["name"] == "surface.pdf", s["name"])
    check("and is not unsaved work", s["dirty"] is False and s["chip"] == "No unsaved changes", f"{s['dirty']} {s['chip']!r}")
    check("with nothing to undo", s["hist"]["canUndo"] is False
          and ev(ws, "document.getElementById('btnUndo').disabled") is True)
    check("the page field says where you are",
          ev(ws, "document.getElementById('pageInput').value + ' ' + document.getElementById('pageTotal').textContent") == "1 / 3",
          ev(ws, "document.getElementById('pageInput').value + ' ' + document.getElementById('pageTotal').textContent"))
    check("the properties row is empty until there is something to style",
          shown("propsNone") and not shown("colorGrp") and not shown("fontSizeGrp") and not shown("penSizeGrp"))

    # --- a tool is used once, then goes back ---
    click(ws, "#toolText")
    check("picking a tool brings its properties and says what it will do",
          shown("colorGrp") and shown("fontSizeGrp") and shown("fillGrp") and shown("armedNote") and not shown("penSizeGrp"))
    check("and says, once, what the tool does",
          "drag to set its width" in ev(ws, "document.getElementById('armedText').textContent") and not shown("placeHint"),
          ev(ws, "document.getElementById('armedText').textContent"))
    check("the tools are a labelled group, not a toolbar that would owe arrow-key focus",
          ev(ws, "document.querySelector('#pageToolbar .tools').getAttribute('role')") == "group")
    tap(*stage_point(ws, 0.2, 0.15))
    typed("First")
    s = st()
    check("placing a note puts the tool back, while the note is still being typed",
          s["tool"] == "select" and len(s["annos"]) == 1 and ev(ws, "!!document.querySelector('.anno-box.editing')") is True
          and ev(ws, "document.getElementById('toolText').classList.contains('toggled')") is False
          and ev(ws, "document.getElementById('toolSelect').classList.contains('toggled')") is True and not shown("armedNote"),
          f"{s['tool']}, {len(s['annos'])}")
    tap(*stage_point(ws, 0.7, 0.15))
    s = st()
    check("the click that ends the typing places nothing", [a["text"] for a in s["annos"]] == ["First"] and s["sel"] is None, str(s["annos"]))
    tap(*stage_point(ws, 0.7, 0.15))
    check("and neither does the one after it: the tool was used", len(st()["annos"]) == 1)
    click(ws, "#toolText")
    tap(*stage_point(ws, 0.7, 0.15))
    typed("Second")
    esc()
    s = st()
    check("picking the tool again places the next", [a["text"] for a in s["annos"]] == ["First", "Second"] and s["tool"] == "select", str(s))
    check("placing and typing a note is one step to undo", s["hist"]["changes"] == 2, str(s["hist"]))

    click(ws, "#toolText")
    tap(*stage_point(ws, 0.45, 0.28))
    esc()
    s = st()
    check("a note placed and left empty is taken away", len(s["annos"]) == 2)
    check("and leaves nothing to undo", s["hist"]["changes"] == 2 and s["hist"]["undoLabel"] == "Add note", str(s["hist"]))

    # Dragging with the text tool sets the width; a click still drops the default.
    click(ws, "#toolText")
    a, b = stage_point(ws, 0.15, 0.3), stage_point(ws, 0.55, 0.34)
    scale = ev(ws, "(async()=>(await import('./js/state.js')).state.currentScale)()", awaitp=True)
    # Mid-drag, pulled a long way down: the outline must show the note
    # that will appear — one line high — not a tall box it would discard.
    mouse("mousePressed", *a)
    for i in range(1, 9):
        mouse("mouseMoved", a[0] + (b[0] - a[0]) * i / 8, a[1] + 160 * i / 8)
        time.sleep(0.015)
    ghost = ev(ws, "(g => g ? {h: g.offsetHeight, w: g.offsetWidth, top: g.getBoundingClientRect().top} : null)(document.querySelector('.note-ghost'))")
    mouse("mouseMoved", *b)
    mouse("mouseReleased", *b)
    time.sleep(0.25)
    check("the outline while dragging is one line high, however far down the pointer goes",
          ghost is not None and ghost["h"] < 40 * scale and abs(ghost["top"] - a[1]) < 2, str(ghost))
    typed("Sized by dragging")
    esc()
    s = st()
    want = (b[0] - a[0]) / scale
    got = s["annos"][-1]["width"] if len(s["annos"]) == 3 else None
    check("dragging the text tool draws a box of that width", got is not None and abs(got - want) < 2, f"{got} vs {want:.1f}")
    check("a clicked one keeps the default width", s["annos"][0]["width"] == 170, str(s["annos"][0]["width"]))
    box_h = ev(ws, "document.querySelectorAll('.anno-box')[2].offsetHeight")
    check("and the note that appears is the one the outline showed", abs(box_h - ghost["h"]) <= 3 and abs(s["annos"][-1]["y"] - (a[1] - to_client(0, 0)[1]) / scale) < 1,
          f"box {box_h} vs ghost {ghost['h']}")

    click(ws, "#toolCallout")
    tap(*stage_point(ws, 0.12, 0.62))
    check("mid-callout, the next step is said where the pointer is",
          shown("placeHint") and "note itself" in ev(ws, "document.getElementById('placeHint').textContent"))

    # Between the two clicks the whole callout is drawn, following the
    # pointer: leader, arrowhead and the note's outline.
    PREVIEW = """(() => {
      const vis = (el) => !!el && el.style.display !== 'none';
      const dot = document.querySelector('circle.callout-preview');
      const lines = [...document.querySelectorAll('line.callout-preview')];
      const box = document.querySelector('.note-ghost.callout-preview');
      const c = document.getElementById('pageCanvas').getBoundingClientRect();
      const n = (el, k) => Number(el.getAttribute(k));
      return {
        dot: vis(dot), lines: lines.filter(vis).length, box: vis(box),
        tip: lines[0] ? [n(lines[0], 'x2') + c.left, n(lines[0], 'y2') + c.top] : null,
        from: lines[0] ? [n(lines[0], 'x1'), n(lines[0], 'y1')] : null,
        boxAt: box ? [box.getBoundingClientRect().left, box.getBoundingClientRect().top] : null,
        hit: box ? getComputedStyle(box).pointerEvents : null,
      };
    })()"""
    tip_at, box_at = stage_point(ws, 0.12, 0.62), stage_point(ws, 0.3, 0.5)
    pv = ev(ws, PREVIEW)
    check("the first click marks the tip", pv["dot"] is True and pv["lines"] == 0, str(pv))
    for i in range(1, 7):
        ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "button": "none", "buttons": 0,
                "x": tip_at[0] + (box_at[0] - tip_at[0]) * i / 6, "y": tip_at[1] + (box_at[1] - tip_at[1]) * i / 6})
        time.sleep(0.02)
    pv = ev(ws, PREVIEW)
    check("moving the pointer draws the whole leader, with its jog, its arrowhead and the note's outline",
          pv["lines"] == 4 and pv["box"] is True and pv["dot"] is False, str(pv))
    check("the leader ends on the tip, and the outline sits at the pointer",
          abs(pv["tip"][0] - tip_at[0]) < 1.5 and abs(pv["tip"][1] - tip_at[1]) < 1.5
          and abs(pv["boxAt"][0] - box_at[0]) < 1.5 and abs(pv["boxAt"][1] - box_at[1]) < 1.5, str(pv))
    check("and nothing in the preview is in the way of the second click", pv["hit"] == "none")
    shot(ws, "09a-callout-preview")
    tap(*box_at)
    placed = ev(ws, """(() => {
      const l = [...document.querySelectorAll('#leaderSvg line')].find((n) => !n.classList.contains('callout-preview'));
      return { from: [Number(l.getAttribute('x1')), Number(l.getAttribute('y1'))], preview: document.querySelectorAll('.callout-preview').length };
    })()""")
    check("the callout that is placed is the one that was shown",
          abs(placed["from"][0] - pv["from"][0]) < 1.5 and abs(placed["from"][1] - pv["from"][1]) < 1.5, f"{placed['from']} vs {pv['from']}")
    check("and the preview is gone", placed["preview"] == 0)
    # The leader meets the note on a short level run — the jog — and only
    # then heads for the tip.
    jog = ev(ws, """(async () => {
      const { state, LEADER_JOG } = await import('./js/state.js');
      const a = state.pages.find((p) => p.id === state.selectedPageId).annotations.at(-1);
      const r = state.domRefs[a.id], n = (el, k) => Number(el.getAttribute(k)), s = state.currentScale;
      return { x1: n(r.jogEl, 'x1'), y1: n(r.jogEl, 'y1'), x2: n(r.jogEl, 'x2'), y2: n(r.jogEl, 'y2'),
               kx: n(r.lineEl, 'x1'), ky: n(r.lineEl, 'y1'), boxLeft: a.x * s, boxMid: a.y * s + r.boxEl.offsetHeight / 2, want: LEADER_JOG * s };
    })()""", awaitp=True)
    check("the leader leaves the note on a level jog", abs(jog["y1"] - jog["y2"]) < 0.01 and abs(abs(jog["x2"] - jog["x1"]) - jog["want"]) < 0.5,
          str(jog))
    check("from the middle of the side facing the tip", abs(jog["x1"] - jog["boxLeft"]) < 0.5 and abs(jog["y1"] - jog["boxMid"]) < 0.5 and jog["x2"] < jog["x1"], str(jog))
    check("and turns for the tip at the knee", abs(jog["x2"] - jog["kx"]) < 0.01 and abs(jog["y2"] - jog["ky"]) < 0.01)
    typed("One")
    check("a placed callout puts its tool back too", st()["tool"] == "select" and not shown("placeHint"))
    tap(*stage_point(ws, 0.9, 0.9))                    # ends the typing
    click(ws, "#toolCallout")
    tap(*stage_point(ws, 0.5, 0.62)); tap(*stage_point(ws, 0.68, 0.5)); typed("Two")
    tap(*stage_point(ws, 0.9, 0.9))                    # a note keeps its text when it loses focus
    s = st()
    check("a second callout takes a second pick of the tool",
          [a["text"] for a in s["annos"] if a["type"] == "callout"] == ["One", "Two"] and s["tool"] == "select", str(s["annos"]))
    esc()

    # --- highlight, arrow, box, cloud ---
    for tool, a, b in (("toolArrow", (0.2, 0.7), (0.4, 0.66)), ("toolRect", (0.5, 0.68), (0.7, 0.78)),
                       ("toolCloud", (0.15, 0.82), (0.45, 0.95)), ("toolHighlight", (0.55, 0.86), (0.85, 0.87))):
        click(ws, "#" + tool)
        drag(stage_point(ws, *a), stage_point(ws, *b))
    s = st()
    kinds = [a["type"] for a in s["annos"]]
    check("each shape tool draws its own kind of markup", kinds[-4:] == ["arrow", "rect", "cloud", "highlight"], str(kinds))
    check("an arrow, a box and a cloud are two points", all(len(a["points"]) == 2 for a in s["annos"][-4:-1]))
    check("a highlight is a path, broad and in its own colour",
          len(s["annos"][-1]["points"]) >= 3 and s["annos"][-1]["size"] >= 8 and s["annos"][-1]["color"] == "#e3b505",
          str(s["annos"][-1]))
    hl = ev(ws, """(() => {
      const svg = document.getElementById('hiliteSvg');
      return { n: svg.querySelectorAll('.ink-stroke').length, blend: getComputedStyle(svg).mixBlendMode,
               inLeader: document.querySelectorAll('#leaderSvg .ink-stroke[stroke="#e3b505"]').length };
    })()""")
    check("it multiplies with the sheet instead of covering it", hl == {"n": 1, "blend": "multiply", "inLeader": 0}, str(hl))
    check("a drawing tool goes back after one use, leaving what it drew selected",
          s["tool"] == "select" and s["sel"] == s["annos"][-1]["id"] and s["label"] == "Highlight"
          and ev(ws, "document.querySelectorAll('.ink-halo').length") == 1, f"{s['tool']}, sel {s['sel']}, {s['label']}")
    drag(stage_point(ws, 0.6, 0.42), stage_point(ws, 0.8, 0.42))
    check("so a second drag draws nothing", len(st()["annos"]) == len(kinds), str(len(st()["annos"])))
    click(ws, "#toolHighlight")
    check("a freehand tool is told to draw, not to place",
          ev(ws, "document.getElementById('armedText').textContent").startswith("draw"), ev(ws, "document.getElementById('armedText').textContent"))
    click(ws, "#toolArrow")
    tap(*stage_point(ws, 0.9, 0.3))
    check("a click with a two-point tool draws nothing", len(st()["annos"]) == len(kinds))
    check("and leaves it in hand: it has not been used yet", st()["tool"] == "arrow")
    for k, code, vk, tool in (("h", "KeyH", 72, "highlight"), ("a", "KeyA", 65, "arrow"), ("r", "KeyR", 82, "rect"),
                              ("c", "KeyC", 67, "cloud"), ("v", "KeyV", 86, "select")):
        key(ws, k, code, vk)
        if st()["tool"] != tool:
            check(f"{k.upper()} picks the {tool} tool", False, st()["tool"])
            break
    else:
        check("H, A, R, C and V pick their tools", True)
    shot(ws, "09-surface")

    # --- undo and redo ---
    before = st()
    undo()
    s = st()
    check("⌘Z undoes the last markup", [a["type"] for a in s["annos"]] == kinds[:-1], str([a["type"] for a in s["annos"]]))
    check("and the count of unsaved changes follows", s["hist"]["changes"] == before["hist"]["changes"] - 1
          and f"{s['hist']['changes']} unsaved changes" in s["chip"], f"{s['hist']} {s['chip']!r}")
    check("and says what it undid", "highlight" in s["status"].lower(), s["status"])
    redo()
    check("⇧⌘Z brings it back", st()["annos"] == before["annos"])
    check("the buttons do the same", ev(ws, "document.getElementById('btnUndo').disabled") is False)
    click(ws, "#btnUndo")
    check("Undo button undoes", len(st()["annos"]) == len(kinds) - 1)
    click(ws, "#btnRedo")
    check("Redo button redoes", st()["annos"] == before["annos"])

    click(ws, "#btnRotateCW")
    time.sleep(0.6)
    turned = st()
    undo()
    time.sleep(0.6)
    s = st()
    check("a rotated page is un-rotated, markups and all", turned["rot"] == 90 and s["rot"] == 0 and s["annos"] == before["annos"],
          f"{turned['rot']} -> {s['rot']}")

    click(ws, "#btnDeletePage")
    time.sleep(0.6)
    gone = st()
    check("a page is deleted without asking", gone["pages"] == 2 and ev(ws, "window.__confirms") == 0, f"{gone['pages']} pages")
    check("and says how to get it back", "brings it back" in gone["status"], gone["status"])
    undo()
    time.sleep(0.8)
    s = st()
    check("⌘Z brings the page back, with its markups", s["pages"] == 3 and s["page"] == 0 and s["annos"] == before["annos"], f"{s['pages']} pages, on {s['page']}")
    check("and its thumbnail", ev(ws, "document.querySelectorAll('#thumbList .thumb').length") == 3)

    click(ws, "#btnClearAll")
    time.sleep(0.5)
    cleared = st()
    check("Clear All empties the document without asking", cleared["pages"] == 0 and ev(ws, "window.__confirms") == 0)
    undo()
    time.sleep(0.8)
    s = st()
    check("and ⌘Z brings all of it back", s["pages"] == 3 and s["name"] == "surface.pdf" and s["annos"] == before["annos"],
          f"{s['pages']} pages, {s['name']}")

    # Inside a note ⌘Z belongs to the text, not the document.
    x, y = to_client(s["annos"][0]["x"] + 20, s["annos"][0]["y"] + 10)
    tap(x, y); tap(x, y)                                # select, then edit
    check("a second click on a selected note opens it", ev(ws, "!!document.querySelector('.anno-box.editing')") is True)
    undo()
    check("⌘Z while typing leaves the document's history alone", st()["hist"] == s["hist"], str(st()["hist"]))
    typed(" note")
    esc()
    s2 = st()
    check("an edit to a note is one step", s2["annos"][0]["text"] == "First note" and s2["hist"]["undoLabel"] == "Edit note"
          and s2["hist"]["changes"] == s["hist"]["changes"] + 1, f"{s2['annos'][0]['text']!r} {s2['hist']}")
    undo()
    check("which undo takes back", st()["annos"][0]["text"] == "First")
    redo()

    # --- the selected markup: fill, duplicate, copy and paste ---
    tap(x, y)
    s = st()
    check("selecting a note shows what can be changed about it",
          s["label"] == "Text" and shown("fillGrp") and shown("btnDuplicate") and shown("btnDeleteAnno")
          and not shown("armedNote") and not shown("penSizeGrp"), s["label"])
    check("a note has a white fill by default", ev(ws, "document.getElementById('fillToggle').checked") is True
          and ev(ws, "getComputedStyle(document.querySelector('.anno-box.selected')).backgroundColor") == "rgb(255, 255, 255)",
          ev(ws, "getComputedStyle(document.querySelector('.anno-box.selected')).backgroundColor"))
    # Brushing a handle is not an edit: no step to undo, no unsaved change.
    quiet = st()["hist"]
    rz = ev(ws, "(r => ({x: r.left + r.width / 2, y: r.top + r.height / 2}))(document.querySelector('.anno-box.selected .anno-resize').getBoundingClientRect())")
    mouse("mousePressed", rz["x"], rz["y"]); mouse("mouseMoved", rz["x"] + 2, rz["y"] + 1); mouse("mouseReleased", rz["x"] + 2, rz["y"] + 1)
    time.sleep(0.2)
    check("a twitch on the resize handle changes nothing", st()["hist"] == quiet and st()["annos"][0]["width"] == 170, str(st()["hist"]))
    drag((rz["x"], rz["y"]), (rz["x"] + 30, rz["y"]))
    s3 = st()
    check("a real drag on it resizes, as one step", s3["annos"][0]["width"] > 180 and s3["hist"]["undoLabel"] == "Resize note"
          and s3["hist"]["changes"] == quiet["changes"] + 1, f"{s3['annos'][0]['width']} {s3['hist']}")
    undo()
    callout = next(a for a in st()["annos"] if a["type"] == "callout")
    tap(*to_client(callout["x"] + 20, callout["y"] + 10))
    tip = ev(ws, "(r => ({x: r.left + r.width / 2, y: r.top + r.height / 2}))([...document.querySelectorAll('.tip-handle')].find((n) => n.style.display !== 'none').getBoundingClientRect())")
    quiet = st()["hist"]
    mouse("mousePressed", tip["x"], tip["y"]); mouse("mouseMoved", tip["x"] + 1, tip["y"] + 2); mouse("mouseReleased", tip["x"] + 1, tip["y"] + 2)
    time.sleep(0.2)
    check("nor does a twitch on a leader's tip", st()["hist"] == quiet, str(st()["hist"]))
    esc()
    tap(x, y)

    click(ws, "#fillToggle")
    check("which can be turned off", st()["annos"][0]["fill"] is False
          and ev(ws, "getComputedStyle(document.querySelector('.anno-box.selected')).backgroundColor") == "rgba(0, 0, 0, 0)",
          ev(ws, "getComputedStyle(document.querySelector('.anno-box.selected')).backgroundColor"))
    # The checkbox has focus now. It is not a place to type.
    key(ws, "d", "KeyD", 68, meta=True)
    s = st()
    dup = s["annos"][-1]
    check("⌘D duplicates the selected markup, just off the original",
          len(s["annos"]) == len(kinds) + 1 and dup["text"] == "First note" and dup["fill"] is False
          and abs(dup["x"] - s["annos"][0]["x"] - 12) < 0.01 and s["sel"] == dup["id"], str(dup))
    key(ws, "c", "KeyC", 67, meta=True)
    click(ws, "#btnNextPage")
    time.sleep(0.6)
    key(ws, "v", "KeyV", 86, meta=True)
    s = st()
    check("⌘C then ⌘V puts the same note on another page, in the same place",
          s["page"] == 1 and len(s["annos"]) == 1 and s["annos"][0]["text"] == "First note"
          and abs(s["annos"][0]["x"] - dup["x"]) < 0.01, str(s["annos"]))
    key(ws, "v", "KeyV", 86, meta=True)
    s = st()
    check("pasting twice does not stack one exactly on the other",
          len(s["annos"]) == 2 and abs(s["annos"][1]["x"] - s["annos"][0]["x"]) > 5, str([a["x"] for a in s["annos"]]))

    # --- where you are ---
    click(ws, "#pageInput")
    typed("3")
    key(ws, "Enter", "Enter", 13)
    time.sleep(0.6)
    check("typing a page number goes to it", st()["page"] == 2, str(st()["page"]))
    click(ws, "#btnPrevPage")
    time.sleep(0.5)
    check("the arrow beside it steps back", st()["page"] == 1)
    click(ws, "#pageInput")
    typed("99")
    key(ws, "Enter", "Enter", 13)
    time.sleep(0.6)
    check("a number past the end goes to the last page",
          st()["page"] == 2 and ev(ws, "document.getElementById('pageInput').value") == "3",
          f"{st()['page']} / {ev(ws, 'document.getElementById(\'pageInput\').value')}")
    check("with nothing further to step to", ev(ws, "document.getElementById('btnNextPage').disabled") is True)

    # --- every markup, in one list ---
    total = ev(ws, "(async()=>(await import('./js/state.js')).state.pages.reduce((n,p)=>n+p.annotations.length,0))()", awaitp=True)
    check("the Markups button counts them all", ev(ws, "document.getElementById('markupCount').textContent") == str(total), str(total))
    stage_w = ev(ws, "document.getElementById('canvasStage').clientWidth")
    click(ws, "#btnMarkups")
    time.sleep(0.6)
    rows = ev(ws, """(() => ({
      rows: document.querySelectorAll('#markupList .markup-row').length,
      heads: [...document.querySelectorAll('#markupList .markup-page')].map((n) => n.textContent),
      first: document.querySelector('#markupList .markup-row').textContent,
    }))()""")
    check("and opens a list of every one, by page", rows["rows"] == total and rows["heads"] == ["PG 1", "PG 2"], str(rows))
    check("a note is listed by what it says", "First note" in rows["first"], rows["first"])
    check("the sheet gives up the width", ev(ws, "document.getElementById('canvasStage').clientWidth") < stage_w)
    click(ws, "#markupList .markup-row")
    time.sleep(0.9)
    s = st()
    check("clicking one goes to its page and selects it", s["page"] == 0 and s["sel"] == s["annos"][0]["id"]
          and ev(ws, "!!document.querySelector('.anno-box.selected')") is True, f"page {s['page']}, sel {s['sel']}")
    check("and marks it in the list", ev(ws, "document.querySelectorAll('#markupList .markup-row.current').length") == 1)
    click(ws, "#btnCloseMarkups")
    time.sleep(0.6)
    esc()

    # --- a shape, selected: its weight, moving it, reshaping it ---
    s = st()
    box = next(a for a in s["annos"] if a["type"] == "rect")
    x0, x1 = sorted(p["x"] for p in box["points"])
    y0, y1 = sorted(p["y"] for p in box["points"])
    edge = to_client((x0 + x1) / 2, y0)
    tap(*edge)
    s = st()
    check("clicking a shape's line selects it", s["sel"] == box["id"] and s["label"] == "Box", f"{s['sel']} {s['label']}")
    check("and offers a weight rather than a text size", shown("penSizeGrp") and not shown("fontSizeGrp") and not shown("fillGrp"))
    check("with a handle on each of its two points", ev(ws, "document.querySelectorAll('#leaderSvg .pt-handle').length") == 2)
    click(ws, "#penSizeGrp .pen-dot:last-child")
    check("the weight applies to the selected shape", next(a for a in st()["annos"] if a["id"] == box["id"])["size"] == 5)
    scale = ev(ws, "(async()=>(await import('./js/state.js')).state.currentScale)()", awaitp=True)
    drag(edge, (edge[0] + 40, edge[1] - 30))
    moved = next(a for a in st()["annos"] if a["id"] == box["id"])
    dx = [m["x"] - p["x"] for m, p in zip(moved["points"], box["points"])]
    dy = [m["y"] - p["y"] for m, p in zip(moved["points"], box["points"])]
    check("dragging a shape moves all of it", all(abs(d - 40 / scale) < 0.6 for d in dx) and all(abs(d + 30 / scale) < 0.6 for d in dy),
          f"dx {dx} dy {dy} want {40 / scale:.1f}, {-30 / scale:.1f}")
    check("and it is still selected afterwards", st()["sel"] == box["id"])
    corner = to_client(moved["points"][1]["x"], moved["points"][1]["y"])
    drag(corner, (corner[0] + 30, corner[1] + 20))
    shaped = next(a for a in st()["annos"] if a["id"] == box["id"])
    check("dragging a handle moves just that point",
          abs(shaped["points"][1]["x"] - moved["points"][1]["x"] - 30 / scale) < 0.6
          and shaped["points"][0] == moved["points"][0], str(shaped["points"]))
    undo(); undo()
    check("both of which undo", next(a for a in st()["annos"] if a["id"] == box["id"])["points"] == box["points"])
    esc()

    # --- one Save; everything else behind it ---
    menu = ev(ws, """(() => ({
      hidden: document.getElementById('fileMenu').hidden,
      primaries: [...document.querySelectorAll('header button.primary')].map((b) => b.id),
      loose: ['btnSaveAs', 'btnDownload', 'btnFlatten', 'btnOpen', 'btnOpenTabs', 'btnClearAll']
        .filter((id) => !document.getElementById(id).closest('#fileMenu')),
      flatten: document.getElementById('btnFlatten').textContent.trim(),
    }))()""")
    check("Save is the one primary action", menu["primaries"] == ["btnSave", "btnFileMenu"] and menu["hidden"] is True, str(menu))
    check("every other file command is in its menu", menu["loose"] == [], str(menu["loose"]))
    check("Flatten is named for what it does", menu["flatten"].startswith("Save Flattened Copy"), menu["flatten"])
    click(ws, "#btnFileMenu")
    check("the chevron opens the menu", ev(ws, "document.getElementById('fileMenu').hidden") is False
          and ev(ws, "document.getElementById('btnFileMenu').getAttribute('aria-expanded')") == "true")
    esc()
    check("Esc closes it, and only it", ev(ws, "document.getElementById('fileMenu').hidden") is True)
    click(ws, "#btnFileMenu")
    tap(*stage_point(ws, 0.2, 0.9))                    # well clear of the menu itself
    check("so does a click anywhere else", ev(ws, "document.getElementById('fileMenu').hidden") is True)
    click(ws, "#btnShortcuts")
    check("the shortcuts are written down somewhere", ev(ws, "document.getElementById('shortcutsDialog').open") is True
          and ev(ws, "document.querySelectorAll('#shortcutsDialog dt').length") >= 20)
    key(ws, "p", "KeyP", 80)
    check("and the list does not pass keys through to the tools", st()["tool"] == "select")
    click(ws, "#btnCloseShortcuts")
    check("it closes", ev(ws, "document.getElementById('shortcutsDialog').open") is False)
    names = ev(ws, """[...document.querySelectorAll('#colorGrp .swatch')].map((b) => b.getAttribute('aria-label')).join()
      + '|' + document.getElementById('colorGrp').getAttribute('aria-label')
      + '|' + document.getElementById('penSizeGrp').getAttribute('aria-label')""")
    check("colours and weights are named, not numbered", names.startswith("Red,Black,Blue,Green,Purple,Amber|Colour|Line weight"), names)

    # --- ⌘Return finishes a note; a note can shrink to its text ---
    click(ws, "#toolText")
    tap(*stage_point(ws, 0.6, 0.4))
    typed("Fit me")
    key(ws, "Enter", "Enter", 13, meta=True)
    s = st()
    note = s["annos"][-1]
    check("⌘Return finishes the note without a click", note["text"] == "Fit me"
          and ev(ws, "!!document.querySelector('.anno-box.editing')") is False
          and ev(ws, "document.activeElement.classList.contains('anno-text')") is False, str(note))
    check("and puts it down altogether: nothing selected, no handles, the properties row back to Select",
          s["tool"] == "select" and s["sel"] is None and ev(ws, "!!document.querySelector('.anno-box.selected')") is False
          and ev(ws, "[...document.querySelectorAll('.tip-handle')].every((n) => n.style.display === 'none')") is True
          and s["label"] == "Select", f"{s['tool']}, sel {s['sel']}, {s['label']}")
    tap(*to_client(note["x"] + 8, note["y"] + 8))      # pick it up again to style it
    check("a note starts at a fixed width, with the option to shrink it", note["width"] == 170 and note["fit"] is False
          and shown("fitGrp") and ev(ws, "document.getElementById('fitToggle').checked") is False)

    BOX = """(() => {
      const b = document.querySelector('.anno-box.selected'), t = b.querySelector('.anno-text');
      return { w: b.offsetWidth, textW: t.scrollWidth, h: b.offsetHeight, fit: b.classList.contains('fit') };
    })()"""
    wide = ev(ws, BOX)
    click(ws, "#fitToggle")
    scale = ev(ws, "(async()=>(await import('./js/state.js')).state.currentScale)()", awaitp=True)
    s, tight = st(), ev(ws, BOX)
    note = next(a for a in s["annos"] if a["id"] == note["id"])
    check("Shrink to text pulls the box in to the width of its words", note["fit"] is True and tight["fit"]
          and tight["w"] < wide["w"] * 0.6 and tight["w"] - tight["textW"] <= 4, f"{wide} -> {tight}")
    check("and the note knows its new width", abs(note["width"] - tight["w"] / scale) < 0.5, f"{note['width']} vs {tight['w'] / scale}")
    check("as one step to undo", s["hist"]["undoLabel"] == "Change style")
    nx, ny = to_client(note["x"] + 8, note["y"] + 8)
    tap(nx, ny)                                       # already selected: this opens it
    typed(" and now it is longer")
    grown_live = ev(ws, BOX)
    key(ws, "Enter", "Enter", 13, meta=True)
    grown = next(a for a in st()["annos"] if a["id"] == note["id"])
    check("it grows with the text as it is typed, on one line", grown_live["w"] > tight["w"] * 2 and grown_live["h"] == tight["h"],
          f"{tight} -> {grown_live}")
    check("and keeps up in the model", abs(grown["width"] - grown_live["w"] / scale) < 0.5 and grown["fit"] is True)
    tap(nx, ny)                                       # ⌘Return put it down; pick it up again
    rz = ev(ws, "(r => ({x: r.left + r.width / 2, y: r.top + r.height / 2}))(document.querySelector('.anno-box.selected .anno-resize').getBoundingClientRect())")
    drag((rz["x"], rz["y"]), (rz["x"] - 60, rz["y"]))
    sized = next(a for a in st()["annos"] if a["id"] == note["id"])
    check("dragging its edge takes the width back by hand", sized["fit"] is False and abs(sized["width"] - (grown["width"] - 60 / scale)) < 1
          and ev(ws, "document.getElementById('fitToggle').checked") is False and ev(ws, BOX)["h"] > tight["h"],
          f"{sized['width']} vs {grown['width'] - 60 / scale}")
    undo()
    again = next(a for a in st()["annos"] if a["id"] == note["id"])
    check("which undo gives back", again["fit"] is True)
    # The choice carries to the next note, as colour and fill do.
    tap(nx, ny)
    click(ws, "#fitToggle"); click(ws, "#fitToggle")
    click(ws, "#toolText")
    tap(*stage_point(ws, 0.63, 0.58))                 # clear of the note above and the callouts either side
    typed("ok")
    key(ws, "Enter", "Enter", 13, meta=True)
    nxt = st()["annos"][-1]
    check("the next note placed shrinks too", nxt["text"] == "ok" and nxt["fit"] is True and nxt["width"] < 60, str(nxt))
    # While the option is on, *finishing* a note is what shrinks it — so a
    # note placed before the box was ticked, or opened from an older file,
    # does not sit there at its old width looking as if nothing happened.
    older = next(a for a in st()["annos"] if a["text"] == "Second")
    ox, oy = to_client(older["x"] + 8, older["y"] + 8)
    esc()
    tap(ox, oy); tap(ox, oy)                          # select, then open
    typed(" one")
    key(ws, "Enter", "Enter", 13, meta=True)
    done = next(a for a in st()["annos"] if a["id"] == older["id"])
    check("with the option on, ⌘Return on an older fixed-width note shrinks it", older["fit"] is False and older["width"] == 170
          and done["text"] == "Second one" and done["fit"] is True and done["width"] < 120, str(done))
    undo()
    back = next(a for a in st()["annos"] if a["id"] == older["id"])
    check("as part of the same step as the typing", back["text"] == "Second" and back["fit"] is False and back["width"] == 170, str(back))
    redo()
    # And a drag has no width to choose while the text is choosing it.
    click(ws, "#toolText")
    drag(stage_point(ws, 0.76, 0.74), stage_point(ws, 0.93, 0.76))
    typed("dragged")
    key(ws, "Enter", "Enter", 13, meta=True)
    dr = st()["annos"][-1]
    check("with the option on, dragging out a box still gives one that hugs its text", dr["text"] == "dragged" and dr["fit"] is True and dr["width"] < 80, str(dr))
    tap(*to_client(dr["x"] + 5, dr["y"] + 5))          # select it, to turn the option off with it

    click(ws, "#fitToggle")
    check("until the option is turned off", ev(ws, "(async()=>(await import('./js/state.js')).state.currentFit)()", awaitp=True) is False
          and st()["annos"][-1]["fit"] is False)
    loose = ev(ws, BOX)
    check("which leaves the note a fixed width with room to spare, still on one line",
          st()["annos"][-1]["width"] > dr["width"] * 1.05 and loose["h"] == tight["h"], f"{dr['width']} -> {st()['annos'][-1]['width']}, h {loose['h']}")
    # A click with an unsteady hand is still a click: a few pixels of
    # travel must not make a box a few pixels wide.
    click(ws, "#toolText")
    slip = stage_point(ws, 0.76, 0.64)
    mouse("mousePressed", *slip); mouse("mouseMoved", slip[0] + 5, slip[1] + 2); mouse("mouseMoved", slip[0] + 9, slip[1] + 3)
    mouse("mouseReleased", slip[0] + 9, slip[1] + 3)
    time.sleep(0.25)
    typed("slipped")
    key(ws, "Enter", "Enter", 13, meta=True)
    sl = st()["annos"][-1]
    check("a click that slips a few pixels places an ordinary note, not a sliver", sl["text"] == "slipped" and sl["width"] == 170 and sl["fit"] is False, str(sl))
    esc()
    shot(ws, "09b-shrunk")

    # --- the save state, in words; a failed save, in the way ---
    s = st()
    check("unsaved work is counted on screen", s["dirty"] and s["chipShown"]
          and re.match(r"^\d+ unsaved changes$", s["chip"]) is not None
          and ev(ws, "document.getElementById('saveChip').classList.contains('unsaved')") is True, repr(s["chip"]))

    ev(ws, """(async () => {
      const { state } = await import('./js/state.js');
      window.__writes = 0;
      const handle = { kind: 'file', name: 'surface.pdf' };
      const def = (k, v) => Object.defineProperty(handle, k, { value: v, enumerable: false, writable: true });
      def('queryPermission', async () => 'prompt');
      def('requestPermission', async () => 'denied');
      def('createWritable', async () => ({ write: async () => { window.__writes++; }, close: async () => {} }));
      state.fileHandle = handle;
      window.__handle = handle;
    })()""", awaitp=True)
    key(ws, "s", "KeyS", 83, meta=True)
    wait_for(ws, "document.getElementById('saveAlert').classList.contains('show')", timeout=15, label="save refused")
    alert = ev(ws, "document.getElementById('saveAlert').innerText")
    check("a refused save says nothing was written and the work is still here",
          "Nothing was written" in alert and "still open" in alert and "declined" in alert, alert)
    check("and offers the two ways out", shown("btnAlertSaveAs") and shown("btnAlertDownload"))
    s = st()
    check("the document is still unsaved, and says so", s["dirty"] and "unsaved" in s["chip"] and ev(ws, "window.__writes") == 0)
    time.sleep(5.6)                                   # longer than a status message lasts
    check("the alert does not fade", ev(ws, "document.getElementById('saveAlert').classList.contains('show')") is True)

    ev(ws, "window.__handle.requestPermission = async () => 'granted'; window.__handle.createWritable = async () => { throw new Error('disk full'); }")
    key(ws, "s", "KeyS", 83, meta=True)
    wait_for(ws, "document.getElementById('saveAlertWhy').textContent.includes('disk full')", timeout=15, label="write failed")
    check("a write that fails says why", st()["dirty"] is True)

    # The banner is a message; the chip is the state. A document whose last
    # write did not happen has to go on saying so after the message is put
    # away — the file on disk is the only copy there is.
    chipState = lambda: ev(ws, """(() => ({
      text: document.getElementById('saveChipText').textContent,
      failed: document.getElementById('saveChip').classList.contains('failed'),
      banner: document.getElementById('saveAlert').classList.contains('show'),
    }))()""")
    c = chipState()
    check("and the chip stops counting changes and says the save failed",
          c["failed"] is True and "NOT SAVED" in c["text"], str(c))
    click(ws, "#btnAlertDismiss")
    time.sleep(0.4)
    c = chipState()
    check("dismissing the banner takes away the banner and nothing else",
          c["banner"] is False and c["failed"] is True and "NOT SAVED" in c["text"], str(c))

    ev(ws, "window.__handle.createWritable = async () => ({ write: async () => { window.__writes++; }, close: async () => {} })")
    key(ws, "s", "KeyS", 83, meta=True)
    wait_for(ws, "document.getElementById('statusMsg').textContent.includes('Saved')", timeout=30, label="saved")
    s = st()
    check("a save that works takes the alert away", ev(ws, "document.getElementById('saveAlert').classList.contains('show')") is False)
    check("and the chip says when", re.match(r"^Saved \d", s["chip"]) is not None and not s["dirty"]
          and ev(ws, "document.getElementById('saveChip').classList.contains('unsaved')") is False, repr(s["chip"]))
    click(ws, "#toolRect")
    drag(stage_point(ws, 0.8, 0.3), stage_point(ws, 0.9, 0.4))
    esc()
    s = st()
    check("one change later it counts one, and remembers the save",
          re.match(r"^1 unsaved change · last saved \d", s["chip"]) is not None, repr(s["chip"]))
    undo()
    s = st()
    check("undoing back to the save is saved again", not s["dirty"] and s["chip"].startswith("Saved "), repr(s["chip"]))
    undo()
    check("undoing past it is not", st()["dirty"] is True and "1 unsaved change" in st()["chip"], repr(st()["chip"]))
    redo()

    # --- undo may change the document, never which file Save writes ---
    # Every checkpoint taken before a Save As was taken of a document that
    # saved to the old file. Step back onto one and ⌘S must still write to
    # the file that was saved *to* — not overwrite the one saved away from.
    ev(ws, """(() => {
      window.__bWrites = 0;
      window.__pickerWas = window.showSaveFilePicker;
      window.showSaveFilePicker = async () => {
        const b = { kind: 'file', name: 'B-reviewed.pdf' };
        const def = (k, v) => Object.defineProperty(b, k, { value: v, enumerable: false });
        def('queryPermission', async () => 'granted');
        def('requestPermission', async () => 'granted');
        def('createWritable', async () => ({ write: async () => { window.__bWrites++; }, close: async () => {} }));
        window.__b = b;
        return b;
      };
    })()""")
    a_writes = ev(ws, "window.__writes")
    key(ws, "s", "KeyS", 83, meta=True, shift=True)
    wait_for(ws, "document.getElementById('statusMsg').textContent.includes('Saved B-reviewed.pdf')", timeout=30, label="saved as B")
    click(ws, "#toolRect")
    drag(stage_point(ws, 0.8, 0.3), stage_point(ws, 0.9, 0.4))
    esc()
    undo()
    undo()                                            # past the Save As, onto a checkpoint from before it
    aim = ev(ws, """(async () => {
      const { state } = await import('./js/state.js');
      return { name: state.docName, isB: state.fileHandle === window.__b, isA: state.fileHandle === window.__handle,
               dirty: state.dirty, title: document.getElementById('docTitle').textContent };
    })()""", awaitp=True)
    check("undo past a Save As still aims at the file saved to", aim["isB"] and aim["name"] == "B-reviewed.pdf" and aim["title"] == "B-reviewed.pdf", str(aim))
    check("and the document knows it differs from that file", aim["dirty"] is True)
    key(ws, "s", "KeyS", 83, meta=True)
    wait_for(ws, "window.__bWrites === 2", timeout=30, label="second write to B")
    check("so Save writes there, and the original is not touched", ev(ws, "window.__writes") == a_writes and ev(ws, "window.__bWrites") == 2,
          f"A {ev(ws, 'window.__writes')} (was {a_writes}), B {ev(ws, 'window.__bWrites')}")
    redo()
    ev(ws, "window.showSaveFilePicker = window.__pickerWas")

    # --- the new shapes survive a save and reopen, through the real app ---
    trip = ev(ws, """(async () => {
      const { state } = await import('./js/state.js'), tabs = await import('./js/tabs.js');
      const pages = await import('./js/pages.js'), view = await import('./js/view.js');
      const { buildPdfBytes } = await import('./js/export.js');
      const was = state.pages[0].annotations.map((a) => a.type + (a.fill === false ? ':bare' : ''));
      const bytes = await buildPdfBytes();
      const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const kinds = (await (await doc.getPage(1)).getAnnotations()).map((a) => a.subtype);
      tabs.openDocument();
      await pages.importPdfBytes(bytes.slice().buffer, 'surface-reopened.pdf');
      await view.renderMainCanvas();
      return { was, now: state.pages[0].annotations.map((a) => a.type + (a.fill === false ? ':bare' : '')), kinds,
               dom: document.querySelectorAll('#leaderSvg .ink-hit').length + document.querySelectorAll('.anno-box').length,
               hl: document.querySelectorAll('#hiliteSvg .ink-stroke').length, dirty: state.dirty };
    })()""", awaitp=True)
    time.sleep(0.6)
    check("saved and reopened, every markup is still the markup it was", trip["was"] == trip["now"] and len(trip["was"]) >= 8,
          f"{trip['was']} -> {trip['now']}")
    check("each one a standard annotation to any other program",
          {"FreeText", "Line", "Square", "Polygon", "Ink"} <= set(trip["kinds"]), str(trip["kinds"]))
    check("and they are on screen to be edited", trip["dom"] == len(trip["now"]) and trip["hl"] == 1 and trip["dirty"] is False, str(trip))
    shot(ws, "10-surface-reopened")

    # --- zoom is a movement, not a cut ---
    # Every frame between the two sizes is shown, the page never goes
    # blank on the way, and the sharp redraw arrives once it has settled.
    ev(ws, """(() => {
      window.__zf = [];
      const c = document.getElementById('pageCanvas');
      const tick = () => {
        window.__zf.push({ z: document.getElementById('zoomReadout').textContent, w: c.width, css: parseFloat(c.style.width) });
        if (window.__zfOn) requestAnimationFrame(tick);
      };
      window.__zfOn = true;
      requestAnimationFrame(tick);
    })()""")
    time.sleep(0.2)
    click(ws, "#btnZoomIn")
    time.sleep(1.3)
    ev(ws, "window.__zfOn = false")
    frames = ev(ws, "window.__zf")
    sizes = []
    for f in frames:
        if not sizes or sizes[-1] != f["css"]:
            sizes.append(f["css"])
    grew = all(b > a for a, b in zip(sizes, sizes[1:]))
    check("a zoom step passes through the sizes in between", len(sizes) >= 5 and grew, f"{len(sizes)} sizes: {sizes[:8]}")
    check("the page is never blank on the way", min(f["w"] for f in frames) > 2, str(min(f["w"] for f in frames)))
    check("its pixels are stretched first and redrawn sharp once it settles",
          any(f["css"] > frames[0]["css"] and f["w"] == frames[0]["w"] for f in frames) and frames[-1]["w"] > frames[0]["w"],
          f"backing {frames[0]['w']} -> {frames[-1]['w']}")
    for _ in range(3):
        ev(ws, "document.getElementById('btnZoomIn').click()")
    time.sleep(1.4)
    z3 = ev(ws, "document.getElementById('zoomReadout').textContent")
    check("steps taken before the last has landed add up", z3 == "400%", z3)
    held = ev(ws, "document.getElementById('pageCanvas').width")
    ev(ws, """(() => { window.__draws = 0; const c = document.getElementById('pageCanvas');
      const set = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').set;
      Object.defineProperty(c, 'width', { configurable: true, get() { return Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width').get.call(c); },
        set(v) { window.__draws++; set.call(c, v); } }); })()""")
    click(ws, "#toolRect")
    drag(stage_point(ws, 0.3, 0.3), stage_point(ws, 0.4, 0.4))
    esc()
    undo()
    time.sleep(0.8)
    check("a markup edit and its undo redraw no page pixels", ev(ws, "window.__draws") == 0
          and ev(ws, "document.getElementById('pageCanvas').width") == held, str(ev(ws, "window.__draws")))
    ev(ws, "delete document.getElementById('pageCanvas').width")
    click(ws, "#btnFitWidth")
    time.sleep(1.2)
    check("a fit mode is glided to, and then holds", ev(ws, "(async()=>(await import('./js/state.js')).state.zoomMode)()", awaitp=True) == "fit-width"
          and ev(ws, "document.getElementById('btnFitWidth').classList.contains('toggled')") is True)

    # --- a page turned to has already been drawn ---
    # Once a page is up and nothing else is asked for, the ordinary pages
    # either side are drawn out of sight; turning to one is a copy.
    ev(ws, "(async()=>{const {state}=await import('./js/state.js');const p=await import('./js/pages.js');await p.selectPage(state.pages[0].id);})()", awaitp=True)
    time.sleep(1.0)
    ev(ws, """(() => { window.__copies = 0; window.__renders2 = 0;
      const di = CanvasRenderingContext2D.prototype.drawImage;
      window.__diReal = di;
      CanvasRenderingContext2D.prototype.drawImage = function (img, ...rest) {
        if (this.canvas.id === 'pageCanvas' && img instanceof HTMLCanvasElement && img.width > 600) window.__copies++;
        return di.call(this, img, ...rest); }; })()""")
    key(ws, "ArrowRight", "ArrowRight", 39)
    time.sleep(0.1)
    turned = ev(ws, "({ copies: window.__copies, page: document.getElementById('pageInput').value, w: document.getElementById('pageCanvas').width })")
    check("turning to the next page shows it at once, drawn ahead", turned["copies"] == 1 and turned["page"] == "2" and turned["w"] > 600, str(turned))
    time.sleep(1.0)
    key(ws, "ArrowLeft", "ArrowLeft", 37)
    time.sleep(0.1)
    back = ev(ws, "({ copies: window.__copies, page: document.getElementById('pageInput').value })")
    check("and so does turning back", back["copies"] == 2 and back["page"] == "1", str(back))
    ev(ws, "CanvasRenderingContext2D.prototype.drawImage = window.__diReal")

    # --- hover a tool, see its key ---
    def hover(sel):
        c = ev(ws, f"(r => ({{x: r.left + r.width / 2, y: r.top + r.height / 2}}))(document.querySelector('{sel}').getBoundingClientRect())")
        ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": c["x"], "y": c["y"]})
    TIP = """(() => { const t = document.getElementById('tooltip'), r = t.getBoundingClientRect();
      return { shown: !t.hidden, name: t.querySelector('.tip-name')?.textContent, key: t.querySelector('kbd')?.textContent,
               desc: t.querySelector('.tip-desc')?.textContent, top: r.top, left: r.left, right: r.right }; })()"""
    ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 5, "y": 700})
    time.sleep(0.8)
    hover("#toolPen")
    time.sleep(0.15)
    check("a hover box does not jump out at a passing pointer", ev(ws, TIP)["shown"] is False)
    time.sleep(0.6)
    tp = ev(ws, TIP)
    pen = ev(ws, "(r => ({ bottom: r.bottom, left: r.left, right: r.right }))(document.getElementById('toolPen').getBoundingClientRect())")
    check("resting on a tool shows its name and shortcut key", tp["shown"] and tp["name"] == "Pen" and tp["key"] == "P" and tp["desc"] == "Draw freehand", str(tp))
    check("in a box just under it", 0 < tp["top"] - pen["bottom"] < 20 and tp["left"] < pen["right"] and tp["right"] > pen["left"], f"{tp} vs {pen}")
    hover("#toolCallout")
    time.sleep(0.05)
    tc = ev(ws, TIP)
    check("sliding along the row shows the next one at once", tc["shown"] and tc["name"] == "Callout" and tc["key"] == "Q", str(tc))
    hover("#btnUndo")
    time.sleep(0.05)
    tu = ev(ws, TIP)
    check("undo says what it would undo, and its key", tu["shown"] and tu["key"] == "⌘Z"
          and tu["desc"] == (st()["hist"]["undoLabel"] or "Nothing to undo"), str(tu))
    ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 5, "y": 700})
    time.sleep(0.1)
    check("moving away puts it away", ev(ws, TIP)["shown"] is False)
    hover("#toolArrow")
    time.sleep(0.7)
    c = ev(ws, "(r => ({x: r.left + r.width / 2, y: r.top + r.height / 2}))(document.getElementById('toolArrow').getBoundingClientRect())")
    ws.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": c["x"], "y": c["y"], "button": "left", "clickCount": 1})
    check("and so does clicking the tool", ev(ws, TIP)["shown"] is False)
    ws.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": c["x"], "y": c["y"], "button": "left", "clickCount": 1})
    esc()
    check("every button with a key has the box, not the browser's own tooltip",
          ev(ws, "[...document.querySelectorAll('[data-key]')].filter((b) => b.hasAttribute('title')).map((b) => b.id)") == []
          and ev(ws, "document.querySelectorAll('#pageToolbar .tools [data-key]').length") == 8)

    # --- a note still being typed when the document changes under it ---
    click(ws, "#toolText")
    tap(*stage_point(ws, 0.8, 0.3))
    typed("Mid-thought")
    key(ws, "t", "KeyT", 84, meta=True)                # a new tab, without leaving the note first
    time.sleep(0.6)
    after = ev(ws, """(async () => {
      const { state } = await import('./js/state.js');
      const { historyStatus } = await import('./js/history.js');
      const old = state.docs.find((d) => d.docName === 'surface-reopened.pdf');
      return { here: state.docName, pages: state.pages.length, dirty: state.dirty, canUndo: historyStatus().canUndo,
               kept: old.pages[0].annotations.some((a) => a.text === 'Mid-thought'), oldDirty: old.dirty };
    })()""", awaitp=True)
    check("⌘T mid-note keeps what was typed, in the document it was typed in", after["kept"] and after["oldDirty"], str(after))
    check("and leaves the new tab clean, with nothing of the old one to undo",
          after["here"] == "Untitled.pdf" and after["pages"] == 0 and not after["dirty"] and not after["canUndo"], str(after))

    # --- on a phone both side panels are drawers, and behave alike ---
    check("a PDF arriving from Finder retires the note explaining how to set that up",
          ev(ws, "(async()=>(await import('./js/persist.js')).finderHintSeen())()", awaitp=True) is True
          and ev(ws, "JSON.parse(localStorage.getItem('redline.prefs') || '{}').finderHintDone") is True)
    ws.call("Emulation.setDeviceMetricsOverride", {"width": 390, "height": 780, "deviceScaleFactor": 2, "mobile": True})
    time.sleep(0.6)
    # Anything that stands past the right edge widens the whole page, and a
    # phone then shows the app shrunk, or lets it slide sideways. A hidden
    # label escaping the scrolling toolbar once made it 623 px wide.
    wide = ev(ws, "({ doc: document.scrollingElement.scrollWidth, screen: document.documentElement.clientWidth })")
    check("on a phone the app is exactly as wide as the screen", wide["doc"] <= wide["screen"], str(wide))
    PANELS = """(() => ({
      pages: document.getElementById('sidebar').classList.contains('open'),
      markups: !document.getElementById('markupRail').hidden,
      scrim: document.getElementById('drawerScrim').classList.contains('show'),
    }))()"""
    ev(ws, "document.getElementById('btnPages').click()")
    check("the pages drawer opens over a scrim", ev(ws, PANELS) == {"pages": True, "markups": False, "scrim": True}, str(ev(ws, PANELS)))
    ev(ws, "document.getElementById('btnMarkups').click()")
    check("opening the markups list closes it, and keeps the scrim", ev(ws, PANELS) == {"pages": False, "markups": True, "scrim": True}, str(ev(ws, PANELS)))
    esc()
    check("Esc puts the markups list away", ev(ws, PANELS) == {"pages": False, "markups": False, "scrim": False}, str(ev(ws, PANELS)))
    ev(ws, "document.getElementById('btnMarkups').click()")
    ev(ws, "document.getElementById('btnPages').click()")
    check("opening pages closes the markups list in turn", ev(ws, PANELS) == {"pages": True, "markups": False, "scrim": True}, str(ev(ws, PANELS)))
    esc()
    check("Esc puts the pages drawer away", ev(ws, PANELS) == {"pages": False, "markups": False, "scrim": False}, str(ev(ws, PANELS)))
    ev(ws, "document.getElementById('btnMarkups').click()")
    ev(ws, "document.getElementById('drawerScrim').click()")
    check("and a tap on the scrim closes whichever is open", ev(ws, PANELS) == {"pages": False, "markups": False, "scrim": False}, str(ev(ws, PANELS)))
    # There the properties row scrolls sideways, so the instruction moves
    # to the floating hint — still one place, just the other one.
    ev(ws, "document.getElementById('btnAddBlank').click()")
    time.sleep(0.6)
    esc()
    key(ws, "t", "KeyT", 84)
    hints = ev(ws, """({ float: getComputedStyle(document.getElementById('placeHint')).display,
      row: getComputedStyle(document.getElementById('armedNote')).display,
      text: document.getElementById('placeHint').textContent })""")
    check("on a narrow screen the floating hint speaks and the row keeps quiet",
          hints["float"] == "block" and hints["row"] == "none" and "drag to set its width" in hints["text"], str(hints))
    esc()
    ws.call("Emulation.clearDeviceMetricsOverride")
    time.sleep(0.4)


class FakeOllama:
    """A stand-in for Ollama's HTTP API, so the AI panel can be tested
    without a model: /api/tags, and /api/chat streaming newline-delimited
    JSON a word at a time. Answers CORS preflights, as Ollama does for an
    origin it allows. Records every request it is sent."""

    WORDS = ("A revision cloud marks what changed on a sheet since the last issue . "
             "It is drawn around the change and tagged with the revision number .").split()

    def __init__(self, port):
        import http.server, threading
        fake = self
        self.port, self.requests, self.models, self.delay = port, [], ["gemma3:4b"], 0.03

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            def log_message(self, *a): pass
            def cors(self):
                # No keep-alive: a connection the browser holds open would
                # outlive stop(), and Ollama would never look gone.
                self.close_connection = True
                self.send_header("Connection", "close")
                self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            def do_OPTIONS(self):
                self.send_response(204); self.cors(); self.send_header("Content-Length", "0"); self.end_headers()
            def do_GET(self):
                fake.requests.append(("GET", self.path, None))
                body = json.dumps({"models": [{"name": m} for m in fake.models]}).encode()
                self.send_response(200); self.cors()
                self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
                self.end_headers(); self.wfile.write(body)
            def do_POST(self):
                n = int(self.headers.get("Content-Length", "0"))
                req = json.loads(self.rfile.read(n) or b"{}")
                fake.requests.append(("POST", self.path, req))
                self.send_response(200); self.cors()
                self.send_header("Content-Type", "application/x-ndjson"); self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                def chunk(obj):
                    data = (json.dumps(obj) + "\n").encode()
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data)); self.wfile.flush()
                try:
                    for i, w in enumerate(fake.WORDS):
                        chunk({"message": {"role": "assistant", "content": ("" if i == 0 else " ") + w}, "done": False})
                        time.sleep(fake.delay)
                    chunk({"message": {"role": "assistant", "content": ""}, "done": True})
                    self.wfile.write(b"0\r\n\r\n"); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass                                  # the page stopped reading: that is Stop working

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True
            def handle_error(self, request, client_address): pass     # a reader that stopped: Stop, working
        self.server = Server(("127.0.0.1", port), H)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def ai_checks(ws):
    """The local AI panel, against a stand-in Ollama: it looks for nothing
    until opened, streams an answer, stops when told, says plainly what is
    missing, and never touches the document."""
    print("\n=== local AI panel ===")
    fake = FakeOllama(11450)
    try:
        # This session has never opened the panel: nothing has been asked
        # of localhost, and nothing is polling it.
        unused = ev(ws, "(async () => !(await import('./js/ai.js')).aiConfig.used && document.getElementById('aiDot').dataset.state === 'unknown')()", awaitp=True)
        ev(ws, "(async () => { (await import('./js/ai.js')).saveAiConfig({ host: 'http://localhost:11450', model: 'gemma3:4b' }); })()", awaitp=True)
        time.sleep(0.6)
        check("nothing contacts Ollama until the AI panel is opened", unused is True and len(fake.requests) == 0,
              f"unused {unused}, {len(fake.requests)} requests")
        dirty0 = ev(ws, "(async () => { const { state } = await import('./js/state.js'); const { historyStatus } = await import('./js/history.js'); return [state.dirty, historyStatus().changes]; })()", awaitp=True)
        click(ws, "#btnMarkups")
        time.sleep(0.4)
        click(ws, "#btnAi")
        # Plain chat first: these checks are about the conversation itself.
        ev(ws, "document.getElementById('aiScope').value = 'none'")
        wait_for(ws, "document.getElementById('aiDot').dataset.state === 'ready'", timeout=10, label="AI ready")
        panel = ev(ws, """({ open: !document.getElementById('aiRail').hidden, markups: !document.getElementById('markupRail').hidden,
          status: document.getElementById('aiStatusLine').innerText, ask: !document.getElementById('btnAiAsk').disabled,
          model: document.getElementById('aiModelName').textContent })""")
        check("opening it finds Ollama and the model, and says which", panel["open"] and panel["ask"] and panel["status"] == ""
              and panel["model"] == "gemma3:4b", str(panel))
        check("and it takes the markups list's place rather than squeezing the sheet further", panel["markups"] is False)

        click(ws, "#aiInput")
        ws.call("Input.insertText", {"text": "What is a revision cloud?"})
        key(ws, "Enter", "Enter", 13, meta=True)
        time.sleep(0.25)
        mid = ev(ws, """({ text: [...document.querySelectorAll('#aiLog .ai-msg.bot')].at(-1).textContent,
          stop: !document.getElementById('btnAiStop').hidden, dot: document.getElementById('aiDot').dataset.state })""")
        wait_for(ws, "document.getElementById('btnAiStop').hidden", timeout=15, label="answer finished")
        done = ev(ws, "[...document.querySelectorAll('#aiLog .ai-msg.bot')].at(-1).textContent")
        check("⌘Return asks, and the answer arrives a word at a time", 0 < len(mid["text"]) < len(done) and mid["stop"] and mid["dot"] == "busy",
              f"{mid} / {done!r}")
        check("all of it", done == " ".join(FakeOllama.WORDS), repr(done))
        post = next(r[2] for r in reversed(fake.requests) if r[0] == "POST")
        check("asking for the context it needs, not Ollama's silent 4K default",
              post["options"].get("num_ctx") == 8192 and post["model"] == "gemma3:4b" and post["stream"] is True, str(post.get("options")))
        check("with the question last, after the instructions",
              post["messages"][0]["role"] == "system" and post["messages"][-1] == {"role": "user", "content": "What is a revision cloud?"},
              str(post["messages"]))

        fake.delay = 0.25                                 # slow enough to stop part way
        click(ws, "#aiInput")
        ws.call("Input.insertText", {"text": "And a delta?"})
        click(ws, "#btnAiAsk")
        wait_for(ws, "[...document.querySelectorAll('#aiLog .ai-msg.bot')].at(-1).textContent.split(' ').length >= 3", timeout=10, label="streaming")
        click(ws, "#btnAiStop")
        time.sleep(0.2)
        at_stop = ev(ws, "[...document.querySelectorAll('#aiLog .ai-msg.bot')].at(-1).textContent")
        time.sleep(1.0)
        after = ev(ws, """({ text: [...document.querySelectorAll('#aiLog .ai-msg.bot')].at(-1).textContent,
          cls: [...document.querySelectorAll('#aiLog .ai-msg.bot')].at(-1).className, ask: !document.getElementById('btnAiAsk').hidden })""")
        check("Stop ends the answer where it is", after["text"] == at_stop and "stopped" in after["cls"] and after["ask"]
              and len(at_stop.split()) < len(FakeOllama.WORDS), str(after))
        follow = next(r[2] for r in reversed(fake.requests) if r[0] == "POST")
        check("and a second question carries the conversation so far", [m["role"] for m in follow["messages"]] == ["system", "user", "assistant", "user"],
              str([m["role"] for m in follow["messages"]]))
        fake.delay = 0.03

        dirty1 = ev(ws, "(async () => { const { state } = await import('./js/state.js'); const { historyStatus } = await import('./js/history.js'); return [state.dirty, historyStatus().changes]; })()", awaitp=True)
        check("talking to the model changes nothing in the document", dirty1 == dirty0, f"{dirty0} -> {dirty1}")

        # Asked about the document, it is given the passages that bear on
        # the question, tagged by sheet — and told to keep to them.
        ev(ws, """(async () => {
          const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
          tabs.openDocument();
          await pages.importPdfBytes(await (await fetch('./tests/browser/fixture.pdf')).arrayBuffer(), 'fixture.pdf');
        })()""", awaitp=True)
        time.sleep(1.0)
        ev(ws, "document.getElementById('aiScope').value = 'all'")
        click(ws, "#aiInput")
        ws.call("Input.insertText", {"text": "What does the landscape check page say?"})
        click(ws, "#btnAiAsk")
        wait_for(ws, "document.getElementById('btnAiStop').hidden && !!document.querySelector('#aiLog .ai-src')", timeout=20, label="document answer")
        sent = next(r[2] for r in reversed(fake.requests) if r[0] == "POST")
        doc = next((m["content"] for m in sent["messages"] if m["role"] == "system" and "Passages" in m["content"]), "")
        rules = sent["messages"][0]["content"]
        src = ev(ws, "[...document.querySelectorAll('#aiLog .ai-src')].at(-1).textContent")
        check("asked about the document, it is sent the passage that answers, tagged with its sheet",
              "(p. 2) PAGE TWO" in doc and "LANDSCAPE CHECK" in doc, doc[:300])
        check("best match first", doc.split("\n")[2].startswith("(p. 2)") if len(doc.split("\n")) > 2 else False, doc[:300])
        check("and told to keep to it, and never to claim it can see the drawings",
              "Use only that text" in rules and "Never say you can see" in rules, rules[:200])
        check("the answer says which sheets it came from", src.startswith("Passages from p. 2"), src)
        check("an answer about a drawing is not a creative one", sent["options"].get("temperature") == 0.2, str(sent["options"]))
        ev(ws, "document.getElementById('aiScope').value = 'none'")
        click(ws, "#aiInput")
        ws.call("Input.insertText", {"text": "Can you see the PDF?"})
        click(ws, "#btnAiAsk")
        wait_for(ws, "document.getElementById('btnAiStop').hidden", timeout=20, label="chat answer")
        chat = next(r[2] for r in reversed(fake.requests) if r[0] == "POST")
        check("in plain chat it is sent no document, and told it cannot see one",
              not any("Passages" in m["content"] for m in chat["messages"]) and "NOT been given the open document" in chat["messages"][0]["content"],
              chat["messages"][0]["content"][:160])
        ev(ws, "document.getElementById('aiScope').value = 'all'")

        fake.models = ["llama3.2:3b"]
        ev(ws, "window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange'))")
        wait_for(ws, "document.getElementById('aiDot').dataset.state === 'nomodel'", timeout=10, label="model gone")
        missing = ev(ws, "document.getElementById('aiStatusLine').innerText")
        check("a model that isn't downloaded is named, with the command to get it",
              "ollama pull gemma3:4b" in missing and "llama3.2:3b" in missing and ev(ws, "document.getElementById('btnAiAsk').disabled") is True, missing)
        fake.models = ["gemma3:4b"]
    finally:
        fake.stop()
    ev(ws, "document.dispatchEvent(new Event('visibilitychange'))")
    wait_for(ws, "document.getElementById('aiDot').dataset.state === 'off'", timeout=10, label="Ollama gone")
    gone = ev(ws, "document.getElementById('aiStatusLine').innerText")
    check("with Ollama gone the dot goes grey, Ask is off, and the panel says what to do",
          "isn’t answering" in gone and ev(ws, "document.getElementById('btnAiAsk').disabled") is True, gone)
    click(ws, "#btnMarkups")
    check("opening the markups list puts the AI panel away", ev(ws, "document.getElementById('aiRail').hidden") is True)
    click(ws, "#btnMarkups")
    shot(ws, "11-ai")


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
    # beta has an unsaved blank page and is now in the background. Closing
    # the window must still ask: with nothing saved between launches, that
    # prompt is the only thing between a background tab and lost work.
    guard = ev(ws, """(async () => {
      const { state } = await import('./js/state.js');
      const ask = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
      const background = ask();
      const saved = state.docs.map((d) => d.dirty), mine = state.dirty;
      state.docs.forEach((d) => { d.dirty = false; }); state.dirty = false;
      const allClean = ask();
      state.docs.forEach((d, i) => { d.dirty = saved[i]; }); state.dirty = mine;
      return { activeDirty: mine, background, allClean };
    })()""", awaitp=True)
    check("closing asks first when a background tab has unsaved work",
          guard["activeDirty"] is False and guard["background"] is True, str(guard))
    check("and does not ask when every document is saved", guard["allClean"] is False, str(guard))
    check("thumbnails belong to the newly active document",
          ev(ws, "document.querySelectorAll('#thumbList .thumb').length") == 3,
          f"{ev(ws, 'document.querySelectorAll(\'#thumbList .thumb\').length')} thumbs")

    # --- the chip answers for every tab, not just this one ---
    # alpha is exactly what is on disk; beta is holding an unsaved blank
    # page out of sight. A chip that reads "No unsaved changes" here is the
    # one sentence this app cannot afford to get wrong.
    chip = ev(ws, """(() => {
      const more = document.getElementById('saveChipOthers');
      return {
        text: document.getElementById('saveChipText').textContent,
        others: more.hidden ? null : more.textContent,
        warn: document.getElementById('saveChip').classList.contains('unsaved'),
        marks: [...document.querySelectorAll('#tabStrip .tab')].map((t) =>
          (t.classList.contains('dirty') ? 'dirty' : 'clean') + (t.querySelector('.tab-dot') ? '+dot' : '')),
      };
    })()""")
    check("a saved document never reads clean while another tab is unsaved",
          chip["text"] != "No unsaved changes" and chip["warn"] is True, str(chip))
    check("and the chip counts the tabs that are out of sight",
          chip["others"] == "· 1 other tab unsaved", repr(chip["others"]))
    check("the unsaved tab is marked and the saved one is not",
          chip["marks"] == ["clean", "dirty+dot"], str(chip["marks"]))
    click(ws, "#saveChipOthers")
    time.sleep(1.2)
    d = docs()
    check("pressing it goes to the tab that is holding the work",
          d["active"] == "beta.pdf" and ev(ws, "document.getElementById('saveChipOthers').hidden") is True, str(d))
    click(ws, "#tabStrip .tab:first-child")
    time.sleep(1.2)
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
        check("and the chip drops its second half, leaving the header as it was",
              ev(ws, "document.getElementById('saveChipOthers').hidden") is True)

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


def lifecycle_checks(ws):
    """How documents come and go: a file still loading when the user turns
    to another tab, or closes its own; what a closed tab gives back; a drop
    of several files; and a file its author has locked."""
    print("\n=== documents coming and going ===")
    ensure_locked_fixture()
    b64 = lambda path: base64.b64encode(open(path, "rb").read()).decode()
    ev(ws, f"""window.__fx = Uint8Array.from(atob('{b64(FIXTURE)}'), (c) => c.charCodeAt(0));
      window.__locked = Uint8Array.from(atob('{b64(LOCKED_FIXTURE)}'), (c) => c.charCodeAt(0));
      window.confirm = () => true;""")
    # A slow file, made slow on purpose: its parse waits for a gate the
    # test opens once the user has moved on. Deterministic, unlike a big file.
    SLOW = """const real = PDFLib.PDFDocument.load; let open; const gate = new Promise((r) => { open = r; });
      PDFLib.PDFDocument.load = async (...a) => { await gate; return real.apply(PDFLib.PDFDocument, a); };
      const done = () => { PDFLib.PDFDocument.load = real; };"""
    MODS = """const { state, captureActiveDoc } = await import('./js/state.js'); const pages = await import('./js/pages.js');
      const tabs = await import('./js/tabs.js'); const files = await import('./js/files.js'); const view = await import('./js/view.js');
      const H = await import('./js/history.js'); const pause = (ms) => new Promise((r) => setTimeout(r, ms));"""

    r = ev(ws, f"""(async () => {{ {MODS}
      tabs.openDocument(); await pages.importPdfBytes(window.__fx.slice().buffer, 'stay.pdf');
      const stay = state.activeDocId;
      {SLOW}
      const loading = files.openInTabs([{{ file: new File([window.__fx], 'slow.pdf', {{ type: 'application/pdf' }}) }}]);
      await pause(60);
      document.querySelector(`#tabStrip .tab[data-doc-id="${{stay}}"]`).click();
      open(); await loading; done(); await pause(300);
      captureActiveDoc();
      const rec = (n) => state.docs.find((d) => d.docName === n);
      return {{ active: state.docName, stay: rec('stay.pdf') && [rec('stay.pdf').pages.length, rec('stay.pdf').combined],
               slow: rec('slow.pdf') ? rec('slow.pdf').pages.length : null, merged: state.docs.some((d) => d.docName === 'Combined.pdf') }};
    }})()""", awaitp=True)
    check("a file still loading when another tab is clicked opens in its own tab",
          r["slow"] == 3 and not r["merged"], str(r))
    check("and the tab clicked is left alone, and stays in front",
          r["stay"] == [3, False] and r["active"] == "stay.pdf", str(r))

    r = ev(ws, f"""(async () => {{ {MODS}
      {SLOW}
      const loading = files.openInTabs([{{ file: new File([window.__fx], 'gone.pdf', {{ type: 'application/pdf' }}) }}]);
      await pause(60);
      document.querySelector('#tabStrip .tab.active .tab-close').click();
      open(); const n = await loading; done(); await pause(300);
      captureActiveDoc();
      return {{ opened: n, landed: state.docs.some((d) => d.docName === 'gone.pdf' || d.docName === 'Combined.pdf'),
               status: document.getElementById('statusMsg').textContent }};
    }})()""", awaitp=True)
    check("a file whose tab is closed while it loads lands nowhere",
          r["opened"] == 0 and not r["landed"], str(r))
    check("and the status line says why", "closed" in r["status"], r["status"])

    r = ev(ws, f"""(async () => {{ {MODS}
      tabs.openDocument(); await pages.importPdfBytes(window.__fx.slice().buffer, 'a.pdf');
      await pages.importPdfBytes(window.__fx.slice().buffer, 'b.pdf');      // a merge: an edit
      const [a, b] = state.sources.map((s) => s.pdfjsDoc);
      H.undo(); view.renderThumbnails(); await pause(200);
      const keptForRedo = !b.loadingTask.destroyed;
      H.redo(); view.renderThumbnails(); await view.renderMainCanvas();
      const redoRenders = state.pages.length === 6;
      document.querySelector('#tabStrip .tab.active .tab-close').click(); await pause(400);
      return {{ keptForRedo, redoRenders, aFreed: a.loadingTask.destroyed, bFreed: b.loadingTask.destroyed }};
    }})()""", awaitp=True)
    check("a file only redo can bring back keeps its pdf.js document",
          r["keptForRedo"] and r["redoRenders"], str(r))
    check("closing a tab gives back its pdf.js documents", r["aFreed"] and r["bFreed"], str(r))

    ev(ws, "(async () => { (await import('./js/tabs.js')).openDocument(); })()", awaitp=True)
    data = {"items": [], "files": [FIXTURE, FIXTURE], "dragOperationsMask": 1}
    # An empty tab has no page to aim at; the drop is the window's.
    pt = ev(ws, "(() => { const r = document.getElementById('canvasStage').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()")
    x, y = pt
    for t in ("dragEnter", "dragOver", "drop"):
        ws.call("Input.dispatchDragEvent", {"type": t, "x": x, "y": y, "data": data})
        time.sleep(0.1)
    for _ in range(60):
        r = ev(ws, "(async () => { const { state } = await import('./js/state.js'); return { pages: state.pages.length, sources: state.sources.length }; })()", awaitp=True)
        if r["pages"] >= 6:
            break
        time.sleep(0.25)
    check("two PDFs dropped at once both arrive", r == {"pages": 6, "sources": 2}, str(r))

    r = ev(ws, f"""(async () => {{ {MODS}
      tabs.openDocument(); await pages.importPdfBytes(window.__locked.slice().buffer, 'locked.pdf');
      const opened = {{ pages: state.pages.length, status: document.getElementById('statusMsg').textContent }};
      let wrote = false;
      state.fileHandle = {{ kind: 'file', name: 'locked.pdf', queryPermission: async () => 'granted',
        createWritable: async () => {{ wrote = true; return {{ write: async () => {{}}, close: async () => {{}} }}; }} }};
      await files.save();
      const vis = (id) => {{ const el = document.getElementById(id); return !!el && !el.hidden; }};
      const r = {{ opened, wrote, alert: document.getElementById('saveAlert').classList.contains('show'),
                  why: document.getElementById('saveAlertWhy').textContent,
                  chip: document.getElementById('saveChipText').textContent,
                  classes: document.getElementById('saveChip').className,
                  savePrimary: document.getElementById('btnSave').classList.contains('primary'),
                  tabLock: !!document.querySelector('#tabStrip .tab.active .tab-lock'),
                  ways: ['btnAlertSaveAs', 'btnAlertDownload', 'btnAlertUnderstood'].filter(vis) }};
      files.dismissSaveAlert();
      r.stillLocked = document.getElementById('saveChip').classList.contains('locked');
      return r;
    }})()""", awaitp=True)
    check("a file locked by its author opens, and says it can't be saved",
          r["opened"]["pages"] == 1 and "locked" in r["opened"]["status"], str(r["opened"]))
    check("saving it is refused before the file is touched", r["wrote"] is False, str(r))
    check("and the refusal stays on screen, saying why", r["alert"] and "locked" in r["why"], r["why"])
    # Every way of writing it goes through the same refusal, flatten
    # included, so the two usual ways out are dead ends and are not
    # offered: there is nothing to do but know.
    check("the refusal offers only what works", r["ways"] == ["btnAlertUnderstood"], str(r["ways"]))
    check("a locked document never reads clean",
          "Locked" in r["chip"] and "locked" in r["classes"] and r["stillLocked"] is True, f'{r["chip"]!r} {r["classes"]!r}')
    check("and Save is not offered as the thing to do", r["savePrimary"] is False, r["classes"])
    check("its tab says so too", r["tabLock"] is True, str(r["tabLock"]))

    r = ev(ws, f"""(async () => {{ {MODS}
      tabs.openDocument(); const n = state.pages.length;
      await pages.importPdfBytes(new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3]).buffer, 'broken.pdf');
      return {{ added: state.pages.length - n, status: document.getElementById('statusMsg').textContent }};
    }})()""", awaitp=True)
    check("a damaged file is refused in plain words", r["added"] == 0 and "isn’t a PDF Redline can read" in r["status"], r["status"])


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

    if plot:
        # Once its markups are lifted out, a page is left with an empty
        # annotation list. That is not "has annotations": a sheet with no
        # text and nothing else to show needs no text layer drawn or held
        # on the GPU.
        layer = ev(ws, """(async () => {
          const tabs = await import('./js/tabs.js'), pages = await import('./js/pages.js');
          const { state, markDirty } = await import('./js/state.js'), plots = await import('./js/plot.js');
          const { buildPdfBytes } = await import('./js/export.js');
          const heavy = state.pages[state.pages.length - 1];
          heavy.annotations.push({ id: state.nextAnnoId++, type: 'ink', color: '#1a7f37', size: 5,
                                   points: [{ x: 400, y: 100 }, { x: 460, y: 160 }] });
          const bytes = await buildPdfBytes();
          heavy.annotations.pop();
          markDirty(false);
          tabs.openDocument();
          await pages.importPdfBytes(bytes.slice().buffer, 'resaved.pdf');
          const page = state.pages[state.pages.length - 1];
          pages.selectPage(page.id);
          const src = state.sources.find((s) => s.id === page.sourceId);
          const rec = plots.plotRecord(src, page.sourcePageIndex);
          for (let i = 0; i < 300 && rec.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
          const annots = src.pdfLibDoc.getPage(page.sourcePageIndex).node.Annots();
          return { state: rec.state, annots: annots ? annots.size() : null, text: !!(rec.page && rec.page.text),
                   markups: page.annotations.length };
        })()""", awaitp=True)
        check("the sheet's one markup came back, leaving its annotation list empty",
              layer["state"] == "ready" and layer["markups"] == 1 and layer["annots"] == 0, str(layer))
        check("and an empty list does not earn it a text layer", layer["text"] is False, str(layer))
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
                   cache: (sw.match(/const CACHE = 'redline-v(\\d+\\.\\d+)'/) || [])[1] };
        })()""", awaitp=True)
        check("build stamp on screen", stamp["shown"] and stamp["text"].startswith("rev "), stamp["text"])
        check("build stamp names the service worker's cache", stamp["text"].startswith(f"rev {stamp['cache']} "),
              f"{stamp['text']!r} vs redline-v{stamp['cache']}")
        check("build stamp repeated on the empty sheet", stamp["empty"] == stamp["text"], stamp["empty"])
        # The cache has to *contain* the build it is named for. Rev 0.24
        # filled a cache called v0.24 with 0.23's files, and an installed
        # app sat on the old build with nothing to tell it otherwise.
        cached = ev(ws, """(async () => {
          await navigator.serviceWorker.ready;
          const name = (await caches.keys()).find((k) => k.startsWith('redline-v'));
          if (!name) return { name: null };
          const cache = await caches.open(name);
          const keys = (await cache.keys()).map((r) => new URL(r.url));
          const page = await cache.match('./index.html');
          return { name, n: keys.length, versioned: keys.filter((u) => /[?&]v=/.test(u.search)).length,
                   stamp: page ? ((await page.text()).match(/id="buildStamp">\\s*(rev [0-9.]+)/) || [])[1] : null,
                   main: !!(await cache.match('./js/main.js')) };
        })()""", awaitp=True)
        check("the worker's cache holds the build it is named for",
              cached["name"] == f"redline-v{stamp['cache']}" and cached.get("stamp") == f"rev {stamp['cache']}", str(cached))
        check("with every file stored under the address the page asks for",
              cached.get("n", 0) >= 25 and cached.get("versioned") == 0 and cached.get("main") is True, str(cached))
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

        # Thumbnails arrive one at a time after the page itself; wait for
        # them as a person would, rather than catch the rail mid-fill.
        wait_for(ws, "document.querySelectorAll('#thumbList canvas').length >= 3", timeout=15, label="thumbnails painted")
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
        # The page-edit buttons sit above the rail, so the third thumbnail
        # starts below the fold; bring both ends of the drag into view.
        ev(ws, "document.getElementById('sidebar').scrollTop = 220")
        time.sleep(0.2)
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
        # Shortcuts must not fire while typing in the page-number field.
        ev(ws, "document.getElementById('pageInput').focus()")
        key(ws, "q", "KeyQ", 81)
        check("Q is inert while typing in a text field",
              ev(ws, "document.getElementById('toolCallout').classList.contains('toggled')") is False)
        ev(ws, "document.getElementById('pageInput').blur()")
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
        # The line weights come and go with the tool. That is only safe
        # because nothing below them moves when they do: a toolbar that
        # grew resized the stage, and that resize triggered a re-render
        # that tripped the known renderer race.
        CHROME_BOX = """(() => {
          const r = (id) => document.getElementById(id).getBoundingClientRect();
          return [r('pageToolbar').height, r('propsRow').height, r('canvasStage').top, r('canvasStage').height].join();
        })()"""
        chrome_before = ev(ws, CHROME_BOX)
        check("line weights are put away while nothing uses them",
              ev(ws, "getComputedStyle(document.getElementById('penSizeGrp')).display") == "none")
        key(ws, "p", "KeyP", 80)
        check("P activates the pen",
              ev(ws, "document.getElementById('toolPen').classList.contains('toggled')") is True)
        check("and brings out the line weights",
              ev(ws, "getComputedStyle(document.getElementById('penSizeGrp')).display") != "none")
        check("activating the pen moves nothing below the toolbar",
              ev(ws, CHROME_BOX) == chrome_before, f"{ev(ws, CHROME_BOX)} vs {chrome_before}")
        check("three pen sizes offered",
              ev(ws, "document.querySelectorAll('#penSizeGrp .pen-dot').length") == 3,
              str(ev(ws, "document.querySelectorAll('#penSizeGrp .pen-dot').length")))

        # Blue, so the stroke is separable from the fixture's black text.
        click(ws, "#colorGrp .swatch[data-color='#1f6feb']")
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
          return el ? (el.getAttribute('d').match(/[ML]/g) || []).length : 0;
        })()""")
        check("stroke followed the pointer", pcount >= 4, f"{pcount} points")
        check("stroke uses the selected colour",
              ev(ws, "document.querySelector('#leaderSvg .ink-stroke').getAttribute('stroke')")
              == "#1f6feb",
              ev(ws, "document.querySelector('#leaderSvg .ink-stroke').getAttribute('stroke')"))

        # One pick of the pen is one stroke, as with every tool: it goes
        # back to Select, and the stroke is left selected.
        check("the pen is put away after one stroke",
              ev(ws, "document.getElementById('toolPen').classList.contains('toggled')") is False
              and ev(ws, "document.querySelectorAll('#leaderSvg .ink-halo').length") == 1)
        drag_stroke([(0.25, 0.65), (0.45, 0.78), (0.7, 0.65)])
        check("so a second drag pans instead of drawing",
              ev(ws, "document.querySelectorAll('#leaderSvg .ink-stroke').length") == 1,
              f"{ev(ws, 'document.querySelectorAll(\"#leaderSvg .ink-stroke\").length')} strokes")
        key(ws, "p", "KeyP", 80)
        drag_stroke([(0.25, 0.65), (0.45, 0.78), (0.7, 0.65)])
        check("picking the pen again draws the next stroke",
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
            if (hit && (hit.getAttribute('class') || '').includes('ink-hit')) return last;
          }
          return last;
        })()"""
        key(ws, "p", "KeyP", 80)                       # in hand again, for the check below
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
        # What takes the pointer is the hit path — the same line, invisible
        # and wider — not the hairline that is drawn.
        check("a finished stroke is hit-testable once the pen is put away",
              ev(ws, "getComputedStyle(document.querySelector('#leaderSvg .ink-hit')).pointerEvents")
              == "stroke")
        check("by a path no narrower than a fingertip is kind to",
              ev(ws, "parseFloat(getComputedStyle(document.querySelector('#leaderSvg .ink-hit')).strokeWidth)") >= 14,
              str(ev(ws, "getComputedStyle(document.querySelector('#leaderSvg .ink-hit')).strokeWidth")))
        ev(ws, """(() => {
          document.querySelector('#leaderSvg .ink-hit').dispatchEvent(
            new PointerEvent('pointerdown', {bubbles: true, cancelable: true, pointerId: 7}));
          window.dispatchEvent(new PointerEvent('pointerup', {pointerId: 7}));
        })()""")
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
        # The save panel starts from the document's own name.
        ev(ws, "(async()=>{const s=await import('./js/state.js'); s.state.docName='smoke-out.pdf';})()", awaitp=True)
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

        # The Finder set-up step is done once. Installed, with nothing yet
        # opened from Finder, the empty sheet explains it — until it is
        # dismissed, and then never again.
        # (Chrome's media emulation does not cover display-mode, so the
        # one query the app makes is answered for it.)
        installed = ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": """
          (() => { const real = window.matchMedia.bind(window);
            window.matchMedia = (q) => /display-mode:\\s*standalone/.test(q)
              ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q); })();"""})
        ws.call("Page.navigate", {"url": URL})
        wait_for(ws, "document.querySelectorAll('#colorGrp .swatch').length > 0", timeout=30, label="installed app booted")
        time.sleep(0.5)
        NOTE = """(() => ({
          shown: getComputedStyle(document.getElementById('platformNote')).display !== 'none',
          text: document.getElementById('platformNoteText').textContent,
          done: getComputedStyle(document.getElementById('btnPlatformNoteDone')).display !== 'none',
        }))()"""
        note = ev(ws, NOTE)
        check("an installed app explains the one-time Finder step", note["shown"] and "Change All" in note["text"] and note["done"], str(note))
        click(ws, "#btnPlatformNoteDone")
        check("which can be dismissed", ev(ws, NOTE)["shown"] is False)
        ws.call("Page.navigate", {"url": URL})
        wait_for(ws, "document.querySelectorAll('#colorGrp .swatch').length > 0", timeout=30, label="booted again")
        time.sleep(0.5)
        check("and does not come back on the next launch", ev(ws, NOTE)["shown"] is False, str(ev(ws, NOTE)))
        ws.call("Page.removeScriptToEvaluateOnNewDocument", {"identifier": installed["identifier"]})

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
        markup_checks(ws3)
        surface_checks(ws3)
        typing_checks(ws3)
        ai_checks(ws3)
        lifecycle_checks(ws3)
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
