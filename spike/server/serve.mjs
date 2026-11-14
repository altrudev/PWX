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
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css" };

const hits = []; let tcp = 0;
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
  if (u.pathname === "/__test/reset") { hits.length = 0; tcp = 0; return res.writeHead(204).end(); }
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${APP}; object-src 'none'; base-uri 'none'; form-action 'none'`;
  if (u.pathname === "/" ) return serveFile(res, join(ROOT, "loader"), "index.html", { "Content-Security-Policy": csp });
  if (u.pathname.startsWith("/lib/")) return serveFile(res, join(ROOT, "lib"), u.pathname.slice(5));
  if (u.pathname.startsWith("/packages/")) return serveFile(res, join(ROOT, "packages"), u.pathname.slice(10));
  return serveFile(res, join(ROOT, "loader"), u.pathname.slice(1), { "Content-Security-Policy": csp });
}).listen(8100, "127.0.0.1");

// 8101 app origin: only the bootstrap and the service worker are ever served from the network.
http.createServer((req, res) => {
  const u = new URL(req.url, APP);
  if (u.pathname === "/__pwx/bootstrap.html") {
    return serveFile(res, join(ROOT, "app-origin"), "bootstrap.html", {
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; frame-ancestors ${LOADER}`,
    });
  }
  if (u.pathname === "/__pwx/bootstrap.js") return serveFile(res, join(ROOT, "app-origin"), "bootstrap.js");
  if (u.pathname === "/sw.js") return serveFile(res, join(ROOT, "app-origin"), "sw.js", { "Service-Worker-Allowed": "/" });
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
const udp = dgram.createSocket("udp4");
udp.on("message", () => record("udp", "/leak/webrtc-stun"));
udp.bind(3478, "127.0.0.1");

console.log("PWX spike servers up: loader :8100, app :8101, control :8102, canary :8199 + udp/3478");
