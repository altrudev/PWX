#!/usr/bin/env python3
"""PWX Signer spike (M4 section 0, option 3): passphrase-locked browser keys, hardware-kind
keys (ECDSA P-256, as security chips use), two-device approval. No passkeys, no platform sync.
Two separate browser profiles stand in for two devices ("laptop" and "phone"). Real security
chips aren't reachable on the test machine, so a non-extractable P-256 WebCrypto key stands in
for a hardware device's key to test the format and the checks.
Usage: .venv/bin/python tests/signer_test.py --browser chromium|firefox|webkit"""
import argparse, json, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8150/signer/"
AUTHOR = "author:val"
PASS = {"laptop": "laptop pass 123", "phone": "phone pass 456"}

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

            # --- 1. passphrase-locked device keys ---
            short = ev(laptop, "async () => { try { await signer.setup('1234', 'Laptop'); return 'set'; } catch (e) { return e.message; } }")
            check("a short passphrase is refused", short != "set", short)
            k_laptop = ev(laptop, "(p) => signer.setup(p, 'Laptop')", PASS["laptop"])
            k_phone = ev(phone, "(p) => signer.setup(p, 'Phone')", PASS["phone"])
            check("each device has its own key", k_laptop and k_phone and k_laptop != k_phone)
            stored = ev(laptop, """async () => { const r = await signer.record();
              return { keys: Object.keys(r).sort(), anyCryptoKey: Object.values(r).some((v) => v instanceof CryptoKey) }; }""")
            check("only an encrypted key is stored", not stored["anyCryptoKey"] and "locked" in stored["keys"] and "privateKey" not in stored["keys"], ",".join(stored["keys"]))
            laptop_ctx.close(); laptop_ctx, laptop = open_device("laptop")
            check("key survives a browser restart", ev(laptop, "() => signer.publicKey()") == k_laptop)

            # --- pairing: the phone shows a code, the laptop adds it ---
            code = json.loads(ev(phone, "() => signer.pairingCode()"))
            check("pairing code carries the phone key and its kind", code["key"] == k_phone and code["kind"] == "pin" and code["alg"] == "ed25519")
            dev = lambda name, key, alg="ed25519", kind="pin": {"name": name, "key": key, "alg": alg, "kind": kind}
            key_set = {"author": AUTHOR, "threshold": 2, "devices": [dev("Laptop", k_laptop), dev(code["name"], code["key"], code["alg"], code["kind"])]}

            notes = ev(laptop, "() => fetch('/packages/notes.pwx.json').then((r) => r.text())")
            declared = ev(laptop, "() => fetch('/packages/declared.pwx.json').then((r) => r.text())")

            def phone_asks(pkg, prev=None):
                ev(phone, "([pkg, prev, author]) => { window.answer = signer.ask(pkg, prev, author); }", [pkg, prev, AUTHOR])
                expect(phone.locator("#card")).to_be_visible(timeout=10000)
                return ev(phone, "() => signer.shown")

            def verify(pkg, approvals, ks=None):
                return ev(laptop, """async ([pkg, approvals, ks]) => {
                  const m = await import('./approval.mjs');
                  try { return m.describe(await m.verifyApprovals(m.manifestOf(pkg), approvals, ks)); } catch (e) { return 'REJECTED ' + e.message; }
                }""", [pkg, approvals, ks or key_set])
            accepted = lambda r: not r.startswith("REJECTED")

            # --- 2. two-device approval, with the passphrase ---
            wrong = ev(laptop, "async ([pkg, a]) => { try { await signer.approve(pkg, a, 'not my passphrase'); return 'signed'; } catch (e) { return e.message; } }", [notes, AUTHOR])
            check("wrong passphrase can't sign", wrong == "wrong passphrase", wrong)
            a_laptop = ev(laptop, "([pkg, a, p]) => signer.approve(pkg, a, p)", [notes, AUTHOR, PASS["laptop"]])
            shown = phone_asks(notes)
            check("phone shows what is being published", shown["title"].startswith("Publish Notes 1.0.0") and "stores data on this device" in shown["all"], shown["title"])
            phone.fill("#pass", "wrong passphrase"); phone.click("#approve")
            expect(phone.locator("#err")).to_be_visible(timeout=20000)
            check("phone: wrong passphrase keeps asking", phone.locator("#card").is_visible() and "wrong passphrase" in phone.locator("#err").inner_text())
            phone.fill("#pass", PASS["phone"]); phone.click("#approve")
            a_phone = ev(phone, "() => window.answer")
            res = verify(notes, [a_laptop, a_phone])
            check("laptop + phone approvals accepted", res == "Approved on 2 devices", res)

            # --- 3. what a thief with one device, or a forged key, can't do ---
            check("one device alone is rejected", not accepted(verify(notes, [a_laptop])))
            check("the same device twice is rejected", not accepted(verify(notes, [a_laptop, a_laptop])))
            forged = ev(laptop, """async ([pkg, author]) => {
              const m = await import('./approval.mjs'); const v = await import('../lib/pwx-verify.mjs');
              const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
              return { key: v.b64.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), alg: 'ed25519',
                       sig: v.b64.enc(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, await m.statementBytes(m.manifestOf(pkg), author)))) };
            }""", [notes, AUTHOR])
            check("a key that isn't one of the author's devices is rejected", not accepted(verify(notes, [a_laptop, forged])))
            check("approvals for one release don't work for another", not accepted(verify(declared, [a_laptop, a_phone])))
            check("approvals for one author don't work for another", not accepted(verify(notes, [a_laptop, a_phone], dict(key_set, author="author:someone-else"))))
            check("an approval claiming another algorithm is rejected", not accepted(verify(notes, [a_laptop, dict(a_phone, alg="p256")])))

            # --- 4. hardware-kind device (P-256 stand-in for a security chip) ---
            hw = ev(laptop, """async ([pkg, author]) => {
              const m = await import('./approval.mjs'); const v = await import('../lib/pwx-verify.mjs');
              const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
              const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, await m.statementBytes(m.manifestOf(pkg), author));
              return { key: v.b64.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), alg: 'p256', sig: v.b64.enc(new Uint8Array(sig)) };
            }""", [notes, AUTHOR])
            ks_hw = dict(key_set, devices=key_set["devices"] + [dev("Desktop (pwx-local)", hw["key"], "p256", "hardware")])
            res = verify(notes, [a_laptop, hw], ks_hw)
            check("laptop + hardware device accepted and labelled", res == "Approved on 2 devices (1 hardware-protected)", res)
            res = verify(notes, [a_laptop, a_phone], ks_hw)
            check("a browser key can't claim to be hardware", res == "Approved on 2 devices", res)

            # --- 5. a lying laptop: it says "Notes", sends something else ---
            shown = phone_asks(declared, notes)
            honest = shown["title"].startswith("Update Declared-host test") and any("talks to" in x for x in shown["added"]) and shown["unusual"]
            check("phone shows the real package and highlights new access", honest, "; ".join(shown["added"]))
            phone.click("#deny")
            check("Deny gives no approval", ev(phone, "() => window.answer") is None)

            # --- 6. a tampered package is refused before the card appears ---
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
