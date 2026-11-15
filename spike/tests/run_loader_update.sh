#!/usr/bin/env bash
# Hosted loader integrity and updates (audit M6) in every engine. The test manages its own server.
set -u
cd "$(dirname "$0")/.."
for b in chromium firefox webkit; do
  echo "##### $b loader update"
  timeout 300 .venv/bin/python tests/loader_update_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
