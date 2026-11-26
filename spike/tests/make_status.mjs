// Test helper: writes a release status list (M4 5a) from the spike's dev log, as the public log's
// `pwx-log status` would. Steps run in order, so each list is a longer log than the one before:
//   node tests/make_status.mjs <out.json> <step,step,...> [message]
// steps: release (log Notes' release) | withdrawn | revoked (signed by Notes' publisher key)
//        | forged (a revoke of Notes signed by some other key: loaders must ignore it)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256, strictParse } from "../lib/pwx-verify.mjs";
import { Log, Witness, signEntry, keyFromJwk, newEd25519Jwk, receipt, addCosigs } from "../log/log.mjs";
import { DEV, KEYS, logKey, witnessKey } from "../log/devlog.mjs";

const [out, steps, message] = process.argv.slice(2);
const ROOT = new URL("..", import.meta.url).pathname;
const pkg = strictParse(readFileSync(join(ROOT, "packages/notes.pwx.json"), "utf8")), m = strictParse(pkg.manifest);
const hash = await sha256(new TextEncoder().encode(canonicalize(m)));
const publisher = await keyFromJwk(JSON.parse(readFileSync(join(KEYS(), "dev-key.json"), "utf8")));
const log = new Log(DEV.origin, await logKey());
const revokes = [];
for (const step of steps.split(",")) {
  if (step === "release") { await log.append(await signEntry(publisher, { type: "release", author: m.publisher, app: m.id, version: m.version, manifest: hash })); continue; }
  const key = step === "forged" ? await keyFromJwk(await newEd25519Jwk()) : publisher;
  const reason = step === "forged" ? "revoked" : step;
  revokes.push(await log.append(await signEntry(key, { type: "revoke", reason, author: m.publisher, app: m.id, version: m.version, manifest: hash,
    ...(message ? { message } : {}) })));
}
const ws = [];
for (const name of DEV.witnesses) ws.push(new Witness(name, await witnessKey(name), log.vkey, DEV.origin));
const note = await log.checkpoint();
const cp = addCosigs(note, await Promise.all(ws.map((w) => w.cosign(note, []))));
const revocations = await Promise.all(revokes.map(async (i) => { const r = await receipt(log, i, cp); return { leaf: r.leaf, index: r.index, proof: r.proof }; }));
writeFileSync(out, JSON.stringify({ checkpoint: cp, revocations }));
console.log(`status: ${steps} -> size ${log.leaves.length}, ${revocations.length} revocation entries`);
