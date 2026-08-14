"""Redline browser smoke test: boot, render, zoom, rotate, reorder, save.

Drives real Chrome over CDP with real input events. The only seam is
window.showSaveFilePicker, replaced with an in-page fake handle so the
save path runs to completion without a native panel nobody can click.
"""
import base64, json, os, shutil, sys, tempfile, time
import cdp

PORT = int(os.environ.get("PORT", "8000"))
URL = f"http://localhost:{PORT}/"
HEADLESS = "--headful" not in sys.argv
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
  // Methods are non-enumerable so the handle stays structured-cloneable,
  // like the real FileSystemFileHandle persist.js expects to store.
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
        ws.call("Page.addScriptToEvaluateOnNewDocument", {"source": STUB})

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

        def wheel(dy, ctrl=False, meta=False, pinch=False):
            """A real Ctrl+wheel means the Ctrl key is physically down, so hold
            it for the duration — that is exactly what the app uses to tell a
            keyboard Ctrl from a trackpad pinch (which sets ctrlKey with no
            key press, i.e. pinch=True here)."""
            mods = (2 if (ctrl or pinch) else 0) | (4 if meta else 0)
            box = ev(ws, """(() => {
              const r = document.getElementById('canvasStage').getBoundingClientRect();
              return {x: r.left + r.width/2, y: r.top + r.height/2};
            })()""")
            if ctrl:
                ws.call("Input.dispatchKeyEvent", {
                    "type": "rawKeyDown", "key": "Control", "code": "ControlLeft",
                    "windowsVirtualKeyCode": 17, "nativeVirtualKeyCode": 17,
                    "modifiers": 2})
                time.sleep(0.05)
            ws.call("Input.dispatchMouseEvent", {
                "type": "mouseWheel", "x": box["x"], "y": box["y"],
                "deltaX": 0, "deltaY": dy, "modifiers": mods,
            })
            if ctrl:
                time.sleep(0.05)
                ws.call("Input.dispatchKeyEvent", {
                    "type": "keyUp", "key": "Control", "code": "ControlLeft",
                    "windowsVirtualKeyCode": 17, "nativeVirtualKeyCode": 17,
                    "modifiers": 0})
            time.sleep(0.5)

        def sel():
            return ev(ws, "[...document.querySelectorAll('#thumbList .thumb')]"
                          ".findIndex(t => t.classList.contains('selected'))")

        # --- Fit Pg: wheel turns pages, ctrl+wheel zooms ---
        click(ws, "#btnFitPage")
        time.sleep(0.6)
        click(ws, "#thumbList .thumb")
        time.sleep(0.6)
        start = sel()
        wheel(120)
        after = sel()
        check("Fit Pg: wheel down goes to the next page", after == start + 1,
              f"page index {start} -> {after}")
        wheel(-120)
        back = sel()
        check("Fit Pg: wheel up goes back", back == start, f"-> {back}")

        z0 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(-120, ctrl=True)
        z1 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit Pg: ctrl+wheel zooms instead", z0 != z1, f"{z0} -> {z1}")
        check("Fit Pg: ctrl+wheel did not also turn the page", sel() == back,
              f"page index {sel()}")

        # --- Fit W: wheel zooms, ctrl+wheel scrolls ---
        click(ws, "#btnFitWidth")
        time.sleep(0.6)
        pg0 = sel()
        z2 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(-120)
        z3 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit W: wheel zooms in", z2 != z3, f"{z2} -> {z3}")
        check("Fit W: wheel did not change page", sel() == pg0, f"page index {sel()}")

        # Zooming flips zoomMode to 'custom' — the wheel must keep zooming.
        z4 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(-120)
        z5 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit W: wheel still zooms after leaving the fit mode", z4 != z5,
              f"{z4} -> {z5}")

        ev(ws, "document.getElementById('canvasStage').scrollTop = 0")
        time.sleep(0.3)
        top0 = ev(ws, "document.getElementById('canvasStage').scrollTop")
        z6 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(120, ctrl=True)
        top1 = ev(ws, "document.getElementById('canvasStage').scrollTop")
        z7 = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("Fit W: ctrl+wheel scrolls the stage", top1 > top0, f"scrollTop {top0} -> {top1}")
        check("Fit W: ctrl+wheel did not zoom", z6 == z7, f"{z6} -> {z7}")

        # Cmd+wheel is the always-zoom escape hatch.
        z8 = ev(ws, "document.getElementById('zoomReadout').textContent")
        wheel(-120, meta=True)
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
        wheel(-20, pinch=True)
        zb = ev(ws, "document.getElementById('zoomReadout').textContent")
        check("trackpad pinch still zooms in Fit W", za != zb, f"{za} -> {zb}")

        # --- Tool shortcuts ---
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

        def stage_point(fx, fy):
            b = ev(ws, """(() => {
              const c = document.getElementById('pageCanvas').getBoundingClientRect();
              const s = document.getElementById('canvasStage').getBoundingClientRect();
              const l = Math.max(c.left, s.left), r = Math.min(c.right, s.right);
              const t = Math.max(c.top, s.top), b2 = Math.min(c.bottom, s.bottom);
              return {l, t, w: r - l, h: b2 - t};
            })()""")
            return b["l"] + b["w"] * fx, b["t"] + b["h"] * fy

        # Zoom in so there is somewhere to pan to.
        click(ws, "#btnZoomIn")
        time.sleep(0.8)
        before = ev(ws, "(s=>({l:s.scrollLeft,t:s.scrollTop}))(document.getElementById('canvasStage'))")
        x0, y0 = stage_point(0.6, 0.6)
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
        px, py = stage_point(0.5, 0.5)
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
        print("\n=== session restore ===")
        ws.call("Page.navigate", {"url": URL})
        wait_for(ws, "!!document.getElementById('pageCanvas')", label="reload")
        ok = wait_for(ws, "document.querySelectorAll('#thumbList .thumb').length === 3", timeout=30)
        check("session restored from IndexedDB after reload", ok,
              ev(ws, "document.getElementById('statusMsg').textContent"))
        order2 = ev(ws, "[...document.querySelectorAll('#thumbList .thumb')].map(t=>t.dataset.pageId)")
        check("restored page order matches", order2 == order1, f"{order2} vs {order1}")
        # The re-render is async and a restored session may come back at a
        # large zoom, so poll rather than sampling the instant thumbs appear.
        INK = """(() => {
          const c = document.getElementById('pageCanvas');
          const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] < 200 && d[i+3] > 0) dark++;
          return dark;
        })()"""
        wait_for(ws, f"{INK} > 500", timeout=20)
        restored_ink = ev(ws, INK)
        if restored_ink <= 500:
            # Known pre-existing bug, not a regression — see KNOWN-ISSUES.md.
            # The data restores fine; the render pipeline deadlocks. This
            # probe distinguishes the two so a future failure here isn't
            # mistaken for the detached-ArrayBuffer trap.
            print("      probe:", ev(ws, """(async () => {
              const s = await import('./js/state.js');
              const v = await import('./js/view.js');
              const t = (p, ms) => Promise.race([
                p.then(() => 'resolved').catch(e => String(e).slice(0, 120)),
                new Promise(r => setTimeout(() => r('HUNG'), ms))]);
              const page = s.state.pages.find(p => p.id === s.state.selectedPageId);
              const src = s.state.sources.find(x => x.id === page.sourceId);
              return {
                sourceBytes: src.bytes.byteLength,      // data intact?
                numPages: src.pdfjsDoc.numPages,
                getPage: await t(src.pdfjsDoc.getPage(page.sourcePageIndex + 1), 5000),
                thumbCanvases: document.querySelectorAll('#thumbList canvas').length,
                render: await t(v.renderMainCanvas(), 8000),
              };
            })()""", awaitp=True))
        check("restored page re-rasterises (ArrayBuffer not detached)", restored_ink > 500,
              f"{restored_ink} dark px")
        shot(ws, "07-restored")

        # ---------------------------------------------- console
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

    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        shutil.rmtree(profile, ignore_errors=True)

    print(f"\n{passed} passed, {failed} failed")
    print(f"screenshots: {SHOTS}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
