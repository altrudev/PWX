// M4 log spike: the attacks M4.md lists, against the log, witnesses, receipts and key history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64 } from "../lib/pwx-verify.mjs";
import { Log, Witness, newKey, pub, signEntry, keyId, receipt, verifyReceipt, verifyCheckpoint } from "../log/log.mjs";
import { checkRelease, verifyFullView, WAIT } from "../log/authors.mjs";

const HOUR = 3600e3, DAY = 24 * HOUR, T0 = Date.UTC(2026, 10, 17);
let now = T0; const clock = () => now;
const ORIGIN = "log.pwx.example/spike";

async function world() {
  now = T0;
  const logKey = await newKey(), log = new Log(ORIGIN, logKey, clock);
  const wk = await Promise.all([newKey(), newKey(), newKey()]);
  const witnesses = wk.map((k, i) => new Witness(`w${i + 1}`, k, pub(logKey), ORIGIN));
  const trust = { origin: ORIGIN, log: pub(logKey), witnesses: wk.map(pub), quorum: 2 };
  // The log publishes a checkpoint; every witness checks it extends what it saw, and co-signs.
  const publish = async (l = log) => {
    const cp = await l.checkpoint(); const cosigs = [];
    for (const w of witnesses) {
      const proof = w.last ? (await l.consistency(w.last.size, cp.body.size)).map((h) => b64.enc(h)) : [];
      const c = await w.cosign(cp, proof); if (c) cosigs.push(c);
    }
    return { cp, cosigs };
  };
  const d1 = await newKey(), rec = await newKey();
  await log.append(await signEntry(d1, { type: "key-event", op: "create", author: "val", keys: [pub(d1)], recovery: await keyId(pub(rec)) }));
  return { log, logKey, witnesses, trust, publish, d1, rec };
}
const rel = (k, manifest, version = "1.0.0") => signEntry(k, { type: "release", author: "val", app: "org.example.notes", version, manifest });

test("a logged release passes offline with its receipt", async () => {
  const w = await world();
  now += HOUR; const i = await w.log.append(await rel(w.d1, "m-1"));
  const { cp, cosigs } = await w.publish();
  const r = await receipt(w.log, i, cp, cosigs);
  const leaf = await verifyReceipt(JSON.parse(JSON.stringify(r)), w.trust);   // as if read from a file
  assert.equal(leaf.entry.manifest, "m-1");
  assert.deepEqual(await checkRelease(w.log.leaves, "val", "m-1", now), { ok: true });
});

test("a release missing from the log is rejected", async () => {
  const w = await world();
  now += HOUR; const i = await w.log.append(await rel(w.d1, "m-1"));
  const { cp, cosigs } = await w.publish();
  assert.equal((await checkRelease(w.log.leaves, "val", "m-unlogged", now)).reason, "not in the log");
  const r = await receipt(w.log, i, cp, cosigs);
  const other = await rel(w.d1, "m-unlogged");                                  // validly signed, never logged
  r.leaf = { ...other, loggedAt: r.leaf.loggedAt };
  await assert.rejects(verifyReceipt(r, w.trust), /not in the log/);
});

test("forged receipts are rejected", async () => {
  const w = await world();
  for (let n = 0; n < 5; n++) { now += HOUR; await w.log.append(await rel(w.d1, `m-${n}`)); }
  const { cp, cosigs } = await w.publish();
  const good = await receipt(w.log, 3, cp, cosigs);
  const clone = () => JSON.parse(JSON.stringify(good));
  let r = clone(); r.proof[0] = b64.enc(new Uint8Array(32)); await assert.rejects(verifyReceipt(r, w.trust), /not in the log/);
  r = clone(); r.checkpoint.body.root = b64.enc(new Uint8Array(32)); await assert.rejects(verifyReceipt(r, w.trust), /not signed by the log/);
  r = clone(); r.cosigs = r.cosigs.slice(0, 1); await assert.rejects(verifyReceipt(r, w.trust), /1 of 2 witnesses/);
  r = clone(); r.cosigs = [r.cosigs[0], r.cosigs[0]]; await assert.rejects(verifyReceipt(r, w.trust), /1 of 2 witnesses/);
  const stranger = await newKey(); const fake = await new Witness("x", stranger, w.trust.log, ORIGIN).cosign(cp, []);
  r = clone(); r.cosigs = [r.cosigs[0], fake]; await assert.rejects(verifyReceipt(r, w.trust), /1 of 2 witnesses/);
  r = clone(); r.leaf.entry.version = "9.9.9"; await assert.rejects(verifyReceipt(r, w.trust), /signature invalid/);
});

