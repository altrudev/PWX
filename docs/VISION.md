# PWX vision: where this goes

**Status: direction agreed with Altru on 2026-11-16. Nothing in this file is built yet**, except
what [`SPEC.md`](SPEC.md) already describes. It records what PWX is for, so design choices can
be checked against it.

## In one sentence

**PWX: apps anyone can make, share, update and branch, that run on everything, and where you
always know who made them and what they can do.**

## What PWX is, and isn't

- **PWX is an open format and a runtime,** like PDF for documents: a signed file that runs on any
  device, on the web or from disk, and can only do what it declares.
- **PWX is not an app builder and not a store.** Build however you like: by hand, with AI, in any
  framework. Then pack, sign and share. Requiring one builder would be a restriction, not freedom.
- **The one tool every author needs is a packer:** drop in a folder, get a signed `.pwx`. A
  command line for developers, and a web page for everyone else.

## The gap PWX fills

As of November 2026, "personal software" is a crowded, funded field: AI builders for non-coders,
apps made inside group chats, apps remixed on canvases. They keep the apps and the data on their
own platform or in one messenger. Owned single-file apps exist only in niches (a Windows-only
database builder, single-file notebooks). Nothing found combines all of these:

1. an app is one file you own: no account, no platform;
2. signed, so anyone can check who made it and that it hasn't changed;
3. limited by the runtime to what it declares, with the limits shown plainly;
4. the same file runs on phones, tablets and computers;
5. anyone can branch it, and everyone can see where it came from.

## The big shift

Today an app belongs to the store that sells it. In PWX an app is an object that belongs to
whoever holds it, like a book, a song file or a key. That opens up:

### Ways to get an app

- **Buy:** a signed license bound to the buyer's key, checkable offline, no store fee.
- **Earn:** finish a course, reach a goal or help a project, and the author signs an unlock.
- **Gift or lend:** a license that passes to someone else, or expires after a set time.
- **Free, with tips upstream:** lineage records who built what, so tips can reach every author
  in an app's history.

### Ways to shape an app

- **Branches with lineage.** A branch is signed by its new author and declares what it came from
  ("forked from Notes 1.2, by Val"). The loader shows the family tree and what each version is
  allowed to do, so a branch asking for more than the original stands out.
- **Blessed branches.** The original author co-signs a branch as endorsed, so people can tell an
  approved version from an unknown one.
- **Branded editions.** A business takes an app and brands it; the lineage still shows its origin.
- **Personal copies.** One author's app, many private copies, each with its own data.

### New kinds of apps

- **Documents that run:** invitations, menus, receipts, resumes, contracts; signed and offline.
- **Humanitarian delivery:** apps passed by USB, Bluetooth or QR code where there's no internet,
  still verifiable.
- **Software that lasts:** a self-contained signed file that still runs decades later.
- **Safe AI-made software:** AI agents build apps on demand; PWX keeps them inside what their
  manifest declares and records who or what made them.

## Delivery

One universal shell, the same apps everywhere:

| How it runs | Where |
| --- | --- |
| Hosted page, added to the home screen | phones (iPhone included) and any browser |
| A single file saved and opened | desktop computers (needs a spike per browser) |
| `pwx-local` or a small native wrapper | desktop; Android (the ALTRU OS idea) |

**Hosted is the front door, not the destination.** A link is the easiest way to reach anyone, on
any device, so most people will meet PWX through the hosted shell. From there they keep and run
apps the way that suits them: on the home screen, as a saved file, or in `pwx-local`.

On iPhone, adding the PWX shell to the home screen is the one step that replaces the App Store.
The shell should teach it on first visit with a short visual guide, so it becomes common
knowledge.

Push, background sync and offline work are capabilities the shell provides and the manifest
declares, like storage. Apps don't need workers of their own (see [`QUARANTINE.md`](QUARANTINE.md),
Part 1).

## Ownership on the record

