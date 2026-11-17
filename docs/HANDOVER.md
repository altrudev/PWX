# PWX handover

For the next person (or chat) picking up PWX. Last updated 2026-11-17, at spike release **0.4.2**.
Read [`../README.md`](../README.md) for what PWX is, [`SPEC.md`](SPEC.md) for how it works and
[`AUDIT.md`](AUDIT.md) for the security record, [`VISION.md`](VISION.md) for where PWX is going,
[`M4.md`](M4.md) for the approved signing and log design, [`SIGNER-SPIKE.md`](SIGNER-SPIKE.md) for
its first spike, and [`QUARANTINE.md`](QUARANTINE.md) for the proposal still awaiting a decision. This file covers where things are, how to work on
them, and what's next.

## Where things stand

- **Stage:** early design, with a working, security-audited spike. Not ready for production.
- **Security audit:** 0 of 10 exploits work in Chromium 159, Firefox 159 and WebKit 27.2.
- **Tests:** all suites pass in all three engines (47 unit tests); the PWX Guard extension spike passes in Chromium. The leak matrix is unchanged:
  without the extra protections, the Standard runtime leaks WebRTC in every engine, plus link
  preconnect in WebKit, which has no switch to stop either. That's a browser limit (see AUDIT.md).
- **Hosted tier, honestly:** a compromised host can still swap a service worker. The loader locks
  down, app origins accept only genuine packages, and erasing needs the user's click. A swapped
  *app-origin* worker can still read that app's data. The PWX Guard extension blocks a swapped
  loader worker, in Chromium only. `pwx-local` has none of these gaps.
- **Direction (decided 2026-11-16, [`VISION.md`](VISION.md)):** PWX is an open, signed app format
  and runtime that runs on everything, not a builder or a store. Hosted is the front door.
- **M4 (approved design, [`M4.md`](M4.md)):** stop stolen keys with device keys and two-device
  approval, then a witnessed public log, receipts, revocation, automatic key rotation and update
  policies. **Built so far:** the Signer spike only. Until the log exists, a publisher whose key
  is stolen still can't be stopped in the shipped loader.
- **Signer spike ([`SIGNER-SPIKE.md`](SIGNER-SPIKE.md), `spike/signer/`):** passphrase-locked
  browser keys, ECDSA P-256 format for hardware keys, two-device approval; 20/20 in all three
  engines, and a copied browser profile can't sign. Not built: chip access in `pwx-local` /
  ALTRU OS (the VPS has no TPM). Not used by the loader yet.

## Where everything lives

| What | Where |
| --- | --- |
| Code, spec, audit, tests | branch `spike` (all active work) |
| Project overview, LICENSE, NOTICE, SECURITY.md, CI | branch `main` (also on `spike`) |
| Working copy | VPS: `~/PWX`, checked out on `spike`, clean |
| Signing keys | VPS only: `~/.config/pwx-dev/dev-key.json` and `release-key.json` (never in the repo) |
| Python venv with Playwright and browsers | VPS: `~/PWX/spike/.venv` (gitignored) |
| Prometheus | nothing PWX-related |

Browser tests and anything that signs must run on the VPS: it has the browsers and the keys.

## How to work on it

All commands run from `spike/` on the VPS.

```bash
node --test tests/verify.test.mjs   # unit tests (any machine with Node)
bash tests/run_all.sh                # every suite, all engines (~25 min; the matrix is slowest)
bash audit/run.sh                    # security audit: every exploit must print "blocked"
bash tests/run_signer.sh             # Signer spike: two-device approval + copied-profile probe
../safeaudit.sh ..                   # static scan, same as CI
```

### Changing the runtime or loader: re-pin and re-sign

Files in `app-origin/`, `loader/` and `lib/` are pinned by hash and covered by the signed release.
After changing any of them:

```bash
echo 0.4.3 > VERSION                 # bump the release version
node tools/pin-runtime.mjs           # re-pins runtime hashes in app-origin/sw.js and the release key
node tools/build-packages.mjs        # rebuilds the test packages
node tools/make-release.mjs          # signs local/release.json with the release key
```

Commit `VERSION`, `app-origin/sw.js` and `local/release.json` together with the change. Docs,
tests and `package.json` aren't pinned, so they can change freely.

### Git and GitHub

- Work on a branch, open a PR into `spike` (or `main` for overview docs), and wait for the
  `audit` CI check (safeaudit) to pass before merging.
- Commits made on the VPS use the identity `Altru.dev`
  `<266135212+altrudev@users.noreply.github.com>`.
- The VPS can push to GitHub. Force-pushes and branch deletions were refused in the last
  session, so add new commits rather than rewriting history.

## Gotchas

- **Use saved browser profiles in tests that measure network traffic.** Playwright's temporary
  WebKit profile doesn't keep scripts in its HTTP cache and ignores `updateViaCache`, which looked
  like a WebKit leak until 0.4.1. `tests/offline_test.py` uses `launch_persistent_context`.
