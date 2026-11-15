# PWX: Progressive Web eXecutable

PWX is a signed, self-contained web app package that runs in any modern browser and can
only do what its manifest declares. Anyone can verify the code, and the runtime enforces
the declared limits instead of relying on the publisher's promise.

## Purpose

Today, using an app means trusting whoever made it. An app's privacy policy says where your
data goes, but nothing stops the app from sending it somewhere else, changing after you install
it, or disappearing along with your data.

PWX moves that trust from the publisher to something you can check:

- **Signed and verifiable.** Every file in a package is hashed and signed by the publisher. A
  changed byte, an extra file or a quietly widened permission is rejected before the app runs.
- **Limited by its manifest.** The app declares up front which hosts it may contact and what it
  may store. The runtime enforces that list, so an app can't send your data to a host it didn't
  declare.
- **Offline and yours.** Installed apps run with no network, make no calls home, and keep their
  data on your device.

The goals are privacy, no data loss, and users who own their data.

## Status

Early design, with a working, security-audited spike (spike release 0.4.0). On the
[`spike`](https://github.com/altrudev/PWX/tree/spike) branch:

- [`docs/SPEC.md`](https://github.com/altrudev/PWX/blob/spike/docs/SPEC.md): **PWX Specification v0 (Draft)**, as built
- [`docs/AUDIT.md`](https://github.com/altrudev/PWX/blob/spike/docs/AUDIT.md): security audit, fixes and cross-browser results
- [`spike/`](https://github.com/altrudev/PWX/tree/spike/spike): verifier, packer, hosted loader, local Verified-tier loader (`pwx-local`), Strict runtime, a Notes app and the test suites

Every exploit from the audit is blocked in Chromium, Firefox and WebKit. Not built yet: the
transparency log, revocation, key rotation, sync and device pairing (audit item M4). PWX is not
ready for production use.

## Branches

| Branch | Contents |
| --- | --- |
| `main` | Project overview; the spec and stable code land here |
| `spike` | Working spike: verifier, packer, loaders, runtimes, spec, audit and cross-browser tests |

## About

PWX is built by **Valentyn Rukhaylo (Altru)**, an independent developer in Victoria, British
Columbia, working under the name [ALTRU.dev](https://altru.dev): *Code for Humanity*.

ALTRU.dev makes privacy-first, local-first software: free tools for people who need them, and
productivity apps that keep your data on your own devices. PWX comes from the same idea: you
shouldn't have to take an app's word for what it does with your data.

## License

Copyright 2026 Valentyn Rukhaylo (Altru), ALTRU.dev.

Licensed under the [Apache License, Version 2.0](LICENSE). You may use, modify and distribute
PWX, including commercially, as long as you keep the copyright and license notices (see
[`NOTICE`](NOTICE)). The license also grants a patent license from contributors, and it comes
with no warranty.
