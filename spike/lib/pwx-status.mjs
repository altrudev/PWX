// Release status: which releases their publishers have withdrawn or revoked (M4 section 5a).
// The loader downloads the whole list from the public log, so no request reveals which apps a
// device has, and checks it here, on the device:
//   status = { checkpoint: signed note, revocations: [{ leaf: { entry, sig, loggedAt }, index, proof }] }
// Every entry must be signed by its author's key and proven to be in a log state enough witnesses
// co-signed. An entry that fails any check is dropped, never shown. Whether an entry applies to an
// installed app (same publisher key, same manifest) is decided by the caller.
import { canonicalize, b64 } from "./pwx-verify.mjs";
import { leafHash, verifyInclusion } from "./pwx-merkle.mjs";
import { verifyCheckpointNote } from "./pwx-note.mjs";

const te = new TextEncoder();
export const REASONS = new Set(["withdrawn", "revoked"]);

async function verifySig(p, value, sig) {
  try {
    if (!p || p.alg !== "ed25519" || typeof p.key !== "string" || typeof sig !== "string") return false;
    const k = await crypto.subtle.importKey("raw", b64.dec(p.key), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, b64.dec(sig), te.encode(canonicalize(value)));
  } catch { return false; }
}

const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : undefined);

// trusts: the logs this loader pins (a list). Returns { origin, size, entries: [...], dropped }
// or throws if the list as a whole can't be trusted (unknown log, checkpoint not witnessed).
export async function checkStatus(status, trusts) {
  if (!status || typeof status !== "object" || typeof status.checkpoint !== "string" || !Array.isArray(status.revocations)) throw new Error("not a release status list");
  if (status.revocations.length > 10000) throw new Error("release status list is too long");
  const origin = status.checkpoint.slice(0, status.checkpoint.indexOf("\n"));
  const trust = [].concat(trusts).find((t) => t && t.origin === origin);
  if (!trust) throw new Error(`release status is from a log this loader doesn't know (${origin.slice(0, 80) || "none"})`);
  let cp;
  try { cp = await verifyCheckpointNote(status.checkpoint, trust); } catch (e) { throw new Error(`release status isn't witnessed (${e.message})`); }
  const entries = []; let dropped = 0;
  for (const r of status.revocations) {
    const e = r?.leaf?.entry;
    const ok = e && e.type === "revoke" && REASONS.has(e.reason) && typeof e.app === "string" && typeof e.manifest === "string"
      && Number.isSafeInteger(r.index) && Array.isArray(r.proof) && r.proof.length <= 64 && Number.isSafeInteger(r.leaf.loggedAt)
      && await verifySig(e.signer, e, r.leaf.sig)
      && await verifyInclusion(r.index, cp.size, await leafHash(te.encode(canonicalize(r.leaf))), r.proof.map(b64.dec), b64.dec(cp.root)).catch(() => false);
    if (!ok) { dropped++; continue; }
    entries.push({ app: e.app, version: text(e.version, 64), manifest: e.manifest, key: e.signer.key, reason: e.reason,
      message: text(e.message, 140), replacement: text(e.replacement, 64), loggedAt: r.leaf.loggedAt });
  }
  return { origin: cp.origin, size: cp.size, entries, dropped };
}

// The entry that applies to an installed app, if any: same app, same publisher key, same manifest.
// "revoked" outranks "withdrawn" if both exist.
export function statusFor(entries, { id, publisher, manifestHash }) {
  const key = String(publisher ?? "").replace(/^ed25519:/, "");
  const mine = entries.filter((e) => e.app === id && e.key === key && e.manifest === manifestHash);
  return mine.find((e) => e.reason === "revoked") ?? mine.find((e) => e.reason === "withdrawn") ?? null;
}
