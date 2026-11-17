#!/usr/bin/env bash
# Signer spike (M4 section 0): two-device approval, then the known-limit probe. Every engine.
set -u
cd "$(dirname "$0")/.."
for b in chromium firefox webkit; do
  echo "##### $b signer"
  timeout 150 .venv/bin/python tests/signer_test.py --browser "$b"
  echo "exit $?"
  timeout 90 .venv/bin/python tests/signer_clone_probe.py --browser "$b" 2>&1 | tail -1
done
echo ALLDONE