Every sale, resale, gift, donation or loan is a **transfer** signed by the current owner to the new
owner's key, and becomes part of the app's history, next to its lineage.

- **Double selling** is the one real problem: an owner could sign two transfers, and offline no
  one can tell which came first. Fix: transfers go into the **M4 transparency log**, an
  append-only public log with outside witnesses (like the logs browsers use to catch fake HTTPS
  certificates). The first transfer logged wins. No blockchain, tokens or fees, and it's the same
  log PWX needs for revocation and key rotation.
- **Privacy:** owners appear as keys, not names, and the log holds a fingerprint of each transfer,
  not its contents. Anyone can check one ownership claim; no one can list what a person owns.
- **Loans** are transfers that expire and return. **Licenses** (buy, earn, gift) use the same record.

## Earned results

Example: a test made as a PWX app, where finishing it produces a grade the student keeps.

- **Rule: nobody signs their own reward.** A key on the student's device can be extracted, so the
  student's app only signs the **answers** ("these are my answers, at this time").
- The **issuer** (teacher or school) grades those signed answers and signs the **result**: online
  at once, or offline when the teacher's device next syncs.
- The result is a credential the student owns. Anyone can check it with the school's public key,
  with no call to the school. Use the existing standard, **W3C Verifiable Credentials / Open
  Badges**, so results work with systems schools and employers already accept.
- Low-stakes results (practice quizzes, game badges) may be self-graded, and say so.
- Out of scope: someone else taking the test. That's proctoring, not software.

## Opening a .pwx file

No browser recognises `.pwx` yet. The API that lets an installed web app own a file type exists in
Chrome and Edge on desktop only (not Firefox, not Safari, not phones). So PWX uses several routes:

| Route | Works in |
| --- | --- |
| Installed PWX shell registers `.pwx` (File Handling API) | Chrome and Edge on desktop |
| `pwx-local` or ALTRU OS registers `.pwx` with the operating system | Windows, macOS, Linux, Android |
| Links such as `…/open#<package>` open in the shell | every browser, iPhone included |
| **A self-opening .pwx** | every desktop browser |

**Self-opening file:** a `.pwx` that is also a valid HTML page. It holds the signed package and a
tiny launcher, so any browser opens it on double-click. The launcher never trusts itself: it hands
the package to the user's trusted PWX shell, which verifies and runs it. Without a shell it offers
"Verify and open with PWX" and a read-only preview. On iPhone, files are opened through the shell.

Long term: once PWX is widely used, propose it to browser makers as a standard, the way PDF
ended up built into every browser.

## Hard problems, stated plainly

- **No store means no gatekeeper.** Malware authors can sign too. Lineage, the public log (M4)
  and enforced permissions make bad apps visible and contained, not impossible.
- **Licenses can be copied,** like any software. Binding them to the buyer's key makes copying
  traceable, not impossible.
- **Branching and signing pull against each other.** Lineage and blessings are the answer; they
  need a design before code.
- **iPhone stays the hardest platform:** Apple decides what home-screen web apps can do.

## Design items this adds

1. **Lineage and blessings:** manifest fields for `forkedFrom` (id, version, publisher, manifest
   hash), co-signatures for blessed branches, and how the loader shows the family tree. Pairs
   with the M4 transparency log, which makes the history impossible to rewrite.
2. **Packer for everyone:** a web page that packs and signs a folder in the browser, with the key
   kept on the author's device.
3. **Licenses:** a signed, offline-checkable license format (buy, earn, gift, lend, expire).
4. **Shell capabilities:** push, background sync and an install guide for iPhone.
5. **Ownership transfers** in the M4 log: signed transfer format, first-logged-wins, privacy.
6. **Earned credentials:** answers signed by the earner, results signed by the issuer, as W3C
   Verifiable Credentials / Open Badges.
7. **Self-opening .pwx:** an HTML-and-package file whose launcher hands off to the trusted shell;
   File Handling registration in the shell and OS registration in `pwx-local` / ALTRU OS.
