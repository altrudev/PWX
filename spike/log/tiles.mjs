// The log as plain static files, in the public tlog-tiles layout (c2sp.org/tlog-tiles), so any
// ordinary web host or CDN can serve it and anyone can mirror it:
//   checkpoint                       signed checkpoint (note.mjs), the only file that changes
//   tile/<L>/<N>[.p/<W>]             up to 256 hashes of complete subtrees, 32 bytes each
//   tile/entries/<N>[.p/<W>]         up to 256 entries, each prefixed with a big-endian u16 length
// Full tiles never change, so they can be cached forever; ".p/<W>" files are partial tiles.
// The reader fetches only the tiles it needs and builds proofs from them.
import * as M from "./merkle.mjs";

export const WIDTH = 256;
const cat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; } return out;
};
// 1234067 -> "x001/x234/067"; 5 -> "005"
export function nPath(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("tiles: bad index");
  const groups = []; let s = String(n);
  while (s.length > 3) { groups.unshift(s.slice(-3)); s = s.slice(0, -3); }
  groups.unshift(s.padStart(3, "0"));
  return groups.map((g, i) => (i < groups.length - 1 ? "x" + g : g)).join("/");
}
const suffix = (w) => (w > 0 && w < WIDTH ? `.p/${w}` : "");
export const tilePath = (level, n, w = 0) => `tile/${level}/${nPath(n)}${suffix(w)}`;
export const entriesPath = (n, w = 0) => `tile/entries/${nPath(n)}${suffix(w)}`;

// Every tile and entry bundle for a log of these leaves. leafData: Uint8Array[], leafHashes: Uint8Array[]
export async function buildTiles(leafData, leafHashes) {
  if (leafData.length !== leafHashes.length) throw new Error("tiles: data and hashes differ");
  const files = new Map();
  for (let b = 0; b * WIDTH < leafData.length; b++) {
    const ents = leafData.slice(b * WIDTH, (b + 1) * WIDTH), parts = [];
    for (const e of ents) {
      if (e.length > 0xffff) throw new Error("tiles: entry too large");
      parts.push(Uint8Array.of(e.length >> 8, e.length & 0xff), e);
    }
    files.set(entriesPath(b, ents.length), cat(parts));
  }
  let row = leafHashes;
  for (let level = 0; row.length > 0; level++) {
    for (let t = 0; t * WIDTH < row.length; t++) {
      const hs = row.slice(t * WIDTH, (t + 1) * WIDTH);
      files.set(tilePath(level, t, hs.length), cat(hs));
    }
    const next = [];
    for (let t = 0; (t + 1) * WIDTH <= row.length; t++) next.push(await M.root(row.slice(t * WIDTH, (t + 1) * WIDTH)));
    row = next;
  }
  return files;
}

const split = (n) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

