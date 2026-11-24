// The spike's development log: what tools/pin-runtime.mjs pins into the loader, and what
// tools/build-packages.mjs logs the test packages in. Its log and witness keys are kept with the
// other dev keys (never in the repo). The witnesses are not independent yet: that needs other
// people running them (M4.md, section 2), so this log is for testing the receipt path only.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { canonicalize, sha256, strictParse } from "../lib/pwx-verify.mjs";
import { Log, Witness, signEntry, newEd25519Jwk, keyFromJwk, receipt, addCosigs } from "./log.mjs";
import { writeFiles } from "./static.mjs";

export const DEV = { origin: "dev.log.pwx.altru.dev", witnesses: ["w1.dev.pwx.altru.dev", "w2.dev.pwx.altru.dev"], quorum: 2 };
export const KEYS = () => process.env.PWX_KEYS ?? join(homedir(), ".config/pwx-dev");

// An Ed25519 key kept in the dev key folder, made on first use.
export async function fileKey(file) {
  const path = join(KEYS(), file);
  if (!existsSync(path)) {
    await mkdir(KEYS(), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(await newEd25519Jwk()), { mode: 0o600 });
  }
  return keyFromJwk(JSON.parse(await readFile(path, "utf8")));
}
// The dev log's key, or another log's key file named in $PWX_LOG_KEY (e.g. public-log-key.json).
export const logKey = () => fileKey(process.env.PWX_LOG_KEY ?? "log-key.json");
export const PUBLIC = { origin: "pwx.altru.dev/log", url: "https://pwx.altru.dev/log/", keyFile: "public-log-key.json" };
// The public log's trust: its key, and the witnesses listed in log/public-witnesses.json
// (their public keys, as each witness's operator hands them over).
export async function publicTrust() {
  const lk = await fileKey(PUBLIC.keyFile);
  const { witnesses, quorum } = JSON.parse(await readFile(new URL("./public-witnesses.json", import.meta.url), "utf8"));
  return { origin: PUBLIC.origin, log: { name: PUBLIC.origin, key: lk.key }, witnesses, quorum };
}
export const witnessKey = (name) => fileKey(`witness-${name.replace(/[^A-Za-z0-9.-]/g, "_")}.json`);

export async function devTrust() {
  const lk = await logKey(), ws = [];
  for (const name of DEV.witnesses) ws.push({ name, key: (await witnessKey(name)).key });
  return { origin: DEV.origin, log: { name: DEV.origin, key: lk.key }, witnesses: ws, quorum: DEV.quorum };
}

// Logs a release entry for each package (signed by its publisher key), has the witnesses co-sign,
// and returns each package with its receipt added. Writes the log's static files to `dir`.
export async function logPackages(pkgTexts, publisherKey, dir) {
  const log = new Log(DEV.origin, await logKey());
  const ws = [];
  for (const name of DEV.witnesses) ws.push(new Witness(name, await witnessKey(name), log.vkey, DEV.origin));
  const idx = [];
  for (const text of pkgTexts) {
    const pkg = strictParse(text), manifest = strictParse(pkg.manifest);
    if (pkg.sig.key !== publisherKey.key) throw new Error(`devlog: ${manifest.id} isn't signed by this publisher key`);
    idx.push(await log.append(await signEntry(publisherKey, { type: "release", author: manifest.publisher, app: manifest.id,
      version: manifest.version, manifest: await sha256(new TextEncoder().encode(canonicalize(manifest))) })));
  }
  const note = await log.checkpoint();
  const cp = addCosigs(note, await Promise.all(ws.map((w) => w.cosign(note, []))));
  if (dir) await writeFiles(dir, await log.files(cp));
  return Promise.all(pkgTexts.map(async (text, i) => JSON.stringify({ ...JSON.parse(text), receipt: await receipt(log, idx[i], cp) })));
}
