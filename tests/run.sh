#!/bin/sh
# Headless checks for the logic that is painful to verify by eye —
# the rotation math, annotation geometry on rotated pages, and export.
#
# Uses JavaScriptCore, which ships with macOS, so there is no npm and no
# node_modules. Anything involving actual rendering or DOM interaction
# still has to be checked in a browser; see README.
set -e
cd "$(dirname "$0")"

JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if [ ! -x "$JSC" ]; then
  echo "JavaScriptCore not found at $JSC" >&2
  exit 1
fi

fail=0
for t in run_imports run_rotmath run_geometry run_rotate run_export; do
  echo "=== $t ==="
  if ! "$JSC" -m "$t.mjs"; then fail=1; fi
  echo
done

if [ "$fail" -ne 0 ]; then
  echo "SUITE FAILED" >&2
  exit 1
fi
echo "All suites passed."
