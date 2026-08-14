"""Standalone repro: import -> reorder page 1 to the end -> select the
first thumb -> reload. Does the restored session paint?

Uses only stock UI gestures, so it runs against any version of the app.
"""
import shutil, sys, tempfile, time
sys.path.insert(0, "/Users/erikstrock/Desktop/myStuff/Apps/redline/tests/browser")
import cdp

FIX = "/Users/erikstrock/Desktop/myStuff/Apps/redline/tests/browser/fixture.pdf"
READY = "document.querySelectorAll('#colorGrp .swatch').length > 0"
INK = """(()=>{const c=document.getElementById('pageCanvas');
 const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let k=0;
 for(let i=0;i<d.length;i+=4) if(d[i]<200&&d[i+3]>0)k++;
 return {main:k, thumbs:document.querySelectorAll('#thumbList canvas').length};})()"""


def ev(ws, e, a=False):
    r = ws.call("Runtime.evaluate", {"expression": e, "returnByValue": True, "awaitPromise": a})
    if "exceptionDetails" in r:
        return {"THREW": r["exceptionDetails"].get("text")}
    return r["result"].get("value")


def wf(ws, e, t=30):
    end = time.time() + t
    while time.time() < end:
        if ev(ws, e):
            return True
        time.sleep(0.15)
    return False


def run(port):
    prof = tempfile.mkdtemp(prefix="rl-race-")
    proc = cdp.launch("about:blank", port, prof)
    try:
        t = cdp.page_target(port)
        ws = cdp.WS(t["webSocketDebuggerUrl"])
        ws.call("Runtime.enable"); ws.call("Page.enable")
        ws.call("Page.navigate", {"url": "http://localhost:8000/"})
        wf(ws, READY)
        doc = ws.call("DOM.getDocument")["root"]["nodeId"]
        n = ws.call("DOM.querySelector", {"nodeId": doc, "selector": "#fileInput"})["nodeId"]
        ws.call("DOM.setFileInputFiles", {"nodeId": n, "files": [FIX]})
        wf(ws, "document.querySelectorAll('#thumbList .thumb').length===3")
        time.sleep(2)

        # drag thumb 1 to the bottom half of thumb 3
        r = ev(ws, """[...document.querySelectorAll('#thumbList .thumb')].map(t=>{
          const b=t.getBoundingClientRect();
          return {x:b.left+b.width/2, y:b.top+b.height/2, low:b.top+b.height*0.8};})""")
        src, dst = r[0], r[2]
        ws.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": src["x"], "y": src["y"],
                                             "button": "left", "clickCount": 1})
        for i in range(1, 11):
            ws.call("Input.dispatchMouseEvent", {"type": "mouseMoved",
                "x": src["x"] + (dst["x"]-src["x"])*i/10,
                "y": src["y"] + (dst["low"]-src["y"])*i/10, "button": "left", "buttons": 1})
            time.sleep(0.04)
        ws.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": dst["x"], "y": dst["low"],
                                             "button": "left", "buttons": 0, "clickCount": 1})
        time.sleep(1.5)
        order = ev(ws, "[...document.querySelectorAll('#thumbList .thumb')].map(t=>t.dataset.pageId)")

        # select the first thumb in the new order
        b = ev(ws, """(()=>{const e=document.querySelectorAll('#thumbList .thumb')[0];
          const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()""")
        for ty in ("mousePressed", "mouseReleased"):
            ws.call("Input.dispatchMouseEvent", {"type": ty, "x": b["x"], "y": b["y"],
                                                 "button": "left", "clickCount": 1})
        time.sleep(2)
        before = ev(ws, INK)
        time.sleep(2.5)     # autosave debounce

        ws.call("Page.navigate", {"url": "http://localhost:8000/"})
        wf(ws, READY)
        wf(ws, "document.querySelectorAll('#thumbList .thumb').length===3")
        time.sleep(4)
        print(f"  order={order}  before reload={before}  AFTER RESTORE={ev(ws, INK)}")
    finally:
        proc.terminate()
        shutil.rmtree(prof, ignore_errors=True)


if __name__ == "__main__":
    for i in range(int(sys.argv[1]) if len(sys.argv) > 1 else 1):
        run(9400 + i)
