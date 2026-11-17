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

## Not built yet

1. **Public hosting:** the spike keeps the log in memory. Next: write it as static files in the
   public C2SP formats (signed-note checkpoints, tiles), so ordinary hosting can serve it.
2. **Witnesses as separate services,** run by separate people, and finding the first witnesses.
3. **Release entries carrying the two-device approvals** from the Signer spike.
4. **Receipts inside packages, and the loader checking them** (soft mode first: warn, then
   refuse).
5. **Revocation list download** for loaders, and **monitors** in the PWX Signer that alert the
   author and offer one-tap revoke.
6. **Clock:** the log's timestamps decide the waiting period. Witnesses should refuse checkpoints
   whose time goes backwards or runs far ahead; not built.