// Reads a log of `size` leaves through `get(path) -> Uint8Array` (fetch, a file system, ...).
export class TileReader {
  constructor(get, size) { this.get = get; this.size = size; this.cache = new Map(); }
  // A partial tile may be gone once the log has grown and the full tile exists (tlog-tiles lets
  // hosts delete them), so fall back to the full tile and use its first `w` items. Every hash is
  // still checked against a signed root by whoever uses it.
  async fetchTile(path, w, fullPath) {
    try { return { raw: await this.get(path), partial: true }; }
    catch (e) { if (w < WIDTH) return { raw: await this.get(fullPath), partial: false }; throw e; }
  }
  // Hashes in tile `t` of level `level`: only complete subtrees, so a tile's width follows from the size.
  async tile(level, t) {
    const inRow = Math.floor(this.size / WIDTH ** level), w = Math.min(WIDTH, inRow - t * WIDTH);
    if (!(w > 0)) throw new Error("tiles: no such tile");
    const path = tilePath(level, t, w);
    if (!this.cache.has(path)) {
      const { raw, partial } = await this.fetchTile(path, w, tilePath(level, t));
      if (!(raw instanceof Uint8Array) || (partial ? raw.length !== 32 * w : raw.length !== 32 * WIDTH)) throw new Error(`tiles: ${path} has the wrong length`);
      this.cache.set(path, Array.from({ length: w }, (_, i) => raw.slice(32 * i, 32 * (i + 1))));
    }
    return this.cache.get(path);
  }
  // Hash of the complete subtree of height h covering leaves [k*2^h, (k+1)*2^h).
  async node(h, k) {
    const level = Math.floor(h / 8), r = h % 8, first = k * 2 ** r;
    let hs = [];
    for (let j = 0; j < 2 ** r; j++) {
      const i = first + j; hs.push((await this.tile(level, Math.floor(i / WIDTH)))[i % WIDTH]);
    }
    while (hs.length > 1) { const up = []; for (let j = 0; j < hs.length; j += 2) up.push(await M.nodeHash(hs[j], hs[j + 1])); hs = up; }
    return hs[0];
  }
  // Merkle tree hash of leaves [lo, hi), as RFC 6962 defines it.
  async range(lo, hi) {
    const n = hi - lo;
    if (n === 1) return this.node(0, lo);
    if ((n & (n - 1)) === 0 && lo % n === 0) return this.node(Math.log2(n), lo / n);
    const k = split(n);
    return M.nodeHash(await this.range(lo, lo + k), await this.range(lo + k, hi));
  }
  async root(size = this.size) { return size === 0 ? new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array())) : this.range(0, size); }
  async inclusionProof(m, size = this.size) {
    const path = async (m, lo, hi) => {
      const n = hi - lo; if (n <= 1) return [];
      const k = split(n);
      return m < k ? [...await path(m, lo, lo + k), await this.range(lo + k, hi)]
        : [...await path(m - k, lo + k, hi), await this.range(lo, lo + k)];
    };
    if (!(m >= 0 && m < size && size <= this.size)) throw new Error("tiles: index out of range");
    return path(m, 0, size);
  }
  async consistencyProof(m, size = this.size) {
    const sub = async (m, lo, hi, whole) => {
      const n = hi - lo;
      if (m === n) return whole ? [] : [await this.range(lo, hi)];
      const k = split(n);
      return m <= k ? [...await sub(m, lo, lo + k, whole), await this.range(lo + k, hi)]
        : [...await sub(m - k, lo + k, hi, false), await this.range(lo, lo + k)];
    };
    if (!(m >= 0 && m <= size && size <= this.size)) throw new Error("tiles: size out of range");
    return m === 0 || m === size ? [] : sub(m, 0, size, true);
  }
  // The bytes of entry i.
  async entry(i) {
    if (!(i >= 0 && i < this.size)) throw new Error("tiles: index out of range");
    const b = Math.floor(i / WIDTH), w = Math.min(WIDTH, this.size - b * WIDTH), path = entriesPath(b, w);
    if (!this.cache.has(path)) {
      const { raw, partial } = await this.fetchTile(path, w, entriesPath(b)), ents = [];
      for (let o = 0; o < raw.length;) {
        if (o + 2 > raw.length) throw new Error(`tiles: ${path} is truncated`);
        const len = (raw[o] << 8) | raw[o + 1]; o += 2;
        if (o + len > raw.length) throw new Error(`tiles: ${path} is truncated`);
        ents.push(raw.slice(o, o + len)); o += len;
      }
      if (ents.length !== (partial ? w : WIDTH)) throw new Error(`tiles: ${path} has ${ents.length} entries, expected ${w}`);
      this.cache.set(path, ents);
    }
    return this.cache.get(path)[i % WIDTH];
  }
  // Entry i, proven against a signed root (base64): the bytes, its index and its inclusion proof.
  // Tiles are untrusted; anything changed in them makes this fail.
  async provenEntry(i, rootB64, size = this.size) {
    const data = await this.entry(i), proof = await this.inclusionProof(i, size);
    const root = Uint8Array.from(atob(rootB64), (c) => c.charCodeAt(0));
    if (!(await M.verifyInclusion(i, size, await M.leafHash(data), proof, root))) throw new Error(`tiles: entry ${i} is not in the signed log`);
    return { data, proof };
  }
}
