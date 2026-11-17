# PWX security audit: findings, fixes and results

**Status (2026-11-15):** every working exploit from the audit is blocked in Chromium, Firefox and
WebKit, including C3. L3 (an app's data outlived Remove) is fixed. M6 (the hosted loader was never
checked or updated) is fixed as far as a web host allows; what remains is a browser limit, below.
M4 remains open (see [Open](#open)).

| | |
| --- | --- |
| Code | branch `spike`: `03b3b65` (Stage 1), `25b2621` (Stage 2), `20b1797` (L3), `38b6769` (M6), host-compromise layers (this commit) |
| Engines | Chromium 159.0.8154.6, Firefox 159.0, WebKit 27.2 (Playwright, headless) |
| Harness | [`spike/audit/`](../spike/audit/): `run.sh` runs static checks, then `exploits.py` in each engine |
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

## L3 fix: data outlives Remove

**L3:** removing an app deleted only its library record. Its origin went back into the pool, but
the origin's data stayed. The next app given that origin could read it with `PwxUI.store.all()`:
in hosted mode any app, and in both modes a later app with the same id from any publisher.

**Fix:** Remove now wipes the app's origin before forgetting the app. The loader opens the origin's
bootstrap on the same `MessageChannel` it uses for installs and sends `wipe`. The bootstrap deletes
every IndexedDB database on the origin (`indexedDB.databases()`, plus `pwx-app-store`), every cache,
and `localStorage` / `sessionStorage`. Only after it answers `wiped` does the loader delete the
library record. If the wipe fails, for example because another tab still has the app open, the app
stays installed and the loader says so. An origin is never handed out with data still in it. Only
the loader can send `wipe`, because only the loader can frame the bootstrap.

**Proof:** the Notes test now removes Notes, reinstalls it, checks it got the same origin, and
checks no notes came back. With the wipe switched off, that test fails in all three engines
(Chromium shows the old notes), which also reproduces L3. With the fix, it passes in all three.

## M6 fix: the hosted loader is checked and updated only from signed releases

**M6:** the hosted loader's service worker cached the loader once and served it forever, with no
integrity check and no update path. A single compromise of the host persisted, and fixes never
arrived.

**Fix, in three layers:**

1. **Signed release, checked on every serve.** The loader ships as a release signed with the PWX
   release key (`tools/make-release.mjs`, the same signed release `pwx-local` checks itself
   against, served as `/loader-release.json`). The loader's service worker carries only that
   public key, pinned by `tools/pin-runtime.mjs`. On first install it verifies the release and
   every loader file against it. Then, each time it serves a loader file, it re-checks the file
   against the stored release, and re-verifies the release's signature on every launch. A
   changed cache entry is replaced from the host only if the host's copy matches; otherwise the
   loader refuses to start (HTTP 503) and nothing runs.
2. **Explicit, rollback-proof updates.** The loader never checks for updates on its own, so it
   still makes no calls home. The user clicks *Check for loader update*. The service worker
   accepts only a correctly signed release with a higher version, refuses an older one or the
   same version with different contents, downloads every file, checks each one, and only then
   switches versions in one step. A release with one bad file is refused whole.
3. **Warning when the host changes `sw.js`.** The browser re-fetches `sw.js` from the host by
   itself and no page code can stop that. When it brings a new one, the loader page compares it
   with the `sw.js` hash in the current and the newest signed release. If neither matches, the
   loader shows a warning that the host may be compromised.

**What remains (browser limit):** a host that serves a malicious `sw.js` still takes over the
hosted loader, because the browser installs it; and the layer-3 check is advisory, because a
hostile host can serve the check a different copy than the browser. That's inherent to loading
code from a web host. The Verified tier (`pwx-local`) removes the host from the picture: its
signed release self-check stops it from starting if any file changed.

**Proof:** `tests/loader_update_test.py` plays a hostile host, 13 checks, passing in Chromium,
Firefox and WebKit:

| Attack | Result |
| --- | --- |
| Poison the cached `loader.mjs` | not run; replaced with the signed copy from the host |
| Poison the cache and have the host serve a tampered `loader.mjs` | refused with 503; nothing runs; recovers once the host serves the signed file |
| Offer the same release | "up to date" |
| Offer an older signed release | refused |
| Offer the same version with different contents | refused |
| Offer a release signed with another key | refused (signature invalid) |
| Offer a newer signed release with one wrong file | refused whole; still on the old version |
| Offer a newer signed release | applied, only after the user clicks Update |
| Change `sw.js` with no matching signed release | warning shown |
| Change `sw.js` along with a matching signed release | no warning; update offered |

## Surviving a compromised host (hosted tier)

M6 left one thing a web page can't prevent: the browser itself fetches the loader's `sw.js` from
the host and installs it. Neither the page nor the current worker can veto that, a new worker
can activate at once and discard the old one, and unregistering it only hands the next page load
to the same host. So the hosted tier can't block or quarantine a replaced worker. Two layers now
limit what a replaced loader can do:

1. **Lockdown.** When a swap happens, the verified loader page is still running: the browser
   loads it from the old worker first, then checks for a new one. If the new `sw.js` matches no
   signed release, the page locks: it hides the library, removes its bootstrap frames, disables
   every control, refuses to open, install, update or remove anything, and tells the user to
   close the tab and not reopen the loader. This holds for that page only; the next page load
   comes from the replaced worker.
2. **App origins don't trust the loader.** The bootstrap used to accept files and headers from
   the loader as given. Now the loader hands over the signed package, and the app origin verifies
   the signature and every file hash itself (`/__pwx/verify.mjs`, pinned by hash in the app
   origin's service worker), computes the CSP itself, and keeps its own pin: app id, publisher
   key, version and manifest hash. It refuses raw files, another publisher's signature, a changed
   file, an older version, a same-version swap, and any other app's package. Test switches are
   honoured only if the origin's own service worker says it's a test build. So a replaced loader
   can only install a genuine package from the app's own publisher, and a genuine Strict app
   can't send data anywhere.

**Proof:** `tests/bootstrap_trust_test.py` runs script on the loader's own origin (what a
replaced loader would be) against the Notes origin: 6 pushes refused, Notes and its note intact,
and a genuine newer version accepted; 9/9 in each engine. `tests/loader_update_test.py` now also
checks the lockdown (15 checks).

3. **Erasing needs the user's own click on the app's origin** (0.4.2). A replaced loader could
   ask an app origin to wipe itself. Now a wipe request only makes the app origin show its own
   box ("Erase Notes and all its data from this device?"), in a frame the loader can't script or
   click. Only the user's click there erases anything; "Keep it" cancels. The Erase button stays
   off for a second, and in Chromium a click is ignored while the box is covered or see-through
   (IntersectionObserver v2); Chromium also drops clicks on a cross-origin frame that has just
   appeared. Proof: a wipe pushed by script on the loader origin, with no click, erases nothing
   (`bootstrap_trust_test.py`, 10/10 in each engine), and the Notes test covers Keep and Erase
   (10/10 in each engine). Limit: Firefox and WebKit can't tell whether the box is covered, so
   there the delay and the plain wording are the only defence against a tricked click.

### PWX Guard: a browser-extension spike (Chromium)

**Question:** can something outside the host stop a swapped service worker, and keep the old
verified one? **Answer: yes, in Chromium.** `spike/extension/` is a small extension that:

- blocks the loader's `sw.js` by default (a `declarativeNetRequest` rule),
- fetches `sw.js` and the signed loader release itself, checks the signature against the pinned
  PWX release key, checks the `sw.js` hash against the release, and refuses older releases,
- lets the browser fetch `sw.js` for 5 seconds only after that check passes.

`tests/guard_ext_test.py`, 10/10 in Chromium 159:

| Case | Without the extension | With the extension |
| --- | --- | --- |
| Host serves an unsigned `sw.js` | installed; the page can only lock down | update fetch blocked; no new worker; the old verified worker keeps serving the loader |
| Host serves a newer signed `sw.js` | installed | verified, then let through |
| Host goes back to an older signed release | not detected by the browser | refused by the extension |

**Limits of the spike:**

- **A timing gap remains.** The extension can't see the exact bytes the browser receives. A host
  that gives the extension a good copy and the browser a bad one inside the 5-second window
  still gets through. Firefox extensions can read and replace response bodies, which would close
  this; that is not tested yet.
- **Loader only.** App origins' `sw.js` isn't covered yet, because servers substitute the loader
  origin into it, so its bytes don't match the release hash. Making that file byte-stable is the
  next step, and it is what protects app data from a compromised host.
- **Chromium only, loaded unpacked.** No Firefox or Safari version, no store listing, and the
  watched origins are fixed in `config.json`.

**Still open in the hosted tier:** without the extension, a fully compromised host can replace
the app origins' own service workers and read app data directly. `pwx-local` has no such gap.

## Test results after Stage 2

| Suite | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Unit tests (`verify.test.mjs`, Node) | 47/47 (0.4.1) | | |
| Strict leak test | pass | pass | pass |
| Notes (includes the L3 and erase-confirmation tests) | 10/10 | 10/10 | 10/10 |
| Offline (saved profile, since 0.4.1) | 6/6 | 6/6 | 6/6 |
| Local (pwx-local) | 6/6 | 6/6 | 6/6 |
| Loader integrity, updates and lockdown (M6) | 15/15 | 15/15 | 15/15 |
| App origin refuses a hijacked loader (installs and wipe) | 10/10 | 10/10 | 10/10 |
| PWX Guard extension spike | 10/10 | not built | not built |

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
| M4 | Open | Protections in the spec aren't built yet: transparency log with witnessed checkpoints, revocation, the key-rotation waiting period, the `sync` capability, device pairing and update policies. Until they are, the threat-table rows that depend on them don't hold. |
| M6 residue | Browser limit, reduced | A host that serves a malicious `sw.js` still takes over the hosted loader. The running page locks down, app origins accept only genuine packages from the app's own publisher, and erasing needs the user's click on the app's origin. Still possible without the extension: replacing the app origins' own workers. The PWX Guard spike blocks a swapped loader worker in Chromium. See "Surviving a compromised host". |
| WebKit offline | Resolved: test setup | The `sw.js` requests came from Playwright's temporary WebKit profile, whose HTTP cache doesn't keep scripts between visits, so it ignored `updateViaCache: "all"`. With a saved profile, like real Safari uses, WebKit answers the check from its cache and sends nothing (offline test 6/6 in all engines). A probe showed the same for a plain page outside PWX. |
| Daily update check | Accepted | In every browser, the service worker spec makes the update check skip the cache once it's more than 24 hours old. So the host can see one `sw.js` request a day per origin, telling it that PWX was opened that day, not which app or what it did. It's how loader security updates arrive, and those are signed. Users who don't want even that should use the Verified tier (`pwx-local`). |
| WebKit leaks | Browser limit | WebRTC and link preconnect leak in WebKit, and it has no switch to stop them. Strict apps aren't affected: they have no DOM and no `RTCPeerConnection`. |
| Notes migration | Accepted for the spike | Notes saved in the old `pwx-notes` database aren't moved to `pwx-app-store`. |

**Resolved (spike 0.4.1):** Strict apps used to get `PwxUI.store` whatever their manifest said.
Now the store is granted only when the manifest declares `storage.local` (SPEC 6.3). The Strict
test checks that an app without it gets no `PwxUI.store` and that a store request sent by hand is
refused.

## How to rerun

```bash
cd spike
node tools/pin-runtime.mjs && node tools/build-packages.mjs && node tools/make-release.mjs
bash audit/run.sh                # rebuilds the attack apps; every exploit must print "blocked": 0 of 10 per engine
bash tests/run_all.sh            # unit, strict, notes, offline, local, leak matrix
```

- Firefox needs `media.peerconnection.ice.loopback=True` for the WebRTC tests.
- The attacker site is `https://127.0.0.2:9443`. Chromium needs
  `--ip-address-space-overrides=127.0.0.2:9443=public`.
- The audit harness (attack apps and exploit scripts) is in `spike/audit/`. `build.mjs` signs the
  attack app with your dev key from `~/.config/pwx-dev/dev-key.json`, like any publisher could.
