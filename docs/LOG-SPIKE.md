# Log spike: results (2026-11-17)

First spike of the public log in [`M4.md`](M4.md). Code: `spike/log/`. Tests:
`spike/tests/merkle.test.mjs`, `log.test.mjs` and `log_browser_test.py` (`bash tests/run_log.sh`).

## What it does

- **Log** (`log/log.mjs`): an append-only Merkle tree log, with the same hashing and proofs as
  Certificate Transparency (RFC 6962 / 9162). Every entry is signed by its author; the log only
  orders and timestamps entries, and refuses anything with a bad signature. The log signs
  checkpoints (size, root, time).
- **Witnesses:** co-sign a checkpoint only after checking, with a consistency proof, that it
  extends the last one they saw. A rewritten or forked history gets no signature, and the witness
  keeps the conflicting checkpoint as evidence.
- **Receipts:** entry + log time + inclusion proof + witnessed checkpoint. Checked fully offline;
  a checkpoint counts only with co-signatures from enough known witnesses (2 of 3 in the tests).
- **Key history** (`log/authors.mjs`): create (with a committed recovery key), rotate (takes effect
  after **7 days**), recover (recovery key only: immediate, cancels pending rotations, and cuts off
  the old keys from the time of compromise), release, revoke. Who may publish is worked out from
  the log alone. Ed25519 and ECDSA P-256 (hardware) keys both work.
- **Full view:** a client holding the whole log can check it against a witnessed checkpoint, so
  a log can't hide a revocation or a recovery from one client.

## Results

| Test | Result |
| --- | --- |
| Merkle proofs, every tree size up to 40: every proof verifies, every changed leaf, root or proof element fails | pass |
| A logged release passes offline with its receipt | pass |
| A release missing from the log is rejected (also a valid receipt with a swapped entry) | pass |
| Forged receipts: changed proof, changed root, one witness, one witness twice, unknown witness, changed entry | all rejected |
| The log can't forge or alter entries; a stranger's "release" for the author is rejected | pass |
| Split view: a forked history and a same-size swapped history get **no** witness signatures; the honest log keeps being co-signed | pass |
| A revoked release is rejected; a stranger can't revoke | pass |
| New key rejected inside the 7-day wait, accepted after; old key works during the wait, not after | pass |
| Recovery: releases before the theft stay valid, the stolen key is cut off from the theft on, the thief's rotation is cancelled, the new key works at once | pass |
| Only the committed recovery key can recover | pass |
| A client with the whole log detects a hidden revocation or an altered entry | pass |
| Hardware (P-256) keys in the log | pass |
| Same scenario in the browser: Chromium 159, Firefox 159, WebKit 27.2 | 4/4 each |

**Each protection was switched off once to prove its test catches it** (the method AgentTrust
uses): no witness history check, no waiting period, any key can recover, revocations ignored,
receipts without the inclusion proof. Every one made the matching test fail.

## Static files and receipts (2026-11-18)

- **C2SP formats.** Checkpoints are signed notes (`lib/pwx-note.mjs`); witnesses add
  cosignature/v1 lines; the log is written as tlog-tiles static files (`log/tiles.mjs`). A reader
  fetches only the tiles it needs and proves entries against the signed root; it falls back to a
  full tile when a partial one is gone.
- **Tool:** `tools/pwx-log.mjs` (`init`, `append`, `witness`, `cosign`, `trust`). A witness reads
  the log over HTTP like any client and builds the consistency proof from the tiles itself.
- **Checked by other people's code.** `spike/interop/` (Go) verifies a PWX log folder with
  `golang.org/x/mod/sumdb/note` (log signature), `transparency-dev/formats` (witness
  co-signatures) and `golang.org/x/mod/sumdb/tlog` (every tile and every entry's inclusion proof).
- **Receipts in packages, loader soft mode** (release 0.4.10): see SPEC.md section 4.1.
  `tools/build-packages.mjs` logs every test package in a development log (`log/devlog.mjs`; its
  keys sit with the other dev keys, and its files in `spike/devlog/`, not committed).

| Test | Result |
| --- | --- |
| Tiles vs the in-memory tree: same root, inclusion and consistency proofs and entries, sizes 1 to 65537 (level-2 tiles), a reader at an older size after partial tiles are gone | pass (`tiles.test.mjs`) |
| Changed tiles or entries are caught against the signed root | pass |
| Signed notes: format, verifier keys, malformed text refused; a stranger using a witness's name, a duplicate line, a changed timestamp | all refused |
| Static log on `python -m http.server` (no PWX code): two witnesses co-sign over HTTP; Go verifies the log signature, both co-signatures and all 561 entries from tiles; a rewritten history is refused by the witness (evidence kept) and by Go | pass (`run_static_log.sh`) |
| Receipts: a logged package passes; another app's, version's, contents' or publisher's receipt, a changed proof, time, entry or signature, a missing witness, and a receipt from another log are refused | pass (`receipt.test.mjs`) |
| Loader in Chromium, Firefox, WebKit: logged package shown as logged at install and launch; no receipt and a wrong receipt shown as not logged, still installed | 6/6 each (`receipt_test.py`) |

## Not built yet

1. **Public hosting** of a real log: the format and tool are ready; the dev log isn't served
   anywhere yet, and receipts come from it.
2. **Witnesses as separate services,** run by separate people, and finding the first witnesses.
3. **Release entries carrying the two-device approvals** from the Signer spike.
4. **Required mode:** the loader shows receipts (soft mode, 0.4.10) but doesn't refuse
   unlogged releases yet; it also doesn't check key history or revocations.
5. **Revocation list download** for loaders, and **monitors** in the PWX Signer that alert the
   author and offer one-tap revoke.
6. **Clock:** the log's timestamps (`loggedAt` in each entry) decide the waiting period, and a
   C2SP checkpoint carries no time of its own, so a dishonest log could backdate an entry.
   Witnesses can close this because the tiles are public: before co-signing, read the new
   entries and refuse if any `loggedAt` goes backwards or is ahead of the witness's clock. The
   witness co-signature time also bounds when an entry existed. Not built.
