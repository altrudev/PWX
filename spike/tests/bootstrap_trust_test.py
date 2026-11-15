#!/usr/bin/env python3
"""App origins don't trust the loader.
Plays a hijacked loader: script running on the loader's own origin frames the Notes origin's
bootstrap (as the real loader does) and pushes things at it. The app origin must refuse
everything except a genuine package from Notes' own publisher that isn't older, and Notes and
its data must be untouched afterwards. Starts and stops its own server.
Usage: .venv/bin/python tests/bootstrap_trust_test.py --browser chromium|firefox|webkit"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOADER = "http://127.0.0.1:8100"

PUSH = """async ([origin, msg]) => {
  const boot = Object.assign(document.createElement('iframe'), { src: origin + '/__pwx/bootstrap.html' });
  boot.style.display = 'none';
  const ready = new Promise((ok) => addEventListener('message', function on(e) {
    if (e.origin === origin && e.data?.type === 'bootstrap-ready') { removeEventListener('message', on); ok(); }
  }));
  document.body.append(boot);
  await ready;
  const ch = new MessageChannel();
  const reply = new Promise((ok) => { ch.port1.onmessage = (m) => ok(m.data); setTimeout(() => ok({ type: 'timeout' }), 15000); });
  boot.contentWindow.postMessage({ type: 'connect' }, origin, [ch.port2]);
  ch.port1.postMessage(msg);
  const r = await reply;
  boot.remove();
  return r;
}"""

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + note) if note else ''}", flush=True)
    pk = json.loads(subprocess.check_output(["node", "tests/make_hostile_packages.mjs"], cwd=ROOT))
    server = subprocess.Popen(["node", "server/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL, env={**os.environ, "PWX_TEST": "1"})
    time.sleep(1)
    try:
        with sync_playwright() as p:
            b = getattr(p, a.browser).launch(); version = b.version
            ctx = b.new_context(); page = ctx.new_page(); app = page.frame_locator("iframe.app")
            page.goto(f"{LOADER}/?pkg=notes")
            app.get_by_role("button", name="New note").click(timeout=20000)
            app.get_by_label("Title", exact=True).fill("Keep me")
            expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
            origin = page.evaluate("() => window.__pwx.appOrigin")
            check("Notes installed through the app origin's own verification", True, origin)

            page.goto(LOADER + "/")
            page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'library'", timeout=20000)
            def push(msg): return page.evaluate(PUSH, [origin, msg])
            evil_js = "self.postMessage({ops:[]}); // hijacked"
            attacks = [
                ("raw files and headers (the old protocol)", {"type": "install", "files": {"app/main.js": evil_js}, "headers": {}}, "signed package"),
                ("package signed with another key", {"type": "install", "text": pk["forged"]}, "publisher changed"),
                ("genuine package with a changed file", {"type": "install", "text": pk["broken"]}, "hash mismatch"),
                ("older genuine version (rollback)", {"type": "install", "text": pk["older"]}, "older than installed"),
                ("same version, different contents", {"type": "install", "text": pk["swapped"]}, "different content"),
                ("another app's genuine package", {"type": "install", "text": pk["other"]}, "belongs to org.example.notes"),
            ]
            for name, msg, expected in attacks:
                r = push(msg)
                check(f"refused: {name}", r.get("type") == "install-failed" and expected in r.get("error", ""), str(r)[:90])

            page.goto(f"{LOADER}/?open=org.example.notes")
            try:
                expect(app.get_by_role("button", name="Keep me")).to_be_visible(timeout=20000); intact = True
            except AssertionError:
                intact = False
            check("Notes and its data untouched after the attacks", intact)

            page.goto(LOADER + "/")
            page.wait_for_function("() => window.__pwx && window.__pwx.phase === 'library'", timeout=20000)
            r = push({"type": "install", "text": pk["newer"]})
            check("accepted: newer genuine version from the same publisher", r.get("type") == "installed", str(r)[:90])
            b.close()
    finally:
        server.terminate()
    print(f"{a.browser} {version}: {'PASS' if all(checks) else 'FAIL'} ({sum(checks)}/{len(checks)})")
    sys.exit(0 if all(checks) else 1)

if __name__ == "__main__":
    main()
