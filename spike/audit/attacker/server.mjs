// Audit only: a hostile website on https://127.0.0.2:9443 (self-signed; tests ignore cert errors).
// Any https origin works the same way; a real attacker would use a normal public site.
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
const DIR = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript" };
https.createServer({ key: readFileSync(join(DIR, "key.pem")), cert: readFileSync(join(DIR, "cert.pem")) }, (req, res) => {
  const name = basename(new URL(req.url, "https://127.0.0.2").pathname);
  const file = join(DIR, name);
  if (!/^[a-z-]+\.(html|js)$/.test(name) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": TYPES[extname(name)], "Cache-Control": "no-store" }).end(readFileSync(file));
}).listen(9443, "127.0.0.2", () => console.log("attacker site on https://127.0.0.2:9443"));
