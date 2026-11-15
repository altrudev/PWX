#!/usr/bin/env bash
# Every PWX test suite, in order. Summary lines only; full logs in /tmp/pwx-all-*.log.
set -u
cd "$(dirname "$0")/.."
node --test tests/verify.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
for suite in run_strict run_notes run_offline run_local run_loader_update run_trust run_matrix; do
  bash "tests/$suite.sh" > "/tmp/pwx-all-$suite.log" 2>&1
  echo "== $suite"; grep -E "^#####|: PASS|: FAIL|^FAIL|PASS: no|FAIL: |tampered|blocked [0-9]" "/tmp/pwx-all-$suite.log"
done
echo ALLDONE
