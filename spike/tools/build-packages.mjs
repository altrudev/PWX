#!/usr/bin/env node
// Builds the spike's test packages into packages/ with a local development key.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pack } from "./pack.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const out = join(ROOT, "packages");
mkdirSync(out, { recursive: true });
const key = join(out, ".dev-key.json");
if (!existsSync(key)) {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  writeFileSync(key, JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)), { mode: 0o600 });
}
// "declared" reuses the leak-test code but declares the canary as an allowed host
// (loopback http is accepted only in dev mode), to show declared hosts still work.
for (const [app, code, dev] of [["evil", "evil", false], ["declared", "evil", true]]) {
  const pkg = await pack(join(ROOT, "apps", code), join(ROOT, "apps", app, "manifest.template.json"), key, { allowLoopbackHttp: dev });
  writeFileSync(join(out, `${app}.pwx.json`), pkg);
  console.log("built", `packages/${app}.pwx.json`);
}
