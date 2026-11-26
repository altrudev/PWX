#!/usr/bin/env bash
# Every PWX test suite, in order. Summary lines only; full logs in /tmp/pwx-all-*.log.
set -u
cd "$(dirname "$0")/.."
node --test tests/verify.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
for suite in run_strict run_notes run_app_install run_offline run_local run_loader_update run_a2hs run_trust run_receipt run_release_status run_log run_matrix; do
  bash "tests/$suite.sh" > "/tmp/pwx-all-$suite.log" 2>&1
  echo "== $suite"; grep -E "^#####|: PASS|: FAIL|^FAIL|PASS: no|FAIL: |tampered|blocked [0-9]|^ℹ (pass|fail)|^OK   Go|static log:" "/tmp/pwx-all-$suite.log"
done
echo "== guard extension (Chromium only)"
timeout 300 .venv/bin/python tests/guard_ext_test.py > /tmp/pwx-all-guard.log 2>&1; grep -E "PASS|FAIL" /tmp/pwx-all-guard.log
echo ALLDONE
