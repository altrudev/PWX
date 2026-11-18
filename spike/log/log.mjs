// M4 public log: an append-only log, witnesses, and receipts, in the public C2SP formats.
// - Every entry is signed by its author; the log only orders and timestamps entries, it can't
//   forge them.
// - The log signs checkpoints (c2sp.org/tlog-checkpoint as a signed note). Witnesses co-sign a
//   checkpoint (c2sp.org/tlog-cosignature) only after checking it extends the last one they saw,
//   so a log can't show different people different histories.
// - The log is published as static files (tiles.mjs), so ordinary hosting can serve it.
// - A receipt (entry + index + inclusion proof + witnessed checkpoint) lets anyone check offline
//   that an entry is in the log.
import { canonicalize, b64 } from "../lib/pwx-verify.mjs";
import { ALGS } from "../signer/approval.mjs";
import * as M from "./merkle.mjs";
import * as N from "./note.mjs";
import { buildTiles } from "./tiles.mjs";

const te = new TextEncoder();
export const bytes = (v) => te.encode(canonicalize(v));

// ---------- keys and signatures (Ed25519, or ECDSA P-256 for authors' hardware keys) ----------
export async function newKey(alg = "ed25519") {
  const kp = await crypto.subtle.generateKey(alg === "p256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "Ed25519" }, false, ["sign", "verify"]);
  return { alg, priv: kp.privateKey, key: b64.enc(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
}
export const pub = (k) => ({ key: k.key, alg: k.alg });
// Ed25519 keys kept in a file (the log's and witnesses' keys, outside any served folder).
export async function newEd25519Jwk() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return crypto.subtle.exportKey("jwk", kp.privateKey);
}
export async function keyFromJwk(jwk) {
  if (jwk?.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string") throw new Error("key: expected an Ed25519 private key");
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  return { alg: "ed25519", priv, key: b64.enc(b64.dec(jwk.x.replace(/-/g, "+").replace(/_/g, "/") + "=")) };
}
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
export const leafBytes = (leaf) => bytes(leaf);

// ---------- the log ----------
// The log's key name is its origin, as C2SP logs do. Log and witness keys are Ed25519.
export class Log {
  constructor(origin, key, clock = () => Date.now()) {
    if (key.alg !== "ed25519") throw new Error("log: the log key must be Ed25519");
    this.origin = origin; this.key = key; this.clock = clock; this.leaves = []; this.hashes = [];
  }
  get vkey() { return { name: this.origin, key: this.key.key }; }
  // Appends an entry if its signature is valid. Returns its index.
  async append(signed) {
    if (!signed?.entry || !(await verifySig(signed.entry.signer, signed.entry, signed.sig))) throw new Error("log: bad entry signature");
    const leaf = { entry: signed.entry, sig: signed.sig, loggedAt: this.clock() };
    this.leaves.push(leaf); this.hashes.push(await M.leafHash(leafBytes(leaf)));
    return this.leaves.length - 1;
  }
  // A checkpoint for the current size, signed by the log (a signed note, before witnesses add lines).
  async checkpoint(size = this.leaves.length) {
    const body = N.checkpointBody(this.origin, size, b64.enc(await M.root(this.hashes.slice(0, size))));
    return N.joinNote(body, [await N.signLine(body, this.origin, this.key)]);
  }
  inclusion(i, size = this.leaves.length) { return M.inclusionProof(i, this.hashes.slice(0, size)); }
  consistency(m, n = this.leaves.length) { return M.consistencyProof(m, this.hashes.slice(0, n)); }
  // Every file a static host needs to serve the log: the checkpoint (with co-signatures) and tiles.
  async files(checkpointNote) {
    const files = await buildTiles(this.leaves.map(leafBytes), this.hashes);
    files.set("checkpoint", te.encode(checkpointNote));
    return files;
  }
}

// ---------- witnesses ----------
// name: the witness's key name (a schema-less URL); log: { name, key } of the log it watches.
export class Witness {
  constructor(name, key, log, origin, clock = () => Date.now()) {
    if (key.alg !== "ed25519") throw new Error("witness: the witness key must be Ed25519");
    this.name = name; this.key = key; this.log = log; this.origin = origin; this.clock = clock; this.last = null; this.evidence = [];
  }
  get vkey() { return { name: this.name, key: this.key.key }; }
  // Co-signs only a checkpoint the log signed that extends the last one this witness saw.
  // Returns a signature line to add to the note, or null.
  async cosign(note, proof = []) {
    let cp;
    try { cp = await N.logSignedOnly(note, this.log); } catch { return null; }
    if (!cp || cp.origin !== this.origin) return null;
    if (this.last) {
      const ok = cp.size >= this.last.size && await M.verifyConsistency(this.last.size, cp.size,
        b64.dec(this.last.root), b64.dec(cp.root), (proof ?? []).map(b64.dec));
      if (!ok) { this.evidence.push({ seen: this.last, conflicting: note }); return null; }   // split view or rewrite
    }
    this.last = { size: cp.size, root: cp.root };
    return N.cosignLine(cp.note.body, this.name, this.key, Math.floor(this.clock() / 1000));
  }
}
export const addCosigs = (note, lines) => note + lines.filter(Boolean).join("");

// ---------- receipts ----------
// checkpoint: the note with the log's signature and the witnesses' co-signatures.
export async function receipt(log, index, checkpoint) {
  const { size } = N.parseCheckpoint(N.parseNote(checkpoint).body);
  return { leaf: log.leaves[index], index, checkpoint, proof: (await log.inclusion(index, size)).map((h) => b64.enc(h)) };
}

// trust: { origin, log: { name, key }, witnesses: [{ name, key }], quorum }
export const verifyCheckpoint = (note, trust) => N.verifyCheckpointNote(note, trust);

// Checks a receipt fully offline. Returns the leaf if it's genuinely in a witnessed log state.
export async function verifyReceipt(r, trust) {
  let cp;
  try { cp = await N.verifyCheckpointNote(r?.checkpoint, trust); } catch (e) { throw new Error("receipt: " + e.message); }
  if (!(await verifySig(r.leaf?.entry?.signer, r.leaf.entry, r.leaf.sig))) throw new Error("receipt: entry signature invalid");
  if (!Number.isSafeInteger(r.index) || !Array.isArray(r.proof) || r.proof.length > 64) throw new Error("receipt: malformed");
  const ok = await M.verifyInclusion(r.index, cp.size, await M.leafHash(leafBytes(r.leaf)), r.proof.map(b64.dec), b64.dec(cp.root));
  if (!ok) throw new Error("receipt: entry is not in the log");
  return r.leaf;
}
