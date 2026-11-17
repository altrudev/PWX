# Signer spike: results (2026-11-16)

Spike for [`M4.md`](M4.md) section 0: device keys and two-device approval, **without passkeys or
any Apple/Google sync** (Altru's decision). Code: `spike/signer/`. Tests: `spike/tests/signer_test.py`
and `spike/tests/signer_clone_probe.py` (`bash tests/run_signer.sh`).

## How it works

- Each device makes its own Ed25519 key with the browser's standard crypto (WebCrypto),
  **non-extractable**, and keeps it in IndexedDB. Page code can sign with it but can't read it.
- Pairing: a device shows a pairing code (its public key; a QR code in the real Signer). The
  author's **key set** lists their device keys and how many must approve (here 2).
- To publish, the requesting device signs, and the approving device **verifies the package
  itself** and shows what it really does, highlighting anything new. Nothing the requesting device
  says is shown.
- Each approval signs a statement binding author, app id, version and manifest hash, so it can't be
  reused for anything else. Loaders accept a release only with approvals from 2 distinct devices
  in the key set.

## Results: 14/14 in Chromium 159, Firefox 159 and WebKit 27.2

| Check | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| Private key can't be exported by page code | pass | pass | pass |
| Each device has its own key; it survives a browser restart | pass | pass | pass |
| Pairing code carries the other device's key | pass | pass | pass |
| Approving device shows what is really published | pass | pass | pass |
| Two devices approve: accepted | pass | pass | pass |
| One device alone: rejected | pass | pass | pass |
| Same device twice: rejected | pass | pass | pass |
| Key that isn't one of the author's devices: rejected | pass | pass | pass |
| Approval reused for another release or another author: rejected | pass | pass | pass |
| Lying laptop (says "Notes", sends another app): phone shows the real app and its new network access | pass | pass | pass |
| Deny gives no approval | pass | pass | pass |
| Tampered package refused before the approval screen | pass | pass | pass |

## The limit this found

**A copied browser profile can sign with the device key, in all three browsers**
(`signer_clone_probe.py`). "Non-extractable" protects the key from web code (apps, malicious
pages), but the browser stores it in the profile folder on disk, not in security hardware.
Malware on the computer that copies that folder gets a working copy of that device's key.

What still holds: the copy is still only **one** device. Publishing needs a second device, which
shows the real package before anyone approves. So malware has to take over two of the author's
devices, as in M4's threat table. But "keys that can't be copied" is only true in the browser
against web attackers, not against malware.

## Options to close it (for Altru)

1. **PIN-locked browser keys.** Store the device key only encrypted with a key derived from the
   author's PIN or passphrase; unlock it in memory for each approval. A copied profile is useless
   without the PIN. Cheap, works in every browser. Weak PINs can be guessed offline, so it needs a
   passphrase or a long PIN.
2. **Hardware keys through PWX's own native parts,** no passkeys: `pwx-local` (Windows TPM, macOS
   Secure Enclave, Linux TPM) and ALTRU OS on Android (Android Keystore) keep the key in the
   device's security chip, where it can't be copied at all. Browser-only devices use option 1.
3. **Both** (recommended): hardware where a native PWX part is installed, PIN-locked keys
   everywhere else, and the key set records which kind each device has, so loaders can show
   "approved on 2 hardware-protected devices".

iPhone: a home-screen web app can't reach the Secure Enclave without passkeys, so iPhone signers
would use option 1.
