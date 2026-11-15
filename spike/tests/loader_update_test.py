#!/usr/bin/env python3
"""Hosted loader integrity and updates (audit M6).
The hosted loader's service worker serves the loader only from a signed release, checks every
file each time it serves it, and changes versions only when the user asks. The test server
plays the host: it can tamper with files, offer older, forged, broken or same-version releases,
or change sw.js. Starts and stops its own server.
Usage: .venv/bin/python tests/loader_update_test.py --browser chromium|firefox|webkit"""
import argparse, os, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOADER = "http://127.0.0.1:8100"
VERSION = (ROOT / "VERSION").read_text().strip()
NEXT = ".".join(VERSION.split(".")[:2] + [str(int(VERSION.split(".")[2]) + 1)])

def host(**kw):
    q = "&".join(f"{k}={v}" for k, v in kw.items())
    urllib.request.urlopen(f"{LOADER}/__test/loader?{q}").read()

POISON = """async () => {
  const { cache } = await (await (await caches.open('pwx-loader-meta')).match('current')).json();
  await (await caches.open(cache)).put('/loader.mjs', new Response('document.title = "poisoned";'));
  return cache;
}"""
CACHED = """async () => {
  const { cache } = await (await (await caches.open('pwx-loader-meta')).match('current')).json();
  return (await (await caches.open(cache)).match('/loader.mjs')).text();
}"""

def ready(page):
    page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'library' && 'loaderVersion' in window.__pwx", timeout=30000)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + note) if note else ''}", flush=True)
    server = subprocess.Popen(["node", "server/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL, env={**os.environ, "PWX_TEST": "1"})
    time.sleep(1)
    try:
        with sync_playwright() as p:
            b = getattr(p, a.browser).launch(); version = b.version
            ctx = b.new_context(); page = ctx.new_page()
            msg = page.locator("#update-msg")
            def ask(release):
                host(release=release); page.get_by_role("button", name="Check for loader update").click()

            page.goto(LOADER + "/"); ready(page)
            page.reload(); ready(page)
            check("loader runs from signed release", page.evaluate("() => window.__pwx.loaderVersion") == VERSION, VERSION)

            # 1. A changed cached file is replaced from the host, never run.
            page.evaluate(POISON); page.reload(); ready(page)
            check("poisoned cache entry not run", page.title() != "poisoned")
            check("poisoned cache entry repaired", "poisoned" not in page.evaluate(CACHED))
            # 2. Changed cache and a tampering host: the loader refuses to start.
            host(tamper=1); page.evaluate(POISON)
            page.goto(LOADER + "/"); time.sleep(2)
            r = page.evaluate("() => fetch('/loader.mjs').then(async (r) => ({ status: r.status, flag: r.headers.get('x-pwx-integrity'), text: await r.text() }))")
            ran = page.evaluate("() => Boolean(window.__pwx) || document.title === 'poisoned' || document.title === 'tampered'")
            check("tampered file refused (503), nothing ran", r["status"] == 503 and r["flag"] == "failed" and not ran, f"status {r['status']}, ran={ran}")
            host(tamper=0); page.goto(LOADER + "/"); ready(page)
            check("recovers once the host serves the signed file", page.title() != "poisoned")

            # 3. Updates only from a newer, correctly signed, complete release.
            ask("normal"); expect(msg).to_contain_text("Up to date", timeout=20000); check("same release: up to date", True)
            ask("older"); expect(msg).to_contain_text("older version", timeout=20000); check("older release refused", True)
            ask("same-different"); expect(msg).to_contain_text("same version", timeout=20000); check("same-version swap refused", True)
            ask("forged"); expect(msg).to_contain_text("signature is invalid", timeout=20000); check("forged release refused", True)
            ask("badfile"); expect(msg).to_contain_text("is available", timeout=20000)
            page.get_by_role("button", name="Update loader").click()
            expect(msg).to_contain_text("doesn't match the signed release", timeout=30000)
            page.reload(); ready(page)
            check("broken release not applied", page.evaluate("() => window.__pwx.loaderVersion") == VERSION)
            ask("next"); expect(msg).to_contain_text(f"{NEXT} is available", timeout=20000)
            page.get_by_role("button", name="Update loader").click()
            page.wait_for_function(f"() => window.__pwx && window.__pwx.loaderVersion === '{NEXT}'", timeout=30000)
            check("signed newer release applied on click", True, NEXT)
            host(release="normal"); ctx.close()

            # 4. The host changes sw.js: warn unless a signed release matches it.
            for release, expected in [("normal", "unsigned"), ("next", "signed")]:
                host(release="normal", sw="normal", swcache=0)
                c = b.new_context(); pg = c.new_page(); pg.goto(LOADER + "/"); ready(pg)
                host(release=release, sw="changed")
                pg.evaluate("() => navigator.serviceWorker.getRegistration().then((r) => r.update())")
                pg.wait_for_function("() => window.__pwx.swChange", timeout=30000)
                got = pg.evaluate("() => window.__pwx.swChange")
                note = pg.locator("#update-msg").inner_text()
                check(f"sw.js change, release={release}: {expected}", got == expected, f"{got}: {note[:70]}")
                locked = pg.evaluate("() => Boolean(window.__pwx.locked)")
                if expected == "unsigned":
                    shut = pg.locator("#lock").is_visible() and not pg.locator("#library").is_visible()
                    check("unsigned sw.js: loader locks down", locked and shut)
                else:
                    check("signed sw.js: no lockdown", not locked)
                c.close()
            host(release="normal", sw="normal", swcache=1)
            b.close()
    finally:
        server.terminate()
    print(f"{a.browser} {version}: {'PASS' if all(checks) else 'FAIL'} ({sum(checks)}/{len(checks)})")
    sys.exit(0 if all(checks) else 1)

if __name__ == "__main__":
    main()
