#!/usr/bin/env python3
"""Strict runtime leak test: app code runs only in a worker and asks a loader-owned
renderer for UI. Control: same app with the renderer allowlist and shell CSP turned off.
Usage: .venv/bin/python tests/strict_test.py --browser chromium|firefox|webkit
Requires the servers (npm run serve) and packages (npm run build)."""
import argparse, json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

LOADER = "http://127.0.0.1:8100"
MODES = ["passive", "strict-link-preconnect"]
CONNECTION_ONLY = {"strict-link-preconnect"}

def get(path):
    with urllib.request.urlopen(LOADER + path) as r:
        return json.loads(r.read() or b"null")

def run(browser, url, wait_s=6):
    ctx = browser.new_context(); page = ctx.new_page()
    urllib.request.urlopen(LOADER + "/__test/reset").read()
    page.goto(url); time.sleep(wait_s)
    data = get("/__test/hits")
    try: state = page.evaluate("() => window.__pwx")
    except Exception: state = None
    ctx.close(); time.sleep(1.0)
    hits = sorted({h["path"].split("/leak/")[1].split("?")[0] for h in data["hits"] if "/leak/" in h["path"]})
    return hits, data["tcp"], state or {}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium")
    a = ap.parse_args()
    rows, rejected, has_rtc = [], set(), set()
    with sync_playwright() as p:
        b = getattr(p, a.browser).launch()
        version = b.version
        for mode in MODES:
            cv, ctcp, _ = run(b, f"{LOADER}/?pkg=evil-strict&dev=1&unsafe=1&mode={mode}")
            xv, xtcp, st = run(b, f"{LOADER}/?pkg=evil-strict&mode={mode}")
            rep = next((m for m in st.get("messages", []) if m.get("type") == "evil-done"), {})
            rejected |= set(rep.get("rejected", [])); has_rtc.add(rep.get("hasRTC"))
            for v in rep.get("tried", []):
                c, x = (ctcp > 0, xtcp > 0) if v in CONNECTION_ONLY else (v in cv, v in xv)
                rows.append((v, c, x, "LEAK" if x else ("blocked" if c else "untested: control did not leak")))
        b.close()
    print(f"browser: {a.browser} {version}   run: strict runtime")
    print(f"WebRTC available in worker: {sorted(map(str, has_rtc))}")
    for v, c, x, r in sorted(rows, key=lambda r: (r[3] != "LEAK", r[3], r[0])):
        print(f"{v:24} {'leak' if c else '-':8} {'leak' if x else '-':8} {r}")
    print(f"renderer rejected: {sorted(rejected)}")
    leaks = [r[0] for r in rows if r[2]]
    print("PASS: no vector leaked" if rows and not leaks else f"FAIL: {leaks or 'no rows'}")
    return 0 if rows and not leaks else 1

if __name__ == "__main__":
    sys.exit(main())
