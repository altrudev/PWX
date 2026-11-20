#!/usr/bin/env node
// A PWX log witness anyone can run (issue #22). It speaks the public witness protocol
// (c2sp.org/tlog-witness), so a PWX log can use witnesses from other projects and this witness
// can serve other logs:
//
//   POST /add-checkpoint
//     old <size>                 the size the log thinks this witness last co-signed
//     <base64 hash>...           consistency proof from that size (at most 63 lines)
//                                (blank line)
//     <checkpoint note>          signed by the log
//
//   200  the witness's co-signature line (cosignature/v1)
//   409  "<size>\n" (text/x.tlog.size): the old size is wrong; this is the size it last co-signed
//   404  unknown log      403  not signed by the log      400  malformed
//   422  refused: the proof doesn't show the log only grew (evidence kept), or the clock check failed
//
// PWX extra check (when the log's URL is configured): before co-signing, it reads the new
// entries from the log's public tiles and refuses if any entry's time (loggedAt) goes backwards,
// is earlier than this witness's previous co-signature, or is ahead of its own clock. That stops a
// log from backdating an entry to dodge the 7-day key-rotation wait.
//
// Usage: node log/witness-service.mjs <config.json>
//   { "name": "witness.example", "key": "<path to Ed25519 JWK>", "state": "<path>", "port": 8180,
//     "host": "127.0.0.1", "skewSeconds": 300,
//     "logs": [{ "origin": "...", "key": "<base64 Ed25519 public key>", "url": "https://.../log/" }] }
import http from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { b64, strictParse } from "../lib/pwx-verify.mjs";
import * as M from "../lib/pwx-merkle.mjs";
import * as N from "../lib/pwx-note.mjs";
import { TileReader } from "./tiles.mjs";
import { keyFromJwk } from "./log.mjs";
import { fromUrl } from "./static.mjs";

const MAX_BODY = 1 << 20;

