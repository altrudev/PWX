# PWX spike

Week-one spike for the PWX v0 spec (section 10, tests 1–5). It checks whether a signed web
package can be verified in the browser and whether an app can be stopped from sending data to
hosts it didn't declare.

## What's here

| Path | What it is |
| --- | --- |
| `lib/pwx-verify.mjs` | Verifier shared by the loader and tests: strict JSON (rejects duplicate keys), canonical JSON, manifest and origin grammar, Ed25519 signature, file hashes, rollback check, and the fixed CSP / Permissions-Policy template |
| `tools/pack.mjs` | Packer: hashes an app folder, signs the canonical manifest, writes a `.pwx.json` package |
| `loader/` | Loader page (Host-verified tier). Verifies, shows capabilities, installs files on the app origin, runs the app in a sandboxed frame |
| `app-origin/` | App-origin bootstrap and service worker. The SW serves only verified files from cache, with headers from the manifest |
| `apps/evil/` | Leak-test app: 27 ways to send data to an undeclared host |
| `server/serve.mjs` | Local servers: loader `:8100`, per-app origins `:8110`–`:8129`, unprotected control `:8102`, canary `:8199` + UDP `3478` |
| `tests/` | Unit tests (tests 2–5), browser leak test (test 1), browser rejection test |

Spike simplifications: the package is a JSON container rather than a Signed Web Bundle, there's one
fixed app origin, consent is shown but not interactive, and there's no transparency log yet.

## Run

```bash
npm test                       # unit tests: injection, JSON, file swap, rollback (Node 22+)
npm run build                  # builds packages/ with a local dev key
npm run serve                  # in a second terminal
pip install playwright && python3 -m playwright install chromium firefox webkit
python3 tests/leak_test.py --browser chromium    # repeat with firefox and webkit
python3 tests/loader_reject.py --browser chromium
```

The leak test runs every vector twice: once with no protections (the control proves the canary
can see that vector), and once through the PWX loader. A vector counts as blocked only if it
leaked in the control and not through PWX. Navigating vectors each get their own run. A
declared-host run confirms that declared hosts still work.

## First results (week one, Chrome 153, headless)

Current results for all three engines (Chromium, Firefox and WebKit) are in
[`../docs/AUDIT.md`](../docs/AUDIT.md). Unit tests: 47 of 47 pass as of spike release 0.4.1.
The week-one results, kept for the record:

- Unit tests: 34 of 34 pass.
- Tampered packages (changed byte, extra file, changed capability, duplicate key): all rejected in the browser; the app never starts.
- Leaks: **25 of 26 testable vectors blocked**, including self-navigation, top navigation, popups, forms, ping, prefetch and workers.
- **WebRTC leaks:** a STUN request reaches the undeclared host even with CSP `webrtc 'block'`.
- Preconnect is untested because the control run opened no connection.
- Declared hosts work. `<a ping>` and `<link rel=prefetch>` follow `connect-src`.

Firefox and WebKit were run later; see the audit.

## Later additions

- **Strict runtime** (`app-origin/renderer.js`, `strict.html`, `ui.css`): app code runs only in a
  worker and draws through a loader-owned renderer. `tests/run_strict.sh`.
- **Notes** (`apps/notes`): first real app on the Strict runtime. `tests/run_notes.sh`.
- **Offline-first loader** (`loader/sw.js`, `loader/store.mjs`, `app-origin/sw.js`): installed
  apps open with no network, are re-verified at every launch, and can be sideloaded from a file.
  `tests/run_offline.sh` shuts the host down and takes the browser offline.
- **Full leak matrix**: `tests/run_matrix.sh` (Standard runtime, with and without guard and hardening).

Run everything on a machine with all three Playwright browsers:

```bash
python3 -m venv .venv && .venv/bin/pip install playwright && .venv/bin/python -m playwright install chromium firefox webkit
npm test && bash tests/run_matrix.sh && bash tests/run_strict.sh && bash tests/run_notes.sh && bash tests/run_offline.sh
```

## Local loader (Verified tier)

`local/pwx-local.mjs` serves the loader and runtime from your own machine, on 127.0.0.1 only,
after checking every file against a signed release (`local/release.json`). Each app gets its own
origin. No web host is involved, so none can swap the verifier or see which apps you open.

```bash
node tools/make-release.mjs 0.1.0   # re-sign after changing lib/, loader/ or app-origin/ (key in packages/)
node local/pwx-local.mjs add packages/notes.pwx.json
node local/pwx-local.mjs serve      # then open http://127.0.0.1:7100/?pkg=notes
bash tests/run_local.sh             # tamper check + all three engines
```
