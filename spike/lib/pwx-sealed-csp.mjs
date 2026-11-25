// The loader page's CSP pins the sealed runtime (Quarantine Part 1): only these exact inline
// bytes may run in a sealed app frame. Node side; loader/sw.js gets the same values written in by
// tools/pin-runtime.mjs, and the signed loader release covers both files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const h = (p) => "'sha256-" + createHash("sha256").update(readFileSync(p)).digest("base64") + "'";
export function sealedPins(loaderDir) {
  return { script: h(join(loaderDir, "sealed-runtime.js")), style: h(join(loaderDir, "sealed.css")) };
}
// frames: the app origins this loader may still frame (Standard apps until Step B).
export function loaderCsp(loaderDir, frames) {
  const p = sealedPins(loaderDir);
  return `default-src 'self'; script-src 'self' ${p.script}; style-src 'self' ${p.style}; worker-src 'self' data:; connect-src 'self'; frame-src ${frames}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
