#!/usr/bin/env python3
"""Signer spike, known-limit probe: non-extractable WebCrypto keys stop web code from copying
a key, but are they safe from malware that copies the browser profile folder on disk?
Prints whether a copied profile can still sign with the original device key.
Usage: .venv/bin/python tests/signer_clone_probe.py --browser chromium|firefox|webkit"""
import argparse, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8150/signer/"

ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
server = subprocess.Popen(["node", "signer/serve.mjs"], cwd=ROOT, stdout=subprocess.DEVNULL); time.sleep(1)
src = tempfile.mkdtemp(prefix="pwx-clone-src-"); dst = tempfile.mkdtemp(prefix="pwx-clone-dst-")
try:
    with sync_playwright() as p:
        bt = getattr(p, a.browser)
        def key_and_sig(d):
            ctx = bt.launch_persistent_context(d, headless=True); pg = ctx.pages[0] if ctx.pages else ctx.new_page()
            pg.goto(URL); pg.wait_for_function("() => window.signerReady === true", timeout=15000)
            k = pg.evaluate("() => signer.publicKey()")
            ok = pg.evaluate("""async () => { const kp = await signer.deviceKey();
              const d = new TextEncoder().encode('probe');
              const s = await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, d);
              return crypto.subtle.verify({ name: 'Ed25519' }, kp.publicKey, s, d); }""")
            ctx.close(); return k, ok
        k1, _ = key_and_sig(src)
        shutil.rmtree(dst); shutil.copytree(src, dst, symlinks=True, ignore=shutil.ignore_patterns("lock", ".parentlock", "SingletonLock"))
        k2, ok2 = key_and_sig(dst)
        cloned = k1 == k2 and ok2
        print(f"{a.browser}: copied profile {'CAN' if cloned else 'cannot'} sign with the original device key")
finally:
    server.terminate()
