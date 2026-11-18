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

**Where it's going:** apps anyone can make, share, update and branch, that run on everything,
and where you always know who made them and what they can do. See [`docs/VISION.md`](docs/VISION.md).

**Live demo:** [pwx.altru.dev](https://pwx.altru.dev): install the Notes app and see what it's
allowed to do. An early demo; please don't keep important data there.

## Status

Early design, with a working, security-audited spike (spike release **0.4.8**). On this branch (`spike`):

- [`docs/SPEC.md`](docs/SPEC.md): **PWX Specification v0 (Draft)**, as built
- [`docs/AUDIT.md`](docs/AUDIT.md): security audit, fixes and cross-browser results
- [`docs/VISION.md`](docs/VISION.md): what PWX is for, and the design items that follow from it
- [`docs/M4.md`](docs/M4.md): approved design for stopping stolen keys: device keys with two-device approval, a witnessed public log, revocation and key rotation
- [`docs/SIGNER-SPIKE.md`](docs/SIGNER-SPIKE.md) and [`docs/LOG-SPIKE.md`](docs/LOG-SPIKE.md): the first prototypes of that design
- [`docs/HANDOVER.md`](docs/HANDOVER.md): where the project stands and how to work on it
- [`spike/`](spike/): verifier, packer, hosted loader, local Verified-tier loader (`pwx-local`), Strict runtime, a Notes app and the test suites

Every exploit from the audit is blocked in Chromium, Firefox and WebKit. The Signer and the public
log work as prototypes, but the loader doesn't require them yet, so a stolen publisher key still
can't be stopped. PWX is not ready for production use.

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

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md). Before your first pull
request, read and accept the [Contributor License Agreement](CLA.md): you keep the copyright in
your work, and you give the project a license to use it.

## License

Copyright 2026 Valentyn Rukhaylo (Altru), ALTRU.dev.

Licensed under the [Apache License, Version 2.0](LICENSE). You may use, modify and distribute
PWX, including commercially, as long as you keep the copyright and license notices (see
[`NOTICE`](NOTICE)). The license also grants a patent license from contributors, and it comes
with no warranty.

**Trademarks:** "PWX", "Progressive Web eXecutable", "ALTRU.dev" and "ALTRU", and their logos, are
not licensed under Apache-2.0. Forks are welcome, but must use a different name and must not
present themselves as official PWX releases. Official releases are the ones signed with the PWX
release key.
