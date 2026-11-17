// M4 log spike: an append-only public log, witnesses, and receipts.
// - Every entry is signed by its author; the log only orders and timestamps entries, it can't
//   forge them.
// - The log signs checkpoints (size + root). Witnesses co-sign a checkpoint only after checking
//   it extends the last one they saw, so a log can't show different people different histories.
// - A receipt (entry + log time + inclusion proof + witnessed checkpoint) lets anyone check
//   offline that an entry is in the log.
import { canonicalize, b64 } from "../lib/pwx-verify.mjs";
import { ALGS } from "../signer/approval.mjs";
import * as M from "./merkle.mjs";

const te = new TextEncoder();
export const bytes = (v) => te.encode(canonicalize(v));

// ---------- keys and signatures (Ed25519, or ECDSA P-256 for hardware keys) ----------
export async function newKey(alg = "ed25519") {
  const kp = await crypto.subtle.generateKey(alg === "p256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" }, false, ["sign", "verify"]);
  return { alg, priv: kp.privateKey, key: b64.enc(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
}
export const pub = (k) => ({ key: k.key, alg: k.alg });
export async function sign(k, value) {
  return b64.enc(new Uint8Array(await crypto.subtle.sign(ALGS[k.alg].ver, k.priv, bytes(value))));
}
export async function verifySig(p, value, sig) {
  try {
    if (!p || !ALGS[p.alg] || typeof p.key !== "string" || typeof sig !== "string") return false;
    const k = await crypto.subtle.importKey("raw", b64.dec(p.key), ALGS[p.alg].imp, false, ["verify"]);
    return await crypto.subtle.verify(ALGS[p.alg].ver, k, b64.dec(sig), bytes(value));
  } catch { return false; }
}
export const keyId = async (p) => b64.enc(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(p))));

// An author signs an entry. `signer` says which key signed it.
export async function signEntry(k, body) {
  const entry = { ...body, signer: pub(k) };
  return { entry, sig: await sign(k, entry) };
}

// ---------- the log ----------
export class Log {
  constructor(origin, key, clock = () => Date.now()) { this.origin = origin; this.key = key; this.clock = clock; this.leaves = []; this.hashes = []; }
  // Appends an entry if its signature is valid. Returns its index.
  async append(signed) {
    if (!signed?.entry || !(await verifySig(signed.entry.signer, signed.entry, signed.sig))) throw new Error("log: bad entry signature");
    const leaf = { entry: signed.entry, sig: signed.sig, loggedAt: this.clock() };
    this.leaves.push(leaf); this.hashes.push(await M.leafHash(bytes(leaf)));
    return this.leaves.length - 1;
  }
  async checkpoint() {
    const body = { origin: this.origin, size: this.leaves.length, root: b64.enc(await M.root(this.hashes)), time: this.clock() };
    return { body, sig: await sign(this.key, body) };
  }
  inclusion(i, size = this.leaves.length) { return M.inclusionProof(i, this.hashes.slice(0, size)); }
  consistency(m, n = this.leaves.length) { return M.consistencyProof(m, this.hashes.slice(0, n)); }
}

// ---------- witnesses ----------
export class Witness {
  constructor(name, key, logPub, origin) { this.name = name; this.key = key; this.logPub = logPub; this.origin = origin; this.last = null; this.evidence = []; }
  // Co-signs only a checkpoint that is signed by the log and extends the last one it saw.
  async cosign(cp, proof) {
    if (cp.body.origin !== this.origin || !(await verifySig(this.logPub, cp.body, cp.sig))) return null;
    if (this.last) {
      const ok = cp.body.size >= this.last.size && await M.verifyConsistency(this.last.size, cp.body.size,
        b64.dec(this.last.root), b64.dec(cp.body.root), (proof ?? []).map(b64.dec));
      if (!ok) { this.evidence.push({ seen: this.last, conflicting: cp }); return null; }   // split view or rewrite
    }
    this.last = { size: cp.body.size, root: cp.body.root };
    return { witness: this.name, key: pub(this.key), sig: await sign(this.key, cp.body) };
  }
}

// ---------- receipts ----------
export async function receipt(log, index, cp, cosigs) {
  return { leaf: log.leaves[index], index, checkpoint: cp, cosigs,
    proof: (await log.inclusion(index, cp.body.size)).map((h) => b64.enc(h)) };
}

// trust: { origin, log: {key, alg}, witnesses: [{key, alg}], quorum }
// Checks a receipt fully offline. Returns the leaf if it's genuinely in a witnessed log state.
// A checkpoint counts only if the log signed it and at least `quorum` known witnesses co-signed it.
export async function verifyCheckpoint(cp, cosigs, trust) {
  if (!cp || cp.body.origin !== trust.origin || !(await verifySig(trust.log, cp.body, cp.sig))) throw new Error("checkpoint not signed by the log");
  const good = new Set();
  for (const c of cosigs ?? []) {
    const w = trust.witnesses.find((x) => c && x.key === c.key?.key && x.alg === c.key?.alg);
    if (w && !good.has(w.key) && await verifySig(w, cp.body, c.sig)) good.add(w.key);
  }
  if (good.size < trust.quorum) throw new Error(`${good.size} of ${trust.quorum} witnesses`);
  return true;
}

export async function verifyReceipt(r, trust) {
  const cp = r?.checkpoint;
  try { await verifyCheckpoint(cp, r?.cosigs, trust); } catch (e) { throw new Error("receipt: " + e.message); }
  if (!(await verifySig(r.leaf?.entry?.signer, r.leaf.entry, r.leaf.sig))) throw new Error("receipt: entry signature invalid");
  const ok = await M.verifyInclusion(r.index, cp.body.size, await M.leafHash(bytes(r.leaf)), r.proof.map(b64.dec), b64.dec(cp.body.root));
  if (!ok) throw new Error("receipt: entry is not in the log");
  return r.leaf;
}
