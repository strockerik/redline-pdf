#!/bin/sh
# Browser smoke test: boot, render, zoom, rotate, reorder, save, restore.
#
# Kept out of tests/run.sh on purpose — that suite needs only JavaScriptCore,
# while this one needs Chrome and a live http server. Pass --headful to watch
# it drive a real window.
set -e

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
port=${PORT:-8000}

if [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  echo "Google Chrome is required (the File System Access API is Chromium-only)." >&2
  exit 1
fi

# Reuse an already-running server; otherwise start one and clean it up.
srv=""
if ! curl -fsS -o /dev/null "http://localhost:$port/index.html" 2>/dev/null; then
  (cd "$root" && exec python3 -m http.server "$port") >/dev/null 2>&1 &
  srv=$!
  for _ in $(seq 1 40); do
    curl -fsS -o /dev/null "http://localhost:$port/index.html" 2>/dev/null && break
    sleep 0.25
  done
fi

cleanup() {
  # kill + wait, so the shell reaps the job without printing "Terminated".
  # Every step is `|| true`: `wait` on a SIGTERMed job returns 143, and
  # `set -e` would otherwise make that the script's exit status.
  if [ -n "$srv" ]; then
    kill "$srv" 2>/dev/null || true
    wait "$srv" 2>/dev/null || true
  fi
  pkill -f "redline-smoke-" 2>/dev/null || true
  exit "${1:-0}"
}
trap 'cleanup 1' INT TERM

PORT="$port" python3 "$here/smoke.py" "$@" || cleanup 1
cleanup 0
