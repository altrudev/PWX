# PWX Specification v0 (Draft)

**PWX (Progressive Web eXecutable)** is a signed, self-contained app package. It runs offline in
any modern browser and can do only what its manifest declares. Anyone can check the code, and the
runtime enforces the declared limits instead of trusting the publisher's promise.

Goals: privacy, no data loss, and users who own their data.

This draft describes PWX as built on branch `spike` at `25b2621`. Anything the code doesn't do yet
is marked **not implemented**. Security findings and test results are in [`AUDIT.md`](AUDIT.md).

## 1. Package

A package is one JSON file (`.pwx` / `.pwx.json`) with exactly three fields:

```json
{
  "manifest": "<the manifest, as JSON text>",
  "sig": { "alg": "ed25519", "key": "<base64 raw public key>", "sig": "<base64 signature>" },
  "files": { "app/index.html": "<base64 bytes>", "...": "..." }
}
```

- Any other field rejects the package.
- `manifest` is carried as text. The signature covers the **canonical JSON** of the parsed
  manifest (sorted keys, no whitespace), so formatting can't change what was signed.
- Every package is parsed with the **strict JSON parser**: duplicate keys rejected, at most 64
  levels of nesting, at most 64 MiB.

## 2. Manifest

```json
{
  "pwx": "0",
  "id": "org.example.notes",
  "name": "Notes",
  "version": "1.0.0",
  "publisher": "ed25519:<base64 public key>",
  "runtime": "strict",
  "entry": "app/main.js",
  "capabilities": {
    "network": { "connect": [], "webrtc": "none" },
    "storage": { "local": true, "persistent": true }
  },
  "files": { "app/main.js": "sha256-<base64>" }
}
```

| Field | Rule |
| --- | --- |
| `pwx` | `"0"` |
| `id` | reverse-DNS: lowercase, at least two labels |
| `version` | `MAJOR.MINOR.PATCH`, each part 1–9 digits |
| `publisher` | `ed25519:` + the public key; it must equal `sig.key` |
| `runtime` | `standard` (default) or `strict` |
| `entry` | a listed file. Strict: a `.js` worker script |
| `files` | every file with its SRI hash (`sha256-…`). Paths start with `app/`, and `..` isn't allowed |
| `capabilities` | only the keys listed in section 3; an unknown key rejects the manifest |

## 3. Capabilities

Capabilities compile into fixed response headers (`buildHeaders` in `lib/pwx-verify.mjs`). Headers
come from a template and are never joined from raw input.

| Capability | Values | Enforced as |
| --- | --- | --- |
| `network.connect` | list of `https://` / `wss://` origins | CSP `connect-src`; an empty list becomes `'none'` |
| `network.webrtc` | `none` (default) · `peer-only` · `any` | `none` adds CSP `webrtc 'block'`; Strict apps never have WebRTC |
| `camera`, `microphone`, `location` | boolean | Permissions-Policy `(self)` or `()` |
| `notifications` | boolean | validated only; **not implemented** |
| `storage`, `files`, `clipboard`, `sync` | object | validated only; **not implemented** (see 6.3) |

`network.connect` rejects IP literals, `localhost` and private-use names (`.local`, `.lan`,
`.internal`, `.home.arpa`, `.localhost`). An app can't reach the user's machine, home network or
cloud metadata. LAN access would need its own, separately granted capability, which isn't
designed yet.

Every app also gets: `default-src 'self'`, no frames, no objects, no forms, no `<base>`, no web
manifest, COOP `same-origin`, `nosniff` and `no-referrer`. USB, serial, HID, Bluetooth, payment,
display capture and WebAuthn are always off.

## 4. Verification

Every install **and every launch** runs the same checks (`verifyPackage`):

1. Strict-parse the package and the manifest; validate the manifest (section 2).
2. `sig.alg` is `ed25519`, and `sig.key` matches `publisher`.
3. The publisher matches the one already installed for this id, if any. A changed publisher is
   rejected.
4. The Ed25519 signature over the canonical manifest is valid.
5. No unlisted files, no missing files, and every file matches its hash.
6. Updates must be newer: an older version, or the same version with different contents, is
   rejected (rollback).

## 5. Loader

The loader installs, keeps and launches apps.

- **Library:** installed packages are kept on the device in IndexedDB. The loader's service worker
  keeps the loader on the device, so installed apps open with no network. The loader makes no calls home.
- **Loader integrity (hosted tier):** the loader is a release signed with the PWX release key
  (`/loader-release.json`). Its service worker pins only that public key, verifies every loader
  file against the release when it installs, and re-checks each file every time it serves it;
  a file that doesn't match is replaced from the host only with a matching copy, or the loader
  refuses to start. Updates happen only when the user clicks *Check for loader update*: a higher
  version, correctly signed, every file verified, then switched in one step. Older versions and
  same-version swaps are refused. If the browser brings a new `sw.js` that no signed release
  matches, the loader warns that the host may be compromised. (A host can still replace `sw.js`;
  only the Verified tier removes that risk.)
- **Install consent:** before every install or update, the loader shows the app's name, version,
  capabilities and a short **publisher fingerprint**. Nothing installs without a click.
- **Sideloading:** a `.pwx` file from disk installs through the same verification and consent.
- **Bootstrap:** the loader frames the app origin's `/__pwx/bootstrap.html` and hands it a
  `MessageChannel` port. The bootstrap accepts files only on that port, writes them into the
  `pwx-verified` cache with their CSP headers, and does nothing when opened as a tab.
- **Test switches** (`dev`, `mode`, `guard`, `unsafe`) work only when the server ships a test
  config (`TEST=true` under `PWX_TEST=1`). Production and pwx-local ship `TEST=false`.

