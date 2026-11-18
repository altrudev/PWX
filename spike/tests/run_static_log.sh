#!/usr/bin/env bash
# The log as static files: published with tools/pwx-log.mjs, served by a plain static web server
# (python -m http.server: no PWX code, no special headers), co-signed by two witnesses that read it
# over HTTP, then checked by Go's x/mod and transparency-dev code, and by the PWX reader in Node.
# Uses throwaway keys; never the real ones.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); export PWX_KEYS="$T/keys" PWX_TEST_AUTHOR="$T/author.json"
LOG="$T/www/log"; ORIGIN="log.pwx.example/test"; W1=w1.pwx.example; W2=w2.pwx.example
fail() { echo "FAIL $*"; exit 1; }
ok() { echo "OK   $*"; }
mkdir -p "$T/www"
(cd "$T/www" && exec python3 -m http.server 8170 --bind 127.0.0.1) >/dev/null 2>&1 & HTTP=$!
trap 'kill $HTTP 2>/dev/null; rm -rf "$T"' EXIT
sleep 1
URL=http://127.0.0.1:8170/log/

node tools/pwx-log.mjs init "$LOG" "$ORIGIN" >/dev/null || fail init
node tools/pwx-log.mjs trust "$LOG" "$ORIGIN" $W1 $W2 > "$T/trust.json"
export PWX_LOG_VKEY=$(node -e 'const t=require(process.argv[1]); console.log(JSON.stringify(t.log))' "$T/trust.json")
cosign() {   # both witnesses read the log over HTTP and co-sign; the lines go into the checkpoint
  node tools/pwx-log.mjs witness "$URL" "$ORIGIN" $W1 "$T/w1.json" > "$T/w1.line" || return 1
  node tools/pwx-log.mjs witness "$URL" "$ORIGIN" $W2 "$T/w2.json" > "$T/w2.line" || return 1
  node tools/pwx-log.mjs cosign "$LOG" "$T/w1.line" "$T/w2.line" >/dev/null
}
gocheck() {
  /tmp/pwx-interop "$LOG" "$(node -e 'console.log(require(process.argv[1]).vkeys.log)' "$T/trust.json")" 2 \
    $(node -e 'console.log(require(process.argv[1]).vkeys.witnesses.join(" "))' "$T/trust.json")
}
cosign && ok "witnesses co-sign the empty log" || fail "first co-sign"

node tests/make_log_entries.mjs "$T/e1.json" 300 >/dev/null
node tools/pwx-log.mjs append "$LOG" "$ORIGIN" "$T/e1.json" >/dev/null || fail append
cosign && ok "witnesses co-sign after 301 entries (consistency proof built from tiles fetched over HTTP)" || fail cosign
out=$(gocheck) && ok "Go (x/mod note + tlog, transparency-dev cosignature): ${out##*$'\n'}" || fail "go check: $out"

node tests/make_log_entries.mjs "$T/e2.json" 260 300 >/dev/null
node tools/pwx-log.mjs append "$LOG" "$ORIGIN" "$T/e2.json" >/dev/null || fail append2
cosign && ok "log grows past a full tile; witnesses still co-sign" || fail cosign2
out=$(gocheck) && ok "Go check at size 561: ${out##*$'\n'}" || fail "go check 2: $out"

node --input-type=module -e "
  import { readFile } from 'node:fs/promises';
  import { fromUrl } from './log/static.mjs';
  import { TileReader } from './log/tiles.mjs';
  import * as N from './log/note.mjs';
  const trust = JSON.parse(await readFile('$T/trust.json', 'utf8'));
  const get = fromUrl('$URL');
  const cp = await N.verifyCheckpointNote(new TextDecoder().decode(await get('checkpoint')), trust);
  const r = new TileReader(get, cp.size);
  const e = await r.provenEntry(400, cp.root);
  const leaf = JSON.parse(new TextDecoder().decode(e.data));
  if (leaf.entry.version !== '1.0.399') throw new Error('wrong entry ' + leaf.entry.version);
  console.log('OK   PWX reader over HTTP: entry 400 proven against the witnessed checkpoint (' + cp.cosigned.length + ' witnesses)');
" || fail "node reader"

# A log that rewrites history: the witnesses refuse, and keep evidence.
cp "$LOG/checkpoint" "$T/good-checkpoint"
rm -rf "$LOG"; node tools/pwx-log.mjs init "$LOG" "$ORIGIN" >/dev/null
node tests/make_log_entries.mjs "$T/e3.json" 600 1000 >/dev/null
node tools/pwx-log.mjs append "$LOG" "$ORIGIN" "$T/e3.json" >/dev/null
if node tools/pwx-log.mjs witness "$URL" "$ORIGIN" $W1 "$T/w1.json" > /dev/null 2>"$T/err"; then fail "witness signed a rewritten log"; fi
grep -q "doesn't extend" "$T/err" && [ "$(node -e 'console.log(require(process.argv[1]).evidence.length)' "$T/w1.json")" = 1 ] \
  && ok "rewritten history: witness refuses and keeps the conflicting checkpoint as evidence" || fail "rewrite: $(cat "$T/err")"
out=$(gocheck 2>&1) && fail "Go accepted an un-co-signed checkpoint" || ok "Go also refuses the rewritten log's checkpoint (no witness co-signatures)"
echo "static log: PASS"
