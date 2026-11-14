#!/usr/bin/env node
// Signs a pwx-local release: hashes every file the local loader serves and signs the list.
//   node tools/make-release.mjs <version> [release-key.json]
// The public key is written to local/release.pub. In a real distribution it is compiled into
// the signed pwx-local binary; the OS code signature is the root of trust.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, sha256, b64 } from "../lib/pwx-verify.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const [version = "0.0.0-dev", keyPath = join(ROOT, "packages/.release-key.json")] = process.argv.slice(2);
if (!existsSync(keyPath)) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  writeFileSync(keyPath, JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)), { mode: 0o600 });
}
const jwk = JSON.parse(readFileSync(keyPath, "utf8"));
const priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
const pub = b64.enc(b64.dec(jwk.x.replace(/-/g, "+").replace(/_/g, "/") + "="));

const walk = (d) => readdirSync(d).flatMap((n) => statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]);
const files = {};
for (const dir of ["lib", "loader", "app-origin"]) {
  for (const abs of walk(join(ROOT, dir)).sort()) {
    files[relative(ROOT, abs)] = await sha256(new Uint8Array(readFileSync(abs)));
  }
}
const release = { version, files };
const sig = b64.enc(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(canonicalize(release)))));
writeFileSync(join(ROOT, "local/release.json"), JSON.stringify({ release, sig: { alg: "ed25519", key: pub, sig } }, null, 2) + "\n");
writeFileSync(join(ROOT, "local/release.pub"), pub + "\n");
console.log(`signed release ${version}: ${Object.keys(files).length} files`);
