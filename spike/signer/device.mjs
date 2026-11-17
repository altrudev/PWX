// One author device, browser kind ("pin"). The private key is never stored in usable form:
// only encrypted (AES-256-GCM) with a key derived from the author's passphrase
// (PBKDF2-SHA-256, 600,000 iterations, random salt). For each approval it's decrypted into a
// non-extractable key in memory, used once, and dropped. A copied browser profile holds only
// ciphertext, so it can't sign without the passphrase.
import { b64, verifyPackage } from "../lib/pwx-verify.mjs";
import { statementBytes, summarize, manifestOf } from "./approval.mjs";

const DB = "pwx-signer", STORE = "keys", ITER = 600000, MIN_PASS = 8;
function db() {
  return new Promise((ok, no) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
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
async function passKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export const record = () => idb("readonly", (s) => s.get("device"));
export async function isSetUp() { return Boolean(await record()); }

// First run on a device: make the key, lock it with the passphrase, keep only the locked copy.
export async function setup(passphrase, name) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASS) throw new Error(`passphrase must be at least ${MIN_PASS} characters`);
  if (await record()) throw new Error("this device already has a key");
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await passKey(passphrase, salt), pkcs8);
  new Uint8Array(pkcs8).fill(0);
  const pub = b64.enc(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  await idb("readwrite", (s) => s.put({ v: 1, name, pub, alg: "ed25519", kind: "pin", iter: ITER,
    salt: b64.enc(salt), iv: b64.enc(iv), locked: b64.enc(new Uint8Array(ct)) }, "device"));
  return pub;
}

export async function publicKey() { return (await record())?.pub ?? null; }
// Pairing code: what another device scans (a QR code in the real Signer).
export async function pairingCode() {
  const r = await record();
  return JSON.stringify({ type: "pwx-device", name: r.name, key: r.pub, alg: r.alg, kind: r.kind });
}

// Unlocks the key for one use. A wrong passphrase fails the AES-GCM check.
async function unlock(passphrase) {
  const r = await record();
  if (!r) throw new Error("this device has no key yet");
  let pkcs8;
  try {
    pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.dec(r.iv) }, await passKey(passphrase, b64.dec(r.salt)), b64.dec(r.locked));
  } catch { throw new Error("wrong passphrase"); }
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  new Uint8Array(pkcs8).fill(0);
  return { key, r };
}

// Step 1, on the approving device: verify the package itself and show what it really does.
// The requesting device's own description is ignored on purpose.
export async function review(pkgText, prevPkgText = null) {
  await verifyPackage(pkgText, { allowLoopbackHttp: true });
  const manifest = manifestOf(pkgText);
  const prev = prevPkgText ? manifestOf(prevPkgText) : null;
  return { manifest, summary: summarize(manifest, prev) };
}

// Step 2, after the person taps Approve and enters the passphrase: sign exactly this release.
export async function approve(pkgText, authorId, passphrase) {
  const manifest = manifestOf(pkgText);
  const { key, r } = await unlock(passphrase);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, await statementBytes(manifest, authorId)));
  return { key: r.pub, alg: r.alg, sig: b64.enc(sig) };
}
