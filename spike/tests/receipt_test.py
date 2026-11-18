#!/usr/bin/env python3
"""M4 soft mode in the loader: a package's log receipt is checked offline at install and launch,
and the result is shown. A missing or wrong receipt is shown, but doesn't block the install yet.
Starts and stops its own server. Usage: .venv/bin/python tests/receipt_test.py --browser chromium|firefox|webkit"""
import argparse, json, os, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOADER = "http://127.0.0.1:8100"
installed = "() => window.__pwx && window.__pwx.phase === 'running' && window.__pwx.logStatus"
library = "() => window.__pwx && ['library', 'running'].includes(window.__pwx.phase)"

def variant(name, change):
    pkg = json.loads((ROOT / "packages/evil-strict.pwx.json").read_text())
    change(pkg)
    path = Path(tempfile.mkdtemp()) / f"{name}.pwx.json"
    path.write_text(json.dumps(pkg))
    return str(path)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + str(note)[:120]) if note else ''}", flush=True)
    notes_receipt = json.loads((ROOT / "packages/notes.pwx.json").read_text())["receipt"]
    no_receipt = variant("no-receipt", lambda p: p.pop("receipt"))
    wrong = variant("wrong-receipt", lambda p: p.__setitem__("receipt", notes_receipt))   # Notes' receipt on another app
    server = subprocess.Popen(["node", "server/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL, env={**os.environ, "PWX_TEST": "1"})
    time.sleep(1)
    try:
        with sync_playwright() as p:
            b = getattr(p, a.browser).launch(); version = b.version
            ctx = b.new_context(); page = ctx.new_page()
            page.goto(f"{LOADER}/?pkg=notes"); page.wait_for_function(installed, timeout=20000)
            time.sleep(2)   # a running app moves the page to its own address (0.4.9); let that settle
            s = page.evaluate("() => window.__pwx.logStatus")
            check("Notes: receipt checked offline, logged with 2 witnesses", s.get("logged") is True and s.get("witnesses") == 2, s)
            check("the install screen says it's in the public log", "In the public log" in page.locator("#consent").inner_text())

            page.goto(LOADER + "/"); page.wait_for_function(library, timeout=20000)
            page.set_input_files("#file", no_receipt)
            page.wait_for_function("() => (window.__pwx.apps || []).includes('org.example.leaktest-strict')", timeout=20000)
            s = page.evaluate("() => window.__pwx.logStatus")
            check("no receipt: shown as not in the public log", s.get("logged") is False and s.get("reason") == "no receipt", s)
            check("no receipt: still installed (soft mode)", "org.example.leaktest-strict" in page.evaluate("() => window.__pwx.apps"))

            # Remove it and sideload the same app carrying Notes' receipt: the receipt doesn't match.
            page.evaluate("() => indexedDB.open('pwx-loader').onsuccess = (e) => e.target.result.transaction('packages','readwrite').objectStore('packages').delete('org.example.leaktest-strict')")
            page.goto(LOADER + "/"); page.wait_for_function(library, timeout=20000)
            page.set_input_files("#file", wrong)
            page.wait_for_function("() => (window.__pwx.apps || []).includes('org.example.leaktest-strict')", timeout=20000)
            s = page.evaluate("() => window.__pwx.logStatus")
            check("another app's receipt: shown as not in the public log", s.get("logged") is False and "another app" in s.get("reason", ""), s)

            # Launch re-checks the receipt from the stored package, offline.
            page.goto(f"{LOADER}/?open=org.example.notes")
            page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'running'", timeout=20000)
            s = page.evaluate("() => window.__pwx.logStatus")
            check("launch re-checks the stored receipt", s.get("logged") is True, s)
            b.close()
    finally:
        server.terminate()
    print(f"{a.browser} {version}: {'PASS' if all(checks) else 'FAIL'} ({sum(checks)}/{len(checks)})")
    sys.exit(0 if all(checks) else 1)

if __name__ == "__main__":
    main()
