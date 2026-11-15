#!/usr/bin/env python3
"""Offline and privacy test for installed PWX apps.
Online: install Notes from the host, sideload a second app from a file, then measure what
the host sees when the user opens an installed app. Then the host is shut down and the
browser is put offline: the library, Notes and its data must still work, and a tampered
local copy must be rejected. Starts and stops its own servers.
Usage: .venv/bin/python tests/offline_test.py --browser chromium|firefox|webkit"""
import argparse, json, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOADER = "http://127.0.0.1:8100"
running = "() => window.__pwx && ['running','library','rejected'].includes(window.__pwx.phase)"

def get(path):
    with urllib.request.urlopen(LOADER + path) as r:
        return json.loads(r.read() or b"null")

TAMPER = """async () => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('pwx-loader', 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const rec = await new Promise((ok) => { const q = db.transaction('packages').objectStore('packages').get('org.example.notes'); q.onsuccess = () => ok(q.result); });
  const pkg = JSON.parse(rec.text); pkg.manifest = pkg.manifest.replace('"Notes"', '"Notes (tampered)"'); rec.text = JSON.stringify(pkg);
  await new Promise((ok) => { const t = db.transaction('packages', 'readwrite'); t.objectStore('packages').put(rec); t.oncomplete = ok; });
  db.close(); return true;
}"""

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + note) if note else ''}")
    server = subprocess.Popen(["node", "server/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL, env={**__import__("os").environ, "PWX_TEST": "1"})
    time.sleep(1)
    try:
        with sync_playwright() as p:
            b = getattr(p, a.browser).launch(); version = b.version
            ctx = b.new_context(); page = ctx.new_page(); app = page.frame_locator("iframe.app")
            # --- online: install, use, sideload ---
            page.goto(f"{LOADER}/?pkg=notes"); page.wait_for_function(running, timeout=15000)
            app.get_by_role("button", name="New note").click()
            app.get_by_label("Title", exact=True).fill("Written online")
            expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
            page.goto(f"{LOADER}/"); page.wait_for_function(running)
            page.set_input_files("#file", str(ROOT / "packages/evil-strict.pwx.json"))
            page.wait_for_function("() => (window.__pwx.apps || []).length === 2", timeout=5000)
            check("sideloaded a second app from a file", True)
            # --- privacy: what does the host see when an installed app is opened? ---
            urllib.request.urlopen(LOADER + "/__test/reset").read()
            page.goto(f"{LOADER}/?open=org.example.notes"); page.wait_for_function(running)
            expect(app.get_by_role("button", name="Written online")).to_be_visible(timeout=10000)
            time.sleep(1)
            seen = get("/__test/served")
            check("opening an installed app sent nothing to the host", not seen, f"host saw: {seen}" if seen else "")
            # --- offline: host gone, browser offline ---
            server.terminate(); server.wait(); ctx.set_offline(True)
            page.goto(f"{LOADER}/"); page.wait_for_function(running, timeout=15000)
            check("library opens offline", page.evaluate("() => window.__pwx.phase") == "library"
                  and len(page.evaluate("() => window.__pwx.apps")) == 2)
            page.get_by_role("link", name="Open Notes").click(); page.wait_for_function(running, timeout=15000)
            expect(app.get_by_role("button", name="Written online")).to_be_visible(timeout=10000)
            check("Notes opens offline with its data", True)
            app.get_by_role("button", name="New note").click()
            app.get_by_label("Title", exact=True).fill("Written offline")
            expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
            page.reload(); page.wait_for_function(running, timeout=15000)
            expect(app.locator(".item")).to_have_count(2, timeout=10000)
            check("offline edits persist across reload", True)
            # --- integrity offline: a tampered local copy must not run ---
            page.goto(f"{LOADER}/"); page.wait_for_function(running); page.evaluate(TAMPER)
            page.goto(f"{LOADER}/?open=org.example.notes"); page.wait_for_function(running, timeout=15000)
            st = page.evaluate("() => ({ phase: window.__pwx.phase, error: window.__pwx.error })")
            check("tampered local copy rejected offline", st == {"phase": "rejected", "error": "signature"}, str(st))
            b.close()
    except Exception as e:
        check(f"no errors ({type(e).__name__})", False, str(e).splitlines()[0][:200])
    finally:
        if server.poll() is None: server.terminate()
    ok = all(checks) and checks
    print(f"{a.browser} {version if 'version' in dir() else ''}: {'PASS' if ok else 'FAIL'} ({sum(checks)}/{len(checks)})")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