test("the log can't forge or alter entries", async () => {
  const w = await world();
  const e = await rel(w.d1, "m-1"); e.entry.manifest = "m-evil";
  await assert.rejects(w.log.append(e), /bad entry signature/);
  const thief = await newKey();
  const forged = await rel(thief, "m-evil");                                   // signed, but not by val's key
  await w.log.append(forged);
  assert.match((await checkRelease(w.log.leaves, "val", "m-evil", now)).reason, /wasn't allowed/);
});

test("split view: witnesses refuse a history that was rewritten or forked", async () => {
  const w = await world();
  for (let n = 0; n < 4; n++) { now += HOUR; await w.log.append(await rel(w.d1, `m-${n}`)); }
  const honest = await w.publish();
  assert.equal(honest.cosigs.length, 3);
  // The log operator builds a second history: same start, a revocation left out, more entries.
  const fork = new Log(ORIGIN, w.logKey, clock);
  for (const l of w.log.leaves.slice(0, 2)) await fork.append({ entry: l.entry, sig: l.sig });
  for (let n = 0; n < 4; n++) await fork.append(await rel(w.d1, `fork-${n}`));
  const forked = await w.publish(fork);
  assert.equal(forked.cosigs.length, 0, "no witness co-signs the fork");
  assert.ok(w.witnesses.every((x) => x.evidence.length === 1), "every witness keeps the conflicting checkpoint as evidence");
  await assert.rejects(verifyCheckpoint(forked.cp, forked.cosigs, w.trust), /0 of 2 witnesses/);
  // Same size, different contents is refused too.
  const same = new Log(ORIGIN, w.logKey, clock);
  for (const l of w.log.leaves.slice(0, 4)) await same.append({ entry: l.entry, sig: l.sig });
  await same.append(await rel(w.d1, "swapped"));
  assert.equal((await w.publish(same)).cosigs.length, 0);
  // The honest log keeps growing and keeps being co-signed.
  now += HOUR; await w.log.append(await rel(w.d1, "m-next"));
  assert.equal((await w.publish()).cosigs.length, 3);
});

test("a revoked release is rejected", async () => {
  const w = await world();
  now += HOUR; await w.log.append(await rel(w.d1, "m-bad"));
  assert.ok((await checkRelease(w.log.leaves, "val", "m-bad", now)).ok);
  now += HOUR; await w.log.append(await signEntry(w.d1, { type: "revoke", author: "val", manifest: "m-bad" }));
  assert.equal((await checkRelease(w.log.leaves, "val", "m-bad", now)).reason, "revoked");
  const stranger = await newKey();
  await w.log.append(await signEntry(stranger, { type: "revoke", author: "val", manifest: "m-good" }));
  now += HOUR; await w.log.append(await rel(w.d1, "m-good"));
  assert.ok((await checkRelease(w.log.leaves, "val", "m-good", now)).ok, "only val's keys can revoke val's releases");
});

test("a new key only works after the 7-day waiting period", async () => {
  const w = await world(); const d2 = await newKey();
  now += HOUR; const t = now;
  await w.log.append(await signEntry(w.d1, { type: "key-event", op: "rotate", author: "val", add: [pub(d2)], remove: [w.d1.key] }));
  now = t + DAY; await w.log.append(await rel(d2, "new-early")); await w.log.append(await rel(w.d1, "old-during"));
  now = t + WAIT + HOUR; await w.log.append(await rel(d2, "new-late")); await w.log.append(await rel(w.d1, "old-after"));
  const c = (m) => checkRelease(w.log.leaves, "val", m, now);
  assert.match((await c("new-early")).reason, /wasn't allowed/, "new key inside the wait: rejected");
  assert.ok((await c("old-during")).ok, "old key keeps working during the wait");
  assert.ok((await c("new-late")).ok, "new key after the wait: accepted");
  assert.match((await c("old-after")).reason, /wasn't allowed/, "old key after the wait: rejected");
});

test("recovery cancels a thief's rotation and cuts off the stolen key at once", async () => {
  const w = await world(); const thiefKey = await newKey(), d3 = await newKey(), rec2 = await newKey();
  now += HOUR; await w.log.append(await rel(w.d1, "before-theft"));
  now += DAY; const theft = now;
  await w.log.append(await signEntry(w.d1, { type: "key-event", op: "rotate", author: "val", add: [pub(thiefKey)], remove: [w.d1.key] }));
  now += HOUR; await w.log.append(await rel(w.d1, "thief-with-stolen-key"));
  now += HOUR;                                                          // val's monitor alerts; val recovers
  await w.log.append(await signEntry(w.rec, { type: "key-event", op: "recover", author: "val", keys: [pub(d3)], recovery: await keyId(pub(rec2)), compromisedSince: theft }));
  await w.log.append(await rel(d3, "after-recovery"));
  now = theft + WAIT + DAY; await w.log.append(await rel(thiefKey, "thief-after-wait"));
  const c = (m) => checkRelease(w.log.leaves, "val", m, now);
  assert.ok((await c("before-theft")).ok, "releases from before the theft stay valid");
  assert.match((await c("thief-with-stolen-key")).reason, /wasn't allowed/, "stolen key cut off from the theft on");
  assert.ok((await c("after-recovery")).ok, "new key works immediately after recovery");
  assert.match((await c("thief-after-wait")).reason, /wasn't allowed/, "thief's rotation was cancelled");
});

test("only the committed recovery key can recover", async () => {
  const w = await world(); const thiefKey = await newKey(), thiefRec = await newKey();
  now += HOUR;
  await w.log.append(await signEntry(thiefRec, { type: "key-event", op: "recover", author: "val", keys: [pub(thiefKey)], recovery: await keyId(pub(thiefRec)) }));
  await w.log.append(await rel(thiefKey, "thief"));
  await w.log.append(await rel(w.d1, "real"));
  assert.match((await checkRelease(w.log.leaves, "val", "thief", now)).reason, /wasn't allowed/);
  assert.ok((await checkRelease(w.log.leaves, "val", "real", now)).ok);
});

test("a client with the whole log can tell if anything was hidden from it", async () => {
  const w = await world();
  now += HOUR; await w.log.append(await rel(w.d1, "m-bad"));
  now += HOUR; await w.log.append(await signEntry(w.d1, { type: "revoke", author: "val", manifest: "m-bad" }));
  const { cp, cosigs } = await w.publish();
  assert.ok(await verifyFullView(w.log.leaves, cp, cosigs, w.trust, verifyCheckpoint));
  const hidden = w.log.leaves.filter((l) => l.entry.type !== "revoke");      // the revocation left out
  await assert.rejects(verifyFullView(hidden, cp, cosigs, w.trust, verifyCheckpoint), /wrong size/);
  const swapped = [...w.log.leaves]; swapped[2] = { ...swapped[2], loggedAt: swapped[2].loggedAt + 1 };
  await assert.rejects(verifyFullView(swapped, cp, cosigs, w.trust, verifyCheckpoint), /don't match/);
});

test("hardware keys (ECDSA P-256) work in the log like any other key", async () => {
  const w = await world(); const hw = await newKey("p256");
  now += HOUR; await w.log.append(await signEntry(w.d1, { type: "key-event", op: "rotate", author: "val", add: [pub(hw)], remove: [] }));
  now += WAIT + HOUR; const i = await w.log.append(await rel(hw, "from-hardware"));
  const { cp, cosigs } = await w.publish();
  await verifyReceipt(await receipt(w.log, i, cp, cosigs), w.trust);
  assert.ok((await checkRelease(w.log.leaves, "val", "from-hardware", now)).ok);
});
