#!/usr/bin/env python3
"""Upgrade from an older loader the way a phone does: the old worker stays in place (sw.js is
cached for a day), then the user taps Check for loader update -> Update loader. Afterwards the
new worker must be running and per-app install must work.
Usage: git worktree add /tmp/pwx-old edca6a2 && (cd /tmp/pwx-old/spike && node tools/build-packages.mjs)
       .venv/bin/python tests/worker_upgrade_test.py /tmp/pwx-old/spike . chromium|firefox|webkit"""
import subprocess, sys, time, shutil, tempfile, json, os
from playwright.sync_api import sync_playwright
OLD, NEW, BROWSER = sys.argv[1], sys.argv[2], sys.argv[3]
WANT = open(os.path.join(NEW, "VERSION")).read().strip()
L = "http://127.0.0.1:8100"
def server(root):
    p = subprocess.Popen(["node", "server/serve.mjs"], cwd=root, env={**os.environ, "PWX_TEST": "1"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.2); return p
prof = tempfile.mkdtemp()
with sync_playwright() as p:
    bt = getattr(p, BROWSER)
    s = server(OLD)
    ctx = bt.launch_persistent_context(prof, viewport={"width": 412, "height": 900})
    pg = ctx.new_page()
    pg.goto(L + "/?pkg=notes")
    pg.wait_for_function("() => window.__pwx && window.__pwx.phase === 'running'", timeout=30000)
    pg.goto(L + "/"); pg.wait_for_function("() => window.__pwx.phase === 'library'", timeout=20000)
    print("old loader:", pg.locator("#loader-version").inner_text())
    ctx.close(); s.terminate(); s.wait()
    s = server(NEW)
    ctx = bt.launch_persistent_context(prof, viewport={"width": 412, "height": 900})
    pg = ctx.new_page()
    pg.goto(L + "/"); pg.wait_for_function("() => window.__pwx.phase === 'library'", timeout=20000)
    time.sleep(1)
    print("before update:", pg.locator("#loader-version").inner_text())
    pg.click("#update-check")
    pg.wait_for_selector("#update-apply", state="visible", timeout=20000)
    pg.click("#update-apply")
    # The old page reloads; the new page finishes the update (may reload again).
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            if pg.evaluate("() => window.__pwx && window.__pwx.phase === 'library' && document.querySelector('#loader-version').textContent.includes('0.4.')"):
                v = pg.locator("#loader-version").inner_text()
                w = pg.evaluate("() => new Promise((ok) => { const c = new MessageChannel(); c.port1.onmessage = (m) => ok(m.data); navigator.serviceWorker.controller.postMessage({ type: 'status' }, [c.port2]); setTimeout(() => ok(null), 3000); })")
                if w and w.get("worker") == 2 and w.get("version") == WANT: break
                if pg.locator("#update-apply").is_visible(): pg.click("#update-apply")
                elif not pg.locator("#update-msg").inner_text(): pg.click("#update-check")
        except Exception: pass
        time.sleep(1)
    print("after update:", pg.locator("#loader-version").inner_text(), "| worker:", w)
    m = pg.evaluate("async () => { const r = await fetch('/app/org.example.notes/manifest.webmanifest'); return r.ok ? (await r.json()).name : 'HTTP ' + r.status; }")
    print("Notes install manifest:", m)
    pg.goto(L + "/app/org.example.notes/?src=notes")
    pg.wait_for_function("() => window.__pwx && ['running','rejected','library'].includes(window.__pwx.phase)", timeout=30000)
    print("app page:", pg.evaluate("() => window.__pwx.phase"), "| title:", pg.title(), "| manifest link:", pg.evaluate("() => document.querySelector('link[rel=manifest]').getAttribute('href')"), "| locked:", pg.evaluate("() => !!window.__pwx.locked"))
    ok = w and w.get("worker") == 2 and w.get("version") == WANT and pg.evaluate("() => window.__pwx.phase") == "running" and m == "Notes" and pg.title() == "Notes"
    print(BROWSER, "UPGRADE", "PASS" if ok else "FAIL")
    ctx.close(); s.terminate()
shutil.rmtree(prof, ignore_errors=True)
