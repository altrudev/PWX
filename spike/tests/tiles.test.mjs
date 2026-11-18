// The log as static files (tlog-tiles) and its text formats (signed note, checkpoint, cosignature).
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64 } from "../lib/pwx-verify.mjs";
import * as M from "../log/merkle.mjs";
import * as N from "../log/note.mjs";
import { nPath, tilePath, entriesPath, buildTiles, TileReader } from "../log/tiles.mjs";
import { newKey } from "../log/log.mjs";

const te = new TextEncoder();
const eqb = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

test("tile paths follow tlog-tiles", () => {
  assert.equal(nPath(0), "000"); assert.equal(nPath(5), "005"); assert.equal(nPath(999), "999");
  assert.equal(nPath(1000), "x001/000"); assert.equal(nPath(1234067), "x001/x234/067");
  assert.equal(tilePath(1, 1234067), "tile/1/x001/x234/067");
  assert.equal(tilePath(0, 3, 256), "tile/0/003");
  assert.equal(entriesPath(1234067, 8), "tile/entries/x001/x234/067.p/8");
});

async function world(n) {
  const data = Array.from({ length: n }, (_, i) => te.encode(`entry ${i}`));
  const hashes = await Promise.all(data.map((d) => M.leafHash(d)));
  const files = await buildTiles(data, hashes);
  return { data, hashes, files, reader: new TileReader(async (p) => { const f = files.get(p); if (!f) throw new Error("404 " + p); return f; }, n) };
}

// Sizes on both sides of tile edges, and one that needs a level-2 tile (65536 leaves).
for (const n of [1, 2, 7, 255, 256, 257, 511, 512, 513, 65537]) {
  test(`tiles give the same root, proofs and entries as the in-memory tree (${n} entries)`, async () => {
    const { data, hashes, reader } = await world(n);
    assert.ok(eqb(await reader.root(), await M.root(hashes)), "root");
    const picks = [...new Set([0, 1, Math.floor(n / 2), n - 2, n - 1, 255, 256, 257].filter((i) => i >= 0 && i < n))];
    for (const i of picks) {
      const want = await M.inclusionProof(i, hashes), got = await reader.inclusionProof(i);
      assert.equal(got.length, want.length, `inclusion ${i}`);
      got.forEach((h, j) => assert.ok(eqb(h, want[j]), `inclusion ${i}/${j}`));
      assert.ok(eqb(await reader.entry(i), data[i]), `entry ${i}`);
    }
    for (const m of picks.filter((m) => m > 0)) {
      const want = await M.consistencyProof(m, hashes), got = await reader.consistencyProof(m);
      assert.equal(got.length, want.length, `consistency ${m}`);
      got.forEach((h, j) => assert.ok(eqb(h, want[j]), `consistency ${m}/${j}`));
    }
  });
}

test("a reader at an older size works after the log grew (partial tiles gone)", async () => {
  // The folder as a host has it after publishing at 300 and again at 600 (writeFiles keeps old
  // partial tiles), minus the size-300 partials that now have full tiles, which a host may delete.
  const { hashes, files: f600 } = await world(600), { files: f300 } = await world(300);
  const files = new Map([...f300, ...f600]);
  files.delete("tile/0/001.p/44"); files.delete("tile/entries/001.p/44");
  assert.ok(files.has("tile/0/001") && files.has("tile/1/000.p/1"));
  const old = new TileReader(async (p) => { const f = files.get(p); if (!f) throw new Error("404 " + p); return f; }, 300);
  assert.ok(eqb(await old.root(), await M.root(hashes.slice(0, 300))));
  const want = await M.inclusionProof(299, hashes.slice(0, 300)), got = await old.inclusionProof(299);
  got.forEach((h, j) => assert.ok(eqb(h, want[j])));
  assert.equal(new TextDecoder().decode(await old.entry(299)), "entry 299");
});

test("changed tiles or entries are caught against the signed root", async () => {
  const { hashes, files } = await world(300);
  const root = b64.enc(await M.root(hashes));
  const bad = new Map(files);
  // Leaf 6's hash is part of leaf 7's proof.
  const t = new Uint8Array(bad.get("tile/0/000")); t[32 * 6] ^= 1; bad.set("tile/0/000", t);
  const r = new TileReader(async (p) => bad.get(p), 300);
  await assert.rejects(r.provenEntry(7, root), /not in the signed log/);
  const bad2 = new Map(files);
  const e = new Uint8Array(bad2.get("tile/entries/000")); e[5] ^= 1; bad2.set("tile/entries/000", e);
  await assert.rejects(new TileReader(async (p) => bad2.get(p), 300).provenEntry(0, root), /not in the signed log/);
  const good = new TileReader(async (p) => files.get(p), 300);
  assert.equal(new TextDecoder().decode((await good.provenEntry(299, root)).data), "entry 299");
  const short = new Map(files); short.set("tile/0/001.p/44", files.get("tile/0/001.p/44").slice(0, 32));
  await assert.rejects(new TileReader(async (p) => short.get(p), 300).root(), /wrong length/);
});

test("signed notes, checkpoints and co-signatures", async () => {
  const logKey = await newKey(), wKey = await newKey(), origin = "log.pwx.example/test";
  const body = N.checkpointBody(origin, 3, b64.enc(new Uint8Array(32)));
  assert.equal(body, `${origin}\n3\n${"A".repeat(43)}=\n`);
  const note = N.joinNote(body, [await N.signLine(body, origin, logKey), await N.cosignLine(body, "w.example", wKey, 1700000000)]);
  assert.match(note, /^log\.pwx\.example\/test\n3\n[A-Za-z0-9+/]{43}=\n\n— log\.pwx\.example\/test [A-Za-z0-9+/]+=*\n— w\.example [A-Za-z0-9+/]+=*\n$/);
  const trust = { origin, log: { name: origin, key: logKey.key }, witnesses: [{ name: "w.example", key: wKey.key }], quorum: 1 };
  const cp = await N.verifyCheckpointNote(note, trust);
  assert.equal(cp.size, 3); assert.equal(cp.cosigned[0].time, 1700000000);
  // The co-signature line is key ID (4) + time (8) + signature (64).
  assert.equal(b64.dec(note.trim().split(" ").at(-1)).length, 76);
  // Verifier keys round-trip and carry the right key ID.
  const vk = await N.vkey(origin, N.ED25519, logKey.key);
  assert.deepEqual(await N.parseVkey(vk), { name: origin, type: 1, key: logKey.key });
  await assert.rejects(N.parseVkey(vk.replace(/\+[0-9a-f]{8}\+/, "+00000000+")), /doesn't match/);
  // Key data with "+" in its base64 (found by a flaky run): 32 bytes of 0xfb encode to "+/v7...".
  const plus = b64.enc(new Uint8Array(32).fill(0xfb));
  assert.ok(plus.includes("+"));
  assert.deepEqual(await N.parseVkey(await N.vkey("w.example", N.COSIG_V1, plus)), { name: "w.example", type: 4, key: plus });
  // Malformed text is refused.
  for (const bad of [body, note.replace("\n\n", "\n"), note.replace("—", "-"), note.replace("\n3\n", "\n03\n"), note + "x"]) {
    await assert.rejects(N.verifyCheckpointNote(bad, trust));
  }
  await assert.rejects(N.verifyCheckpointNote(note, { ...trust, origin: "other" }), /not signed by the log/);
});
