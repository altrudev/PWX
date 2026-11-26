#!/usr/bin/env node
// Runs a PWX log as a folder of static files that any web host can serve.
//   node tools/pwx-log.mjs init     <dir> <origin>                 new log (key: $PWX_KEYS/log-key.json)
//   node tools/pwx-log.mjs append   <dir> <origin> <entries.json>  add signed entries [{ entry, sig }]
//   node tools/pwx-log.mjs release  <dir> <origin> <pkg.pwx.json> <publisher-key.json>
//                                       log a package's release, signed by its publisher key
//                                       (does nothing if that exact release is already logged)
//   node tools/pwx-log.mjs withdraw <dir> <origin> <pkg.pwx.json> <publisher-key.json> withdrawn|revoked [message] [replacement]
//                                       log that a release is withdrawn (bug, replaced) or revoked (unsafe),
//                                       signed by its publisher key (M4 section 5a); then run publish and status
//   node tools/pwx-log.mjs status   <dir> <trust.json> [out]
//                                       write <dir>/status.json: every withdrawal and revocation, each with
//                                       its inclusion proof against the witnessed checkpoint (loaders download it whole)
//   node tools/pwx-log.mjs publish  <dir> <origin> <witness-url>...
//                                       get each witness to co-sign the current checkpoint
//                                       (c2sp.org/tlog-witness) and write the co-signatures in
//   node tools/pwx-log.mjs receipt  <dir> <trust.json> <pkg.pwx.json> [out]
//                                       add the log receipt to a package (needs a witnessed checkpoint)
//   node tools/pwx-log.mjs trust    <origin> <witness name>=<witness key file>...
//                                       the settings a loader pins (keys, quorum)
// Each witness's last co-signed size is kept next to the folder, in <dir>.witnesses.json (not served).
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, sha256, strictParse } from "../lib/pwx-verify.mjs";
import * as N from "../lib/pwx-note.mjs";
import { checkReceipt } from "../lib/pwx-receipt.mjs";
import { checkStatus, REASONS } from "../lib/pwx-status.mjs";
import { TileReader } from "../log/tiles.mjs";
import { Log, signEntry, keyFromJwk, receipt } from "../log/log.mjs";
import { loadLog, writeFiles, fromDir, readCheckpoint } from "../log/static.mjs";
import { logKey } from "../log/devlog.mjs";
import { requestCosignature } from "../log/witness-service.mjs";

const te = new TextEncoder();
const publishFiles = async (dir, log) => { await writeFiles(dir, await log.files(await log.checkpoint())); return log.leaves.length; };
const writeAtomic = async (path, text) => { await writeFile(path + ".tmp", text); await rename(path + ".tmp", path); };

