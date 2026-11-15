// PWX v0 spike: package verification shared by the loader (browser) and tests (Node).
// Uses only WebCrypto (globalThis.crypto.subtle). Every failure throws PwxError.

export class PwxError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const te = new TextEncoder();

// ---------- Strict JSON: rejects duplicate keys, which JSON.parse silently accepts ----------

const MAX_DEPTH = 64, MAX_TEXT = 64 * 1024 * 1024;
export function strictParse(text) {
  if (typeof text !== "string" || text.length > MAX_TEXT) throw new PwxError("json", "input too large");
  let i = 0, depth = 0;
  const ws = () => { while (i < text.length && " \t\n\r".includes(text[i])) i++; };
  const fail = (m) => { throw new PwxError("json", `${m} at ${i}`); };
  function value() {
    ws();
    const c = text[i];
    if (c === "{" || c === "[") {
      if (++depth > MAX_DEPTH) fail("nested too deeply");
      const v = c === "{" ? object() : array();
      depth--;
      return v;
    }
    if (c === '"') return string();
    if (c === "t" && text.startsWith("true", i)) { i += 4; return true; }
    if (c === "f" && text.startsWith("false", i)) { i += 5; return false; }
    if (c === "n" && text.startsWith("null", i)) { i += 4; return null; }
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    fail("unexpected token");
  }
  function object() {
    i++; const out = Object.create(null); const seen = new Set(); ws();
    if (text[i] === "}") { i++; return out; }
    for (;;) {
      ws(); if (text[i] !== '"') fail("expected key");
      const k = string();
      if (seen.has(k)) fail(`duplicate key "${k}"`);
      seen.add(k); ws();
      if (text[i] !== ":") fail("expected :"); i++;
      out[k] = value(); ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "}") { i++; return out; }
      fail("expected , or }");
    }
  }
  function array() {
    i++; const out = []; ws();
    if (text[i] === "]") { i++; return out; }
    for (;;) {
      out.push(value()); ws();
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "]") { i++; return out; }
      fail("expected , or ]");
    }
  }
  function string() {
    const start = i; i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
    if (text[i] !== '"') fail("unterminated string");
    i++;
    return JSON.parse(text.slice(start, i));
  }
  function number() {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail("bad number");
    if (m[2] || m[3]) fail("only integers are allowed in a PWX manifest");
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n)) fail("integer out of range");
    return n;
  }
  const v = value(); ws();
  if (i !== text.length) fail("trailing data");
  return v;
}

// ---------- Canonical JSON (RFC 8785 subset: strings, safe integers, booleans, null) ----------

