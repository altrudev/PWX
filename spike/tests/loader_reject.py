#!/usr/bin/env python3
"""In-browser check: the loader refuses tampered packages and never starts the app.
Builds tampered copies of packages/evil.pwx.json, then loads each through the loader."""
import argparse, base64, json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
src = json.loads((ROOT / "packages/evil.pwx.json").read_text())

def variant(name, fn):
    pkg = json.loads(json.dumps(src)); fn(pkg)
    (ROOT / f"packages/{name}.pwx.json").write_text(json.dumps(pkg))
    return name

def flip(pkg):
    b = bytearray(base64.b64decode(pkg["files"]["app/app.js"])); b[0] ^= 1
    pkg["files"]["app/app.js"] = base64.b64encode(b).decode()

cases = {
    variant("t-filebyte", flip): "files",
    variant("t-extrafile", lambda p: p["files"].__setitem__("app/x.js", base64.b64encode(b"x").decode())): "files",
    variant("t-caps", lambda p: p.__setitem__("manifest", p["manifest"].replace('"connect": []', '"connect": ["https://evil.example"]'))): "signature",
    variant("t-dupkey", lambda p: p.__setitem__("manifest", p["manifest"].replace('"pwx": "0"', '"pwx": "0", "pwx": "0"'))): "json",
}
ap = argparse.ArgumentParser(); ap.add_argument("--executable"); ap.add_argument("--browser", default="chromium")
a = ap.parse_args()
fails = 0
with sync_playwright() as p:
    b = getattr(p, a.browser).launch(**({"executable_path": a.executable} if a.executable else {}))
    for name, code in cases.items():
        page = b.new_context().new_page()
        page.goto(f"http://127.0.0.1:8100/?pkg={name}"); time.sleep(1.5)
        st = page.evaluate("() => window.__pwx")
        frames = [f.url for f in page.frames if any(f"127.0.0.1:{port}/" in f.url for port in range(8110, 8130))]
        ok = st["phase"] == "rejected" and st.get("error") == code and not frames
        fails += not ok
        print(f"{name:12} expected {code:9} got {st['phase']}/{st.get('error')}  app frames: {len(frames)}  {'OK' if ok else 'FAIL'}")
    b.close()
print("PASS" if not fails else "FAIL"); sys.exit(1 if fails else 0)
