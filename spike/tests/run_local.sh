#!/usr/bin/env bash
# pwx-local: tamper check, then the browser test in every engine.
set -u
cd "$(dirname "$0")/.."
node tools/build-packages.mjs
echo "##### tamper check"
node local/pwx-local.mjs verify
T=$(mktemp -d)
cp -r lib loader app-origin local "$T"/
echo "// injected" >> "$T/loader/loader.mjs"
if PWX_BUNDLE="$T" PWX_HOME="$T/home" PWX_PORT=7190 timeout 5 node local/pwx-local.mjs serve; then
  echo "FAIL: tampered bundle was served"
else
  echo "OK   tampered bundle refused (exit $?)"
fi
rm -rf "$T"
for b in chromium firefox webkit; do
  echo "##### $b local"
  timeout 180 .venv/bin/python tests/local_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
