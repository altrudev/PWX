#!/usr/bin/env bash
# The log as static files with real witnesses: logs published with tools/pwx-log.mjs and served by
# a plain static web server (python -m http.server: no PWX code, no special headers); two witness
# services (log/witness-service.mjs, the c2sp.org/tlog-witness protocol) co-sign over HTTP and read
# new entries from the public tiles for their clock check; Go's x/mod and transparency-dev code
# verifies the result. Uses throwaway keys; never the real ones.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); export PWX_KEYS="$T/keys" PWX_TEST_AUTHOR="$T/author.json"
WWW="$T/www"; MAIN=log.pwx.example/test; BACK=log.pwx.example/back; FUT=log.pwx.example/future
fail() { echo "FAIL $*"; exit 1; }
ok() { echo "OK   $*"; }
mkdir -p "$WWW" "$T/keys"
(cd "$WWW" && exec python3 -m http.server 8170 --bind 127.0.0.1) >/dev/null 2>&1 & HTTP=$!
PIDS="$HTTP"; trap 'kill $PIDS 2>/dev/null; rm -rf "$T"' EXIT
dirof() { echo "$WWW/${1#log.pwx.example/}"; }
for o in $MAIN $BACK $FUT; do node tools/pwx-log.mjs init "$(dirof $o)" "$o" >/dev/null || fail "init $o"; done
LOGKEY=$(node --input-type=module -e "import { logKey } from './log/devlog.mjs'; console.log((await logKey()).key)")
for w in 1 2; do
  node -e 'require("crypto").webcrypto.subtle.generateKey({name:"Ed25519"},true,["sign"]).then(k=>require("crypto").webcrypto.subtle.exportKey("jwk",k.privateKey)).then(j=>require("fs").writeFileSync(process.argv[1],JSON.stringify(j)))' "$T/keys/w$w.json"
  node -e '
    const [w, key, dir, logKey] = process.argv.slice(1);
    const logs = ["test", "back", "future"].map((n) => ({ origin: "log.pwx.example/" + n, key: logKey, url: "http://127.0.0.1:8170/" + n + "/" }));
    require("fs").writeFileSync(dir + "/w" + w + ".config.json", JSON.stringify({ name: "w" + w + ".pwx.example", key, state: dir + "/w" + w + ".state.json", port: 8180 + Number(w), logs }));
  ' "$w" "$T/keys/w$w.json" "$T" "$LOGKEY"
  node log/witness-service.mjs "$T/w$w.config.json" >/dev/null 2>"$T/w$w.err" & PIDS="$PIDS $!"
done
sleep 1
W="http://127.0.0.1:8181/ http://127.0.0.1:8182/"
node tools/pwx-log.mjs trust "$MAIN" w1.pwx.example="$T/keys/w1.json" w2.pwx.example="$T/keys/w2.json" > "$T/trust.json"
gocheck() {
  /tmp/pwx-interop "$(dirof $MAIN)" "$(node -e 'console.log(require(process.argv[1]).vkeys.log)' "$T/trust.json")" 2 \
    $(node -e 'console.log(require(process.argv[1]).vkeys.witnesses.join(" "))' "$T/trust.json")
}
publish() { node tools/pwx-log.mjs publish "$(dirof $1)" "$1" $W; }

