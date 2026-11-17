# PWX handover

For the next person (or chat) picking up PWX. Last updated 2026-11-16, at spike release **0.4.1**.
Read [`../README.md`](../README.md) for what PWX is, [`SPEC.md`](SPEC.md) for how it works and
[`AUDIT.md`](AUDIT.md) for the security record. This file covers where things are, how to work on
them, and what's next.

## Where things stand

- **Stage:** early design, with a working, security-audited spike. Not ready for production.
- **Security audit:** 0 of 10 exploits work in Chromium 159, Firefox 159 and WebKit 27.2.
- **Tests:** all suites pass in all three engines (47 unit tests). The leak matrix is unchanged:
  without the extra protections, the Standard runtime leaks WebRTC in every engine, plus link
  preconnect in WebKit, which has no switch to stop either. That's a browser limit (see AUDIT.md).
- **Main open item:** M4. The transparency log, revocation, key rotation with a waiting period,
  and update policies aren't built. Until they are, a publisher whose key is stolen can't be stopped.

## Where everything lives

| What | Where |
| --- | --- |
| Code, spec, audit, tests | branch `spike` (all active work) |
| Project overview, LICENSE, NOTICE, SECURITY.md, CI | branch `main` (also on `spike`) |
| Working copy | VPS: `~/PWX`, checked out on `spike`, clean |
| Signing keys | VPS only: `~/.config/pwx-dev/dev-key.json` and `release-key.json` (never in the repo) |
| Python venv with Playwright and browsers | VPS: `~/PWX/spike/.venv` (gitignored) |
| Old copies, to delete by hand | VPS: `~/_to_delete/pwx-spike`, plus `~/pwx-audit` (now in `spike/audit/`) |
| Prometheus | nothing PWX-related |

Browser tests and anything that signs must run on the VPS: it has the browsers and the keys.

## How to work on it

All commands run from `spike/` on the VPS.

```bash
node --test tests/verify.test.mjs   # unit tests (any machine with Node)
bash tests/run_all.sh                # every suite, all engines (~25 min; the matrix is slowest)
bash audit/run.sh                    # security audit: every exploit must print "blocked"
../safeaudit.sh ..                   # static scan, same as CI
```

### Changing the runtime or loader: re-pin and re-sign

Files in `app-origin/`, `loader/` and `lib/` are pinned by hash and covered by the signed release.
After changing any of them:

```bash
echo 0.4.2 > VERSION                 # bump the release version
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

## Recent work (Nov 15–16, 2026)

| PR | Change |
| --- | --- |
| #1 | safeaudit CI on `main`, with its self-scan fix |
| #2, #3 | Apache-2.0 LICENSE, NOTICE with copyright, README purpose and about sections |
| #4, #5 | Audit setup moved into `spike/audit/`, SECURITY.md, CI on `spike` |
| #6 | Strict apps get `PwxUI.store` only when the manifest declares storage (release 0.4.1) |
| #7 | Offline test on a saved profile; the WebKit `sw.js` item was a test-setup artifact |

## Waiting on Altru

1. **Back up the signing keys.** On the VPS, choosing your own passphrase:
   `tar -C ~/.config -c pwx-dev | gpg -c --cipher-algo AES256 -o ~/pwx-keys.tar.gpg`.
   Copy the file to Prometheus and a USB stick, then delete it from the VPS. Restore with
   `gpg -d pwx-keys.tar.gpg | tar -x -C ~/.config`.
2. **Turn on private vulnerability reporting:** repo Settings → Security → Private vulnerability
   reporting → Enable. SECURITY.md tells people to use it.
3. **Delete the old copies** on the VPS: `~/_to_delete/pwx-spike` and `~/pwx-audit`.
4. **Delete merged branches** on GitHub: `audit/harness-and-ci`, `chore/safeaudit-ci`,
   `chore/spike-security`, `docs/license-about`, `docs/license-about-spike`,
   `docs/security-main`, `fix/storage-cap`, `fix/webkit-offline`.

## What's next

1. **M4 design, before any code.** Write a short design for approval covering:
   - a transparency log every release must appear in
   - revocation of a compromised key or a bad release
   - key rotation with a waiting period, so a stolen key can't instantly replace the real one
   - update policies (who may publish an update, how loaders check)
2. **Package format.** Keep the PWX manifest and signature as the standard. Later, move the
   container from base64 JSON to a compact binary format that can be read in parts (no 33% size
   overhead, no 64 MB limit). Optionally export a Signed Web Bundle for Chrome once Isolated Web
   Apps can be installed by anyone. Signed Web Bundles are Chrome-only, and Google controls an
   allowlist for managed installs.
3. **Production hosting:** a real subdomain per app instead of the local ports the spike uses.
4. **Not implemented yet:** `storage.persistent`, storage limits for Standard apps, and the
   `files`, `clipboard` and `sync` capabilities (validated only).
5. Merge `spike` into `main` once M4 is designed and the spec is stable.
