#!/usr/bin/env python3
"""M4 log spike in the browser: the loader runs in a browser, so the log, witness and receipt
code must work in every engine. Runs a small scenario inside the page.
Usage: .venv/bin/python tests/log_browser_test.py --browser chromium|firefox|webkit"""
import argparse, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SCENARIO = """async () => {
  const L = await import('/log/log.mjs'); const A = await import('/log/authors.mjs'); const { b64 } = await import('/lib/pwx-verify.mjs');
  let now = Date.UTC(2026, 10, 17); const clock = () => now, out = {};
  const logKey = await L.newKey(), log = new L.Log('o', logKey, clock);
  const wk = [await L.newKey(), await L.newKey('p256')];
  const ws = wk.map((k, i) => new L.Witness('w' + i, k, L.pub(logKey), 'o'));
  const trust = { origin: 'o', log: L.pub(logKey), witnesses: wk.map(L.pub), quorum: 2 };
  const d1 = await L.newKey(), rec = await L.newKey(), hw = await L.newKey('p256');
  await log.append(await L.signEntry(d1, { type: 'key-event', op: 'create', author: 'val', keys: [L.pub(d1), L.pub(hw)], recovery: await L.keyId(L.pub(rec)) }));
  now += 1000; const i = await log.append(await L.signEntry(hw, { type: 'release', author: 'val', app: 'a', version: '1.0.0', manifest: 'm' }));
  const cp = await log.checkpoint(); const cosigs = [];
  for (const w of ws) cosigs.push(await w.cosign(cp, []));
  const r = JSON.parse(JSON.stringify(await L.receipt(log, i, cp, cosigs)));
  out.receipt = (await L.verifyReceipt(r, trust)).entry.manifest === 'm';
  r.proof = r.proof.length ? [b64.enc(new Uint8Array(32)), ...r.proof.slice(1)] : r.proof;
  r.index = r.index + 0; r.leaf.entry.version = '2.0.0';
  out.forged = await L.verifyReceipt(r, trust).then(() => false, () => true);
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
names = {"receipt": "receipt verifies offline (Ed25519 + P-256 witnesses, P-256 hardware key)",
         "forged": "a changed receipt is rejected", "release": "release accepted from the log",
         "revoked": "recovery key revokes the release"}
for k, v in out.items(): print(f"{'OK  ' if v else 'FAIL'} {names[k]}")
ok = all(out.values())
print(f"{a.browser} {version}: {'PASS' if ok else 'FAIL'} ({sum(out.values())}/{len(out)})")
sys.exit(0 if ok else 1)