const [cmd, ...a] = process.argv.slice(2);
try {
  if (cmd === "init") {
    const [dir, origin] = a;
    if (existsSync(join(dir, "checkpoint"))) throw new Error("a log already exists there");
    console.log(`log ${origin}: size ${await publishFiles(dir, new Log(origin, await logKey()))}`);
  } else if (cmd === "append") {
    const [dir, origin, file] = a;
    // PWX_LOG_TIME_SHIFT_MS: tests play a dishonest log that backdates or postdates entries.
    const shift = Number(process.env.PWX_LOG_TIME_SHIFT_MS ?? 0);
    const log = await loadLog(dir, origin, await logKey(), () => Date.now() + shift);
    for (const signed of [].concat(strictParse(await readFile(file, "utf8")))) await log.append(signed);
    console.log(`log ${origin}: size ${await publishFiles(dir, log)} (not co-signed yet: run publish)`);
  } else if (cmd === "release") {
    const [dir, origin, pkgFile, keyFile] = a;
    const log = await loadLog(dir, origin, await logKey());
    const pkg = strictParse(await readFile(pkgFile, "utf8")), m = strictParse(pkg.manifest);
    const pub = await keyFromJwk(JSON.parse(await readFile(keyFile, "utf8")));
    if (pub.key !== pkg.sig.key) throw new Error("that key didn't sign this package");
    const body = { type: "release", author: m.publisher, app: m.id, version: m.version, manifest: await sha256(te.encode(canonicalize(m))) };
    const have = log.leaves.findIndex((l) => ["type", "author", "app", "version", "manifest"].every((k) => l.entry[k] === body[k]) && l.entry.signer?.key === pub.key);
    if (have >= 0) { console.log(`${m.id} ${m.version} is already logged (entry ${have})`); process.exit(0); }
    await log.append(await signEntry(pub, body));
    console.log(`logged ${m.id} ${m.version}: size ${await publishFiles(dir, log)} (not co-signed yet: run publish)`);
  } else if (cmd === "withdraw") {
    const [dir, origin, pkgFile, keyFile, reason, message, replacement] = a;
    if (!REASONS.has(reason)) throw new Error("reason must be withdrawn or revoked");
    if (message !== undefined && message.length > 140) throw new Error("message is longer than 140 characters");
    const log = await loadLog(dir, origin, await logKey());
    const pkg = strictParse(await readFile(pkgFile, "utf8")), m = strictParse(pkg.manifest);
    const pub = await keyFromJwk(JSON.parse(await readFile(keyFile, "utf8")));
    if (pub.key !== pkg.sig.key) throw new Error("that key didn't sign this package");
    const body = { type: "revoke", reason, author: m.publisher, app: m.id, version: m.version, manifest: await sha256(te.encode(canonicalize(m))),
      ...(message ? { message } : {}), ...(replacement ? { replacement } : {}) };
    await log.append(await signEntry(pub, body));
    console.log(`logged: ${m.id} ${m.version} ${reason}: size ${await publishFiles(dir, log)} (not co-signed yet: run publish, then status)`);
  } else if (cmd === "status") {
    const [dir, trustFile, out = join(dir, "status.json")] = a;
    const trust = JSON.parse(await readFile(trustFile, "utf8")), get = fromDir(dir);
    const text = new TextDecoder().decode(await get("checkpoint"));
    const cp = await N.verifyCheckpointNote(text, trust);
    const reader = new TileReader(get, cp.size), revocations = [];
    for (let i = 0; i < cp.size; i++) {
      const leaf = strictParse(new TextDecoder().decode(await reader.entry(i)));
      if (leaf.entry?.type !== "revoke") continue;
      revocations.push({ leaf, index: i, proof: (await reader.inclusionProof(i)).map((h) => btoa(String.fromCharCode(...h))) });
    }
    const status = { checkpoint: text, revocations };
    const v = await checkStatus(status, [trust]);                // the loader's own check, before writing
    if (v.dropped) throw new Error(`${v.dropped} entries failed the loader's check`);
    await writeAtomic(out, JSON.stringify(status));
    console.log(`release status: ${v.entries.length} withdrawn or revoked, log size ${cp.size}, written to ${out}`);
  } else if (cmd === "publish") {
    const [dir, origin, ...witnesses] = a;
    const get = fromDir(dir), lk = await logKey();
    const cp = await readCheckpoint(get, { name: origin, key: lk.key });
    const reader = new TileReader(get, cp.size);
    const sizesFile = dir.replace(/\/+$/, "") + ".witnesses.json";
    const sizes = existsSync(sizesFile) ? JSON.parse(await readFile(sizesFile, "utf8")) : {};
    const note = N.joinNote(cp.note.body, cp.note.sigs.filter((s) => s.name === origin).map((s) => s.line));
    const lines = [];
    for (const url of witnesses) {
      try {
        const { line } = await requestCosignature(url, note, reader, sizes[url] ?? 0);
        lines.push(line); sizes[url] = cp.size;
      } catch (e) { console.error(`pwx-log: ${e.message}`); }
    }
    await writeAtomic(sizesFile, JSON.stringify(sizes, null, 2));
    await writeAtomic(join(dir, "checkpoint"), note + lines.join(""));
    console.log(`log ${origin}: size ${cp.size}, ${lines.length} of ${witnesses.length} witnesses co-signed`);
    if (lines.length < witnesses.length) process.exit(1);
  } else if (cmd === "receipt") {
    const [dir, trustFile, pkgFile, out = pkgFile] = a;
    const trust = JSON.parse(await readFile(trustFile, "utf8")), get = fromDir(dir);
    const text = new TextDecoder().decode(await get("checkpoint"));
    const cp = await N.verifyCheckpointNote(text, trust);
    const pkg = strictParse(await readFile(pkgFile, "utf8")), m = strictParse(pkg.manifest);
    const want = await sha256(te.encode(canonicalize(m)));
    const reader = new TileReader(get, cp.size);
    for (let i = cp.size - 1; i >= 0; i--) {
      const leaf = strictParse(new TextDecoder().decode(await reader.entry(i)));
      const e = leaf.entry;
      if (e.type !== "release" || e.app !== m.id || e.version !== m.version || e.manifest !== want || e.signer?.key !== pkg.sig.key) continue;
      const proof = (await reader.inclusionProof(i)).map((h) => btoa(String.fromCharCode(...h)));
      const r = { leaf, index: i, proof, checkpoint: text };
      await checkReceipt(r, m, pkg.sig.key, trust);          // the loader's own check, before writing
      await writeFile(out, JSON.stringify({ ...pkg, receipt: r }));
      console.log(`receipt added: ${m.id} ${m.version}, entry ${i} of ${cp.size}, ${cp.cosigned.length} witness(es)`);
      process.exit(0);
    }
    throw new Error(`${m.id} ${m.version} isn't in the log at size ${cp.size}`);
  } else if (cmd === "trust") {
    const [origin, ...ws] = a;
    const lk = await logKey(), witnesses = [];
    for (const w of ws) {
      const [name, file] = w.split("=");
      witnesses.push({ name, key: (await keyFromJwk(JSON.parse(await readFile(file, "utf8")))).key });
    }
    console.log(JSON.stringify({ origin, log: { name: origin, key: lk.key }, witnesses, quorum: witnesses.length,
      vkeys: { log: await N.vkey(origin, N.ED25519, lk.key), witnesses: await Promise.all(witnesses.map((w) => N.vkey(w.name, N.COSIG_V1, w.key))) } }, null, 2));
  } else {
    console.error("usage: pwx-log.mjs init|append|release|withdraw|publish|status|receipt|trust ... (see the top of this file)"); process.exit(2);
  }
} catch (err) {
  console.error(`pwx-log: ${err.message}`); process.exit(1);
}
