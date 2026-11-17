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

On iPhone, adding the PWX shell to the home screen is the one step that replaces the App Store.
The shell should teach it on first visit with a short visual guide, so it becomes common
knowledge.

Push, background sync and offline work are capabilities the shell provides and the manifest
declares, like storage. Apps don't need workers of their own (see [`QUARANTINE.md`](QUARANTINE.md),
Part 1).

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
