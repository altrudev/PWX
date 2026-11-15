#!/usr/bin/env bash
# Runs the strict-runtime leak test in every engine.
set -u
cd "$(dirname "$0")/.."
node tools/build-packages.mjs
PWX_TEST=1 node server/serve.mjs > /tmp/pwx-serve.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
for b in chromium firefox webkit; do
  echo "##### $b strict"
  timeout 300 .venv/bin/python tests/strict_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
