#!/usr/bin/env python3
"""PWX Signer spike (M4 section 0): device keys that can't be copied, two-device approval.
No passkeys, no platform sync. Two separate browser profiles stand in for two devices
("laptop" and "phone"). Starts its own server (signer/serve.mjs).
Usage: .venv/bin/python tests/signer_test.py --browser chromium|firefox|webkit"""
import argparse, json, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8150/signer/"
AUTHOR = "author:val"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + note) if note else ''}")
    server = subprocess.Popen(["node", "signer/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL)
    time.sleep(1)
    dirs = {n: tempfile.mkdtemp(prefix=f"pwx-signer-{n}-") for n in ("laptop", "phone")}
    version = "?"
    try:
        with sync_playwright() as p:
            bt = getattr(p, a.browser)
            def open_device(name):
                ctx = bt.launch_persistent_context(dirs[name], headless=True)
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto(URL); page.wait_for_function("() => window.signerReady === true", timeout=15000)
                return ctx, page
            ev = lambda page, js, arg=None: page.evaluate(js, arg)

            laptop_ctx, laptop = open_device("laptop")
            phone_ctx, phone = open_device("phone")
            version = laptop_ctx.browser.version if laptop_ctx.browser else a.browser

            # --- 1. device keys can't be copied ---
            r = ev(laptop, """async () => {
              const kp = await signer.deviceKey();
              let exported = false;
              for (const f of ["pkcs8", "jwk"]) { try { await crypto.subtle.exportKey(f, kp.privateKey); exported = true; } catch {} }
              return { extractable: kp.privateKey.extractable, exported };
            }""")
            check("private key is non-extractable", r["extractable"] is False and r["exported"] is False, json.dumps(r))

            k_laptop, k_phone = ev(laptop, "() => signer.publicKey()"), ev(phone, "() => signer.publicKey()")
            check("each device has its own key", k_laptop and k_phone and k_laptop != k_phone)

            laptop_ctx.close()
            laptop_ctx, laptop = open_device("laptop")
            check("key survives a browser restart", ev(laptop, "() => signer.publicKey()") == k_laptop)

            # --- pairing: each device shows a code, the other adds its key ---
            code = json.loads(ev(phone, "() => signer.pairingCode('Phone')"))
            key_set = {"author": AUTHOR, "threshold": 2, "keys": [k_laptop, code["key"]]}
            check("pairing code carries the phone key", code["key"] == k_phone)

            notes = ev(laptop, "() => fetch('/packages/notes.pwx.json').then((r) => r.text())")
            declared = ev(laptop, "() => fetch('/packages/declared.pwx.json').then((r) => r.text())")

            def phone_asks(pkg, prev=None):
                ev(phone, "([pkg, prev, author]) => { window.answer = signer.ask(pkg, prev, author); }", [pkg, prev, AUTHOR])
                expect(phone.locator("#card")).to_be_visible(timeout=10000)
                return ev(phone, "() => signer.shown")

            def verify(pkg, approvals, ks=key_set):
                return ev(laptop, """async ([pkg, approvals, ks]) => {
                  const m = await import('./approval.mjs');
                  try { await m.verifyApprovals(m.manifestOf(pkg), approvals, ks); return 'ok'; } catch (e) { return e.message; }
                }""", [pkg, approvals, ks])

            # --- 2. two-device approval ---
            a_laptop = ev(laptop, "([pkg, author]) => signer.approve(pkg, author)", [notes, AUTHOR])
            shown = phone_asks(notes)
            check("phone shows what is being published", shown["title"].startswith("Publish Notes 1.0.0") and "stores data on this device" in shown["all"], shown["title"])
            phone.click("#approve"); a_phone = ev(phone, "() => window.answer")
            check("laptop + phone approvals accepted", verify(notes, [a_laptop, a_phone]) == "ok")

            # --- 3. what a thief with one device can't do ---
            res = verify(notes, [a_laptop])
            check("one device alone is rejected", res != "ok", res)
            check("the same device twice is rejected", verify(notes, [a_laptop, a_laptop]) != "ok")
            forged = ev(laptop, """async ([pkg, author]) => {
              const m = await import('./approval.mjs'); const v = await import('../lib/pwx-verify.mjs');
              const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
              const stmt = new TextEncoder().encode(v.canonicalize(await m.approvalStatement(m.manifestOf(pkg), author)));
              return { key: v.b64.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))),
                       sig: v.b64.enc(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, stmt))) };
            }""", [notes, AUTHOR])
            check("a key that isn't one of the author's devices is rejected", verify(notes, [a_laptop, forged]) != "ok")
            check("approvals for one release don't work for another", verify(declared, [a_laptop, a_phone]) != "ok")
            other = dict(key_set, author="author:someone-else")
            check("approvals for one author don't work for another", verify(notes, [a_laptop, a_phone], other) != "ok")

            # --- 4. a lying laptop: it says "Notes", sends something else ---
            shown = phone_asks(declared, notes)
            honest = shown["title"].startswith("Update Declared-host test") and any("talks to" in x for x in shown["added"]) and shown["unusual"]
            check("phone shows the real package and highlights new access", honest, "; ".join(shown["added"]))
            phone.click("#deny")
            check("Deny gives no approval", ev(phone, "() => window.answer") is None)

            # --- 5. a tampered package is refused before the card appears ---
            bad = json.loads(notes); bad["manifest"] = bad["manifest"].replace('"Notes"', '"Notes!"')
            err = ev(phone, "async (pkg) => { try { await signer.review(pkg); return 'shown'; } catch (e) { return e.message; } }", json.dumps(bad))
            check("tampered package refused on the approving device", err != "shown", err)

            laptop_ctx.close(); phone_ctx.close()
    finally:
        server.terminate()
    ok = all(checks)
    print(f"{a.browser} {version}: {'PASS' if ok else 'FAIL'} ({sum(checks)}/{len(checks)})")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
