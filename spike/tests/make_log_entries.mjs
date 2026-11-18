#!/usr/bin/env node
// Writes signed log entries for the static-log test: an author's key-event, then releases.
//   node tests/make_log_entries.mjs <out.json> <count> [startVersion]
// The author key is made fresh each time unless $PWX_TEST_AUTHOR (a JWK file) exists.
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { signEntry, pub, keyId, newKey, keyFromJwk, newEd25519Jwk } from "../log/log.mjs";

const [out, count = "3", start = "0"] = process.argv.slice(2);
const file = process.env.PWX_TEST_AUTHOR ?? "/tmp/pwx-test-author.json";
const first = !existsSync(file);
if (first) await writeFile(file, JSON.stringify(await newEd25519Jwk()), { mode: 0o600 });
const author = await keyFromJwk(JSON.parse(await readFile(file, "utf8")));
const entries = [];
if (first) entries.push(await signEntry(author, { type: "key-event", op: "create", author: "test", keys: [pub(author)], recovery: await keyId(pub(await newKey())) }));
for (let i = 0; i < Number(count); i++) {
  const n = Number(start) + i;
  entries.push(await signEntry(author, { type: "release", author: "test", app: "org.example.notes", version: `1.0.${n}`, manifest: `sha256-test-${n}` }));
}
await writeFile(out, JSON.stringify(entries));
console.log(`${entries.length} entries`);
