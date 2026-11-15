#!/usr/bin/env bash
# Runs the Notes app test in every engine (screenshot from Chromium).
set -u
cd "$(dirname "$0")/.."
node tools/build-packages.mjs
PWX_TEST=1 node server/serve.mjs > /tmp/pwx-serve.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
for b in chromium firefox webkit; do
  echo "##### $b notes"
  shot=""; [ "$b" = chromium ] && shot="--shot /tmp/pwx-notes.png"
  # shellcheck disable=SC2086
  timeout 120 .venv/bin/python tests/notes_test.py --browser "$b" $shot
  echo "exit $?"
done
echo ALLDONE
