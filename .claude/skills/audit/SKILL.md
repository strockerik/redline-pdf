---
name: audit
description: Audit Redline for bugs, dead code, import cycles, wasted work, and design problems, verifying each finding in a real browser before reporting it. Use when asked to review, audit, check, or look for problems in this app — before a deploy, or after a change that touches rendering, pointer handling, persistence, or the service worker.
argument-hint: "[all | <path>] [--fix]"
---

# Audit Redline

## Trigger

Run when asked to review or check this app, and before any deploy that
touches `js/`, `sw.js`, or `index.html`.

Argument decides scope. Mechanical checks always cover the whole repo —
cycles and dead code are global properties and a diff cannot show them.

| Argument | Judgment review covers |
|---|---|
| *(none)* | the current diff (`git diff HEAD`, or the last commit if clean) |
| `all` | every module in `js/` |
| `<path>` | that file or directory |
| `--fix` | apply the findings afterwards, then re-run both suites |

## Steps

### 1. Mechanical checks

```sh
tests/analyze.py
```

Import cycles, unreachable exports, missing DOM ids, absolute paths,
service-worker precache drift, and `state` fields that would leak across
tabs. Exit 1 means a real finding — these are deterministic, so treat a
FAIL as fact and carry it into the report.

The `info` lines are not defects. "Exported but only used inside its own
file" means the `export` keyword is redundant, not that the function is
unreachable; report it as a cleanup at most.

### 2. Establish a baseline

```sh
tests/run.sh                 # must be green before you believe anything else
```

If this is red, stop and report that. Every behavioural claim below is
worthless against a broken baseline.

`tests/browser/run.sh` takes about two minutes and **is expected to end
`85 passed, 1 failed`**. That one red check is the render deadlock. Before
going near it, read `tests/browser/KNOWN-ISSUES.md`: three hypotheses are
already tried and disproved there, including the obvious one. Do not
re-run those experiments.

### 3. Read the target against the hazard catalogue

Read `references/hazards.md` now and work through it against the diff or
path. It is nine categories, each built from a bug that actually shipped
in this repo — not generic advice.

Read `CLAUDE.md` too if the change touches coordinates, rotation, or
export; the visual↔native rule there is the single easiest thing to get
subtly wrong.

### 4. Verify before reporting

This is the step that separates a report from a guess.

Anything behavioural gets reproduced by driving the app — a short CDP
script against `tests/browser/cdp.py`, or a new check in `smoke.py`. Then
label every finding:

- **CONFIRMED** — reproduced, with the observed output quoted.
- **PLAUSIBLE** — reasoned from the code but not reproduced. Say what you
  could not rule out.

Never present PLAUSIBLE as CONFIRMED. Two confident-sounding hypotheses
about this codebase turned out to be wrong on contact with the browser,
and both cost more to unwind than they would have to check.

Three traps specific to this harness:

- **Headless Chrome is not real Chrome.** No browser zoom, no window
  chrome, different device pixel ratio. Ask of any green check: *would
  this pass for the same reason in real Chrome?* A Ctrl+wheel bug hid here
  for exactly this reason.
- **Watch the check count, not just the failures.** The app runs close to
  a render-capacity limit. Adding renders anywhere can move the deadlock
  earlier and silently cost dozens of later checks. If the total drops,
  suspect the wedge moved rather than assuming your change broke things.
- **Render-heavy new checks get their own browser instance** — see
  `zoom_mode_checks` in `smoke.py` for the pattern.

### 5. Report

Rank most severe first. For each finding:

```
<severity>  file.js:LINE  — one sentence saying what is wrong
  Failure:  concrete inputs or steps -> the wrong result the user sees
  Verdict:  CONFIRMED (evidence) | PLAUSIBLE (what is unverified)
```

Severity is about consequence, not effort: **data loss** (a file
overwritten, work lost on reload) ranks above **silent breakage** (a
control that stops working with nothing on screen to say so), which ranks
above **visible bugs**, which rank above **cleanups**.

State plainly when a category came up clean. "No coordinate-space issues —
this change does not touch export" is useful; silence is not.

Do not edit anything unless `--fix` was passed.

## Verification

With `--fix`, after applying:

```sh
tests/analyze.py && tests/run.sh && tests/browser/run.sh
```

The browser suite must still end `85 passed, 1 failed` — same count, same
single known failure. A different total means something moved; investigate
before claiming the fix is done.

If a fix touches the service worker or any precached file, bump `CACHE` in
`sw.js`. `tests/analyze.py` warns when it is stale, and an installed app
will otherwise keep serving the old version out of cache indefinitely.