- **The once-a-day update check is real** in every browser: the host can see which apps were opened
  that day (one `sw.js` request per origin). It's accepted and recorded in AUDIT.md. The Verified
  tier (`pwx-local`) avoids it.
- **safeaudit skips its own files** (`safeaudit.sh`, `CHECKS.md`); otherwise it reports its own
  patterns. Run it on a clean checkout: untracked files on the VPS (the venv, generated test
  certificate) produce HIGH findings that CI never sees.
- **The audit's test HTTPS certificate** (`audit/attacker/key.pem`) is generated on first run and
  gitignored. Never commit it.
- **Strict apps get storage only when declared** (`"storage": { "local": true }`, since 0.4.1).
  Test apps that need storage must declare it.

## Recent work (Nov 15–17, 2026)

| PR | Change |
| --- | --- |
| #1 | safeaudit CI on `main`, with its self-scan fix |
| #2, #3 | Apache-2.0 LICENSE, NOTICE with copyright, README purpose and about sections |
| #4, #5 | Audit setup moved into `spike/audit/`, SECURITY.md, CI on `spike` |
| #6 | Strict apps get `PwxUI.store` only when the manifest declares storage (release 0.4.1) |
| #7 | Offline test on a saved profile; the WebKit `sw.js` item was a test-setup artifact |
| #9 | Erasing an app needs the user's click on the app's own origin (release 0.4.2); PWX Guard extension spike (`spike/extension/`, Chromium) |
| #10 | `QUARANTINE.md`: proposal for quarantine without an extension, in every browser; this handover |
| #11 | `VISION.md`: what PWX is for; ownership, earned results, opening .pwx files |
| #12 | `M4.md`: approved design for the log, revocation, rotation, update policies and the PWX Signer |
| #13 | Signer spike: two-device approval, passphrase-locked keys, hardware key format (`SIGNER-SPIKE.md`) |

## Waiting on Altru

1. **Back up the signing keys.** On the VPS, choosing your own passphrase:
   `tar -C ~/.config -c pwx-dev | gpg -c --cipher-algo AES256 -o ~/pwx-keys.tar.gpg`.
   Copy the file to Prometheus and a USB stick, then delete it from the VPS. Restore with
   `gpg -d pwx-keys.tar.gpg | tar -x -C ~/.config`.
2. **Turn on private vulnerability reporting:** repo Settings → Security → Private vulnerability
   reporting → Enable. SECURITY.md tells people to use it.

Done on 2026-11-16: the old VPS copies (`~/_to_delete/pwx-spike`, `~/pwx-audit`) and the merged
GitHub branches are deleted.

## What's next

Decided on 2026-11-16: the vision ([`VISION.md`](VISION.md)), the M4 design with its decisions
([`M4.md`](M4.md), end of file), and option 3 for signing keys ([`SIGNER-SPIKE.md`](SIGNER-SPIKE.md)).
QUARANTINE.md is still awaiting Altru's approval: ask before building any of it.

1. **M4 log spike (started 2026-11-17).** A tiled, append-only log on the VPS with two witnesses,
   receipts inside packages, and the loader checking them. Tests from M4.md: a release missing
   from the log, a forged receipt, a split view, a revoked release, a rotation inside the waiting
   period, a recovery-key cancel.
2. **Hardware keys:** a small native helper for `pwx-local` (TPM on Windows/Linux, Secure Enclave
   on macOS) and ALTRU OS (Android Keystore), signing ECDSA P-256 approvals in the Signer spike's
   format. Must be tested on real machines (Prometheus, a Mac, an Android phone), not the VPS.
3. **PWX Signer app:** turn the spike into the real screen: pairing by QR code, approval card,
   alerts from the log, one-tap revoke. Simple on the surface.
4. **Then wire it in:** loaders require two-device approvals and a log receipt (soft mode first,
   then required), as in M4.md's rollout.
5. **QUARANTINE.md**, once Altru decides. Part 1 must keep push, background sync and offline work
   possible as capabilities of the shell (VISION.md). The Signer would live on the same origin.
6. **VISION.md design items** after the log: lineage and blessings, licenses and ownership
   transfers, earned credentials, the packer web page, the self-opening .pwx, the iPhone install
   guide.
7. **Smaller items:** PWX Guard extension (only if still wanted after QUARANTINE.md); erase
   confirmation in Firefox and WebKit; binary package format; `storage.persistent`, Standard-app
   storage limits, and the `files`, `clipboard` and `sync` capabilities (validated only).
8. Merge `spike` into `main` once the M4 log works and the spec is stable.

## Side thread, not PWX work

Altru built an email and bookings PWA and reports that an in-app button installed it on a
friend's iPhone with one confirmation. Public sources say Safari has no install prompt, so the
mechanism is unknown. `mindgrowthvalley.com` is the public site only (no manifest, no service
worker); the app's address or code hasn't been shared. If it turns out to be a real one-tap
iPhone install, it matters for PWX's hosted tier on iOS.
