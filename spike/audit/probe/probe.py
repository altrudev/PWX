import json, subprocess, time
from playwright.sync_api import sync_playwright
srv = subprocess.Popen(["node", str(__import__("pathlib").Path(__file__).resolve().parent / "server.mjs")], stdout=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        for name in ("chromium", "firefox", "webkit"):
            b = getattr(p, name).launch()
            for variant in ("data", "outer"):
                pg = b.new_context().new_page(); pg.goto(f"http://127.0.0.1:9100/{variant}.html")
                try:
                    pg.wait_for_function("() => window.result", timeout=8000); r = pg.evaluate("() => window.result")
                except Exception as e:
                    r = {"error": "no result"}
                print(f"{name:9} {'data: worker' if variant == 'data' else 'blob worker in sandboxed frame':32} {json.dumps(r)}")
            b.close()
finally:
    srv.terminate()
