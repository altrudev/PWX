#!/usr/bin/env bash
# Runs the release status test (M4 5a) in every engine (screenshot from Chromium).
set -u
cd "$(dirname "$0")/.."
node tools/build-packages.mjs
PWX_TEST=1 node server/serve.mjs > /tmp/pwx-serve.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
for b in chromium firefox webkit; do
  echo "##### $b release status"

  # shellcheck disable=SC2086
  timeout 120 .venv/bin/python tests/release_status_test.py --browser "$b"
  echo "exit $?"
done
echo ALLDONE
