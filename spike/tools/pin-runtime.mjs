#!/usr/bin/env node
// Pins the PWX runtime: writes the SHA-256 of every runtime file into app-origin/sw.js, so the
// service worker can refuse any copy that doesn't match. Run after changing a runtime file
// (and before tools/make-release.mjs, which hashes sw.js too).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../lib/pwx-verify.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const FILES = { "/__pwx/bootstrap.html": "bootstrap.html", "/__pwx/bootstrap.js": "bootstrap.js",
  "/__pwx/strict.html": "strict.html", "/__pwx/renderer.js": "renderer.js",
  "/__pwx/guard.js": "guard.js", "/__pwx/ui.css": "ui.css" };
const pinned = {};
for (const [path, file] of Object.entries(FILES)) {
  pinned[path] = await sha256(new Uint8Array(readFileSync(join(ROOT, "app-origin", file))));
}
const swPath = join(ROOT, "app-origin/sw.js");
const sw = readFileSync(swPath, "utf8");
const block = /(\/\/ BEGIN PINNED RUNTIME[^\n]*\n)[\s\S]*?(\/\/ END PINNED RUNTIME)/;
if (!block.test(sw)) throw new Error("pin markers not found in sw.js");
writeFileSync(swPath, sw.replace(block, `$1const PINNED = ${JSON.stringify(pinned, null, 2)};\n$2`));
console.log(`pinned ${Object.keys(pinned).length} runtime files in app-origin/sw.js`);