export async function startWitness(cfg) {
  const key = await keyFromJwk(JSON.parse(await readFile(cfg.key, "utf8")));
  const logs = new Map(cfg.logs.map((l) => [l.origin, l]));
  const skew = (cfg.skewSeconds ?? 300) * 1000;
  const state = existsSync(cfg.state) ? JSON.parse(await readFile(cfg.state, "utf8")) : { logs: {} };
  const save = async () => { await writeFile(cfg.state + ".tmp", JSON.stringify(state, null, 2)); await rename(cfg.state + ".tmp", cfg.state); };
  const now = cfg.clock ?? (() => Date.now());
  let queue = Promise.resolve();   // one request at a time: never co-sign two conflicting checkpoints

  async function addCheckpoint(body) {
    const blank = body.indexOf("\n\n");
    if (blank < 0) return [400, "malformed request\n"];
    const head = body.slice(0, blank).split("\n"), note = body.slice(blank + 2);
    const m = /^old (0|[1-9][0-9]{0,15})$/.exec(head[0] ?? "");
    if (!m) return [400, "malformed old size\n"];
    const old = Number(m[1]), proofLines = head.slice(1);
    if (proofLines.length > 63 || !proofLines.every((l) => /^[A-Za-z0-9+/]{43}=$/.test(l))) return [400, "malformed proof\n"];
    let parsed;
    try { parsed = N.parseCheckpoint(N.parseNote(note).body); } catch { return [400, "malformed checkpoint\n"]; }
    const log = logs.get(parsed.origin);
    if (!log) return [404, "unknown log\n"];
    const cp = await N.logSignedOnly(note, { name: log.origin, key: log.key }).catch(() => null);
    if (!cp) return [403, "checkpoint not signed by the log\n"];
    const st = (state.logs[log.origin] ??= { size: 0, root: null, cosignedAt: 0, lastLoggedAt: 0, evidence: [] });
    if (old !== st.size) return [409, `${st.size}\n`, "text/x.tlog.size"];
    if (cp.size < old) return [400, "checkpoint is smaller than the old size\n"];
    if (st.root !== null) {
      const ok = await M.verifyConsistency(old, cp.size, b64.dec(st.root), b64.dec(cp.root), proofLines.map(b64.dec));
      if (!ok) {
        st.evidence.push({ seen: { size: st.size, root: st.root }, conflicting: note, proof: proofLines, at: now() });
        await save();
        return [422, "refused: this checkpoint doesn't extend the last one this witness co-signed (evidence kept)\n"];
      }
    } else if (old !== 0 || proofLines.length) {
      return [400, "first checkpoint must come with old 0 and no proof\n"];
    }
    if (log.url && cp.size > old) {
      const reason = await clockCheck(log, cp, old, st);
      if (reason) return [422, `refused: ${reason}\n`];
    }
    const t = Math.floor(now() / 1000);
    const line = await N.cosignLine(cp.note.body, cfg.name, key, t);
    Object.assign(st, { size: cp.size, root: cp.root, cosignedAt: t });
    await save();                       // state is saved before the co-signature leaves
    return [200, line];
  }

  // New entries come from the log's public tiles and must hash to the signed root.
  async function clockCheck(log, cp, old, st) {
    let reader;
    try {
      reader = new TileReader(fromUrl(log.url), cp.size);
      if (b64.enc(await reader.root()) !== cp.root) return "the log's tiles don't match its checkpoint";
    } catch (e) { return `couldn't read the log's tiles (${e.message})`; }
    let last = st.lastLoggedAt;
    const floor = st.cosignedAt * 1000 - skew, ceiling = now() + skew;
    for (let i = old; i < cp.size; i++) {
      const data = await reader.entry(i);
      if (!M.eq(await M.leafHash(data), await reader.node(0, i))) return `entry ${i} doesn't match the tiles`;
      let t;
      try { t = strictParse(new TextDecoder().decode(data)).loggedAt; } catch { return `entry ${i} isn't a PWX log entry`; }
      if (!Number.isSafeInteger(t)) return `entry ${i} has no time`;
      if (t < last) return `entry ${i}'s time goes backwards`;
      if (t < floor) return `entry ${i} is dated before this witness's last co-signature (backdated)`;
      if (t > ceiling) return `entry ${i} is dated in the future`;
      last = t;
    }
    st.lastLoggedAt = last;
    return null;
  }

  const server = http.createServer((req, res) => {
    const send = (status, body, type = "text/plain; charset=utf-8") => res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" }).end(body);
    const path = new URL(req.url, "http://w").pathname;
    if (req.method === "GET" && path === "/") {
      return send(200, `PWX witness ${cfg.name}\nprotocol: c2sp.org/tlog-witness (POST /add-checkpoint)\nlogs:\n${[...logs.keys()].map((o) => `  ${o}: size ${state.logs[o]?.size ?? 0}`).join("\n")}\n`);
    }
    if (req.method !== "POST" || path !== "/add-checkpoint") return send(404, "not found\n");
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c); });
    req.on("end", () => {
      queue = queue.then(() => addCheckpoint(Buffer.concat(chunks).toString("utf8")))
        .then(([s, b, t]) => send(s, b, t), (e) => send(500, `error: ${e.message}\n`));
    });
  });
  await new Promise((ok) => server.listen(cfg.port ?? 8180, cfg.host ?? "127.0.0.1", ok));
  return { server, state, close: () => new Promise((ok) => server.close(ok)) };
}

// The log side: submit a checkpoint to a witness and get its co-signature line, following the
// protocol's 409 to learn the size the witness last co-signed.
export async function requestCosignature(witnessUrl, note, reader, knownSize = 0) {
  const submit = async (old) => {
    const proof = old > 0 ? (await reader.consistencyProof(old)).map((h) => b64.enc(h)) : [];
    const body = `old ${old}\n${proof.map((p) => p + "\n").join("")}\n${note}`;
    const res = await fetch(new URL("add-checkpoint", witnessUrl.endsWith("/") ? witnessUrl : witnessUrl + "/"), { method: "POST", body });
    return { status: res.status, text: await res.text() };
  };
  let r = await submit(knownSize);
  if (r.status === 409) { const s = Number(r.text.trim()); if (Number.isSafeInteger(s)) { knownSize = s; r = await submit(s); } }
  if (r.status !== 200) throw new Error(`witness ${witnessUrl}: ${r.status} ${r.text.trim()}`);
  return { line: r.text, size: reader.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = JSON.parse(await readFile(process.argv[2], "utf8"));
  await startWitness(cfg);
  console.log(`PWX witness ${cfg.name} on http://${cfg.host ?? "127.0.0.1"}:${cfg.port ?? 8180}/ (c2sp.org/tlog-witness)`);
}
