#!/usr/bin/env bash
# M4 log spike: Merkle proofs and log attacks in Node, then the log in every browser engine.
set -u
cd "$(dirname "$0")/.."
node --test tests/merkle.test.mjs tests/log.test.mjs tests/tiles.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|✖"
for b in chromium firefox webkit; do
  echo "##### $b log"
  timeout 90 .venv/bin/python tests/log_browser_test.py --browser "$b"
done
( cd interop && go build -o /tmp/pwx-interop . ) && bash tests/run_static_log.sh
echo ALLDONE
