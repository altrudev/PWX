// Merkle proofs (RFC 6962 / 9162) for every tree size up to 40: every proof verifies, and a
// changed leaf, root or proof element never does.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../log/merkle.mjs";

const leaves = await Promise.all(Array.from({ length: 40 }, (_, i) => M.leafHash(new TextEncoder().encode(`entry ${i}`))));
const roots = [await M.root([])];
for (let n = 1; n <= 40; n++) roots[n] = await M.root(leaves.slice(0, n));
const flip = (h) => { const c = Uint8Array.from(h); c[0] ^= 1; return c; };

test("inclusion proofs verify for every leaf of every tree, and fail when changed", async () => {
  for (let n = 1; n <= 40; n++) for (let m = 0; m < n; m++) {
    const proof = await M.inclusionProof(m, leaves.slice(0, n));
    assert.ok(await M.verifyInclusion(m, n, leaves[m], proof, roots[n]), `n=${n} m=${m}`);
    assert.ok(!await M.verifyInclusion(m, n, flip(leaves[m]), proof, roots[n]));
    assert.ok(!await M.verifyInclusion(m, n, leaves[m], proof, flip(roots[n])));
    if (proof.length) assert.ok(!await M.verifyInclusion(m, n, leaves[m], [flip(proof[0]), ...proof.slice(1)], roots[n]));
    if (n > 1) assert.ok(!await M.verifyInclusion((m + 1) % n, n, leaves[m], proof, roots[n]) || leaves[m] === leaves[(m + 1) % n]);
  }
});

test("consistency proofs verify for every pair of sizes, and fail when changed", async () => {
  for (let n = 1; n <= 40; n++) for (let m = 1; m <= n; m++) {
    const proof = await M.consistencyProof(m, leaves.slice(0, n));
    assert.ok(await M.verifyConsistency(m, n, roots[m], roots[n], proof), `m=${m} n=${n}`);
    if (m < n) {
      assert.ok(!await M.verifyConsistency(m, n, flip(roots[m]), roots[n], proof));
      assert.ok(!await M.verifyConsistency(m, n, roots[m], flip(roots[n]), proof));
    }
  }
});

test("a rewritten history is not consistent with the old one", async () => {
  const rewritten = [...leaves.slice(0, 20)]; rewritten[5] = await M.leafHash(new TextEncoder().encode("forged"));
  const proof = await M.consistencyProof(10, rewritten);
  assert.ok(!await M.verifyConsistency(10, 20, roots[10], await M.root(rewritten), proof));
});
