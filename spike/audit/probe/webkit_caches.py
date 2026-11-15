import json, subprocess, time
from playwright.sync_api import sync_playwright
srv = subprocess.Popen(["node", str(__import__("pathlib").Path(__file__).resolve().parent / "webkit_caches.mjs")])
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.webkit.launch(); pg = b.new_context().new_page(); pg.goto("http://127.0.0.1:9101/")
        pg.wait_for_function("() => window.result", timeout=8000)
        print("webkit", json.dumps(pg.evaluate("() => window.result")))
        b.close()
finally:
    srv.terminate()
