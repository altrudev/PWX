#!/usr/bin/env python3
"""M4 log spike in the browser: the loader runs in a browser, so the log, witness and receipt
code must work in every engine. Runs a small scenario inside the page.
Usage: .venv/bin/python tests/log_browser_test.py --browser chromium|firefox|webkit"""
import argparse, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCENARIO = """async () => {
  const L = await import('/log/log.mjs'); const A = await import('/log/authors.mjs');
  const T = await import('/log/tiles.mjs'); const { b64 } = await import('/lib/pwx-verify.mjs');
  let now = Date.UTC(2026, 10, 17); const clock = () => now, out = {};
  const logKey = await L.newKey(), log = new L.Log('log.pwx.example/b', logKey, clock);
  const ws = [new L.Witness('w1.example', await L.newKey(), log.vkey, log.origin, clock), new L.Witness('w2.example', await L.newKey(), log.vkey, log.origin, clock)];
  const trust = { origin: log.origin, log: log.vkey, witnesses: ws.map((w) => w.vkey), quorum: 2 };
  const d1 = await L.newKey(), rec = await L.newKey(), hw = await L.newKey('p256');
  await log.append(await L.signEntry(d1, { type: 'key-event', op: 'create', author: 'val', keys: [L.pub(d1), L.pub(hw)], recovery: await L.keyId(L.pub(rec)) }));
  for (let n = 0; n < 300; n++) await log.append(await L.signEntry(d1, { type: 'release', author: 'val', app: 'x', version: '0.0.' + n, manifest: 'f' + n }));
  now += 1000; const i = await log.append(await L.signEntry(hw, { type: 'release', author: 'val', app: 'a', version: '1.0.0', manifest: 'm' }));
  const note = await log.checkpoint(); const lines = [];
  for (const w of ws) lines.push(await w.cosign(note, []));
  const cp = L.addCosigs(note, lines);
  const r = JSON.parse(JSON.stringify(await L.receipt(log, i, cp)));
  out.receipt = (await L.verifyReceipt(r, trust)).entry.manifest === 'm';
  r.leaf.entry.version = '2.0.0';
  out.forged = await L.verifyReceipt(r, trust).then(() => false, () => true);
  // The same log as static files, read back through tiles the way a loader would fetch them.
  const files = await log.files(cp);
  const reader = new T.TileReader(async (p) => { const f = files.get(p); if (!f) throw new Error('404 ' + p); return f; }, log.leaves.length);
  out.tiles = new TextDecoder().decode((await reader.provenEntry(i, (await L.verifyCheckpoint(cp, trust)).root)).data).includes('"manifest":"m"');
  out.release = (await A.checkRelease(log.leaves, 'val', 'm', now)).ok;
  now += 1000; await log.append(await L.signEntry(rec, { type: 'revoke', author: 'val', manifest: 'm' }));
  out.revoked = (await A.checkRelease(log.leaves, 'val', 'm', now)).reason === 'revoked';
  return out;
}"""

ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
server = subprocess.Popen(["node", "signer/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL); time.sleep(1)
try:
    with sync_playwright() as p:
        b = getattr(p, a.browser).launch(); page = b.new_page()
        page.goto("http://127.0.0.1:8150/signer/")
        out = page.evaluate(SCENARIO); version = b.version; b.close()
finally:
    server.terminate()
names = {"receipt": "receipt verifies offline (C2SP checkpoint, 2 witness co-signatures, P-256 hardware key)",
         "tiles": "entry proven from the log's static tiles",
         "forged": "a changed receipt is rejected", "release": "release accepted from the log",
         "revoked": "recovery key revokes the release"}
for k, v in out.items(): print(f"{'OK  ' if v else 'FAIL'} {names[k]}")
ok = all(out.values())
print(f"{a.browser} {version}: {'PASS' if ok else 'FAIL'} ({sum(out.values())}/{len(out)})")
sys.exit(0 if ok else 1)
