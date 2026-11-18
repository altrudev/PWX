// Reading and writing the log as a directory of static files (tiles.mjs layout).
// Node only for writing; reading works anywhere through `fromUrl`.
import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { b64, strictParse } from "../lib/pwx-verify.mjs";
import * as M from "./merkle.mjs";
import * as N from "./note.mjs";
import { TileReader } from "./tiles.mjs";
import { Log, leafBytes } from "./log.mjs";

export const fromDir = (dir) => async (path) => {
  const full = resolve(dir, path);
  if (!full.startsWith(resolve(dir) + "/")) throw new Error("static: bad path");
  return new Uint8Array(await readFile(full));
};
export const fromUrl = (base) => async (path) => {
  const res = await fetch(new URL(path, base.endsWith("/") ? base : base + "/"), { cache: "no-store" });
  if (!res.ok) throw new Error(`static: ${path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

// The checkpoint the host serves, checked against the log's key (not yet against witnesses).
export async function readCheckpoint(get, logVkey) {
  const text = new TextDecoder().decode(await get("checkpoint"));
  const cp = await N.logSignedOnly(text, logVkey);
  if (!cp) throw new Error("static: checkpoint isn't signed by the log");
  return { ...cp, text };
}

// Load a published log back into memory, refusing it if the files don't match the signed root.
export async function loadLog(dir, origin, key, clock) {
  const log = new Log(origin, key, clock), get = fromDir(dir);
  let cp;
  try { cp = await readCheckpoint(get, log.vkey); } catch (e) { if (e.code === "ENOENT") return log; throw e; }
  if (cp.origin !== origin) throw new Error("static: the directory holds another log");
  const reader = new TileReader(get, cp.size);
  for (let i = 0; i < cp.size; i++) {
    const data = await reader.entry(i);
    log.leaves.push(strictParse(new TextDecoder().decode(data))); log.hashes.push(await M.leafHash(data));
  }
  if (b64.enc(await M.root(log.hashes)) !== cp.root) throw new Error("static: entries don't match the signed checkpoint");
  return log;
}

// Write every file; the checkpoint goes last, so a reader never sees a checkpoint whose tiles
// aren't there yet. Old partial tiles are left in place (tlog-tiles allows either).
export async function writeFiles(dir, files) {
  await mkdir(dir, { recursive: true });
  for (const [path, data] of files) {
    if (path === "checkpoint") continue;
    const full = join(dir, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, data);
  }
  const tmp = join(dir, ".checkpoint.tmp");
  await writeFile(tmp, files.get("checkpoint")); await rename(tmp, join(dir, "checkpoint"));
}

// Leaves in a published log are canonical JSON of { entry, sig, loggedAt }.
export const leafFrom = (data) => strictParse(new TextDecoder().decode(data));
export { leafBytes };
