#!/usr/bin/env node
// Spike servers (all on 127.0.0.1):
//   8100 loader host      - loader page, verifier library, packages, test endpoints
//   8101 app origin       - bootstrap page + service worker only; app files come from the SW cache
//   8102 control origin   - serves the leak-test app raw, with no PWX protections (positive control)
//   8199 canary           - records every HTTP / WebSocket request and TCP connection
//   3478/udp canary       - records STUN packets (WebRTC)
import http from "node:http";
import dgram from "node:dgram";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const LOADER = "http://127.0.0.1:8100", APP = "http://127.0.0.1:8101";
// PWX_TEST=1: serve the test config (test switches on) and the unsafe positive-control page.
// Without it, this server behaves like a production host.
const TEST = process.env.PWX_TEST === "1";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css" };

const hits = []; let tcp = 0;
const served = []; // requests that reached the loader or app host (not test hooks)
const record = (kind, path) => hits.push({ kind, path, at: Date.now() });

function serveFile(res, base, rel, headers = {}) {
  const p = normalize(join(base, rel));
  if (!p.startsWith(base) || !existsSync(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[extname(p)] ?? "application/octet-stream", "Cache-Control": "no-store", ...headers });
  res.end(readFileSync(p));
}

// 8100 loader host
http.createServer((req, res) => {
  const u = new URL(req.url, LOADER);
  if (u.pathname === "/__test/hits") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ hits, tcp })); }
  if (u.pathname === "/__test/reset") { hits.length = 0; tcp = 0; served.length = 0; return res.writeHead(204).end(); }
  if (u.pathname === "/__test/served") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(served)); }
  served.push(`loader ${u.pathname}`);
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${APP}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  if (u.pathname === "/config.mjs") {
    if (TEST) { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); return res.end("export const TEST = true;\n"); }
    return serveFile(res, join(ROOT, "loader"), "config.mjs");
  }
  if (u.pathname === "/" ) return serveFile(res, join(ROOT, "loader"), "index.html", { "Content-Security-Policy": csp });
  if (u.pathname.startsWith("/lib/")) return serveFile(res, join(ROOT, "lib"), u.pathname.slice(5));
  if (u.pathname === "/sw.js") return serveFile(res, join(ROOT, "loader"), "sw.js", { "Cache-Control": "max-age=86400" });
  if (u.pathname.startsWith("/packages/")) {
    const name = u.pathname.slice(10); // only package files, never anything else in that folder
    if (!/^[a-z0-9-]+\.pwx\.json$/.test(name)) return res.writeHead(404).end();
    return serveFile(res, join(ROOT, "packages"), name);
  }
  return serveFile(res, join(ROOT, "loader"), u.pathname.slice(1), { "Content-Security-Policy": csp });
}).listen(8100, "127.0.0.1");

// 8101 app origin: only the bootstrap and the service worker are ever served from the network.
http.createServer((req, res) => {
  const u = new URL(req.url, APP);
  served.push(`app ${u.pathname}`);
  // PWX pages may load only into a frame (or be fetched by this origin's own service worker),
  // never as a tab. Browsers send Sec-Fetch-Dest; a top-level open says "document".
  const framedOnly = u.pathname === "/__pwx/bootstrap.html" || u.pathname.startsWith("/__pwx/strict");
  const dest = req.headers["sec-fetch-dest"], site = req.headers["sec-fetch-site"];
  if (framedOnly && !(dest === "iframe" || (dest === "empty" && site === "same-origin"))) {
    return res.writeHead(403, { "Content-Type": "text/plain" }).end("PWX pages only open inside the PWX loader.");
  }
  if (u.pathname === "/__pwx/bootstrap.html") {
    return serveFile(res, join(ROOT, "app-origin"), "bootstrap.html", {
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; frame-ancestors ${LOADER}`,
    });
  }
  if (u.pathname === "/__pwx/bootstrap.js") return serveFile(res, join(ROOT, "app-origin"), "bootstrap.js");
  if (u.pathname === "/__pwx/guard.js") return serveFile(res, join(ROOT, "app-origin"), "guard.js");
  if (u.pathname === "/__pwx/renderer.js") return serveFile(res, join(ROOT, "app-origin"), "renderer.js");
  if (u.pathname === "/__pwx/ui.css") return serveFile(res, join(ROOT, "app-origin"), "ui.css");
  if (TEST && u.pathname === "/__pwx/strict-unsafe.html") {
    return serveFile(res, join(ROOT, "app-origin"), "strict.html", { "Content-Security-Policy": `frame-ancestors ${LOADER}` });
  }
  if (u.pathname === "/__pwx/strict.html") {
    return serveFile(res, join(ROOT, "app-origin"), "strict.html", {
      "Content-Security-Policy": `default-src 'none'; script-src 'self'; worker-src 'self'; img-src blob:; style-src 'self'; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${LOADER}`,
    });
  }
  if (u.pathname === "/sw.js") {
    const sw = readFileSync(join(ROOT, "app-origin/sw.js"), "utf8").replace("__PWX_LOADER_ORIGIN__", LOADER);
    res.writeHead(200, { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/", "Cache-Control": "max-age=86400" });
    return res.end(sw);
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("not served from network");
}).listen(8101, "127.0.0.1");

// 8102 control origin: the same leak-test app with no protections at all.
http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1:8102");
  if (u.pathname === "/") return serveFile(res, join(ROOT, "server"), "control.html");
  if (u.pathname === "/control.js") return serveFile(res, join(ROOT, "server"), "control.js");
  return serveFile(res, join(ROOT, "apps", "evil"), u.pathname.slice(1));
}).listen(8102, "127.0.0.1");

// 8199 canary
const canary = http.createServer((req, res) => {
  record("http", req.url);
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end("ok");
});
canary.on("connection", () => { tcp++; });
canary.on("upgrade", (req, socket) => { record("websocket", req.url); socket.destroy(); });
canary.listen(8199, "127.0.0.1");

// 3478/udp canary
for (const [port, name] of [[3478, "webrtc-stun"], [3479, "webrtc-fresh-realm"], [3480, "worker-webrtc"]]) {
  const udp = dgram.createSocket("udp4");
  udp.on("message", () => record("udp", `/leak/${name}`));
  udp.bind(port, "127.0.0.1");
}

console.log("PWX spike servers up: loader :8100, app :8101, control :8102, canary :8199 + udp/3478-3480");
