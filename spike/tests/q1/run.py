# Runs the sealed-frame probe in an engine: online, then offline (served from the loader's worker).
import json, sys, time, urllib.request, tempfile
def wait(pg, n=40):
    for _ in range(n * 4):
        try:
            if pg.evaluate("window.__q1 && window.__q1.phase") == "done": return
        except Exception: pass
        time.sleep(0.25)
    raise SystemExit("timeout; state: " + json.dumps(pg.evaluate("window.__q1 || null")))
from playwright.sync_api import sync_playwright
B = sys.argv[1]; L = "http://127.0.0.1:8300"
def hits(): return json.loads(urllib.request.urlopen("http://127.0.0.1:8300/hits").read())
with sync_playwright() as p:
    ctx = getattr(p, B).launch_persistent_context(tempfile.mkdtemp())
    pg = ctx.new_page(); urllib.request.urlopen(L + "/reset").read()
    pg.on("console", lambda m: print("console:", m.text, file=sys.stderr)); pg.goto(L + "/"); wait(pg)
    time.sleep(2); on = pg.evaluate("window.__q1"); h1 = hits()
    ctx.set_offline(True); pg.reload(); wait(pg)
    off = pg.evaluate("window.__q1"); ctx.close()
print(json.dumps({"browser": B, "online": on, "canary": h1, "offline": {v: {"worker": off["results"][v].get("worker"), "error": off["results"][v].get("error")} for v in off["results"]}, "swServedOffline": off.get("swServed")}, indent=1))