export function canonicalize(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new PwxError("json", "non-integer number");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort((a, b) => {
    // RFC 8785 sorts by UTF-16 code units, which is JS's default string order.
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

// ---------- Manifest validation ----------

// https or wss, lowercase LDH host (or IPv4), optional port, nothing else.
const ORIGIN_RE = /^(https|wss):\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/;
const PATH_RE = /^app\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const HASH_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;

// IP literals, localhost and private-use names: an app must not reach the user's machine,
// home network or cloud metadata. (A future, separately granted capability could allow LAN.)
function isLocalHost(host) {
  if (/^\d+(\.\d+){3}$/.test(host)) return true;          // any IPv4 literal
  if (/^\d+$/.test(host.split(".").pop())) return true;      // numeric last label
  return host === "localhost" || /\.(localhost|local|internal|home\.arpa|lan)$/.test(host);
}

export function checkOrigin(o, { allowLoopbackHttp = false } = {}) {
  if (typeof o !== "string") throw new PwxError("manifest", "origin must be a string");
  if (allowLoopbackHttp && /^(http|ws):\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(o)) return o;
  const m = ORIGIN_RE.exec(o);
  if (!m) throw new PwxError("manifest", `bad origin ${JSON.stringify(o)}`);
  if (m[3] && Number(m[3]) > 65535) throw new PwxError("manifest", `bad port in ${o}`);
  if (m[2].split(".").some((l) => l.startsWith("xn--") && l.length < 5)) throw new PwxError("manifest", `bad label in ${o}`);
  if (isLocalHost(m[2])) throw new PwxError("manifest", `local or private host not allowed: ${o}`);
  return o;
}

const CAPS = new Set(["network", "storage", "files", "clipboard", "camera", "microphone", "location", "notifications", "sync"]);

export function validateManifest(m, opts = {}) {
  const need = (cond, msg) => { if (!cond) throw new PwxError("manifest", msg); };
  need(m && typeof m === "object" && !Array.isArray(m), "manifest must be an object");
  need(m.pwx === "0", "unsupported pwx version");
  need(typeof m.id === "string" && /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(m.id), "bad id");
  need(typeof m.version === "string" && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(m.version), "bad version");
  need(typeof m.publisher === "string" && m.publisher.startsWith("ed25519:"), "bad publisher");
  need(typeof m.entry === "string" && PATH_RE.test(m.entry), "bad entry");
  const caps = m.capabilities ?? {};
  need(typeof caps === "object" && !Array.isArray(caps), "capabilities must be an object");
  for (const k of Object.keys(caps)) need(CAPS.has(k), `unknown capability ${k}`);
  const net = caps.network ?? {};
  const connect = net.connect ?? [];
  need(Array.isArray(connect), "network.connect must be a list");
  connect.forEach((o) => checkOrigin(o, opts));
  need(new Set(connect).size === connect.length, "duplicate origin");
  need(["none", "peer-only", "any", undefined].includes(net.webrtc), "bad network.webrtc");
  if (caps.storage !== undefined) {
    const st = caps.storage;
    need(st && typeof st === "object" && !Array.isArray(st), "storage must be an object");
    for (const k of Object.keys(st)) need(k === "local" || k === "persistent", `unknown storage key ${k}`);
    for (const k of ["local", "persistent"]) need(st[k] === undefined || typeof st[k] === "boolean", `storage.${k} must be boolean`);
    need(!st.persistent || st.local === true, "storage.persistent needs storage.local");
  }
  for (const k of ["camera", "microphone", "location", "notifications"]) {
    need(caps[k] === undefined || typeof caps[k] === "boolean", `${k} must be boolean`);
  }
  need(m.files && typeof m.files === "object" && !Array.isArray(m.files), "files must be an object");
  for (const [p, h] of Object.entries(m.files)) {
    need(PATH_RE.test(p) && !p.split("/").includes(".."), `bad path ${p}`);
    need(typeof h === "string" && HASH_RE.test(h), `bad hash for ${p}`);
  }
  need(Object.hasOwn(m.files, m.entry), "entry is not a listed file");
  need(m.runtime === undefined || ["standard", "strict"].includes(m.runtime), "bad runtime");
  if (m.runtime === "strict") need(m.entry.endsWith(".js"), "strict entry must be a worker script");
  return m;
}

// ---------- Headers from a fixed template (never joined from raw input) ----------

export function buildHeaders(m, frameAncestor) {
  const connect = m.capabilities?.network?.connect ?? [];
  const webrtc = m.capabilities?.network?.webrtc ?? "none";
  const directives = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", "blob:", "data:"]],
    ["font-src", ["'self'"]],
    ["media-src", ["'self'", "blob:"]],
    ["connect-src", connect.length ? connect : ["'none'"]],
    ["worker-src", ["'self'"]],
    ["frame-src", ["'none'"]],
    ["child-src", ["'none'"]],
    ["object-src", ["'none'"]],
    ["manifest-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["frame-ancestors", [frameAncestor]],
  ];
  if (webrtc === "none") directives.push(["webrtc", ["'block'"]]);
  // Values were validated by checkOrigin; this assertion is a second guard.
  for (const [, vals] of directives) for (const v of vals) {
    if (/[;,\s]/.test(v)) throw new PwxError("headers", `unsafe header token ${v}`);
  }
  const csp = directives.map(([d, v]) => `${d} ${v.join(" ")}`).join("; ");
  const allow = (k) => (m.capabilities?.[k] ? "(self)" : "()");
  const pp = [
    `camera=${allow("camera")}`, `microphone=${allow("microphone")}`,
    `geolocation=${allow("location")}`, "usb=()", "serial=()", "hid=()",
    "bluetooth=()", "payment=()", "display-capture=()", "publickey-credentials-get=()",
  ].join(", ");
  return {
    "Content-Security-Policy": csp,
    "Permissions-Policy": pp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

// ---------- Package verification ----------

const b64 = {
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  enc: (u8) => btoa(String.fromCharCode(...u8)),
};

export async function sha256(bytes) {
  return "sha256-" + b64.enc(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

// pkg: { manifest: <JSON text>, sig: { alg, key, sig }, files: { path: base64 } }
export async function verifyPackage(pkgText, opts = {}) {
  const pkg = strictParse(pkgText);
  for (const k of Object.keys(pkg)) {
    if (!["manifest", "sig", "files"].includes(k)) throw new PwxError("package", `unknown field ${k}`);
  }
  if (typeof pkg.manifest !== "string") throw new PwxError("package", "manifest must be text");
  const manifest = validateManifest(strictParse(pkg.manifest), opts);
  const canonical = te.encode(canonicalize(manifest));

  const { alg, key, sig } = pkg.sig ?? {};
  if (alg !== "ed25519") throw new PwxError("signature", "unsupported algorithm");
  if (`ed25519:${key}` !== manifest.publisher) throw new PwxError("signature", "key does not match publisher");
  if (opts.trustedPublisher && manifest.publisher !== opts.trustedPublisher) {
    throw new PwxError("signature", "publisher changed");
  }
  const pub = await crypto.subtle.importKey("raw", b64.dec(key), { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, pub, b64.dec(sig), canonical))) {
    throw new PwxError("signature", "invalid signature");
  }

  const files = {};
  const listed = Object.keys(manifest.files);
  for (const p of Object.keys(pkg.files ?? {})) {
    if (!Object.hasOwn(manifest.files, p)) throw new PwxError("files", `unlisted file ${p}`);
  }
  for (const p of listed) {
    if (!Object.hasOwn(pkg.files ?? {}, p)) throw new PwxError("files", `missing file ${p}`);
    const bytes = b64.dec(pkg.files[p]);
    if ((await sha256(bytes)) !== manifest.files[p]) throw new PwxError("files", `hash mismatch ${p}`);
    files[p] = bytes;
  }
  if (opts.installedVersion && cmpVersion(manifest.version, opts.installedVersion) <= 0) {
    throw new PwxError("rollback", `${manifest.version} is not newer than ${opts.installedVersion}`);
  }
  return { manifest, files };
}

export function cmpVersion(a, b) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export { b64 };