### App origins

Each app runs on its own origin, so apps can't read each other's data.

| Mode | Origin | Assigned by |
| --- | --- | --- |
| Hosted | spike: `http://127.0.0.1:8110`–`8129`, standing in for per-app subdomains | the loader: FNV-1a(id) mod 20, linear probing; kept in the library record and across updates |
| Local (pwx-local) | `http://127.0.0.1:<port>`, one port per app (up to 256) | pwx-local, through `POST /__pwx/origin` (same-origin only) |

**Remove** wipes the app's origin (every IndexedDB database, every cache, `localStorage`) through
the bootstrap channel, then deletes the library record. If the wipe fails the app stays installed,
so an origin is never reused with data in it.

## 6. Runtimes

### 6.1 Standard

The app's HTML runs in an iframe on its app origin, with `sandbox="allow-scripts allow-same-origin"`
(no popups, no top-level navigation, no forms, no downloads) and the CSP from section 3. Runtime
files on the app origin are served only if they match hashes pinned at build time; a mismatch
returns 503.

### 6.2 Strict

App code never runs in a document.

- **Opaque-origin worker.** The loader-owned renderer (`app-origin/renderer.js`) reads the verified
  entry from `pwx-verified` and starts it as `new Worker(data:…)`, with the `PwxUI` prelude ahead
  of it. The worker's origin is `null`, so it can't use IndexedDB or the runtime caches. In WebKit
  it gets an isolated, empty CacheStorage. It has no `fetch` (CSP), no WebRTC and no DOM.
  Strict CSP: `default-src 'none'; script-src 'self'; worker-src data:; img-src blob:`.
- **UI through an allowlist.** The app sends UI operations (`create`, `attr`, `prop`, `text`,
  `append`, `remove`, `focus`, `listen`). The renderer applies only allowlisted tags, attributes,
  properties and events (`click`, `input`, `change`, `keydown`). Everything else is rejected and
  recorded.
- **The app's API** is `self.PwxUI`: `el`, `text`, `attr`, `prop`, `append`, `remove`, `focus`,
  `mount` and `store`.

### 6.3 Storage capability

```js
await PwxUI.store.put("note-1", { title: "Hello" });
await PwxUI.store.get("note-1");
await PwxUI.store.all();
await PwxUI.store.del("note-1");
```

The worker sends `{t:"store", rid, op, key, value}` with `op` = `get` | `put` | `delete` | `all`.
The renderer serves it from IndexedDB `pwx-app-store` / `kv` on the app's own origin and replies
`{t:"store-result", rid, ok, value | error}`. Keys are strings of 1–256 characters. Values are
anything structured clone accepts.

**Not implemented:** gating the store on `capabilities.storage`. Today every Strict app gets it.

## 7. Verified tier: pwx-local

`local/pwx-local.mjs` is a loopback-only daemon (default `127.0.0.1:7100`) that serves the loader
and per-app origins from the user's own machine.

- **Signed release self-check:** it refuses to start unless every file it serves matches a release
  signed by the pinned release key (`local/release.json`, `local/release.pub`, made with
  `tools/make-release.mjs`).
- **No network requests** of its own.
- `Host` check (421) against DNS rebinding. Origin allocation is POST plus same-origin, so a
  website can't make it allocate origins. Framed-only paths require `Sec-Fetch-Dest: iframe`.
- Environment: `PWX_HOME` (default `~/.pwx`), `PWX_PORT` (default 7100), `PWX_BUNDLE`.

## 8. Threat model

| Threat | Defence | Status |
| --- | --- | --- |
| A tampered or re-signed package | Ed25519 over the canonical manifest, file hashes, publisher pinned per id, checked at every launch | blocked (offline tamper tests) |
| A rollback to an older or swapped version | version must increase; same-version swap rejected | blocked |
| An app leaks data to an undeclared host | CSP `connect-src`, no frames, forms or navigation; sandboxed iframe | blocked, except WebRTC in unhardened browsers and link preconnect in WebKit (AUDIT leak matrix) |
| An app reaches the LAN, localhost or cloud metadata | private and local hosts rejected in the manifest | blocked |
| An app escapes its sandbox (top-level open, self-navigation) | sandbox flags; framed-only pages return 403 | blocked |
| **Another app reads this app's data** | opaque-origin worker + per-app origins + storage capability; Remove wipes the origin | blocked (C3, L3) |
| An app poisons the runtime or its own verified code | runtime pinned by hash; Strict app has no cache access | blocked |
| A website hijacks the bootstrap | framed-only, `MessageChannel` handshake, `frame-ancestors` | blocked |
| A website drives pwx-local (CSRF, DNS rebinding) | POST + same-origin, `Host` check | blocked |
| A link turns protections off | test switches exist only in test builds | blocked |
| Oversized or malicious JSON | strict parser with depth and size limits | blocked |
| A modified pwx-local install | signed release self-check | blocked |
| A changed or partial hosted loader (cache or host) | signed release, every file checked on every serve | blocked (AUDIT M6) |
| A rolled-back or swapped loader update | version must increase; same-version swap refused; updates only on click | blocked (AUDIT M6) |
| A compromised host replaces the loader's `sw.js` | warning when no signed release matches | **browser limit**: detectable, not preventable in the hosted tier; use pwx-local |

## 9. Not implemented yet

- The capabilities marked **not implemented** in section 3.
- Per-app subdomains for hosted mode (the spike uses 20 ports).
- Moving notes from the old `pwx-notes` database.
- Other spec features tracked as audit finding M4.
