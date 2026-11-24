// Receipts inside packages (M4 section 3): what the loader's offline check accepts and refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackage, strictParse } from "../lib/pwx-verify.mjs";
import { checkReceipt } from "../lib/pwx-receipt.mjs";
import { newEd25519Jwk, keyFromJwk, newKey, Log, Witness, signEntry, receipt, addCosigs } from "../log/log.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const tmp = mkdtempSync(join(tmpdir(), "pwx-receipt-"));
process.env.PWX_KEYS = join(tmp, "keys");                        // throwaway log and witness keys
const { logPackages, devTrust } = await import("../log/devlog.mjs");
const { pack } = await import("../tools/pack.mjs");

const keyFile = join(tmp, "publisher.json"); writeFileSync(keyFile, JSON.stringify(await newEd25519Jwk()));
const publisher = await keyFromJwk(JSON.parse(readFileSync(keyFile, "utf8")));
const notes = await pack(join(ROOT, "apps/notes"), join(ROOT, "apps/notes/manifest.template.json"), keyFile);
const other = await pack(join(ROOT, "apps/evil-strict"), join(ROOT, "apps/evil-strict/manifest.template.json"), keyFile);
const [loggedNotes, loggedOther] = await logPackages([notes, other], publisher, join(tmp, "log"));
const trust = await devTrust();
const parts = (text) => { const p = strictParse(text); return { p, m: strictParse(p.manifest) }; };

test("a logged package verifies and its receipt checks offline", async () => {
  await verifyPackage(loggedNotes);                                         // still a valid package
  const { p, m } = parts(loggedNotes);
  const r = await checkReceipt(p.receipt, m, p.sig.key, trust);
  assert.equal(r.logged, true); assert.equal(r.witnesses, 2);
});

test("the package format allows a receipt and nothing else new", async () => {
  await assert.rejects(verifyPackage(JSON.stringify({ ...JSON.parse(notes), extra: 1 })), /unknown field extra/);
  await assert.rejects(verifyPackage(JSON.stringify({ ...JSON.parse(notes), receipt: [1] })), /receipt must be an object/);
  await verifyPackage(notes);                                               // no receipt: still a package
});

test("a receipt is refused for another app, version, contents or publisher", async () => {
  const { p: n, m } = parts(loggedNotes), { p: o } = parts(loggedOther);
  await assert.rejects(checkReceipt(o.receipt, m, n.sig.key, trust), /another app or version/);
  await assert.rejects(checkReceipt(n.receipt, { ...m, version: "9.9.9" }, n.sig.key, trust), /another app or version/);
  await assert.rejects(checkReceipt(n.receipt, { ...m, name: "Notes (changed)" }, n.sig.key, trust), /different contents/);
  const stranger = await newKey();
  await assert.rejects(checkReceipt(n.receipt, m, stranger.key, trust), /wasn't signed by this publisher/);
});

test("forged receipts are refused", async () => {
  const { p, m } = parts(loggedNotes);
  const clone = () => JSON.parse(JSON.stringify(p.receipt));
  let r = clone(); r.proof = r.proof.map(() => "A".repeat(43) + "="); await assert.rejects(checkReceipt(r, m, p.sig.key, trust), /not in the log/);
  r = clone(); r.leaf.loggedAt += 1; await assert.rejects(checkReceipt(r, m, p.sig.key, trust), /not in the log/);
  r = clone(); r.checkpoint = r.checkpoint.split("\n").filter((l) => !l.includes("w2.dev")).join("\n"); await assert.rejects(checkReceipt(r, m, p.sig.key, trust), /not witnessed/);
  r = clone(); r.leaf.entry.version = m.version + "-x"; await assert.rejects(checkReceipt(r, m, p.sig.key, trust), /another app or version/);
  r = clone(); r.leaf.sig = r.leaf.sig.replace(/^./, (c) => (c === "A" ? "B" : "A")); await assert.rejects(checkReceipt(r, m, p.sig.key, trust), /signature is invalid/);
  // A receipt from another log (its own keys) isn't trusted, even if it's internally consistent.
  const lk = await newKey(), log = new Log("evil.log.example", lk), w = [new Witness("w1.dev.pwx.altru.dev", await newKey(), log.vkey, log.origin), new Witness("w2.dev.pwx.altru.dev", await newKey(), log.vkey, log.origin)];
  const entry = clone().leaf.entry; delete entry.signer;
  const i = await log.append(await signEntry(publisher, entry));
  const note = await log.checkpoint();
  const fake = await receipt(log, i, addCosigs(note, await Promise.all(w.map((x) => x.cosign(note)))));
  await assert.rejects(checkReceipt(fake, m, p.sig.key, trust), /not witnessed/);
  await assert.rejects(checkReceipt(null, m, p.sig.key, trust), /no receipt/);
});

test("with several pinned logs, only the log the receipt names is used", async () => {
  const { p, m } = parts(loggedNotes);
  const other = { ...trust, origin: "other.log.example", log: { name: "other.log.example", key: (await newKey()).key } };
  assert.equal((await checkReceipt(p.receipt, m, p.sig.key, [other, trust])).logged, true);
  await assert.rejects(checkReceipt(p.receipt, m, p.sig.key, [other]), /a log this loader doesn't know/);
  // Same name, different key: the checkpoint isn't signed by the pinned key.
  await assert.rejects(checkReceipt(p.receipt, m, p.sig.key, [{ ...trust, log: other.log }]), /not witnessed/);
});
