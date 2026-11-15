# Security policy

PWX exists to make apps provably limited, so security reports are especially welcome.

## Reporting a vulnerability

Please report vulnerabilities **privately**, not in a public issue:

1. Open the repository's **Security** tab on GitHub.
2. Click **Report a vulnerability** and describe the problem, how to reproduce it, and which
   browser engines it affects.

You'll get a reply as soon as possible. This is a one-person project, so allow a few days. Please
give a reasonable time for a fix before publishing details.

## What's in scope

- The verifier (`spike/lib/pwx-verify.mjs`), the packer and the signed release tools
- The hosted loader, the local Verified-tier loader (`pwx-local`) and the app-origin runtime
- Any way an app can reach a host it didn't declare, read another app's data, or run code that
  wasn't signed
- The specification itself (`docs/SPEC.md`), where a design flaw breaks a stated guarantee

## Supported versions

PWX is an early prototype. Only the latest commit on the `spike` branch is supported. It is not
ready for production use.

## Known limits

The current audit, its fixes and the risks that are still open are in
[`docs/AUDIT.md`](docs/AUDIT.md). In short: the transparency log, revocation and key rotation
aren't built yet (M4), a compromised web host can still take over the hosted loader (use the
Verified tier), and WebKit can't stop WebRTC and link-preconnect leaks for Standard apps.
