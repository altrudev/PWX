#!/usr/bin/env python3
"""Signer spike: malware copies the browser profile folder. With passphrase-locked keys, the
copy must not be able to sign without the passphrase. (With the passphrase it can: the
passphrase is the protection, so it must not be stored on the device.)
Usage: .venv/bin/python tests/signer_clone_probe.py --browser chromium|firefox|webkit"""
import argparse, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8150/signer/"
PASS = "real passphrase 789"

ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
server = subprocess.Popen(["node", "signer/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL); time.sleep(1)
src = tempfile.mkdtemp(prefix="pwx-clone-src-"); dst = tempfile.mkdtemp(prefix="pwx-clone-dst-")
SIGN = """async (pass) => { const pkg = await fetch('/packages/notes.pwx.json').then((r) => r.text());
  try { await signer.approve(pkg, 'author:val', pass); return 'signed'; } catch (e) { return e.message; } }"""
code = 1
try:
    with sync_playwright() as p:
        bt = getattr(p, a.browser)
        def open_(d):
            ctx = bt.launch_persistent_context(d, headless=True); pg = ctx.pages[0] if ctx.pages else ctx.new_page()
            pg.goto(URL); pg.wait_for_function("() => window.signerReady === true", timeout=15000); return ctx, pg
        ctx, pg = open_(src); k1 = pg.evaluate("(p) => signer.setup(p, 'Laptop')", PASS); ctx.close()
        shutil.rmtree(dst)
        shutil.copytree(src, dst, symlinks=True, ignore=shutil.ignore_patterns("lock", ".parentlock", "SingletonLock"))
        ctx, pg = open_(dst)
        same = pg.evaluate("() => signer.publicKey()") == k1
        guesses = [pg.evaluate(SIGN, g) for g in ("", "password", "12345678", "laptop pass 123")]
        blocked = all(r == "wrong passphrase" for r in guesses)
        with_pass = pg.evaluate(SIGN, PASS)
        ctx.close()
        print(f"{a.browser}: copied profile {'cannot' if blocked else 'CAN'} sign without the passphrase "
              f"(copy holds the same device: {same}; with the passphrase: {with_pass})")
        code = 0 if blocked and same else 1
finally:
    server.terminate()
sys.exit(code)
