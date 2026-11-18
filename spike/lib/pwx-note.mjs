// The public text formats the PWX log uses, so other people's tools can read it:
//   c2sp.org/signed-note        a text plus signature lines:  "— <name> base64(keyID || sig)"
//   c2sp.org/tlog-checkpoint    the body: "<origin>\n<size>\n<base64 root>\n"
//   c2sp.org/tlog-cosignature   witnesses' timestamped Ed25519 co-signatures (cosignature/v1)
// Log and witness keys are Ed25519. Works in browsers and Node: WebCrypto only.
import { b64 } from "./pwx-verify.mjs";

const te = new TextEncoder(), td = new TextDecoder();
const DASH = "— ";
export const ED25519 = 0x01, COSIG_V1 = 0x04;
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; } return out;
};
const sha256 = async (u8) => new Uint8Array(await crypto.subtle.digest("SHA-256", u8));
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const NAME_RE = /^[\x21-\x2a\x2c-\x7e]+$/;   // printable ASCII, no spaces, no "+"

// Key ID: SHA-256(name || "\n" || type || public key)[:4]
export async function keyId(name, type, pubRaw) {
  if (!NAME_RE.test(name)) throw new Error(`note: bad key name ${JSON.stringify(name)}`);
  return (await sha256(cat(te.encode(name + "\n"), Uint8Array.of(type), pubRaw))).slice(0, 4);
}
// Verifier key string, as other tools print it: <name>+<hex key ID>+<base64(type || key)>
export async function vkey(name, type, pubB64) {
  const raw = b64.dec(pubB64);
  return `${name}+${hex(await keyId(name, type, raw))}+${b64.enc(cat(Uint8Array.of(type), raw))}`;
}
export async function parseVkey(s) {
  // The key data is base64, which can itself contain "+", so split only at the first two.
  const m = /^([^+]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/]+=*)$/.exec(String(s));
  if (!m) throw new Error("note: bad verifier key");
  const [, name, id, data] = m;
  const raw = b64.dec(data), type = raw[0], key = raw.slice(1);
  if (key.length !== 32 || hex(await keyId(name, type, key)) !== id) throw new Error("note: verifier key doesn't match its ID");
  return { name, type, key: b64.enc(key) };
}

// ---------- checkpoints ----------
export const checkpointBody = (origin, size, root) => `${origin}\n${size}\n${root}\n`;
export function parseCheckpoint(body) {
  const m = /^([^\n]+)\n(0|[1-9][0-9]{0,15})\n([A-Za-z0-9+/]{43}=)\n$/.exec(body);
  if (!m) throw new Error("checkpoint: malformed");
  const size = Number(m[2]);
  if (!Number.isSafeInteger(size)) throw new Error("checkpoint: size too large");
  return { origin: m[1], size, root: m[3] };
}

// ---------- notes ----------
export function parseNote(text) {
  if (typeof text !== "string" || text.length > 1 << 20) throw new Error("note: not text");
  const at = text.lastIndexOf("\n\n");
  if (at < 0 || !text.endsWith("\n")) throw new Error("note: malformed");
  const body = text.slice(0, at + 1), sigs = [];
  for (const line of text.slice(at + 2, -1).split("\n")) {
    if (!line.startsWith(DASH)) throw new Error("note: malformed signature line");
    const [name, data, extra] = line.slice(DASH.length).split(" ");
    if (extra !== undefined || !NAME_RE.test(name ?? "") || !/^[A-Za-z0-9+/]+=*$/.test(data ?? "")) throw new Error("note: malformed signature line");
    const raw = b64.dec(data);
    if (raw.length < 5) throw new Error("note: signature too short");
    sigs.push({ name, id: raw.slice(0, 4), sig: raw.slice(4), line: line + "\n" });
  }
  if (!sigs.length) throw new Error("note: no signatures");
  return { body, sigs };
}
export const joinNote = (body, lines) => body + "\n" + lines.join("");

const importEd = (pubB64) => crypto.subtle.importKey("raw", b64.dec(pubB64), { name: "Ed25519" }, false, ["verify"]);
const sameId = (a, b) => a.length === 4 && a.every((x, i) => x === b[i]);

// The log's own signature line over a body. key: { priv (Ed25519), key: base64 public key }
export async function signLine(body, name, key) {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.priv, te.encode(body)));
  return `${DASH}${name} ${b64.enc(cat(await keyId(name, ED25519, b64.dec(key.key)), sig))}\n`;
}
const cosigMessage = (body, time) => te.encode(`cosignature/v1\ntime ${time}\n${body}`);
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n)); return b; };
// A witness's co-signature line: key ID || u64 time (seconds) || Ed25519 signature.
export async function cosignLine(body, name, key, time) {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.priv, cosigMessage(body, time)));
  return `${DASH}${name} ${b64.enc(cat(await keyId(name, COSIG_V1, b64.dec(key.key)), u64(time), sig))}\n`;
}

// Signed by this key (name + key ID must match; unknown keys are ignored, as the spec says).
async function logSigned(note, k) {
  const id = await keyId(k.name, ED25519, b64.dec(k.key)), key = await importEd(k.key);
  for (const s of note.sigs) {
    if (s.name === k.name && sameId(s.id, id) && s.sig.length === 64 && await crypto.subtle.verify({ name: "Ed25519" }, key, s.sig, te.encode(note.body))) return true;
  }
  return false;
}
// The witness's co-signature time (seconds), or null if it didn't validly co-sign.
async function cosignedAt(note, w) {
  const id = await keyId(w.name, COSIG_V1, b64.dec(w.key)), key = await importEd(w.key);
  for (const s of note.sigs) {
    if (s.name !== w.name || !sameId(s.id, id) || s.sig.length !== 72) continue;
    const time = Number(new DataView(s.sig.buffer, s.sig.byteOffset, 8).getBigUint64(0));
    if (await crypto.subtle.verify({ name: "Ed25519" }, key, s.sig.slice(8), cosigMessage(note.body, time))) return time;
  }
  return null;
}

// trust: { origin, log: { name, key }, witnesses: [{ name, key }], quorum }
// A checkpoint counts only if the log signed it and `quorum` distinct known witnesses co-signed it.
export async function verifyCheckpointNote(text, trust) {
  const note = parseNote(text), cp = parseCheckpoint(note.body);
  if (cp.origin !== trust.origin || !(await logSigned(note, trust.log))) throw new Error("checkpoint not signed by the log");
  const cosigned = [];
  for (const w of trust.witnesses ?? []) {
    if (cosigned.some((c) => c.key === w.key)) continue;
    const time = await cosignedAt(note, w);
    if (time !== null) cosigned.push({ name: w.name, key: w.key, time });
  }
  if (cosigned.length < trust.quorum) throw new Error(`${cosigned.length} of ${trust.quorum} witnesses`);
  return { ...cp, cosigned };
}
export const logSignedOnly = async (text, k) => {
  const note = parseNote(text), cp = parseCheckpoint(note.body);
  return (await logSigned(note, k)) ? { ...cp, note } : null;
};
