// Audit only: signs the malicious test app with the spike's dev key, like any publisher could.
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const SPIKE = join(HERE, "..");
const { pack } = await import(join(SPIKE, "tools/pack.mjs"));
const pkg = await pack(join(HERE, "apps/thief"), join(HERE, "apps/thief/manifest.template.json"), join(process.env.HOME, ".config/pwx-dev/dev-key.json"));
writeFileSync(join(SPIKE, "packages/thief.pwx.json"), pkg);
console.log("built packages/thief.pwx.json (signed, verifies like any app)");
