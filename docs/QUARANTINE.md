# Quarantine without an extension: design proposal

**Status: proposal, 2026-11-16. Nothing here is built or tested.** Each part lists the spike that
has to pass in Chromium, Firefox and WebKit before it's relied on. Background: AUDIT.md,
"Surviving a compromised host" and "PWX Guard".

## The problem

In the hosted tier the browser fetches `sw.js` from the host and installs it. No page, and no
running worker, can veto that. The PWX Guard extension can (Chromium spike, 10/10), but an
extension isn't available in every browser, and people have to install it.

**What can't be done:** make every browser refuse a swapped worker using page code alone. No
web API pins a service worker to a hash or a signature.

**What can be done in every browser:** make the swap exactly detectable, make a swapped worker
find nothing it can read, and stop an unsigned worker before it reaches the browser. Four parts,
each useful alone.

## Part 1: one origin instead of twenty-one

Today every app has its own origin, each with its own service worker. Each is another worker the
host can swap, and those origins hold the app data.

**Change:** run each app in a sandboxed frame the loader creates from verified bytes (`srcdoc`
or `blob:`, `sandbox` without `allow-same-origin`). Such a frame has an opaque origin: no
storage, no access to the loader, isolated from every other app. Storage already reaches Strict
apps as a capability over messages; the loader would now serve it from its own storage, keyed
by app id. CSP goes in the frame's own `<meta>` tag, written by the loader from the manifest.

**Result:** app origins, their service workers and their bootstrap disappear. One origin and one
worker are left to protect. Hosted mode no longer needs a subdomain per app.

**Cost:** all app data sits behind the loader origin, and apps can't have origin-bound features
of their own (their own service worker, push, cookies).

**Spike:** rerun the 36-vector leak matrix and the audit exploits with apps in sandboxed opaque
frames. Open questions: does `<meta>` CSP hold for every vector (it can't carry
`frame-ancestors` or `sandbox`); do `data:` workers start inside an opaque sandboxed frame in
all three engines; does WebRTC behave the same there.

## Part 2: a frozen kernel

Today a new `sw.js` may be legitimate (a signed release) or an attack, and the page can only
guess by fetching the file again, which a careful host can answer differently.

**Change:** make the loader's `sw.js` a small kernel that never changes. It only verifies and
serves files from signed releases; everything that can change lives in those releases, which it
already checks. A kernel fix means moving to a new origin with the user's consent, like a key
rotation.

**Result:** any new worker at all is an attack. Detection is exact: the verified page sees
`updatefound` and locks, with no hash comparison to fool. The verified page always loads before
a new worker takes over, because the browser serves the page from the old worker first.

**Spike:** confirm in all three engines that the page sees `updatefound` before the new worker
controls it, including when the new worker calls `skipWaiting()` and `clients.claim()`.

## Part 3: data locked at rest

A swapped worker runs on the loader origin and can read that origin's storage directly, as soon
as it starts installing. Detection alone is too late for data stored in the clear.

**Change:** encrypt app data. The data key is never stored unwrapped. It's wrapped by something
only the user can supply, in a page, with a gesture: a passkey (WebAuthn PRF) or a passphrase.
The unwrapped key lives only in the memory of the verified page for that session.

**Result: this is the quarantine.** A swapped worker gets only ciphertext. On the launch where
the swap happens, the verified page (Part 2) drops the key and locks. After that the attacker's
page has to get the user to unlock again, after they've been warned. Silent theft becomes
theft that needs the user's active help.

**Limit:** a user who unlocks for the replaced loader loses that data. Nothing on the page can
tell them apart at that point.

**Spike:** WebAuthn PRF support and behaviour in Chromium, Firefox and WebKit (desktop and
mobile); a passphrase fallback; cost of encrypting the storage capability.

## Part 4: a verifying gateway in front of the host

The extension's job (refuse an unsigned `sw.js`) can also be done on the network, for every
browser, with nothing to install.

**Change:** put a small gateway in front of the hosting, run under separate credentials from the
publishing pipeline. It pins the release public key and serves a loader file only if it matches
a signed release. The release key stays offline.

