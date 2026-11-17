#!/usr/bin/env python3
"""PWX Guard extension spike (Chromium only).
Question: can a browser extension keep a swapped loader service worker from being installed,
and keep the old verified one running? The test server plays the host. Starts its own server.
Usage: .venv/bin/python tests/guard_ext_test.py"""
import os, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EXT = str(ROOT / "extension")
LOADER = "http://127.0.0.1:8100"
VERSION = (ROOT / "VERSION").read_text().strip()
NEXT = ".".join(VERSION.split(".")[:2] + [str(int(VERSION.split(".")[2]) + 1)])

def host(**kw):
    urllib.request.urlopen(f"{LOADER}/__test/loader?" + "&".join(f"{k}={v}" for k, v in kw.items())).read()

UPDATE = "() => navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => 'updated', (e) => 'failed: ' + e.message)"
PENDING = "() => navigator.serviceWorker.getRegistration().then((r) => Boolean(r.installing || r.waiting))"

def library(page):
    page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'library'", timeout=30000)

def main():
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + str(note)[:110]) if note else ''}", flush=True)
    server = subprocess.Popen(["node", "server/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL, env={**os.environ, "PWX_TEST": "1"})
    time.sleep(1)
    try:
        with sync_playwright() as p:
            host(release="normal", sw="normal", swcache=0)
            # --- control: no extension. The host's unsigned sw.js is installed; the page can only lock. ---
            b = p.chromium.launch(); c = b.new_context(); pg = c.new_page()
            pg.goto(LOADER + "/"); library(pg); pg.reload(); library(pg)
            host(sw="changed")
            pg.evaluate(UPDATE)
            pg.wait_for_function("() => window.__pwx.swChange", timeout=30000)
            check("control (no extension): unsigned sw.js gets installed", pg.evaluate("() => window.__pwx.locked === true"))
            version = b.version; b.close()

            # --- with the extension ---
            host(release="normal", sw="normal", swcache=0)
            ctx = p.chromium.launch_persistent_context(tempfile.mkdtemp(prefix="pwx-guard-"), channel="chromium", headless=True,
                args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
            ext = next((w for w in ctx.service_workers if w.url.startswith("chrome-extension://")), None) or ctx.wait_for_event("serviceworker")
            ext.evaluate("() => new Promise((ok) => setTimeout(ok, 500))")
            guard = lambda: ext.evaluate(f"() => self.pwxGuardCheck('{LOADER}')")

            r = guard()
            check("extension verifies the signed sw.js", r.get("ok") and r.get("version") == VERSION, r)
            page = ctx.new_page(); page.goto(LOADER + "/"); library(page); page.reload(); library(page)
            page.wait_for_function("() => 'loaderVersion' in window.__pwx", timeout=30000)
            check("signed worker installs with the extension on", page.evaluate("() => window.__pwx.loaderVersion") == VERSION)

            host(sw="changed")
            r = guard()
            check("extension rejects the unsigned sw.js", r.get("ok") is False and "doesn't match" in r.get("error", ""), r)
            res = page.evaluate(UPDATE)
            time.sleep(2)
            check("browser's update fetch is blocked", res.startswith("failed"), res)
            check("no new worker installed; loader not locked",
                  not page.evaluate(PENDING) and not page.evaluate("() => window.__pwx.locked || window.__pwx.swChange || false"))
            page.goto(LOADER + "/"); library(page)
            page.wait_for_function("() => 'loaderVersion' in window.__pwx", timeout=30000)
            check("old verified worker still serves the loader", page.evaluate("() => window.__pwx.loaderVersion") == VERSION
                  and not page.evaluate("() => window.__pwx.locked || false"))

            host(release="next", sw="changed")
            r = guard()
            check("extension verifies a newer signed sw.js", r.get("ok") and r.get("version") == NEXT, r)
            res = page.evaluate(UPDATE)
            page.wait_for_function("() => window.__pwx.swChange", timeout=30000)
            check("signed new worker is let through", res == "updated" and page.evaluate("() => window.__pwx.swChange") == "signed", res)

            host(release="normal", sw="normal")
            r = guard()
            check("extension refuses to go back to an older release", r.get("ok") is False and "older" in r.get("error", ""), r)
            ctx.close()
            host(release="normal", sw="normal", swcache=1)
    finally:
        server.terminate()
    print(f"chromium {version} + PWX Guard: {'PASS' if all(checks) else 'FAIL'} ({sum(checks)}/{len(checks)})")
    sys.exit(0 if all(checks) else 1)

if __name__ == "__main__":
    main()
