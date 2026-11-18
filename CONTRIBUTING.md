# Contributing to PWX

Thanks for looking. PWX is an open, signed app format: apps anyone can make, share, update and
branch, that run on everything, and where you always know who made them and what they can do.
See [`docs/VISION.md`](docs/VISION.md) for the why and the live demo at
[pwx.altru.dev](https://pwx.altru.dev) for what works today.

It's early. The most useful things right now are people who try to break it, people who build
small apps on it, and people who help with the pieces listed under "Good first issues".

## Before your first pull request

**Read and accept the [Contributor License Agreement](CLA.md).** You keep the copyright in your
work. You give the project a license to use it, including under other license terms in the
future (CLA sections 2 and 7). Every pull request has an agreement box in its description: tick
it, or the `contributor-agreement` check fails and the pull request can't be merged.

Ticking the box means you accept the CLA, as it stands in this repository on that day, for that
pull request and every later contribution. If you contribute as part of your job, check that your
employer allows it first (CLA section 5).

Please also sign off each commit (`git commit -s`). It adds a `Signed-off-by:` line confirming you
wrote the change or have the right to submit it.

## Ways to help

- **Try to break it.** The [security audit](docs/AUDIT.md) lists the attacks already stopped. Found
  a new one? Please report it **privately** through
  [GitHub's private vulnerability reporting](https://github.com/altrudev/PWX/security/advisories/new),
  not in a public issue. See [`SECURITY.md`](SECURITY.md).
- **Build a small app** and tell us what was hard. Notes (`spike/apps/notes`) is the example.
- **Pick an issue** labelled
  [good first issue](https://github.com/altrudev/PWX/issues?q=is%3Aopen+label%3A%22good+first+issue%22).
- **Improve the docs**, especially anything that confused you.

## Where things are

| What | Where |
| --- | --- |
| All active work | branch `spike` |
| Format and runtime | [`docs/SPEC.md`](docs/SPEC.md) |
| Security record | [`docs/AUDIT.md`](docs/AUDIT.md) |
| Plans and decisions | [`docs/VISION.md`](docs/VISION.md), [`docs/M4.md`](docs/M4.md), [`docs/QUARANTINE.md`](docs/QUARANTINE.md) |
| Where the project stands | [`docs/HANDOVER.md`](docs/HANDOVER.md) |

## Running it

You need Node 22+ and, for the browser tests, Python 3 with Playwright.

```bash
git clone -b spike https://github.com/altrudev/PWX && cd PWX/spike
node --test tests/verify.test.mjs          # unit tests, no browser needed
python3 -m venv .venv && .venv/bin/pip install playwright && .venv/bin/playwright install
bash tests/run_all.sh                      # every suite in Chromium, Firefox and WebKit
```

Changing files in `app-origin/`, `loader/` or `lib/`? They're pinned by hash and covered by a signed
release, so tests will refuse them until you re-pin and re-sign with your own dev keys:

```bash
node tools/pin-runtime.mjs && node tools/build-packages.mjs && node tools/make-release.mjs
```

Your keys are created in `~/.config/pwx-dev/` on first run. Never commit keys. Don't commit the
re-pinned `app-origin/sw.js` and `loader/sw.js`, or the `local/release.json` made with your keys,
either: a maintainer re-pins and signs with the real release key, runs every suite, and merges
your commit with your authorship kept.

## How changes are made

- Branch from `spike`, open a pull request into `spike`. Keep it to one change.
- Say what you changed, why, and how you tested it. Security-relevant changes need a test that fails
  without the fix: switch your fix off once and show the test catches it.
- Run the tests that touch what you changed in all three engines (Chromium, Firefox, WebKit).
- Tick the CLA box in the pull request. GitHub asks a maintainer to approve CI runs for
  first-time contributors, so checks may wait a little.
- The `contributor-agreement` and `audit` (a static scan) checks must pass before merging.
- Write for people, not machines: plain words, short sentences.

## Licence and credit

PWX is released under Apache-2.0. Contributions are accepted under the
[Contributor License Agreement](CLA.md), which lets the project release your contribution under
Apache-2.0 and, if ever needed, under other terms. You keep your copyright, and you're credited in
the commit history and release notes. The names "PWX" and "ALTRU.dev" aren't licensed to
contributors or forks (see the README).
