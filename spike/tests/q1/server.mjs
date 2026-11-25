// Quarantine Part 1 probe servers (127.0.0.1): 8300 loader-like origin, 8399 canary (HTTP/WS/TCP), 3490/udp canary (STUN).
import http from "node:http"; import { createHash } from "node:crypto"; import dgram from "node:dgram"; import { readFileSync } from "node:fs";
const DIR = new URL(".", import.meta.url).pathname;
const hits = []; let tcp = 0, udp = 0;
// The loader's own CSP (as today), plus worker-src data: so a sealed frame may start a data: worker.
const FRAME_HASH = "sha256-" + createHash("sha256").update(readFileSync(new URL("frame.js", import.meta.url))).digest("base64");
const CSP = "default-src 'self'; script-src 'self' '" + FRAME_HASH + "'; worker-src 'self' data:; style-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/hits") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ hits, tcp, udp })); }
  if (u.pathname === "/reset") { hits.length = 0; tcp = udp = 0; return res.writeHead(204).end(); }
  if (u.pathname.startsWith("/loader-probe")) { hits.push({ kind: "loader-origin", path: u.pathname }); return res.writeHead(204).end(); }
  const f = { "/": "probe.html", "/probe.js": "probe.js", "/frame.js": "frame.js", "/sw.js": "sw.js" }[u.pathname];
  if (u.pathname === "/frame-hash") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(FRAME_HASH); }
  if (!f) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[f.split(".").pop()], "Cache-Control": "no-store", ...(f.endsWith(".html") ? { "Content-Security-Policy": CSP } : {}) });
  res.end(readFileSync(DIR + f));
}).listen(8300, "127.0.0.1");
const canary = http.createServer((req, res) => { hits.push({ kind: "http", path: req.url }); res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("x"); });
canary.on("connection", () => tcp++); canary.on("upgrade", (req, s) => { hits.push({ kind: "websocket", path: req.url }); s.destroy(); });
canary.listen(8399, "127.0.0.1");
const u = dgram.createSocket("udp4"); u.on("message", () => udp++); u.bind(3490, "127.0.0.1");
console.log("q1 probe up");
