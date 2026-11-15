#!/usr/bin/env bash
# App origins don't trust the loader: a hijacked loader's pushes are refused, in every engine.
set -u
cd "$(dirname "$0")/.."
for b in chromium firefox webkit; do
  echo "##### $b bootstrap trust"
  timeout 300 .venv/bin/python tests/bootstrap_trust_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
