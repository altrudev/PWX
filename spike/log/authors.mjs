// M4 log spike: who may publish for an author, worked out from the log alone.
// Entry types (all signed; `signer` names the key that signed):
//   key-event create  : { author, keys: [pub], recovery: keyId(recovery pub) }   signed by keys[0]
//   key-event rotate  : { author, add: [pub], remove: [key] }  signed by an active key;
//                       takes effect WAIT after it's logged, unless recovery cancels it first
//   key-event recover : { author, keys: [pub], recovery: keyId(new recovery pub), compromisedSince }
//                       signed by the recovery key committed earlier; takes effect at once,
//                       cancels pending rotations, and invalidates releases signed since then
//   release           : { author, app, version, manifest }      signed by an active key
//   revoke            : { author, manifest }                    signed by an active or recovery key
import { b64 } from "../lib/pwx-verify.mjs";
import { keyId, verifySig, bytes } from "./log.mjs";
import * as M from "./merkle.mjs";
import { verifyCheckpointNote } from "./note.mjs";

export const WAIT = 7 * 24 * 3600 * 1000;   // decided by Altru, 2026-11-16

export async function authorState(leaves, author, now) {
  const st = { created: false, recovery: null, keys: new Map(), pending: [], releases: [], revoked: new Set(), events: [] };
  const applyPending = (t) => {
    for (const p of st.pending) if (!p.done && p.effectiveAt <= t) {
      for (const k of p.remove) { const r = st.keys.get(k); if (r && r.until > p.effectiveAt) r.until = p.effectiveAt; }
      for (const k of p.add) if (!st.keys.has(k.key)) st.keys.set(k.key, { pub: k, from: p.effectiveAt, until: Infinity });
      p.done = true;
    }
  };
  const active = (k, t) => { const r = st.keys.get(k); return Boolean(r && r.from <= t && t < r.until); };
  for (const leaf of leaves) {
    const e = leaf.entry, t = leaf.loggedAt;
    if (e.author !== author) continue;
    if (!(await verifySig(e.signer, e, leaf.sig))) continue;          // never trust an unsigned entry
    applyPending(t);
    if (e.type === "key-event" && e.op === "create") {
      if (st.created || e.signer.key !== e.keys?.[0]?.key) continue;
      st.created = true; st.recovery = e.recovery;
      for (const k of e.keys) st.keys.set(k.key, { pub: k, from: t, until: Infinity });
    } else if (!st.created) {
      continue;
    } else if (e.type === "key-event" && e.op === "rotate") {
      if (!active(e.signer.key, t)) continue;
      st.pending.push({ add: e.add ?? [], remove: e.remove ?? [], effectiveAt: t + WAIT, done: false, at: t });
      st.events.push({ op: "rotate", at: t, effectiveAt: t + WAIT });
    } else if (e.type === "key-event" && e.op === "recover") {
      if (await keyId(e.signer) !== st.recovery) continue;              // only the committed recovery key
      const since = Math.min(e.compromisedSince ?? t, t);
      for (const p of st.pending) if (!p.done) p.done = "cancelled";
      for (const [k, r] of st.keys) if (r.until > since) r.until = since;
      for (const k of e.keys) st.keys.set(k.key, { pub: k, from: t, until: Infinity });
      st.recovery = e.recovery;
      st.events.push({ op: "recover", at: t, since });
    } else if (e.type === "release") {
      st.releases.push({ manifest: e.manifest, app: e.app, version: e.version, key: e.signer.key, at: t });
    } else if (e.type === "revoke") {
      if (active(e.signer.key, t) || await keyId(e.signer) === st.recovery) st.revoked.add(e.manifest);
    }
  }
  applyPending(now);
  return st;
}

// Is this release one the author really published, and still good?
export async function checkRelease(leaves, author, manifest, now) {
  const st = await authorState(leaves, author, now);
  if (!st.created) return { ok: false, reason: "unknown author" };
  const rel = st.releases.filter((r) => r.manifest === manifest);
  if (!rel.length) return { ok: false, reason: "not in the log" };
  if (st.revoked.has(manifest)) return { ok: false, reason: "revoked" };
  const good = rel.find((r) => { const k = st.keys.get(r.key); return k && k.from <= r.at && r.at < k.until; });
  return good ? { ok: true } : { ok: false, reason: "signed by a key that wasn't allowed to publish then" };
}

// A client that fetched the whole log checks it's the same log the witnesses signed, so the
// log can't hide a revocation or a recovery from one client.
// checkpoint: a witnessed checkpoint note.
export async function verifyFullView(leaves, checkpoint, trust) {
  const cp = await verifyCheckpointNote(checkpoint, trust);
  if (leaves.length !== cp.size) throw new Error("view: wrong size");
  const r = await M.root(await Promise.all(leaves.map((l) => M.leafHash(bytes(l)))));
  if (b64.enc(r) !== cp.root) throw new Error("view: entries don't match the witnessed log");
  return true;
}
