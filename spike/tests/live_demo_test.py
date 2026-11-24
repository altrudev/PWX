#!/usr/bin/env python3
"""Checks a deployed PWX demo the way a visitor uses it: open the loader, try Notes, approve the
install, write a note, reload, and check where the app ran. Optional screenshot.
Usage: .venv/bin/python tests/live_demo_test.py --browser chromium --url https://pwx.altru.dev [--shot FILE]"""
import argparse, sys
from playwright.sync_api import sync_playwright, expect

ap = argparse.ArgumentParser()
ap.add_argument("--browser", default="chromium"); ap.add_argument("--url", default="https://pwx.altru.dev"); ap.add_argument("--shot")
a = ap.parse_args()
checks = []
def check(name, ok, note=""):
    checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + note) if note else ''}")
with sync_playwright() as p:
    b = getattr(p, a.browser).launch(); version = b.version
    page = b.new_context(viewport={"width": 900, "height": 700}).new_page()
    page.goto(a.url + "/")
    check("front page explains PWX", page.get_by_role("heading", name="Apps that can only do what they say.").is_visible() and page.get_by_role("heading", name="Why PWX exists").is_visible())
    page.goto(a.url + "/how-it-works.html")
    check("how-it-works page opens with its diagrams", page.get_by_role("heading", name="How PWX works").is_visible() and page.locator("figure.diagram svg").count() == 3)
    # Installable: a manifest with home-screen icons that all load (browsers use these to offer Install).
    page.goto(a.url + "/")
    man = page.evaluate("""async () => {
      const href = document.querySelector('link[rel=manifest]')?.href; if (!href) return 'no manifest link';
      const m = await (await fetch(href)).json();
      for (const i of m.icons) { const r = await fetch(new URL(i.src, href)); if (!r.ok) return 'icon ' + i.src + ' ' + r.status; }
      const sizes = m.icons.map((i) => i.sizes).join(' ');
      return m.display === 'standalone' && m.start_url && /192x192/.test(sizes) && /512x512/.test(sizes) ? 'ok' : 'incomplete manifest';
    }""")
    check("the demo can be installed on a phone or computer", man == "ok", man)
    page.get_by_role("link", name="Try the Notes app").click()
    page.wait_for_function("() => window.__pwx && ['consent', 'running', 'rejected'].includes(window.__pwx.phase)", timeout=30000)
    st = page.evaluate("() => window.__pwx")
    check("install asks first, showing the publisher", st["phase"] == "consent" and "Notes" in page.locator("#consent").inner_text(), st["phase"] + " " + str(st.get("error", "")))
    log = st.get("logStatus") or {}
    check("Notes is in the public log (receipt checked offline)", log.get("logged") is True and log.get("origin") == "pwx.altru.dev/log"
          and "In the public log" in page.locator("#consent").inner_text(), str(log)[:150])
    # The log itself is public: its signed checkpoint is served at /log/checkpoint, readable from any site.
    cp = page.evaluate("() => fetch('/log/checkpoint', { cache: 'no-store' }).then(async (r) => ({ status: r.status, cors: r.headers.get('access-control-allow-origin'), text: await r.text() }))")
    check("the public log is served at /log/", cp["status"] == 200 and cp["text"].startswith("pwx.altru.dev/log\n") and "\u2014 witness-1.altru.dev " in cp["text"] and cp["cors"] == "*", str(cp)[:150])
    if st["phase"] == "consent":
        page.click("#install-confirm")
    page.wait_for_function("() => window.__pwx.phase === 'running' || window.__pwx.phase === 'rejected'", timeout=30000)
    st = page.evaluate("() => window.__pwx")
    origin = st.get("appOrigin", "")
    check("Notes runs on its own app host", st["phase"] == "running" and origin.startswith("https://app") and origin.endswith(".pwx.altru.dev"), origin or str(st.get("error")))
    app = page.frame_locator("iframe.app")
    try:
        expect(app.get_by_text("No notes yet")).to_be_visible(timeout=20000)
        app.get_by_role("button", name="New note").click()
        app.get_by_label("Title", exact=True).fill("Live demo")
        app.get_by_label("Note", exact=True).fill("Signed, sandboxed, and stored only here.")
        expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=10000)
        check("a note can be written", True)
        if a.shot:
            page.screenshot(path=a.shot)
        page.goto(a.url + "/"); page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'library'", timeout=20000)
        check("Notes is in the library after leaving", page.get_by_role("link", name="Open Notes").count() == 1)
        page.get_by_role("link", name="Open Notes").click()
        expect(app.locator(".item")).to_have_count(1, timeout=20000)
        check("the note is still there when Notes reopens", True)
    except Exception as e:
        check("Notes works end to end", False, str(e).splitlines()[0][:160])
    b.close()
ok = all(checks)
print(f"{a.browser} {version}: {'PASS' if ok else 'FAIL'} ({sum(checks)}/{len(checks)})")
sys.exit(0 if ok else 1)
