#!/usr/bin/env python3
"""Add to Home Screen guide: shown on iPhone Safari (once), never elsewhere.
Starts and stops its own server. Usage: .venv/bin/python tests/a2hs_test.py --browser chromium|firefox|webkit
(The user agent is faked, so any engine can stand in for iPhone Safari.)"""
import argparse, subprocess, sys, time, os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
LOADER = "http://127.0.0.1:8100"
IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1"
IPAD = IPHONE.replace("iPhone", "iPad")
DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
ready = "() => window.__pwx && ['library','running','rejected'].includes(window.__pwx.phase)"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}")
    server = subprocess.Popen(["node", "server/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL, env={**os.environ, "PWX_TEST": "1"})
    time.sleep(1)
    try:
        with sync_playwright() as p:
            browser = getattr(p, a.browser).launch()
            def visible(ua, standalone=False, reloads=0, click=False):
                ctx = browser.new_context(user_agent=ua)
                if standalone: ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { value: true })")
                page = ctx.new_page(); page.goto(LOADER + "/"); page.wait_for_function(ready, timeout=15000)
                first = page.locator("#a2hs").is_visible()
                if click: page.click("#a2hs-close"); first = (first, page.locator("#a2hs").is_visible())
                for _ in range(reloads):
                    page.reload(); page.wait_for_function(ready, timeout=15000)
                again = page.locator("#a2hs").is_visible()
                ctx.close(); return first, again
            first, again = visible(IPHONE, reloads=1)
            check("iPhone Safari: guide appears", first)
            check("iPhone Safari: it does not come back on the next visit", not again)
            (shown, after_click), again = visible(IPHONE, reloads=1, click=True)
            check("iPhone Safari: Got it closes the guide", shown and not after_click)
            check("iPhone Safari: still gone after dismissing", not again)
            check("iPhone Chrome: no guide", not visible(IPHONE_CHROME)[0])
            check("iPad: no guide", not visible(IPAD)[0])
            check("desktop Safari: no guide", not visible(DESKTOP)[0])
            check("iPhone Safari from the Home Screen: no guide", not visible(IPHONE, standalone=True)[0])
            browser.close()
    finally:
        server.terminate()
    print(f"{a.browser}: {'PASS' if all(checks) else 'FAIL'} ({sum(checks)}/{len(checks)})"); sys.exit(0 if all(checks) else 1)

main()
