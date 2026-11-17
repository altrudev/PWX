#!/usr/bin/env node
// Spike-only static server for the Signer test: http://127.0.0.1:8150/signer/
// Serves only lib/, signer/ and packages/*.pwx.json from the spike folder.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "../..");
const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json" };
const PORT = Number(process.env.SIGNER_PORT ?? 8150);
http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname.replace(/\/$/, "/index.html");
  const ok = /^\/(lib|signer)\/[\w.-]+$/.test(path) || /^\/packages\/[a-z0-9-]+\.pwx\.json$/.test(path);
  const file = normalize(join(ROOT, path));
  if (!ok || !file.startsWith(ROOT) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  res.end(readFileSync(file));
}).listen(PORT, "127.0.0.1", () => console.log(`signer spike on :${PORT}`));
