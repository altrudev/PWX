#!/usr/bin/env python3
"""Release status (M4 section 5a), the test Jason McGill suggested: show when the device last
checked a release's status, and check the person sees the updated status when it reconnects.
Install Notes online; go offline; the publisher withdraws the release; reopen offline (the app
runs and shows when it was last checked); after 30 days offline, a one-time prompt with
"Open anyway"; reconnect (the withdrawal notice appears); then a revocation (the app stops and
won't start, its data kept). Also: a withdrawal signed by another key is ignored, an older list
is refused, and the device only ever asks for the whole list.
Test builds pretend days pass with ?clock=<days>. Requires the servers (PWX_TEST=1).
Usage: .venv/bin/python tests/release_status_test.py --browser chromium|firefox|webkit"""
import argparse, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
LOADER = "http://127.0.0.1:8100"
STATUS = "/tmp/pwx-test-status.json"
NOTES = "org.example.notes"
settled = "() => window.__pwx && ['running','revoked','stale-check','library','rejected'].includes(window.__pwx.phase)"

def publish(steps, message="Fixed in 1.0.1"):
    subprocess.run(["node", "tests/make_status.mjs", STATUS, steps, message], cwd=ROOT, check=True, capture_output=True)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--browser", default="chromium"); a = ap.parse_args()
    checks = []
    def check(name, ok, note=""):
        checks.append(bool(ok)); print(f"{'OK  ' if ok else 'FAIL'} {name}{('  ' + str(note)) if note else ''}", flush=True)
    urllib.request.urlopen(LOADER + "/__test/reset").read()
    with sync_playwright() as p:
        b = getattr(p, a.browser).launch(); version = b.version
        ctx = b.new_context(); asked = []
        ctx.on("request", lambda r: asked.append(r.url) if "/log/" in r.url else None)
        page = ctx.new_page(); app = page.frame_locator("iframe.app")
        def open_notes(q=""):
            page.goto(f"{LOADER}/?open={NOTES}{q}"); page.wait_for_function(settled, timeout=30000)
            return page.evaluate("() => window.__pwx")
        facts = lambda: page.locator("#consent").inner_text()

        # 1. Online: install, and the first launch checks the release status.
        publish("release")
        page.goto(f"{LOADER}/?pkg=notes"); page.wait_for_function(settled, timeout=30000)
        app.get_by_role("button", name="New note").click(timeout=20000)
        app.get_by_label("Title", exact=True).fill("Offline note")
        expect(app.get_by_text("Saved on this device")).to_be_visible(timeout=5000)
        check("App facts show when the status was checked", "Release status checked against the public log just now" in facts(), facts().splitlines()[-1:])

        # 2. Offline. Meanwhile the publisher withdraws this release; the device can't know yet.
        ctx.set_offline(True)
        publish("release,withdrawn")
        st = open_notes("&clock=3")
        expect(app.get_by_role("button", name="Offline note")).to_be_visible(timeout=15000)
        check("offline, 3 days later: the app runs, with its data", st["phase"] == "running")
        check("offline: App facts show when it was last checked", "checked against the public log 3 days ago" in facts(), [l for l in facts().splitlines() if "Release status" in l])
        check("offline: no withdrawal shown (the device hasn't heard)", (st.get("releaseStatus") or {}).get("reason") is None)

        # 3. Offline for more than 30 days: one prompt, and "Open anyway" works offline.
        st = open_notes("&clock=31")
        check("offline 31 days: asks once before opening", st["phase"] == "stale-check" and page.get_by_text("last checked 31 days ago").count() == 1)
        page.locator("#stale-open").click()
        page.wait_for_function("() => window.__pwx.phase === 'running'", timeout=20000)
        expect(app.get_by_role("button", name="Offline note")).to_be_visible(timeout=15000)
        check("'Open anyway' opens the app offline", True)

        # 4. Reconnect: the device checks and shows the updated status.
        ctx.set_offline(False)
        st = open_notes("&clock=31")
        status_text = page.locator("#status").inner_text()
        check("reconnected: no prompt, the status is checked first", st["phase"] == "running")
        check("reconnected: the withdrawal notice appears, with the publisher's message", "withdrew this version" in status_text and "Fixed in 1.0.1" in status_text, status_text[:120])
        check("reconnected: App facts say it was checked just now", "checked against the public log just now" in facts())

        # 5. The publisher revokes it as unsafe: the running app stops; it won't start again.
        publish("release,withdrawn,revoked", "Signing key stolen")
        st = open_notes("&clock=31&check=now")
        page.wait_for_function("() => window.__pwx.phase === 'revoked'", timeout=20000)
        check("revoked: the app stops and its frame is removed", page.locator("iframe.app").count() == 0)
        st = open_notes("&clock=31")
        check("revoked: it won't start again", st["phase"] == "revoked" and "revoked this version" in page.locator("#status").inner_text())
        page.goto(LOADER + "/"); page.wait_for_function(settled, timeout=30000)
        check("revoked: the app and its data are still on the device", page.get_by_role("button", name="Remove Notes", exact=True).count() == 1)

        # 6. An older list (a log rolled back, or a replayed file) is refused; the revocation stands.
        publish("release,withdrawn")
        st = open_notes("&clock=31&check=now")
        page.wait_for_timeout(1500)
        refresh = page.evaluate("() => window.__pwx.statusRefresh")
        check("an older list is refused", "older list" in str(refresh) and page.evaluate("() => window.__pwx.phase") == "revoked", refresh)

        # 7. Privacy: the device only ever asked for the whole list.
        check("only the whole list was requested", asked and all(u.endswith("/log/status.json") for u in asked), sorted(set(asked)))
        ctx.close()

        # 8. A withdrawal signed by some other key is ignored (fresh device).
        publish("release,forged", "Pay up")
        ctx = b.new_context(); page = ctx.new_page(); app = page.frame_locator("iframe.app")
        page.goto(f"{LOADER}/?pkg=notes"); page.wait_for_function(settled, timeout=30000)
        st = page.evaluate("() => window.__pwx")
        check("a revocation signed by another key is ignored", st["phase"] == "running" and (st.get("releaseStatus") or {}).get("reason") is None
              and "Pay up" not in page.locator("body").inner_text())
        ctx.close(); b.close()
    publish("release")  # leave no revocation behind for other tests sharing this server
    print(f"{a.browser} {version}: {'PASS' if all(checks) else 'FAIL'} ({sum(checks)}/{len(checks)})")
    return 0 if all(checks) else 1

if __name__ == "__main__":
    sys.exit(main())
