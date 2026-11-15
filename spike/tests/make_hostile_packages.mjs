#!/usr/bin/env node
// Builds the packages a hijacked loader might push at the Notes origin. Prints one JSON object.
//   forged:  Notes' id and a higher version, signed with a different key
//   older:   genuine key, lower version
//   swapped: genuine key, same version, different contents
//   broken:  the genuine package with one file byte changed
//   other:   a genuine package for a different app
//   newer:   genuine key, higher version (must be accepted)
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { pack } from "../tools/pack.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const tmp = mkdtempSync(join(tmpdir(), "pwx-hostile-"));
const devKey = join(process.env.PWX_KEYS ?? join(homedir(), ".config/pwx-dev"), "dev-key.json");
const otherKey = join(tmp, "other-key.json");
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
writeFileSync(otherKey, JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)));

const template = JSON.parse(readFileSync(join(ROOT, "apps/notes/manifest.template.json"), "utf8"));
const [a, b, c] = template.version.split(".").map(Number);
const build = async (name, changes, key) => {
  const t = join(tmp, `${name}.json`);
  writeFileSync(t, JSON.stringify({ ...template, ...changes }));
  return pack(join(ROOT, "apps/notes"), t, key);
};
const genuine = readFileSync(join(ROOT, "packages/notes.pwx.json"), "utf8");
const broken = JSON.parse(genuine);
const first = Object.keys(broken.files)[0];
broken.files[first] = Buffer.from("// replaced by a hijacked loader").toString("base64");

console.log(JSON.stringify({
  forged: await build("forged", { version: `${a}.${b}.${c + 5}` }, otherKey),
  older: await build("older", { version: "0.0.1" }, devKey),
  swapped: await build("swapped", { name: "Notes (swapped)" }, devKey),
  broken: JSON.stringify(broken),
  other: readFileSync(join(ROOT, "packages/evil-strict.pwx.json"), "utf8"),
  newer: await build("newer", { version: `${a}.${b}.${c + 1}` }, devKey),
}));
