// Spike tests 2-5 (spec section 10): manifest injection, JSON representation,
// file swap and rollback. Each test tries to break one claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPackage, validateManifest, buildHeaders, canonicalize, strictParse, PwxError, b64, sha256 } from "../lib/pwx-verify.mjs";
import { pack } from "../tools/pack.mjs";

const dir = mkdtempSync(join(tmpdir(), "pwx-"));
const keyPath = join(dir, "key.json");
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
writeFileSync(keyPath, JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)));
const appDir = join(dir, "app"); mkdirSync(appDir);
writeFileSync(join(appDir, "index.html"), "<!doctype html><p>hi</p>");
writeFileSync(join(appDir, "app.js"), "console.log(1)");

const base = { pwx: "0", id: "org.example.t", name: "T", version: "1.0.0", entry: "app/index.html",
  capabilities: { network: { connect: ["wss://relay.example.org"], webrtc: "none" } } };
async function build(overrides = {}) {
  const p = join(dir, "tpl.json");
  writeFileSync(p, JSON.stringify({ ...base, ...overrides }));
  return pack(appDir, p, keyPath);
}
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof PwxError && e.code === code);

test("baseline: a valid package verifies", async () => {
  const { manifest, files } = await verifyPackage(await build());
  assert.equal(manifest.id, "org.example.t");
  assert.deepEqual(Object.keys(files).sort(), ["app/app.js", "app/index.html"]);
});

// ---- Test 2: manifest injection ----
const badOrigins = [
  "https://a.com; script-src *", "https://a.com https://evil.com", "https://A.com", "https://a.com/",
  "https://a.com/path", "https://*.a.com", "*", "'self'", "https://a.com:99999", "https://a.com:0",
  "http://a.com", "javascript:alert(1)", "https://a.com\nscript-src *", "https://аpple.com", // Cyrillic a
  "https://a.com,https://b.com", "wss://a.com?x=1", "https://user@a.com", "https://a..com", "https://-a.com",
];
for (const o of badOrigins) {
  test(`test 2: origin rejected ${JSON.stringify(o)}`, () => {
    assert.throws(() => validateManifest({ ...base, files: { "app/index.html": "sha256-" + "A".repeat(43) + "=" },
      publisher: "ed25519:x", capabilities: { network: { connect: [o] } } }), PwxError);
  });
}
test("test 2: valid origins produce exact connect-src and no extra directives", () => {
  const m = { ...base, capabilities: { network: { connect: ["https://a.example", "wss://relay.example.org:8443"] } } };
  const csp = buildHeaders(m, "https://loader.example")["Content-Security-Policy"];
  assert.match(csp, /connect-src https:\/\/a\.example wss:\/\/relay\.example\.org:8443;/);
  assert.equal(csp.split(";").filter((d) => d.trim().startsWith("script-src")).length, 1);
});
test("test 2: packer refuses to sign an injected manifest", async () => {
  await assert.rejects(build({ capabilities: { network: { connect: ["https://a.com; script-src *"] } } }), PwxError);
});

// ---- Test 3: duplicate keys and canonical form ----
test("test 3: duplicate keys rejected (JSON.parse would silently keep the last)", () => {
  const text = '{"a":1,"a":2}';
  assert.equal(JSON.parse(text).a, 2);
  assert.throws(() => strictParse(text), /duplicate key/);
});
test("test 3: duplicate capability key inside a signed package is rejected", async () => {
  const pkg = JSON.parse(await build());
  pkg.manifest = pkg.manifest.replace('"capabilities": {', '"capabilities": {\n    "camera": true,\n    "camera": false,');
  await rejects(verifyPackage(JSON.stringify(pkg)), "json");
});
test("test 3: reordered and re-spaced manifest verifies identically", async () => {
  const pkg = JSON.parse(await build());
  const m = JSON.parse(pkg.manifest);
  const reordered = Object.fromEntries(Object.entries(m).reverse());
  pkg.manifest = JSON.stringify(reordered);
  const { manifest } = await verifyPackage(JSON.stringify(pkg));
  assert.equal(canonicalize(manifest), canonicalize(m));
});
test("test 3: non-integer numbers and trailing data rejected", () => {
  assert.throws(() => strictParse('{"a":1.5}'), PwxError);
  assert.throws(() => strictParse('{"a":1e3}'), PwxError);
  assert.throws(() => strictParse('{"a":1} x'), PwxError);
});
test("test 3: changing a signed field breaks the signature", async () => {
  const pkg = JSON.parse(await build());
  pkg.manifest = pkg.manifest.replace("wss://relay.example.org", "wss://evil.example.org");
  await rejects(verifyPackage(JSON.stringify(pkg)), "signature");
});

// ---- Test 4: file swap ----
test("test 4: one changed byte in any file is rejected", async () => {
  const pkg = JSON.parse(await build());
  const bytes = b64.dec(pkg.files["app/app.js"]); bytes[0] ^= 1;
  pkg.files["app/app.js"] = b64.enc(bytes);
  await rejects(verifyPackage(JSON.stringify(pkg)), "files");
});
test("test 4: an unlisted extra file is rejected", async () => {
  const pkg = JSON.parse(await build());
  pkg.files["app/extra.js"] = b64.enc(new TextEncoder().encode("evil()"));
  await rejects(verifyPackage(JSON.stringify(pkg)), "files");
});
test("test 4: a missing listed file is rejected", async () => {
  const pkg = JSON.parse(await build());
  delete pkg.files["app/app.js"];
  await rejects(verifyPackage(JSON.stringify(pkg)), "files");
});
test("test 4: path traversal in the manifest is rejected", () => {
  for (const p of ["app/../x.js", "../x.js", "app//x.js", "/app/x.js", "app/.hidden/../x"]) {
    assert.throws(() => validateManifest({ ...base, publisher: "ed25519:x", entry: "app/index.html",
      files: { "app/index.html": "sha256-" + "A".repeat(43) + "=", [p]: "sha256-" + "A".repeat(43) + "=" } }), PwxError, p);
  }
});
test("test 4: a different publisher key re-signing the app is caught when the publisher is pinned", async () => {
  const first = await verifyPackage(await build());
  const kp2 = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const key2 = join(dir, "key2.json");
  writeFileSync(key2, JSON.stringify(await crypto.subtle.exportKey("jwk", kp2.privateKey)));
  const p = join(dir, "tpl.json"); writeFileSync(p, JSON.stringify(base));
  const resigned = await pack(appDir, p, key2);
  await rejects(verifyPackage(resigned, { trustedPublisher: first.manifest.publisher }), "signature");
});

// ---- Test 5: rollback ----
test("test 5: an older validly signed version is rejected", async () => {
  await rejects(verifyPackage(await build({ version: "1.0.0" }), { installedVersion: "1.2.0" }), "rollback");
  await rejects(verifyPackage(await build({ version: "1.2.0" }), { installedVersion: "1.2.0" }), "rollback");
  await verifyPackage(await build({ version: "1.10.0" }), { installedVersion: "1.9.0" });
});

test("sanity: sha256 helper matches SRI format", async () => {
  assert.match(await sha256(new Uint8Array([1])), /^sha256-[A-Za-z0-9+/]{43}=$/);
});
