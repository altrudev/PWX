# PWX security audit: findings, fixes and results

**Status (2026-11-15):** every working exploit from the audit is blocked in Chromium, Firefox and
WebKit, including C3. Some findings remain open (see [Open](#open)), including one new issue found
while writing this report (N1).

| | |
| --- | --- |
| Code | branch `spike`: `03b3b65` (Stage 1), `25b2621` (Stage 2) |
| Engines | Chromium 159.0.8154.6, Firefox 159.0, WebKit 27.2 (Playwright, headless) |
| Harness | audit harness on the test VPS: `run.sh` runs static checks, then `exploits.py` in each engine |
| Spec | [`SPEC.md`](SPEC.md) |

This file is now the audit record in the repo. The first audit report was a shared doc. Finding
IDs below are the ones recorded in the code and tests. Where the wording of an ID isn't in the
repo, this report says so instead of guessing.

## Summary

| Exploits that succeed | Baseline | After Stage 1 | After Stage 2 |
| --- | --- | --- | --- |
| Chromium | 8 of 10 | 1 (C3) | **0 of 10** |
| Firefox | 9 of 10 | 1 (C3) | **0 of 10** |
| WebKit | 4 of 10 | 1 (C3) | **0 of 10** |

The ten exploits, each run in every engine:

| # | Mode | Attack | Result now |
| --- | --- | --- | --- |
| 1 | hosted | A website frames the bootstrap and reads Notes | blocked: canary received nothing |
| 2 | hosted | Another app reads Notes through the shared origin (**C3**) | blocked: the thief runs with origin `null` and every read is denied |
| 3 | hosted | An app poisons the runtime cache, so Notes leaks on relaunch | blocked: canary received nothing after relaunch |
| 4 | hosted | An app opened top-level escapes the sandbox (self-navigation) | blocked: 0 canary hits |
| 5 | hosted | An app opened top-level escapes the sandbox (`window.open`) | blocked: 0 canary hits |
| 6 | hosted | A link with `dev=1&unsafe=1` turns off Strict protections | blocked: 0 canary hits |
| 7 | local | A website hijacks the bootstrap and reads Notes | blocked: canary received nothing |
| 8 | local | Another app reads Notes (separate origins) | blocked: the thief runs with origin `null` |
| 9 | local | An app poisons its own runtime, so a relaunch escapes Strict | blocked: canary received nothing |
| 10 | local | A website makes pwx-local allocate origins (CSRF) | blocked: `ports.json` entries 2 → 2 |

Static checks, all blocked:

- The signing key isn't served (404).
- The loader can't be framed (`frame-ancestors`).
- The bootstrap opened as a tab gets 403.
- Requests with a foreign `Host` get 421 on `/packages/…`, `/__pwx/mode` and `/__pwx/origin`.

## Stage 1 fixes (`03b3b65`)

Stage 1 closed every exploit except C3.

| Area | Fix | ID |
| --- | --- | --- |
| Bootstrap hijack | The bootstrap works only inside a frame. Instructions arrive only on a `MessageChannel` port the parent hands over, and nothing is read from the URL. Framed-only paths return 403 to top-level navigations. Servers check `Sec-Fetch-Dest`. Loaders send `frame-ancestors 'none'`. | |
| Runtime poisoning | The app-origin service worker serves a runtime file only if it matches a hash pinned at build time (`tools/pin-runtime.mjs`), with fixed response headers. A mismatch returns 503. | |
| Test switches | Switches come only from `loader/config.mjs` (`TEST=false`). Only the test server serves `TEST=true`, under `PWX_TEST=1`, so no link can turn protections off. | |
| pwx-local | `Host` check (421). `/__pwx/origin` requires POST and same-origin. At most 256 apps. | |
| Manifest hosts | `network.connect` rejects IP literals, `localhost` and private-use names (`.local`, `.lan`, `.internal`, `.home.arpa`, `.localhost`). | M2 |
| Parser | The strict JSON parser limits nesting to 64 levels and input to 64 MiB, and fails cleanly. | L1 |
| Versions | Each version part is limited to 9 digits. | L2 |
| Packer | The packer never ships the manifest template or hidden files. | L4 |
| Install | A consent screen with the publisher fingerprint appears before every install. Swapping a package for a different one with the same version is rejected. | |

## Stage 2 fixes (`25b2621`): C3

**C3:** in hosted mode every app shared one origin. A second app could read Notes' IndexedDB and
rewrite the shared runtime cache. It's fixed in layers, so layer 1 or layer 3 alone would stop it.

1. **Opaque-origin app worker.** The renderer reads the verified entry from the `pwx-verified`
   cache and starts it as `new Worker(data:…)`, with an inline `PwxUI` prelude ahead of the app
   code. A `data:` worker's origin is `null`. The Strict CSP changed from `worker-src 'self'` to
   `worker-src data:`.
2. **Storage capability.** Apps store data through `PwxUI.store.get/put/del/all`. The renderer
   serves these from IndexedDB `pwx-app-store` / `kv` on the app's own origin. Notes now uses it.
3. **Per-app hosted origins.** Ports 8110–8129 stand in for per-app subdomains, and port 8101 is
   gone. The loader picks an origin by FNV-1a(id) mod 20 with linear probing, stores it in the
   library record and keeps it across updates. The loader's `frame-src` lists all 20 origins.

### Evidence: what the thief app can reach

The audit's thief app displayed "(app produced no output)". A crash would look the same, so a
diagnostic copy reported each step. It proves the thief ran and was denied everything:

| Step | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| `self.origin` | `null` | `null` | `null` |
| IndexedDB (`pwx-notes`, `pwx-app-store`) | SecurityError | SecurityError | SecurityError |
| CacheStorage write | SecurityError (no `caches`) | NS_ERROR_FAILURE | TypeError (isolated, empty store) |
| `fetch` to the canary | blocked by CSP | blocked by CSP | blocked by CSP |
| `RTCPeerConnection` | undefined | undefined | undefined |

## Test results after Stage 2

| Suite | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Unit tests (`verify.test.mjs`, Node) | 46/46 | | |
| Strict leak test | pass | pass | pass |
| Notes | 7/7 | 7/7 | 7/7 |
| Offline | 6/6 | 6/6 | 5/6 (known, see Open) |
| Local (pwx-local) | 6/6 | 6/6 | 6/6 |

Leak matrix (`tests/run_matrix.sh`, Standard runtime, 36 vectors), shown as blocked / leaked. It's
the same before and after Stage 2:

| Config | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| baseline | 31 / 2 | 30 / 2 | 30 / 4 |
| `--guard` | 32 / 1 | 31 / 1 | 32 / 2 |
| `--hardened` | 33 / **0** | 32 / **0** | no switches |
| `--guard --hardened` | 33 / **0** | 32 / **0** | no switches |

The baseline leaks are WebRTC (`webrtc-stun`, `webrtc-fresh-realm`) in every engine, plus link
preconnect in WebKit. WebKit has no hardening switches, so the test side can't close them. The 2–4
untested vectors per engine didn't leak in the unprotected control run either, so they prove
nothing either way.

## Open

| ID | Status | Notes |
| --- | --- | --- |
| **N1** (new) | Open. Found by code review; no exploit written yet. | **Data outlives Remove.** Removing an app deletes only its library record. Its origin goes back into the pool, but the origin's `pwx-app-store` data stays. The next app given that origin can read it with `PwxUI.store.all()`. In hosted mode that can be any app; in both modes, a later app with the same id from any publisher. Fix: wipe the origin's storage on Remove through the bootstrap port, bind each origin to id plus publisher, and add a harness exploit. |
| M4 | Open | Spec features not built yet. The details are in the first audit report. |
| M6 | Open | The details are in the first audit report. |
| L3 | Open | The details are in the first audit report. |
| WebKit offline | Open | In hosted mode, opening an installed app still requests `sw.js` for the app and the loader. Only WebKit does this (offline test 5/6). |
| WebKit leaks | Browser limit | WebRTC and link preconnect leak in WebKit, and it has no switch to stop them. Strict apps aren't affected: they have no DOM and no `RTCPeerConnection`. |
| Notes migration | Accepted for the spike | Notes saved in the old `pwx-notes` database aren't moved to `pwx-app-store`. |

One more thing needs a decision: every Strict app gets `PwxUI.store`, whatever its manifest says
under `capabilities.storage`. The store only reaches the app's own origin, so it can't leak, but
the spec says apps get only the capabilities they declare.

## How to rerun

```bash
cd spike
node tools/pin-runtime.mjs && node tools/build-packages.mjs && node tools/make-release.mjs
node <audit>/build.mjs           # rebuild the audit apps
bash <audit>/run.sh              # every exploit must print "blocked": 0 of 10 per engine
bash tests/run_all.sh            # unit, strict, notes, offline, local, leak matrix
```

- Firefox needs `media.peerconnection.ice.loopback=True` for the WebRTC tests.
- The attacker site is `https://127.0.0.2:9443`. Chromium needs
  `--ip-address-space-overrides=127.0.0.2:9443=public`.
- The audit harness (attack apps and exploit scripts) isn't in this repo.
