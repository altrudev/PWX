#!/usr/bin/env python3
"""Notes app on the strict runtime: create, edit, reload, persist, delete.
Also checks that the app made no network contact at all and that the renderer
rejected nothing (the app fits inside the allowlist).
Usage: .venv/bin/python tests/notes_test.py --browser chromium|firefox|webkit [--shot FILE]"""
import argparse, json, sys, time, urllib.request
from playwright.sync_api import sync_playwright, expect

LOADER = "http://127.0.0.1:8100"

def hits():
    with urllib.request.urlopen(LOADER + "/__test/hits") as r:
        return json.loads(r.read())

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); ap.add_argument("--shot")
    a = ap.parse_args()
    checks = []
    def check(name, ok): checks.append((name, bool(ok))); print(f"{'OK  ' if ok else 'FAIL'} {name}")
    with sync_playwright() as p:
        b = getattr(p, a.browser).launch(); ctx = b.new_context(viewport={"width": 900, "height": 600})
        page = ctx.new_page()
        urllib.request.urlopen(LOADER + "/__test/reset").read()
        page.goto(f"{LOADER}/?pkg=notes")
        app = page.frame_locator("iframe.app")
        expect(app.get_by_text("No notes yet")).to_be_visible(timeout=10000)
        check("empty state shown", True)
        app.get_by_role("button", name="New note").click()
        app.get_by_label("Title", exact=True).fill("Shopping")
        app.get_by_label("Note", exact=True).fill("milk\neggs")
        expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
        app.get_by_role("button", name="New note").click()
        app.get_by_label("Title", exact=True).fill("Ideas")
        expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
        check("two notes listed", app.locator(".item").count() == 2)
        if a.shot:
            app.get_by_label("Note", exact=True).fill("Signed, sandboxed, and stored only here.")
            time.sleep(0.6); page.screenshot(path=a.shot)
        page.reload()
        expect(app.locator(".item")).to_have_count(2, timeout=10000)
        check("notes survive reload", True)
        app.get_by_role("button", name="Shopping").click()
        # The value arrives asynchronously (worker -> renderer), so wait for it rather than read once.
        try:
            expect(app.get_by_label("Note", exact=True)).to_have_value("milk\neggs", timeout=5000)
            restored = True
        except AssertionError:
            restored = False
        check("body restored", restored)
        app.get_by_role("button", name="Delete").click()
        expect(app.locator(".item")).to_have_count(1, timeout=5000)
        check("delete works", app.get_by_role("button", name="Ideas").count() == 1)
        frame = next(f for f in page.frames if "/__pwx/strict.html" in f.url)
        check("renderer rejected nothing", frame.evaluate("() => (window.__pwxRejected || []).length") == 0)
        # Audit N1: Remove erases the app's data, so whatever gets this origin next starts empty.
        origin = page.evaluate("() => window.__pwx.appOrigin")
        page.goto(LOADER + "/")
        page.get_by_role("button", name="Remove Notes", exact=True).click()
        # The page is already on the library before the click, so wait for the list itself to change.
        try:
            expect(page.get_by_role("button", name="Remove Notes", exact=True)).to_have_count(0, timeout=15000)
            gone = True
        except AssertionError:
            gone = False
        check("remove takes the app out of the library", gone and "org.example.notes" in page.evaluate("() => window.__pwx.removed || []"))
        page.goto(f"{LOADER}/?pkg=notes")
        expect(app.get_by_text("No notes yet")).to_be_visible(timeout=10000)
        same = page.evaluate("() => window.__pwx.appOrigin") == origin
        check("reinstalled on the same origin, no old notes", same and app.locator(".item").count() == 0)
        h = hits()
        check("no network contact (canary saw nothing)", not h["hits"] and h["tcp"] == 0)
        version = b.version; b.close()
    ok = all(c for _, c in checks)
    print(f"{a.browser} {version}: {'PASS' if ok else 'FAIL'} ({sum(c for _, c in checks)}/{len(checks)})")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
