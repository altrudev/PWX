#!/usr/bin/env node
// pwx-local: Verified-tier local loader.
// Serves the PWX loader and runtime from this machine, on loopback only, after checking every
// file it serves against a signed release. It makes no network requests of its own while
// serving; the browser talks only to 127.0.0.1. Each app gets its own origin (its own port).
//
//   node local/pwx-local.mjs serve              start serving (default port 7100)
//   node local/pwx-local.mjs add <file.pwx.json> make a package available to install
//   node local/pwx-local.mjs verify             check the bundle and exit
//
// Environment: PWX_HOME (default ~/.pwx), PWX_PORT (default 7100), PWX_BUNDLE (default: this repo).
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const BUNDLE = process.env.PWX_BUNDLE ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.PWX_HOME ?? join(homedir(), ".pwx");
const PORT = Number(process.env.PWX_PORT ?? 7100);
const HOSTNAME = "127.0.0.1";
const LOADER = `http://${HOSTNAME}:${PORT}`;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json" };

const { canonicalize, sha256, strictParse, b64 } = await import(join(BUNDLE, "lib/pwx-verify.mjs"));

// ---------- self-check: refuse to serve anything unless the bundle matches a signed release ----------
async function verifyBundle() {
  const rel = strictParse(readFileSync(join(BUNDLE, "local/release.json"), "utf8"));
  const pub = readFileSync(join(BUNDLE, "local/release.pub"), "utf8").trim();
  if (rel.sig?.alg !== "ed25519" || rel.sig.key !== pub) throw new Error("release is not signed by the pinned key");
  const key = await crypto.subtle.importKey("raw", b64.dec(pub), { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64.dec(rel.sig.sig),
    new TextEncoder().encode(canonicalize(rel.release)));
  if (!ok) throw new Error("release signature is invalid");
  const files = new Map();
  for (const [path, hash] of Object.entries(rel.release.files)) {
    const bytes = new Uint8Array(readFileSync(join(BUNDLE, path)));
    if ((await sha256(bytes)) !== hash) throw new Error(`modified file: ${path}`);
    files.set(path, bytes); // serve exactly the bytes that were checked
  }
  return { version: rel.release.version, files };
}

// ---------- per-app origins ----------
const portsFile = join(HOME, "ports.json");
const loadPorts = () => (existsSync(portsFile) ? JSON.parse(readFileSync(portsFile, "utf8")) : {});
const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}
function sendFile(res, bundle, path, headers = {}) {
  const bytes = bundle.files.get(path);
  if (!bytes) return send(res, 404, "not found");
  send(res, 200, bytes, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", ...headers });
}

function appServer(bundle, port) {
  const RUNTIME = { "/__pwx/bootstrap.js": "app-origin/bootstrap.js", "/__pwx/guard.js": "app-origin/guard.js",
    "/__pwx/renderer.js": "app-origin/renderer.js", "/__pwx/ui.css": "app-origin/ui.css" };
  return http.createServer((req, res) => {
    const u = new URL(req.url, `http://${HOSTNAME}:${port}`);
    if (u.pathname === "/__pwx/bootstrap.html") {
      return sendFile(res, bundle, "app-origin/bootstrap.html", { "Content-Security-Policy": `default-src 'self'; script-src 'self'; frame-ancestors ${LOADER}` });
    }
    if (u.pathname === "/__pwx/strict.html") {
      return sendFile(res, bundle, "app-origin/strict.html", { "Content-Security-Policy":
        `default-src 'none'; script-src 'self'; worker-src 'self'; img-src blob:; style-src 'self'; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${LOADER}` });
    }
    if (u.pathname === "/sw.js") return sendFile(res, bundle, "app-origin/sw.js", { "Service-Worker-Allowed": "/" });
    if (RUNTIME[u.pathname]) return sendFile(res, bundle, RUNTIME[u.pathname]);
    send(res, 404, "not served from network");
  }).listen(port, HOSTNAME);
}

async function serve() {
  const bundle = await verifyBundle();
  mkdirSync(join(HOME, "packages"), { recursive: true });
  const ports = loadPorts();
  const running = new Map();
  const ensureApp = (port) => { if (!running.has(port)) running.set(port, appServer(bundle, port)); };
  Object.values(ports).forEach(ensureApp);
  const appOrigins = () => Object.values(ports).map((p) => `http://${HOSTNAME}:${p}`).join(" ") || "'none'";

  const LOADER_FILES = { "/": "loader/index.html", "/loader.mjs": "loader/loader.mjs", "/loader.css": "loader/loader.css",
    "/store.mjs": "loader/store.mjs", "/lib/pwx-verify.mjs": "lib/pwx-verify.mjs" };
  http.createServer((req, res) => {
    const u = new URL(req.url, LOADER);
    if (u.pathname === "/__pwx/mode") return send(res, 200, JSON.stringify({ local: true, version: bundle.version }), { "Content-Type": "application/json" });
    if (u.pathname === "/__pwx/origin") {
      const id = u.searchParams.get("id") ?? "";
      if (!ID_RE.test(id)) return send(res, 400, "bad id");
      const fresh = !ports[id];
      if (fresh) {
        const used = new Set(Object.values(ports));
        let p = PORT + 1; while (used.has(p)) p++;
        ports[id] = p; writeFileSync(portsFile, JSON.stringify(ports, null, 2));
      }
      ensureApp(ports[id]);
      return send(res, 200, JSON.stringify({ origin: `http://${HOSTNAME}:${ports[id]}`, fresh }), { "Content-Type": "application/json" });
    }
    if (u.pathname.startsWith("/packages/")) {
      const name = basename(u.pathname);
      const file = join(HOME, "packages", name);
      if (!/^[a-z0-9-]+\.pwx\.json$/.test(name) || !existsSync(file)) return send(res, 404, "no such package");
      return send(res, 200, readFileSync(file), { "Content-Type": "application/json" });
    }
    const path = LOADER_FILES[u.pathname];
    if (!path) return send(res, 404, "not found");
    // The loader page may frame only the app origins this machine has assigned.
    sendFile(res, bundle, path, { "Content-Security-Policy":
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${appOrigins()}; object-src 'none'; base-uri 'none'; form-action 'none'` });
  }).listen(PORT, HOSTNAME, () => {
    console.log(`pwx-local ${bundle.version}: verified ${bundle.files.size} files, serving ${LOADER} (loopback only)`);
  });
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "serve") await serve();
  else if (cmd === "verify") { const b = await verifyBundle(); console.log(`bundle OK: ${b.version}, ${b.files.size} files`); }
  else if (cmd === "add") {
    mkdirSync(join(HOME, "packages"), { recursive: true });
    const name = basename(arg ?? "");
    if (!/^[a-z0-9-]+\.pwx\.json$/.test(name)) throw new Error("expected a file named <name>.pwx.json");
    copyFileSync(arg, join(HOME, "packages", name));
    console.log(`added ${name}; open ${LOADER}/?pkg=${name.replace(".pwx.json", "")} to verify and install it`);
  } else if (cmd === "list") console.log(readdirSync(join(HOME, "packages")).join("\n"));
  else { console.error("usage: pwx-local serve | add <file.pwx.json> | list | verify"); process.exit(2); }
} catch (err) {
  console.error(`pwx-local: refusing to run: ${err.message}`);
  process.exit(1);
}
