#!/usr/bin/env bash
# Runs the offline and privacy test in every engine. The test manages its own servers.
set -u
cd "$(dirname "$0")/.."
node tools/build-packages.mjs
for b in chromium firefox webkit; do
  echo "##### $b offline"
  timeout 180 .venv/bin/python tests/offline_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
