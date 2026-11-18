#!/usr/bin/env bash
# M4 soft mode: receipts inside packages, checked offline by the loader, in every engine.
set -u
cd "$(dirname "$0")/.."
node tools/build-packages.mjs >/dev/null
node --test tests/receipt.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)|✖"
for b in chromium firefox webkit; do
  echo "##### $b receipts"
  timeout 180 .venv/bin/python tests/receipt_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
