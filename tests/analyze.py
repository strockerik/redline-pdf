#!/usr/bin/env python3
"""Static checks for Redline — the invariants no behavioural test can see.

The two suites in tests/ run the app. This reads it. Everything here earned
its place by shipping as a real bug at least once:

  - js/tabs.js went out missing from sw.js PRECACHE. The app worked online
    and would have failed to boot offline.
  - An absolute /js/... path works locally and 404s on GitHub Pages, which
    serves from /redline-pdf/.
  - A per-document field added to `state` but not to DOC_FIELDS silently
    leaks across tabs.

Pure stdlib, no dependencies, no build step — same bargain as the rest of
the repo. Run it directly:

    tests/analyze.py            # ok / FAIL / WARN lines, exit 1 on any FAIL
    tests/analyze.py --quiet    # findings only

Deliberately not wired into tests/run.sh: that suite's promise is
"JavaScriptCore only, nothing installed", and this is Python.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
QUIET = "--quiet" in sys.argv

# view.js <-> annots.js is deliberate and documented in CLAUDE.md: neither
# runs anything at module-evaluation time, so the cycle is inert. Any other
# cycle is a finding.
ALLOWED_CYCLES = [frozenset({"view.js", "annots.js"})]

# Fields on `state` that belong to the app, not to a document. Anything on
# `state` that is in neither this set nor DOC_FIELDS is unclassified — which
# is the point: adding a field should force the per-document question,
# because getting it wrong leaks one tab's data into another.
APP_WIDE_STATE = {
    "docs", "activeDocId", "nextDocId",
    "activeTool", "spaceHeld", "wheelZoom", "pendingCalloutTip",
    "currentColor", "currentFontSize", "currentPenSize",
    "zoomMode", "lastFitMode", "zoomLevel", "currentScale",
    "domRefs",
}

passed = failed = warned = 0


def ok(label, detail=""):
    global passed
    passed += 1
    if not QUIET:
        print(f"ok    {label}" + (f"  ({detail})" if detail else ""))


def fail(label, detail=""):
    global failed
    failed += 1
    print(f"FAIL  {label}")
    if detail:
        for line in str(detail).splitlines():
            print(f"      {line}")


def warn(label, detail=""):
    global warned
    warned += 1
    print(f"WARN  {label}")
    if detail:
        for line in str(detail).splitlines():
            print(f"      {line}")


def info(label, detail=""):
    if not QUIET:
        print(f"info  {label}")
        if detail:
            for line in str(detail).splitlines():
                print(f"      {line}")


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as f:
        return f.read()


def js_files():
    d = os.path.join(ROOT, "js")
    return sorted(f for f in os.listdir(d) if f.endswith(".js"))


# ============================================================
# Parsing
# ============================================================
# Static: import ... from './x.js'  /  import './x.js'
RE_STATIC_IMPORT = re.compile(
    r"""import\s*(?:(?P<names>\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*from\s*)?['"](?P<path>[^'"]+)['"]""",
    re.S,
)
# Dynamic: import('./x.js') and import(`${APP}/x.js`). main.js reaches
# rotmath.test.js this way, and a static-only scan calls it an orphan.
RE_DYNAMIC_IMPORT = re.compile(r"""import\s*\(\s*[`'"]([^`'"]+)[`'"]\s*\)""")
# The bindings of a dynamic import are destructured on the assignment, not
# in the import clause:
#     const { runRotMathTests } = await import('./rotmath.test.js');
# Miss this and every dynamically imported name looks unused.
RE_DYNAMIC_BINDING = re.compile(
    r"""(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(\s*[`'"]([^`'"]+)[`'"]""")

RE_EXPORT_DECL = re.compile(
    r"^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)", re.M)
RE_EXPORT_LIST = re.compile(r"^export\s*\{([^}]*)\}", re.M)


def imported_names(block):
    """The names pulled out of an `import { a, b as c }` clause."""
    if not block or not block.startswith("{"):
        return []
    out = []
    for part in block.strip("{}").split(","):
        part = part.strip()
        if not part:
            continue
        out.append(part.split(" as ")[0].strip())
    return out


def module_of(path):
    """'./view.js' or '${APP}/view.js' -> 'view.js'; None if not a js module."""
    tail = path.rsplit("/", 1)[-1]
    return tail if tail.endswith(".js") else None


def scan_imports(text):
    """[(module, [names]), ...] for every import in a file, static or not."""
    found = []
    for m in RE_STATIC_IMPORT.finditer(text):
        mod = module_of(m.group("path"))
        if mod:
            found.append((mod, imported_names(m.group("names"))))
    bound = {}
    for m in RE_DYNAMIC_BINDING.finditer(text):
        mod = module_of(m.group(2))
        if mod:
            bound.setdefault(mod, []).extend(imported_names("{" + m.group(1) + "}"))
    for m in RE_DYNAMIC_IMPORT.finditer(text):
        mod = module_of(m.group(1))
        if mod:
            found.append((mod, bound.pop(mod, [])))
    return found


def scan_exports(text):
    names = set(RE_EXPORT_DECL.findall(text))
    for m in RE_EXPORT_LIST.finditer(text):
        for part in m.group(1).split(","):
            part = part.strip()
            if part:
                names.add(part.split(" as ")[-1].strip())
    return names


# ============================================================
# Checks
# ============================================================
def check_precache():
    """Every file the installed app needs offline must be precached.

    sw.js uses cache.addAll, which is atomic: one 404 fails the whole
    install, so a listed-but-missing entry is as bad as a missing one.
    """
    sw = read("sw.js")
    block = sw[sw.index("const PRECACHE"):sw.index("];", sw.index("const PRECACHE"))]
    listed = set(re.findall(r"['\"]\./([^'\"]*)['\"]", block))
    listed.discard("")                                   # './' itself

    required = {"index.html", "app.css", "manifest.webmanifest"}
    required |= {f"js/{f}" for f in js_files()}

    # Vendor libraries: <script src> plus the worker, which is only ever a
    # string literal in main.js — a module-graph check would never see it.
    html = read("index.html")
    required |= {m for m in re.findall(r"src=\"\./([^\"]+)\"", html) if m.startswith("vendor/")}
    for m in re.findall(r"['\"]\./(vendor/[^'\"]+)['\"]", read("js", "main.js")):
        required.add(m)

    # Icons come from two places, and the manifest's are easy to forget
    # because nothing in the JS references them.
    required |= set(re.findall(r"\"src\":\s*\"\.?/?(icons/[^\"]+)\"", read("manifest.webmanifest")))
    required |= set(re.findall(r"href=\"\./(icons/[^\"]+)\"", html))

    missing = sorted(required - listed)
    if missing:
        fail("every app-shell file is precached",
             "not in sw.js PRECACHE — the installed app fails offline:\n"
             + "\n".join(f"  {m}" for m in missing))
    else:
        ok("every app-shell file is precached", f"{len(listed)} entries")

    ghosts = sorted(p for p in listed if not os.path.exists(os.path.join(ROOT, p)))
    if ghosts:
        fail("every PRECACHE entry exists on disk",
             "cache.addAll is atomic — one 404 fails the whole install:\n"
             + "\n".join(f"  {g}" for g in ghosts))
    else:
        ok("every PRECACHE entry exists on disk")
    return listed


def check_cache_bumped(precached):
    """A deploy that changes app files without bumping CACHE leaves the
    installed app serving the previous version out of cache, forever."""
    m = re.search(r"const CACHE = '([^']+)'", read("sw.js"))
    if not m:
        fail("sw.js declares a CACHE version")
        return
    version = m.group(1)

    def git(*args):
        return subprocess.run(["git", "-C", ROOT, *args],
                              capture_output=True, text=True).stdout.strip()

    if not git("rev-parse", "--git-dir"):
        info("CACHE bump check skipped", "not a git repository")
        return

    # The commit that introduced the current CACHE value.
    since = git("log", "-1", "--format=%H", "-S", f"const CACHE = '{version}'", "--", "sw.js")
    if not since:
        info("CACHE bump check skipped", f"{version} not found in history (unreleased?)")
        return

    tracked = [p for p in sorted(precached) if os.path.exists(os.path.join(ROOT, p))]
    changed = [f for f in git("diff", "--name-only", f"{since}..HEAD", "--", *tracked).splitlines() if f]
    dirty = [f for f in git("diff", "--name-only", "--", *tracked).splitlines() if f]
    stale = sorted(set(changed) | set(dirty))

    if stale:
        warn(f"CACHE ({version}) is older than the files it caches",
             "changed since that bump — bump CACHE before deploying:\n"
             + "\n".join(f"  {s}" for s in stale))
    else:
        ok("CACHE is newer than every precached file", version)


def check_relative_paths():
    """Pages serves from /redline-pdf/, so a root-absolute path works on
    localhost and 404s in production. Everything must stay './'."""
    bad = []
    for name in ["index.html", "sw.js", "manifest.webmanifest"]:
        for i, line in enumerate(read(name).splitlines(), 1):
            for m in re.finditer(r"""(?:src|href)=["'](/[^/"'][^"']*)["']""", line):
                bad.append(f"{name}:{i}  {m.group(1)}")
            for m in re.finditer(r""""(?:src|start_url|scope)":\s*"(/[^/"][^"]*)\"""", line):
                bad.append(f"{name}:{i}  {m.group(1)}")
    for f in js_files():
        for i, line in enumerate(read("js", f).splitlines(), 1):
            for m in re.finditer(r"""from\s*["'](/[^/"'][^"']*)["']""", line):
                bad.append(f"js/{f}:{i}  {m.group(1)}")
    if bad:
        fail("all paths are relative", "root-absolute paths 404 on GitHub Pages:\n"
             + "\n".join(f"  {b}" for b in bad))
    else:
        ok("all paths are relative")


def build_graph():
    graph = {}
    for f in js_files():
        graph[f] = {mod for mod, _ in scan_imports(read("js", f))
                    if mod in set(js_files())}
    return graph


def check_cycles(graph):
    """Report each cycle once. A naive DFS reports view->annots->view and
    annots->view->annots as two findings; they are one strongly connected
    component."""
    index, low, onstack, stack, sccs = {}, {}, set(), [], []
    counter = [0]

    def strongconnect(v):
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        onstack.add(v)
        for w in sorted(graph.get(v, ())):
            if w not in index:
                strongconnect(w)
                low[v] = min(low[v], low[w])
            elif w in onstack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = set()
            while True:
                w = stack.pop()
                onstack.discard(w)
                comp.add(w)
                if w == v:
                    break
            # A single node is only a cycle if it imports itself.
            if len(comp) > 1 or v in graph.get(v, ()):
                sccs.append(frozenset(comp))

    for v in sorted(graph):
        if v not in index:
            strongconnect(v)

    unexpected = [c for c in sccs if c not in ALLOWED_CYCLES]
    if unexpected:
        fail("no undeclared import cycles",
             "\n".join("  " + " <-> ".join(sorted(c)) for c in unexpected)
             + "\nAdd to ALLOWED_CYCLES here and to CLAUDE.md if deliberate —\n"
               "and make sure neither module runs anything at import time.")
    else:
        ok("no undeclared import cycles",
           f"{len(sccs)} declared: " + "; ".join(" <-> ".join(sorted(c)) for c in sccs)
           if sccs else "none")


def check_dead_exports():
    """An export nobody imports is either dead or an accident. Split the
    two cases: something used inside its own file is not unreachable, and
    saying so would be wrong."""
    modules = js_files()
    sources = {f: read("js", f) for f in modules}

    # tests/ count as consumers: drawAnnotationOnPage and
    # remapAnnotationsForRotation are exported *for* the suites.
    consumers = dict(sources)
    tests_dir = os.path.join(ROOT, "tests")
    for f in sorted(os.listdir(tests_dir)):
        if f.endswith(".mjs"):
            consumers[f"tests/{f}"] = read("tests", f)

    imported = set()
    for name, text in consumers.items():
        for mod, names in scan_imports(text):
            imported.update(names)

    dead, self_used = [], []
    for f in modules:
        for name in sorted(scan_exports(sources[f])):
            if name in imported:
                continue
            # More than one mention means it is called where it is defined.
            uses = len(re.findall(rf"\b{re.escape(name)}\b", sources[f]))
            (self_used if uses > 1 else dead).append(f"js/{f}  {name}")

    if dead:
        fail("no unreachable exports",
             "exported, never imported, never used in its own file:\n"
             + "\n".join(f"  {d}" for d in dead))
    else:
        ok("no unreachable exports")

    if self_used:
        info(f"{len(self_used)} exports are only used inside their own file",
             "not dead — just candidates for dropping the `export`:\n"
             + "\n".join(f"  {s}" for s in self_used))


def check_dom_ids():
    """A typo'd id is a silent null: `$('nope').classList` throws, or worse,
    an optional-chained one quietly does nothing."""
    html = read("index.html")
    present = set(re.findall(r'\bid="([\w-]+)"', html))

    referenced = {}
    for f in js_files():
        text = read("js", f)
        # Nearly all access goes through a per-file `const $ = id =>
        # document.getElementById(id)` helper — four of them exist. Grepping
        # only getElementById finds a small fraction of the real ids.
        for pat in (r"\$\(\s*['\"]([\w-]+)['\"]\s*\)",
                    r"getElementById\(\s*['\"]([\w-]+)['\"]",
                    r"querySelector\(\s*['\"]#([\w-]+)"):
            for m in re.findall(pat, text):
                referenced.setdefault(m, set()).add(f"js/{f}")

    missing = sorted(set(referenced) - present)
    if missing:
        fail("every id used from JS exists in index.html",
             "\n".join(f"  #{m}  (from {', '.join(sorted(referenced[m]))})" for m in missing))
    else:
        ok("every id used from JS exists in index.html", f"{len(referenced)} ids")

    # An id in the HTML that no JS and no stylesheet mentions is dead markup.
    css = read("app.css")
    styled = set(re.findall(r"#([\w-]+)", css))
    orphan = sorted(present - set(referenced) - styled)
    if orphan:
        info(f"{len(orphan)} ids in index.html are used by neither JS nor CSS",
             "\n".join(f"  #{o}" for o in orphan))


def check_doc_fields():
    """Tabs work by swapping a fixed list of fields in and out of `state`.
    A per-document field left off that list keeps its value across a tab
    switch — one document showing another's data."""
    src = read("js", "state.js")

    body = src[src.index("export const state = {"):]
    body = body[:body.index("\n};")]
    # Fields are not one-per-line: `sources: [], pages: [],` is real, and a
    # line-anchored regex silently misses half of them.
    declared = set(re.findall(r"[{,\n]\s*(\w+):", body))

    doc_fields = set(re.findall(r"'(\w+)'",
                                src[src.index("export const DOC_FIELDS"):
                                    src.index("export function blankDoc")]))
    blank = src[src.index("export function blankDoc"):src.index("export function captureActiveDoc")]
    blank_fields = set(re.findall(r"[{,\n]\s*(\w+):", blank)) - {"id"}

    unclassified = sorted(declared - doc_fields - APP_WIDE_STATE)
    if unclassified:
        fail("every state field is classified per-document or app-wide",
             "not in DOC_FIELDS (state.js) and not in APP_WIDE_STATE (this script):\n"
             + "\n".join(f"  {u}" for u in unclassified)
             + "\nIf it belongs to a document, add it to DOC_FIELDS or it will\n"
               "leak across tabs. If it is app-wide, list it here.")
    else:
        ok("every state field is classified", f"{len(doc_fields)} per-document")

    gaps = sorted(doc_fields - blank_fields)
    if gaps:
        fail("blankDoc() initialises every DOC_FIELD",
             "a new tab would inherit these from whatever was live:\n"
             + "\n".join(f"  {g}" for g in gaps))
    else:
        ok("blankDoc() initialises every DOC_FIELD")

    extra = sorted(blank_fields - doc_fields)
    if extra:
        fail("blankDoc() sets nothing outside DOC_FIELDS",
             "set on the record but never swapped into state:\n"
             + "\n".join(f"  {e}" for e in extra))
    else:
        ok("blankDoc() sets nothing outside DOC_FIELDS")


def main():
    print("=== service worker ===")
    precached = check_precache()
    check_cache_bumped(precached)

    print("\n=== paths ===")
    check_relative_paths()

    print("\n=== module graph ===")
    check_cycles(build_graph())
    check_dead_exports()

    print("\n=== dom ===")
    check_dom_ids()

    print("\n=== tabs ===")
    check_doc_fields()

    print(f"\n{passed} passed, {failed} failed, {warned} warning(s)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
