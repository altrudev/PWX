#!/usr/bin/env bash
# Runs the leak test in every engine with each defense combination.
# Usage: bash tests/run_matrix.sh [browsers...]   (default: chromium firefox webkit)
set -u
cd "$(dirname "$0")/.."
PY=.venv/bin/python
browsers=("${@:-chromium firefox webkit}")
[ $# -eq 0 ] && browsers=(chromium firefox webkit)
node tools/build-packages.mjs
PWX_TEST=1 node server/serve.mjs > /tmp/pwx-serve.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
for b in "${browsers[@]}"; do
  for f in "" "--guard" "--hardened" "--guard --hardened"; do
    echo "##### $b ${f:-baseline}"
    # shellcheck disable=SC2086
    timeout 400 "$PY" tests/leak_test.py --browser "$b" $f
    echo "exit $?"
  done
done
echo ALLDONE
