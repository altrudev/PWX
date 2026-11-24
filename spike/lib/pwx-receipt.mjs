// Checks the log receipt a package carries, fully offline (M4 section 3).
// A receipt proves this exact release is in the public log, in a state enough witnesses co-signed:
//   { leaf: { entry, sig, loggedAt }, index, proof: [base64 hash], checkpoint: signed note }
// The entry must be a release of this app, this version and this manifest, signed by the
// package's own publisher key. Soft mode (today): a missing or bad receipt is shown, not refused.
import { canonicalize, sha256, b64 } from "./pwx-verify.mjs";
import { leafHash, verifyInclusion } from "./pwx-merkle.mjs";
import { verifyCheckpointNote } from "./pwx-note.mjs";

const te = new TextEncoder();
const ALGS = {
  ed25519: { imp: { name: "Ed25519" }, ver: { name: "Ed25519" } },
  p256: { imp: { name: "ECDSA", namedCurve: "P-256" }, ver: { name: "ECDSA", hash: "SHA-256" } },
};
async function verifySig(p, value, sig) {
  try {
    if (!p || !ALGS[p.alg] || typeof p.key !== "string" || typeof sig !== "string") return false;
    const k = await crypto.subtle.importKey("raw", b64.dec(p.key), ALGS[p.alg].imp, false, ["verify"]);
    return await crypto.subtle.verify(ALGS[p.alg].ver, k, b64.dec(sig), te.encode(canonicalize(value)));
  } catch { return false; }
}

// trust: { origin, log: { name, key }, witnesses: [{ name, key }], quorum }, or a list of them
// (the receipt's checkpoint names its log, and only a pinned log with that name is used).
// Returns { logged: true, loggedAt, witnesses } or throws with a plain reason.
export async function checkReceipt(receipt, manifest, publisherKey, trust) {
  if (!receipt || typeof receipt !== "object") throw new Error("no receipt");
  if (Array.isArray(trust)) {
    const origin = typeof receipt.checkpoint === "string" ? receipt.checkpoint.slice(0, receipt.checkpoint.indexOf("\n")) : "";
    trust = trust.find((t) => t.origin === origin);
    if (!trust) throw new Error(`receipt is from a log this loader doesn't know (${origin.slice(0, 80) || "none"})`);
  }
  if (!trust || !trust.log) throw new Error("this loader has no log to check against");
  const { leaf, index, proof, checkpoint } = receipt;
  let cp;
  try { cp = await verifyCheckpointNote(checkpoint, trust); } catch (e) { throw new Error(`log state not witnessed (${e.message})`); }
  const e = leaf?.entry;
  if (!e || e.type !== "release") throw new Error("receipt isn't for a release");
  if (e.app !== manifest.id || e.version !== manifest.version) throw new Error("receipt is for another app or version");
  if (e.manifest !== await sha256(te.encode(canonicalize(manifest)))) throw new Error("receipt is for different contents");
  if (e.signer?.alg !== "ed25519" || `ed25519:${e.signer.key}` !== `ed25519:${publisherKey}`) throw new Error("receipt wasn't signed by this publisher");
  if (!(await verifySig(e.signer, e, leaf.sig))) throw new Error("receipt entry signature is invalid");
  if (!Number.isSafeInteger(index) || !Array.isArray(proof) || proof.length > 64 || !Number.isSafeInteger(leaf.loggedAt)) throw new Error("receipt is malformed");
  const ok = await verifyInclusion(index, cp.size, await leafHash(te.encode(canonicalize(leaf))), proof.map(b64.dec), b64.dec(cp.root));
  if (!ok) throw new Error("release is not in the log");
  return { logged: true, loggedAt: leaf.loggedAt, witnesses: cp.cosigned.length, origin: cp.origin };
}
