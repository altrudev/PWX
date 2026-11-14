#!/usr/bin/env python3
"""Spike test 1: can a PWX app leak data to a host it didn't declare?

Runs the leak-test app twice against the same canary:
  control - framed with no sandbox and no CSP; proves the canary sees each vector
  pwx     - verified and run by the PWX loader; every vector should be blocked
A vector only counts as blocked if it leaked in the control run and not in the PWX run.

Usage: python3 tests/leak_test.py [--browser chromium|firefox|webkit] [--executable PATH]
Requires the servers (npm run serve) and packages (npm run build).
"""
import argparse, json, sys, time, urllib.request
from playwright.sync_api import sync_playwright

LOADER = "http://127.0.0.1:8100"

def get(path):
    with urllib.request.urlopen(LOADER + path) as r:
        return json.loads(r.read() or b"null")

def run(page, url, wait_s=6):
    urllib.request.urlopen(LOADER + "/__test/reset").read()
    page.goto(url)
    time.sleep(wait_s)
    data = get("/__test/hits")
    vectors = sorted({h["path"].split("/leak/")[1].split("?")[0] for h in data["hits"] if "/leak/" in h["path"]})
    return vectors, data["tcp"]

MODES = ["passive", "link-preconnect", "link-preconnect-dom", "window-open", "top-navigation", "self-navigation", "form-post"]
CONNECTION_ONLY = {"link-preconnect", "link-preconnect-dom"}

# Browser-level hardening a local PWX shell or enterprise policy could apply.
HARDENED = {
    "chromium": {"args": ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]},
    "firefox": {"firefox_user_prefs": {
        "media.peerconnection.enabled": False, "network.dns.disablePrefetch": True,
        "network.http.speculative-parallel-limit": 0, "network.prefetch-next": False,
        "network.predictor.enabled": False}},
    "webkit": None,  # Playwright exposes no equivalent switches for WebKit
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", default="chromium", choices=["chromium", "firefox", "webkit"])
    ap.add_argument("--executable", default=None)
    ap.add_argument("--guard", action="store_true", help="inject the loader guard script")
    ap.add_argument("--hardened", action="store_true", help="run the PWX side in a hardened browser")
    args = ap.parse_args()
    if args.hardened and HARDENED[args.browser] is None:
        print(f"{args.browser}: no hardening switches available; skipping"); return 2
    label = "+".join(["pwx"] + (["guard"] if args.guard else []) + (["hardened"] if args.hardened else []))
    base = {"executable_path": args.executable} if args.executable else {}
    rows, phases, version = [], set(), ""
    with sync_playwright() as p:
        bt = getattr(p, args.browser)
        control_browser = bt.launch(**base)
        pwx_browser = bt.launch(**base, **HARDENED[args.browser]) if args.hardened else control_browser
        version = control_browser.version
        q = "&guard=1" if args.guard else ""
        for mode in MODES:
            # Fresh contexts per run: no shared cache, service worker or connection pool.
            cv, ctcp = run(control_browser.new_context().new_page(), f"http://127.0.0.1:8102/#{mode}")
            page = pwx_browser.new_context().new_page()
            xv, xtcp = run(page, f"{LOADER}/?pkg=evil&mode={mode}{q}", wait_s=7)
            state = page.evaluate("() => window.__pwx") if not page.is_closed() else {}
            phases.add(state.get("phase") if state else "navigated-away")
            tried = next((m["tried"] for m in (state or {}).get("messages", []) if m.get("type") == "evil-done"), None)
            names = (tried or []) if mode == "passive" else [mode]
            for v in names:
                if v in CONNECTION_ONLY:
                    c, x = ctcp > 0, xtcp > 0
                else:
                    c, x = v in cv, v in xv
                result = "LEAK" if x else ("blocked" if c else "untested: control did not leak")
                rows.append({"vector": v, "control": c, "pwx": x, "result": result})
        dv, _ = run(pwx_browser.new_context().new_page(), f"{LOADER}/?pkg=declared&dev=1&mode=passive{q}", wait_s=7)
        if pwx_browser is not control_browser:
            pwx_browser.close()
        control_browser.close()
    # connect-src also governs <a ping> and (in current Chrome) <link rel=prefetch>.
    expected_open = {"fetch", "xhr", "websocket", "eventsource", "beacon", "a-ping", "link-prefetch"} | {
        "worker-fetch", "worker-xhr", "worker-websocket", "worker-eventsource", "worker-nested"}
    core = {"fetch", "xhr", "websocket", "eventsource", "beacon"}
    rtc = {"webrtc-stun", "webrtc-fresh-realm", "worker-webrtc"}
    declared_ok = core <= set(dv) and not (set(dv) - expected_open - rtc)

    print(f"browser: {args.browser} {version}   run: {label}")
    print(f"loader phases seen: {sorted(p for p in phases if p)}")
    print(f"{'vector':22} {'control':8} {'pwx':8} result")
    for r in sorted(rows, key=lambda r: (r["result"] != "LEAK", r["result"], r["vector"])):
        print(f"{r['vector']:22} {'leak' if r['control'] else '-':8} {'leak' if r['pwx'] else '-':8} {r['result']}")
    leaks = [r["vector"] for r in rows if r["pwx"]]
    blocked = [r["vector"] for r in rows if r["result"] == "blocked"]
    untested = [r["vector"] for r in rows if r["result"].startswith("untested")]
    print(f"\nblocked {len(blocked)}, leaked {len(leaks)}, untested {len(untested)} of {len(rows)} vectors")
    with open(f"leak-results-{args.browser}-{label}.json", "w") as f:
        json.dump({"browser": args.browser, "version": version, "run": label, "rows": rows,
                   "declared_reached": sorted(dv)}, f, indent=1)
    print(f"declared-host control: reached {sorted(dv)} -> {'OK' if declared_ok else 'UNEXPECTED'}")
    print("PASS: no vector leaked" if not leaks and rows else f"FAIL: leaked via {', '.join(leaks)}")
    return 0 if not leaks and rows and declared_ok else 1

if __name__ == "__main__":
    sys.exit(main())
