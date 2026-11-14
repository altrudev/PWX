#!/usr/bin/env python3
"""pwx-local (Verified-tier local loader) in a real browser.
Starts pwx-local with a temporary home, adds two packages, then checks: apps install and run,
each app gets its own origin, one app can't see another's storage, the loader registers no
service worker, and every request the browser makes stays on 127.0.0.1.
Usage: .venv/bin/python tests/local_test.py --browser chromium|firefox|webkit"""
import argparse, os, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOADER = "http://127.0.0.1:7100"
settled = "() => window.__pwx && ['running','library','rejected'].includes(window.__pwx.phase)"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + note) if note else ''}")
    home = tempfile.mkdtemp(prefix="pwx-home-")
    env = {**os.environ, "PWX_HOME": home}
    for pkg in ("notes", "evil-strict"):
        subprocess.run(["node", "local/pwx-local.mjs", "add", f"packages/{pkg}.pwx.json"], cwd=ROOT, env=env, check=True, capture_output=True)
    daemon = subprocess.Popen(["node", "local/pwx-local.mjs", "serve"], cwd=ROOT, env=env, stdout=subprocess.PIPE, text=True)
    print(daemon.stdout.readline().strip())
    version = ""
    try:
        with sync_playwright() as p:
            b = getattr(p, a.browser).launch(); version = b.version
            ctx = b.new_context(); hosts = set()
            ctx.on("request", lambda r: hosts.add(urlparse(r.url).hostname))
            page = ctx.new_page(); app = page.frame_locator("iframe.app")
            page.goto(f"{LOADER}/?pkg=notes"); page.wait_for_function(settled, timeout=20000)
            app.get_by_role("button", name="New note").click()
            app.get_by_label("Title", exact=True).fill("Local note")
            expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
            notes_origin = page.evaluate("() => window.__pwx.appOrigin")
            check("Notes installs and runs from pwx-local", page.evaluate("() => window.__pwx.local") is True, notes_origin)
            page.goto(f"{LOADER}/?pkg=evil-strict")
            # A new app reloads the loader once (to allow its new origin), so wait for the final page.
            page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'running' && window.__pwx.appOrigin", timeout=20000)
            expect(app.get_by_role("heading", name="Strict runtime")).to_be_visible(timeout=10000)
            other_origin = page.evaluate("() => window.__pwx.appOrigin")
            frame = None
            for _ in range(50):  # the app frame may still be navigating when the loader reports "running"
                frame = next((f for f in page.frames if f.url.startswith(other_origin + "/__pwx/strict.html")), None)
                if frame: break
                time.sleep(0.2)
            frame.wait_for_load_state()
            dbs = frame.evaluate("async () => indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : ['unsupported']")
            check("each app gets its own origin", notes_origin != other_origin, f"{notes_origin} vs {other_origin}")
            check("another app can't see Notes' storage", "pwx-notes" not in dbs, f"databases visible: {dbs}")
            page.goto(f"{LOADER}/?open=org.example.notes"); page.wait_for_function(settled, timeout=20000)
            expect(app.get_by_role("button", name="Local note")).to_be_visible(timeout=10000)
            check("Notes reopens with its data", True)
            regs = page.evaluate("async () => (await navigator.serviceWorker.getRegistrations()).length")
            check("loader registers no service worker", regs == 0, f"{regs} registered")
            check("every request stayed on 127.0.0.1", hosts == {"127.0.0.1"}, f"hosts: {sorted(h or '?' for h in hosts)}")
            b.close()
    except Exception as e:
        check(f"no errors ({type(e).__name__})", False, (str(e).splitlines() or [""])[0][:200])
    finally:
        daemon.terminate()
    ok = bool(checks) and all(checks)
    print(f"{a.browser} {version}: {'PASS' if ok else 'FAIL'} ({sum(checks)}/{len(checks)})")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
