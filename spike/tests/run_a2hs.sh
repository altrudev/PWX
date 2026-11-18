#!/usr/bin/env bash
# Runs the Add to Home Screen guide test in every engine. The test manages its own server.
set -u
cd "$(dirname "$0")/.."
node tools/build-packages.mjs
for b in chromium firefox webkit; do
  echo "##### $b add to home screen"
  timeout 180 .venv/bin/python tests/a2hs_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
