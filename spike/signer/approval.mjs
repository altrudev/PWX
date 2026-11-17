// PWX Signer spike (M4 section 0): author devices co-sign releases.
// No passkeys and no platform sync: each device makes its own Ed25519 key with WebCrypto,
// non-extractable, and the author's key set lists which device keys belong to them.
//
// An approval signs a small canonical statement about one release. A release counts as
// author-approved only with valid approvals from `threshold` DISTINCT keys in the key set.
import { canonicalize, sha256, b64, strictParse, validateManifest, PwxError } from "../lib/pwx-verify.mjs";

const te = new TextEncoder();
export const manifestHash = async (m) => sha256(te.encode(canonicalize(m)));

// What a device signs. Binding author + id + version + manifest hash means an approval can't
// be replayed for another author, app, version, or different content.
export async function approvalStatement(manifest, authorId) {
  return { type: "pwx-release-approval", v: 1, author: authorId, app: manifest.id, version: manifest.version, manifest: await manifestHash(manifest) };
}

// The approver derives the summary from the package itself, never from text the requesting
// device sends. Compared with the previous release, it lists what the update adds.
export function summarize(manifest, prev = null) {
  const caps = (m) => {
    const c = m?.capabilities ?? {}, out = [];
    for (const h of c.network?.connect ?? []) out.push(`talks to ${h}`);
    if (c.network?.webrtc && c.network.webrtc !== "none") out.push(`direct connections (${c.network.webrtc})`);
    for (const k of ["camera", "microphone", "location", "notifications"]) if (c[k]) out.push(k);
    if (c.storage?.local) out.push("stores data on this device");
    return out;
  };
  const now = caps(manifest), before = new Set(prev ? caps(prev) : []);
  const added = now.filter((x) => !before.has(x));
  return {
    title: `${prev ? "Update" : "Publish"} ${manifest.name ?? manifest.id} ${manifest.version}`,
    from: prev ? prev.version : null,
    added,                       // what's new: shown first, highlighted
    all: now,
    unusual: added.length > 0,   // new permissions must stand out
  };
}

// key set: { author, threshold, keys: ["<b64 raw ed25519>", ...] }
export async function verifyApprovals(manifest, approvals, keySet) {
  if (!keySet || !Array.isArray(keySet.keys) || !(keySet.threshold >= 1)) throw new PwxError("approval", "bad key set");
  const stmt = te.encode(canonicalize(await approvalStatement(manifest, keySet.author)));
  const ok = new Set();
  for (const a of approvals ?? []) {
    if (!a || !keySet.keys.includes(a.key) || ok.has(a.key)) continue;   // unknown or duplicate device
    try {
      const pub = await crypto.subtle.importKey("raw", b64.dec(a.key), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, pub, b64.dec(a.sig), stmt)) ok.add(a.key);
    } catch { /* malformed approval: ignore */ }
  }
  if (ok.size < keySet.threshold) throw new PwxError("approval", `${ok.size} of ${keySet.threshold} required device approvals`);
  return [...ok];
}

// Reads the manifest out of a package (structure checked, signature not yet). The approver
// runs verifyPackage first; this is for the summary.
export function manifestOf(pkgText) {
  return validateManifest(strictParse(strictParse(pkgText).manifest), { allowLoopbackHttp: true });
}
