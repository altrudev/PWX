// PWX Signer spike (M4 section 0): author devices co-sign releases.
// No passkeys and no platform sync. Two kinds of device key (option 3 in SIGNER-SPIKE.md):
//   "pin"      : browser key, stored only encrypted with the author's passphrase (Ed25519)
//   "hardware" : key inside the device's security chip, via pwx-local or ALTRU OS. Chips
//                (TPM, Secure Enclave, Android Keystore) sign with ECDSA P-256, so that is
//                accepted too.
// An approval signs a canonical statement about one release. A release counts as
// author-approved only with valid approvals from `threshold` DISTINCT devices in the key set.
import { canonicalize, sha256, b64, strictParse, validateManifest, PwxError } from "../lib/pwx-verify.mjs";

const te = new TextEncoder();
export const manifestHash = async (m) => sha256(te.encode(canonicalize(m)));
export const ALGS = {
  ed25519: { imp: { name: "Ed25519" }, ver: { name: "Ed25519" } },
  p256: { imp: { name: "ECDSA", namedCurve: "P-256" }, ver: { name: "ECDSA", hash: "SHA-256" } }, // raw r||s, 64 bytes
};
const KINDS = new Set(["pin", "hardware"]);

// What a device signs. Binding author + id + version + manifest hash means an approval can't
// be replayed for another author, app, version, or different content.
export async function approvalStatement(manifest, authorId) {
  return { type: "pwx-release-approval", v: 1, author: authorId, app: manifest.id, version: manifest.version, manifest: await manifestHash(manifest) };
}
export const statementBytes = async (manifest, authorId) => te.encode(canonicalize(await approvalStatement(manifest, authorId)));

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
  return { title: `${prev ? "Update" : "Publish"} ${manifest.name ?? manifest.id} ${manifest.version}`,
    from: prev ? prev.version : null, added, all: now, unusual: added.length > 0 };
}

// key set: { author, threshold, devices: [{ name, key, alg: "ed25519"|"p256", kind: "pin"|"hardware" }] }
function checkKeySet(ks) {
  if (!ks || typeof ks.author !== "string" || !Array.isArray(ks.devices) || !(ks.threshold >= 1) || ks.threshold > ks.devices.length) {
    throw new PwxError("approval", "bad key set");
  }
  for (const d of ks.devices) {
    if (!d || typeof d.key !== "string" || !ALGS[d.alg] || !KINDS.has(d.kind)) throw new PwxError("approval", "bad device in key set");
  }
}

// Returns the devices that approved. The device's kind comes from the key set, never from the
// approval, so a browser key can't claim to be hardware.
export async function verifyApprovals(manifest, approvals, keySet) {
  checkKeySet(keySet);
  const stmt = await statementBytes(manifest, keySet.author);
  const ok = new Map();
  for (const a of approvals ?? []) {
    const dev = keySet.devices.find((d) => a && d.key === a.key && d.alg === a.alg);
    if (!dev || ok.has(dev.key)) continue;                     // unknown device, wrong alg, or duplicate
    try {
      const pub = await crypto.subtle.importKey("raw", b64.dec(a.key), ALGS[dev.alg].imp, false, ["verify"]);
      if (await crypto.subtle.verify(ALGS[dev.alg].ver, pub, b64.dec(a.sig), stmt)) ok.set(dev.key, dev);
    } catch { /* malformed approval: ignore */ }
  }
  if (ok.size < keySet.threshold) throw new PwxError("approval", `${ok.size} of ${keySet.threshold} required device approvals`);
  return [...ok.values()];
}

// What the loader shows next to a release: "Approved on 2 devices (1 hardware-protected)".
export function describe(devices) {
  const hw = devices.filter((d) => d.kind === "hardware").length;
  return `Approved on ${devices.length} device${devices.length === 1 ? "" : "s"}` + (hw ? ` (${hw} hardware-protected)` : "");
}

// Reads the manifest out of a package (structure checked, signature not yet). The approver
// runs verifyPackage first; this is for the summary.
export function manifestOf(pkgText) {
  return validateManifest(strictParse(strictParse(pkgText).manifest), { allowLoopbackHttp: true });
}
