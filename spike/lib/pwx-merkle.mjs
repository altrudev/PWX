// Merkle tree hashing, inclusion proofs and consistency proofs, as in RFC 6962 / RFC 9162
// (Certificate Transparency). Works in browsers and Node: WebCrypto only.
const H = async (...parts) => {
  const len = parts.reduce((n, p) => n + p.length, 0), buf = new Uint8Array(len);
  let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
};
const ZERO = Uint8Array.of(0), ONE = Uint8Array.of(1);
export const leafHash = (data) => H(ZERO, data);
export const nodeHash = (l, r) => H(ONE, l, r);
export const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const split = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };   // largest power of 2 < n

// Root of a list of leaf hashes (MTH). Empty tree: hash of the empty string.
export async function root(leaves) {
  if (leaves.length === 0) return H();
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return nodeHash(await root(leaves.slice(0, k)), await root(leaves.slice(k)));
}

// Inclusion proof for leaf m in a tree of these leaves (PATH).
export async function inclusionProof(m, leaves) {
  if (leaves.length <= 1) return [];
  const k = split(leaves.length);
  return m < k
    ? [...await inclusionProof(m, leaves.slice(0, k)), await root(leaves.slice(k))]
    : [...await inclusionProof(m - k, leaves.slice(k)), await root(leaves.slice(0, k))];
}

// RFC 9162 section 2.1.3.2.
export async function verifyInclusion(index, size, leaf, proof, rootHash) {
  if (!(index >= 0 && index < size)) return false;
  let fn = index, sn = size - 1, r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if ((fn & 1) === 0) while (!((fn & 1) === 1 || fn === 0)) { fn >>= 1; sn >>= 1; }
    } else {
      r = await nodeHash(r, p);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 && eq(r, rootHash);
}

// Consistency proof that the first m leaves are a prefix of these leaves (PROOF / SUBPROOF).
async function subproof(m, leaves, whole) {
  const n = leaves.length;
  if (m === n) return whole ? [] : [await root(leaves)];
  const k = split(n);
  return m <= k
    ? [...await subproof(m, leaves.slice(0, k), whole), await root(leaves.slice(k))]
    : [...await subproof(m - k, leaves.slice(k), false), await root(leaves.slice(0, k))];
}
export const consistencyProof = (m, leaves) => (m === 0 || m === leaves.length ? [] : subproof(m, leaves, true));

// RFC 9162 section 2.1.4.2.
export async function verifyConsistency(size1, size2, root1, root2, proof) {
  if (size1 > size2) return false;
  if (size1 === size2) return proof.length === 0 && eq(root1, root2);
  if (size1 === 0) return proof.length === 0;
  let path = [...proof];
  if ((size1 & (size1 - 1)) === 0) path = [root1, ...path];   // size1 is a power of 2
  if (path.length === 0) return false;
  let fn = size1 - 1, sn = size2 - 1;
  while ((fn & 1) === 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0], sr = path[0];
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = await nodeHash(c, fr); sr = await nodeHash(c, sr);
      if ((fn & 1) === 0) while (!((fn & 1) === 1 || fn === 0)) { fn >>= 1; sn >>= 1; }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;
  }
  return eq(fr, root1) && eq(sr, root2) && sn === 0;
}
