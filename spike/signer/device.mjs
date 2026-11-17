// One author device. Its key is made here, NON-EXTRACTABLE, and kept in IndexedDB as a
// CryptoKey object: page code can use it to sign but can't read or export the private key.
import { canonicalize, b64, verifyPackage } from "../lib/pwx-verify.mjs";
import { approvalStatement, summarize, manifestOf } from "./approval.mjs";

const DB = "pwx-signer", STORE = "keys";
function db() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((ok, no) => {
    const t = d.transaction(STORE, mode); const q = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); ok(q?.result); }; t.onerror = () => { d.close(); no(t.error); };
  });
}

// Returns this device's key pair, creating it on first use.
export async function deviceKey() {
  let kp = await idb("readonly", (s) => s.get("device"));
  if (!kp) {
    kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    await idb("readwrite", (s) => s.put(kp, "device"));
  }
  return kp;
}
export async function publicKey() {
  const kp = await deviceKey();
  return b64.enc(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
}
// Pairing code: what another device scans (a QR code in the real Signer).
export async function pairingCode(name) {
  return JSON.stringify({ type: "pwx-device", name, key: await publicKey() });
}

// Step 1, on the approving device: verify the package itself and show what it really does.
// The requesting device's own description is ignored on purpose.
export async function review(pkgText, prevPkgText = null) {
  await verifyPackage(pkgText, { allowLoopbackHttp: true });
  const manifest = manifestOf(pkgText);
  const prev = prevPkgText ? manifestOf(prevPkgText) : null;
  return { manifest, summary: summarize(manifest, prev) };
}

// Step 2, after the person taps Approve: sign the statement for exactly this release.
export async function approve(pkgText, authorId) {
  const manifest = manifestOf(pkgText);
  const kp = await deviceKey();
  const stmt = new TextEncoder().encode(canonicalize(await approvalStatement(manifest, authorId)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, stmt));
  return { key: await publicKey(), sig: b64.enc(sig) };
}
