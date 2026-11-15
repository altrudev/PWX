#!/usr/bin/env node
// Usage:
//   node tools/pack.mjs keygen <keyfile>
//   node tools/pack.mjs pack <appdir> <manifest-template.json> <keyfile> <out.pwx.json>
// The template supplies id, name, version, entry and capabilities; the packer adds
// publisher and the file hashes, signs the canonical manifest, and writes the package.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { canonicalize, sha256, strictParse, validateManifest, b64 } from "../lib/pwx-verify.mjs";

const [cmd, ...args] = process.argv.slice(2);

async function keygen(out) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  writeFileSync(out, JSON.stringify(jwk), { mode: 0o600 });
  console.log("wrote", out);
}

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export async function pack(appDir, templatePath, keyPath, opts = {}) {
  const template = strictParse(readFileSync(templatePath, "utf8"));
  const jwk = JSON.parse(readFileSync(keyPath, "utf8"));
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const pubRaw = b64.dec(jwk.x.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const key = b64.enc(pubRaw);

  const files = {}, hashes = {};
  for (const abs of walk(appDir).sort()) {
    const rel = relative(appDir, abs);
    if (rel === "manifest.template.json" || rel.split(/[\\/]/).some((part) => part.startsWith("."))) continue;
    const path = "app/" + relative(appDir, abs).split("\\").join("/");
    const bytes = new Uint8Array(readFileSync(abs));
    files[path] = b64.enc(bytes);
    hashes[path] = await sha256(bytes);
  }
  const manifest = { ...template, publisher: `ed25519:${key}`, files: hashes };
  validateManifest(manifest, opts);
  const canonical = canonicalize(manifest);
  const sig = b64.enc(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(canonical))));
  return JSON.stringify({ manifest: JSON.stringify(manifest, null, 2), sig: { alg: "ed25519", key, sig }, files });
}

if (cmd === "keygen") await keygen(args[0]);
else if (cmd === "pack") {
  const [appDir, tpl, keyfile, out] = args;
  writeFileSync(out, await pack(appDir, tpl, keyfile, { allowLoopbackHttp: process.env.PWX_DEV === "1" }));
  console.log("wrote", out);
} else if (cmd) {
  console.error("unknown command"); process.exit(2);
}
