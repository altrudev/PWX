#!/usr/bin/env node
// Runs a PWX log as a folder of static files that any web host can serve, and a witness for it.
//   node tools/pwx-log.mjs init    <dir> <origin>             new log (key in $PWX_KEYS/log-key.json)
//   node tools/pwx-log.mjs append  <dir> <origin> <entry.json> add a signed entry { entry, sig }
//   node tools/pwx-log.mjs witness <dir|url> <origin> <name> <state.json>
//                                       co-sign the current checkpoint if it extends the last one
//                                       this witness saw (key in $PWX_KEYS/witness-<name>.json);
//                                       prints the co-signature line
//   node tools/pwx-log.mjs cosign   <dir> <line-file>...       add witnesses' lines to the checkpoint
//   node tools/pwx-log.mjs trust    <dir> <origin> <witness names...>
//                                       the trust settings a loader needs (verifier keys, quorum)
// The log writes only static files; the witness reads them over HTTP like any client, and builds
// the consistency proof from the tiles itself, so it needs nothing from the log operator.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { b64, strictParse } from "../lib/pwx-verify.mjs";
import * as M from "../log/merkle.mjs";
import * as N from "../log/note.mjs";
import { TileReader } from "../log/tiles.mjs";
import { Log, verifySig, newEd25519Jwk, keyFromJwk } from "../log/log.mjs";
import { loadLog, writeFiles, fromDir, fromUrl, readCheckpoint } from "../log/static.mjs";

const KEYS = process.env.PWX_KEYS ?? join(homedir(), ".config/pwx-dev");
async function key(file) {
  const path = join(KEYS, file);
  if (!existsSync(path)) {
    await mkdir(KEYS, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(await newEd25519Jwk()), { mode: 0o600 });
  }
  return keyFromJwk(JSON.parse(await readFile(path, "utf8")));
}
const logKey = () => key("log-key.json");
const witnessKey = (name) => key(`witness-${name.replace(/[^A-Za-z0-9.-]/g, "_")}.json`);

async function publish(dir, log) {
  await writeFiles(dir, await log.files(await log.checkpoint()));
  return log.leaves.length;
}

const [cmd, ...a] = process.argv.slice(2);
try {
  if (cmd === "init") {
    const [dir, origin] = a;
    if (existsSync(join(dir, "checkpoint"))) throw new Error("a log already exists there");
    console.log(`log ${origin}: size ${await publish(dir, new Log(origin, await logKey()))}`);
  } else if (cmd === "append") {
    const [dir, origin, file] = a;
    const log = await loadLog(dir, origin, await logKey());
    for (const signed of [].concat(strictParse(await readFile(file, "utf8")))) await log.append(signed);
    console.log(`log ${origin}: size ${await publish(dir, log)} (witnesses haven't co-signed this size yet)`);
  } else if (cmd === "witness") {
    const [src, origin, name, stateFile] = a;
    const k = await witnessKey(name), get = /^https?:/.test(src) ? fromUrl(src) : fromDir(src);
    const state = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : { last: null, evidence: [] };
    if (!state.log) {   // first run: pin the log's key from the trust settings handed over out of band
      state.log = JSON.parse(process.env.PWX_LOG_VKEY ?? "null");
      if (!state.log) throw new Error("first run needs PWX_LOG_VKEY='{\"name\":...,\"key\":...}'");
    }
    const cp = await readCheckpoint(get, state.log);
    if (cp.origin !== origin) throw new Error("checkpoint is for another log");
    if (state.last) {
      const reader = new TileReader(get, cp.size);
      const ok = cp.size >= state.last.size
        && b64.enc(await reader.root()) === cp.root
        && await M.verifyConsistency(state.last.size, cp.size, b64.dec(state.last.root), b64.dec(cp.root), await reader.consistencyProof(state.last.size));
      if (!ok) {
        state.evidence.push({ seen: state.last, conflicting: cp.text, at: Date.now() });
        await writeFile(stateFile, JSON.stringify(state, null, 2));
        throw new Error("refused: this checkpoint doesn't extend the last one this witness co-signed (evidence kept)");
      }
    }
    const line = await N.cosignLine(cp.note.body, name, k, Math.floor(Date.now() / 1000));
    state.last = { size: cp.size, root: cp.root };
    await writeFile(stateFile, JSON.stringify(state, null, 2));
    process.stdout.write(line);
  } else if (cmd === "cosign") {
    const [dir, ...lineFiles] = a;
    const text = new TextDecoder().decode(await fromDir(dir)("checkpoint"));
    const note = N.parseNote(text), have = new Set(note.sigs.map((s) => s.line));
    const add = [];
    for (const f of lineFiles) for (const l of (await readFile(f, "utf8")).split(/(?<=\n)/)) if (l.trim() && !have.has(l)) add.push(l);
    N.parseNote(text + add.join(""));   // still a well-formed note
    await writeFile(join(dir, ".checkpoint.tmp"), text + add.join(""));
    await (await import("node:fs/promises")).rename(join(dir, ".checkpoint.tmp"), join(dir, "checkpoint"));
    console.log(`added ${add.length} co-signature line(s)`);
  } else if (cmd === "trust") {
    const [, origin, ...names] = a;
    const lk = await logKey(), ws = [];
    for (const n of names) ws.push({ name: n, key: (await witnessKey(n)).key });
    console.log(JSON.stringify({
      origin, log: { name: origin, key: lk.key }, witnesses: ws, quorum: Math.min(2, ws.length),
      vkeys: { log: await N.vkey(origin, N.ED25519, lk.key), witnesses: await Promise.all(ws.map((w) => N.vkey(w.name, N.COSIG_V1, w.key))) },
    }, null, 2));
  } else {
    console.error("usage: pwx-log.mjs init|append|witness|cosign|trust ... (see the top of this file)"); process.exit(2);
  }
} catch (err) {
  console.error(`pwx-log: ${err.message}`); process.exit(1);
}
