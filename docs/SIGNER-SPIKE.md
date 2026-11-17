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

## First run (before option 3): 14/14 in Chromium 159, Firefox 159 and WebKit 27.2

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

## The limit the first run found

**A copied browser profile can sign with the device key, in all three browsers**
(`signer_clone_probe.py`). "Non-extractable" protects the key from web code (apps, malicious
pages), but the browser stores it in the profile folder on disk, not in security hardware.
Malware on the computer that copies that folder gets a working copy of that device's key.

What still holds: the copy is still only **one** device. Publishing needs a second device, which
shows the real package before anyone approves. So malware has to take over two of the author's
devices, as in M4's threat table. But "keys that can't be copied" is only true in the browser
against web attackers, not against malware.

## Option 3, chosen by Altru: PIN-locked browser keys plus hardware keys

### PIN-locked browser keys (built and tested)

- On first run the device makes its key, then stores it **only encrypted**: AES-256-GCM with a key
  derived from the author's passphrase (PBKDF2-SHA-256, 600,000 iterations, random salt). The
  usable key is never written to disk.
- To approve, the author types the passphrase. The key is decrypted into a non-extractable key in
  memory, signs once, and is dropped. A wrong passphrase fails.
- Passphrases shorter than 8 characters are refused, because a copied profile can be attacked
  offline by guessing.

### Hardware keys (format built and tested; chip access not built)

- Security chips (Windows/Linux TPM, Apple Secure Enclave, Android Keystore) sign with **ECDSA
  P-256**, not Ed25519. Approvals and key sets now name the algorithm, and loaders accept both.
- Each device in the key set has a **kind**, `pin` or `hardware`. The kind comes from the key set,
  never from the approval, so a browser key can't pass itself off as hardware.
- Loaders describe approvals plainly: *"Approved on 2 devices (1 hardware-protected)"*.
- Not built: `pwx-local` and ALTRU OS actually creating and using a chip key. The test VPS has no
  TPM, so a non-extractable P-256 browser key stands in for a chip key in the tests. Next step for
  this part: a small native helper per platform, tested on a real machine (Prometheus, a Mac, an
  Android phone).

### Results: 20/20 in Chromium 159, Firefox 159 and WebKit 27.2

New checks on top of the 14 above: short passphrase refused; only the encrypted key is stored;
wrong passphrase can't sign (in code and on the approval screen, which keeps asking); an approval
claiming another algorithm is rejected; laptop + hardware device accepted and labelled; a browser
key can't claim to be hardware.

**Copied profile, with option 3:** in all three browsers it **cannot sign without the passphrase**
(four guesses tried, including another device's passphrase). With the passphrase it can, so the
passphrase must never be stored on the device, and a stolen profile plus a keylogger is still one
device: the second-device rule still applies.

## Options considered

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