**Result:** someone who takes over the web server or the deploy pipeline can't get an unsigned
worker to any browser. They'd also need the gateway account or the release key.

**Limit:** the gateway (and DNS and TLS for the domain) is now the thing to trust. It's much
smaller and changes rarely. The transparency log in M4 adds outside monitors that fetch the
loader from many places and raise an alarm on anything unsigned.

**Spike:** a gateway as an edge function in front of the test server; the hostile-host tests
must show the unsigned `sw.js` never arrives.

## Optional: a loader with no host

With Part 1 the loader needs no app origins, so it could be one self-contained HTML file that
people save and open from disk. There's no host, so there's nothing to swap. This likely works
on desktop browsers only, and storage for local files differs by browser. **Spike:** storage and
sandboxed frames from a local file in each desktop browser.

## What each tier gives after this

| Tier | A swapped worker is | App data |
| --- | --- | --- |
| Hosted, as today | installed; page locks if it notices | readable through the app origins' workers |
| Hosted + Parts 1–3 | installed, always noticed | ciphertext unless the user unlocks again |
| Hosted + Part 4 | not delivered unless the gateway or key is also taken | as above |
| PWX Guard extension | blocked (Chromium spike; timing gap) | protected for covered workers |
| `pwx-local`, or a local loader file | not possible: no host | on the device only |

## Suggested order

1. Part 1 spike (it decides the architecture, and removes the per-app subdomain problem).
2. Part 2 (small once Part 1 is in).
3. Part 3 spike (PRF support decides the design).
4. Part 4 alongside the M4 transparency log.

## Part 1 probe results (2026-11-24, branch `q/part1`)

Probe: `spike/tests/q1/` (`server.mjs`, `probe.js`, `frame.js`, `run.py`). The loader-like page
creates a sandboxed frame (`sandbox="allow-scripts"`, no `allow-same-origin`) and reports what the
frame and a `data:` worker inside it can reach. A canary records HTTP, WebSocket, TCP and STUN.

| Check | Chromium 159 | Firefox 159 | WebKit 27.2 |
| --- | --- | --- | --- |
| Frame origin is opaque (`null`) | yes | yes | yes |
| localStorage, IndexedDB, CacheStorage, cookies, parent DOM | all blocked | all blocked | all blocked (cookie write is a no-op) |
| `data:` worker starts in the frame | yes | yes | yes |
| `RTCPeerConnection` in that worker | absent | absent | absent |
| HTTP/WebSocket requests reaching the canary (fetch, img, script, beacon, EventSource, prefetch, iframe, popup, WebSocket, importScripts) | 0 | 0 | 0 |
| Works offline: runtime code in `srcdoc` from the loader origin | no | no | no |
| Works offline: runtime code inline, its sha256 pinned in the loader CSP and the frame's meta CSP | **yes** | **yes** | **yes** |
| `blob:` frame instead of `srcdoc` | works | works | no report |

Findings:

- **Sealed frames aren't controlled by the loader's service worker** in any engine, so an
  external script can't be served offline. Inline the runtime and pin its hash in the loader's
  CSP (`script-src 'self' 'sha256-…'`). The loader page's CSP is served by the signed loader
  release, so the pinned hash is covered by the release signature. Use `srcdoc`, not `blob:`.
- The loader CSP needs `worker-src 'self' data:` so a frame can start the app's `data:` worker
  (frames inherit the loader's policy as well as their own meta CSP; both must allow a request).
- **WebKit:** the `data:` worker has a CacheStorage, but it is empty and separate: a cache the
  loader wrote ("LOADER-SECRET") isn't visible from it.
- **Known browser limits carry over unchanged:** the frame *document* still has
  `RTCPeerConnection` (STUN reached the canary in Chromium and WebKit, not Firefox) and WebKit
  still opens a TCP connection for `link rel=preconnect`. No app code runs in the Strict
  renderer document; Standard apps keep today's documented WebRTC and preconnect behaviour.

Next: run the Strict renderer in the sealed frame, serve `PwxUI.store` from the loader's storage
keyed by app id, and rerun the 36-vector leak matrix, the audit and every app test in all three
engines before adopting anything.
