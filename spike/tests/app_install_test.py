#!/usr/bin/env python3
"""Per-app install: each installed app has its own home address, /app/<id>/, whose install
manifest, name and icon are that app's, made on the device from the library. Opening the
address runs the app (same origin, same data); in Chromium the browser must find it installable.
Usage: .venv/bin/python tests/app_install_test.py --browser chromium|firefox|webkit"""
import argparse, sys, time, urllib.request
from playwright.sync_api import sync_playwright, expect

LOADER = "http://127.0.0.1:8100"
HOME = "/app/org.example.notes/"

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); ap.add_argument("--shot")
    a = ap.parse_args()
    checks = []
    def check(name, ok, note=""): checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + str(note)) if note else ''}")
    with sync_playwright() as p:
        b = getattr(p, a.browser).launch(); version = b.version
        ctx = b.new_context(viewport={"width": 900, "height": 700})
        page = ctx.new_page()
        urllib.request.urlopen(LOADER + "/__test/reset").read()
        page.goto(f"{LOADER}/?pkg=notes")
        app = page.frame_locator("iframe.app")
        expect(app.get_by_text("No notes yet")).to_be_visible(timeout=15000)
        app.get_by_role("button", name="New note").click()
        app.get_by_label("Title", exact=True).fill("From the library")
        expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
        origin = page.evaluate("() => window.__pwx.appOrigin")
        # Opened from a link, the page becomes the app's own: saving it saves the app, not PWX.
        loc = page.evaluate("() => ({ path: location.pathname, search: location.search, title: document.title, man: document.querySelector('link[rel=manifest]').getAttribute('href'), touch: document.querySelector('link[rel=apple-touch-icon]').getAttribute('href'), apple: document.querySelector('meta[name=apple-mobile-web-app-title]').content })")
        check("an app opened from a link moves to its own address", loc["path"] == HOME and loc["search"] == "?src=notes", loc)
        check("...and its page names, installs and shows the app, not PWX", loc["title"] == "Notes" and loc["apple"] == "Notes"
              and loc["man"] == HOME + "manifest.webmanifest" and loc["touch"] == HOME + "icon-180.png", loc)
        vh = page.evaluate("() => innerHeight")
        frame_h = page.locator("iframe.app").bounding_box()["height"]
        check("app mode: only the app and a thin strip, no PWX page around it",
              not page.locator("header.bar").is_visible() and not page.locator("footer.foot").is_visible()
              and not page.locator("#intro").is_visible() and not page.locator("#consent").is_visible()
              and page.locator("#app-strip-name").inner_text() == "Notes" and frame_h >= vh * 0.85, f"iframe {frame_h:.0f}px of {vh}px")
        check("the strip links back to the PWX library", page.locator("#app-strip-home").get_attribute("href") == "/library/")
        page.get_by_role("button", name="What it can do").click()
        check("what the app can do is one tap away", page.locator("#consent").is_visible() and "Notes 1.0.0" in page.locator("#consent").inner_text())
        page.get_by_role("button", name="What it can do").click()
        if a.browser == "chromium":
            cdp0 = ctx.new_cdp_session(page); time.sleep(1)
            errs0 = cdp0.send("Page.getInstallabilityErrors").get("installabilityErrors")
            got0 = cdp0.send("Page.getAppManifest")
            check("Chromium would install the app, not PWX, from that page", errs0 == [] and got0.get("url", "").endswith(HOME + "manifest.webmanifest"), (errs0, got0.get("url")))
        page.reload()
        page.wait_for_function("() => window.__pwx && ['running', 'rejected', 'library'].includes(window.__pwx.phase)", timeout=20000)
        expect(app.get_by_text("From the library")).to_be_visible(timeout=10000)
        check("reloading keeps the app, with its data", page.evaluate("() => location.pathname") == HOME)

        page.goto(LOADER + "/")
        expect(page.get_by_role("link", name="Put Notes on your home screen")).to_have_count(1, timeout=10000)
        check("the library offers it too", True)

        page.goto(LOADER + HOME)
        page.wait_for_function("() => window.__pwx && ['running', 'rejected', 'library'].includes(window.__pwx.phase)", timeout=20000)
        st = page.evaluate("() => window.__pwx")
        check("its home address opens the app itself", st["phase"] == "running" and st.get("appOrigin") == origin, st["phase"])
        expect(app.get_by_text("From the library")).to_be_visible(timeout=10000)
        check("same app, same data", True)
        check("the page carries the app's name", page.title() == "Notes", page.title())
        man = page.evaluate("""async () => {
          const href = document.querySelector('link[rel=manifest]').href;
          const m = await (await fetch(href)).json();
          const types = [];
          for (const i of m.icons) { const r = await fetch(new URL(i.src, href)); types.push(r.ok ? r.headers.get('content-type') : 'HTTP ' + r.status); }
          return { href, name: m.name, id: m.id, scope: m.scope, start: m.start_url, display: m.display, types };
        }""")
        check("its install manifest is the app's own", man["href"].endswith(HOME + "manifest.webmanifest") and man["name"] == "Notes"
              and man["id"] == HOME and man["scope"] == HOME and man["start"] == HOME + "?src=notes" and man["display"] == "standalone", man)
        lib = page.evaluate("async () => (await fetch('/manifest.webmanifest')).json()")
        check("the library's install never covers an app's address", lib["scope"] == "/library/" and lib["start_url"] == "/library/", lib.get("scope"))
        check("its icons are made on the device", man["types"] and all(t == "image/png" for t in man["types"]), man["types"])
        if a.browser == "chromium":
            cdp = ctx.new_cdp_session(page)
            time.sleep(1)
            errs = cdp.send("Page.getInstallabilityErrors").get("installabilityErrors")
            got = cdp.send("Page.getAppManifest")
            check("Chromium finds the app installable on its own", errs == [] and got.get("url", "").endswith(HOME + "manifest.webmanifest"), errs)
        if a.shot:
            icon = page.evaluate("async () => { const r = await fetch('" + HOME + "icon-512.png'); const b = await r.blob(); return await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b); }); }")
            import base64; open(a.shot, "wb").write(base64.b64decode(icon.split(",", 1)[1]))

        # Opened from the home screen: nothing but the app.
        home_ctx = b.new_context(viewport={"width": 400, "height": 760})
        home_ctx.add_init_script("Object.defineProperty(navigator, 'standalone', { value: true })")
        hp = home_ctx.new_page(); hp.goto(LOADER + HOME + "?src=notes")
        hp.wait_for_function("() => window.__pwx && ['running', 'rejected'].includes(window.__pwx.phase)", timeout=20000)
        hb = hp.locator("iframe.app").bounding_box()
        check("from the home screen: the app fills the screen, no strip, no PWX page",
              hp.evaluate("() => window.__pwx.phase") == "running" and not hp.locator("#app-install").is_visible()
              and not hp.locator("header.bar").is_visible() and hb["height"] >= 760 * 0.97 and hb["width"] >= 400 * 0.97, hb)
        home_ctx.close()

        # A home-screen copy can start with an empty library (iPhone keeps its storage apart).
        fresh = b.new_context(viewport={"width": 900, "height": 700}).new_page()
        fresh.goto(LOADER + HOME + "?src=notes")
        # (Test builds confirm consent automatically; the consent step itself is covered elsewhere.)
        fresh.wait_for_function("() => window.__pwx && ['running', 'rejected'].includes(window.__pwx.phase)", timeout=20000)
        check("a fresh home-screen copy installs the app with the usual checks", fresh.evaluate("() => window.__pwx.phase") == "running"
              and fresh.title() != "", fresh.evaluate("() => window.__pwx.error"))
        fresh.goto(LOADER + "/app/org.example.other/?src=notes")
        fresh.wait_for_function("() => window.__pwx && ['running', 'rejected', 'library'].includes(window.__pwx.phase)", timeout=20000)
        check("an address can't install a different app under its name", fresh.evaluate("() => window.__pwx.phase") == "rejected", fresh.evaluate("() => window.__pwx.phase"))
        page.goto(LOADER + "/app/org.example.missing/")
        page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'library'", timeout=20000)
        check("a removed app's address explains itself", "isn't in your PWX library" in page.locator("#status").inner_text())
        b.close()
    ok = all(checks)
    print(f"{a.browser} {version}: {'PASS' if ok else 'FAIL'} ({sum(checks)}/{len(checks)})")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