publish $MAIN >/dev/null && ok "two witness services co-sign the empty log (tlog-witness, old 0)" || fail "first publish"
node tests/make_log_entries.mjs "$T/e1.json" 300 >/dev/null
node tools/pwx-log.mjs append "$(dirof $MAIN)" "$MAIN" "$T/e1.json" >/dev/null || fail append
out=$(publish $MAIN) && ok "witnesses co-sign at 301 (consistency from 0, clock check read 301 entries from the tiles)" || fail "publish: $out"
out=$(gocheck) && ok "Go (x/mod note + tlog, transparency-dev cosignature): ${out##*$'\n'}" || fail "go check: $out"
node tests/make_log_entries.mjs "$T/e2.json" 260 300 >/dev/null
node tools/pwx-log.mjs append "$(dirof $MAIN)" "$MAIN" "$T/e2.json" >/dev/null || fail append2
rm "$(dirof $MAIN).witnesses.json"   # the log forgot what the witnesses saw: it sends "old 0"
code=$(curl -s -o /dev/null -w '%{http_code}' --data-binary @<(printf 'old 0\n\n'; cat "$(dirof $MAIN)/checkpoint") http://127.0.0.1:8181/add-checkpoint)
[ "$code" = 409 ] && ok "a wrong old size gets 409 with the witness's size" || fail "expected 409, got $code"
publish $MAIN >/dev/null && ok "log grows past a full tile; after the 409 the log retries from 301 and both witnesses co-sign" || fail publish2
out=$(gocheck) && ok "Go check at size 561: ${out##*$'\n'}" || fail "go check 2: $out"

node --input-type=module -e "
  import { readFile } from 'node:fs/promises';
  import { fromUrl } from './log/static.mjs';
  import { TileReader } from './log/tiles.mjs';
  import * as N from './lib/pwx-note.mjs';
  const trust = JSON.parse(await readFile('$T/trust.json', 'utf8'));
  const get = fromUrl('http://127.0.0.1:8170/test/');
  const cp = await N.verifyCheckpointNote(new TextDecoder().decode(await get('checkpoint')), trust);
  const e = await new TileReader(get, cp.size).provenEntry(400, cp.root);
  if (JSON.parse(new TextDecoder().decode(e.data)).entry.version !== '1.0.399') throw new Error('wrong entry');
  console.log('OK   PWX reader over HTTP: entry 400 proven against the witnessed checkpoint (' + cp.cosigned.length + ' witnesses)');
" || fail "node reader"

# Clock check: a log that backdates or postdates entries gets no co-signature.
for o in $BACK $FUT; do publish $o >/dev/null || fail "first publish $o"; done
node tests/make_log_entries.mjs "$T/e3.json" 2 900 >/dev/null
PWX_LOG_TIME_SHIFT_MS=-86400000 node tools/pwx-log.mjs append "$(dirof $BACK)" "$BACK" "$T/e3.json" >/dev/null
out=$(publish $BACK 2>&1) && fail "witnesses signed backdated entries" || { echo "$out" | grep -q "backdated" && ok "entries backdated by a day: both witnesses refuse" || fail "backdate: $out"; }
PWX_LOG_TIME_SHIFT_MS=86400000 node tools/pwx-log.mjs append "$(dirof $FUT)" "$FUT" "$T/e3.json" >/dev/null
out=$(publish $FUT 2>&1) && fail "witnesses signed future-dated entries" || { echo "$out" | grep -q "in the future" && ok "entries dated a day ahead: both witnesses refuse" || fail "future: $out"; }

# A log that rewrites history: the witnesses refuse and keep evidence; Go refuses the checkpoint.
rm -rf "$(dirof $MAIN)"; node tools/pwx-log.mjs init "$(dirof $MAIN)" "$MAIN" >/dev/null
node tests/make_log_entries.mjs "$T/e4.json" 600 1000 >/dev/null
node tools/pwx-log.mjs append "$(dirof $MAIN)" "$MAIN" "$T/e4.json" >/dev/null
out=$(publish $MAIN 2>&1) && fail "witnesses signed a rewritten log" || true
ev=$(node -e 'console.log(require(process.argv[1]).logs["log.pwx.example/test"].evidence.length)' "$T/w1.state.json")
echo "$out" | grep -q "doesn't extend" && [ "$ev" = 1 ] && ok "rewritten history: witnesses refuse (422) and keep the conflicting checkpoint as evidence" || fail "rewrite: $out (evidence $ev)"
out=$(gocheck 2>&1) && fail "Go accepted an un-co-signed checkpoint" || ok "Go also refuses the rewritten log's checkpoint (no witness co-signatures)"
echo "static log: PASS"
