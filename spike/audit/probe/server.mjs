// Stage 2 feasibility probe: can a document start a worker whose origin is opaque (so it has
// no CacheStorage or IndexedDB), in every engine? Two candidates: a data: URL worker, and a
// blob: worker started inside a CSP-sandboxed frame.
import http from "node:http";
const R = "http://127.0.0.1:9100";
const WORKER = `
const out = { origin: self.origin, isSecureContext };
try { out.idb = typeof indexedDB === "undefined" ? "absent" : "present"; } catch (e) { out.idb = "throws " + e.name; }
try { out.caches = typeof caches === "undefined" ? "absent" : "present"; } catch (e) { out.caches = "throws " + e.name; }
(async () => {
  try { await new Promise((ok, no) => { const r = indexedDB.open("x"); r.onsuccess = ok; r.onerror = () => no(r.error); }); out.idbOpen = "opened"; }
  catch (e) { out.idbOpen = "failed " + (e && e.name); }
  try { await caches.open("x"); out.cacheOpen = "opened"; } catch (e) { out.cacheOpen = "failed " + (e && e.name); }
  try { await fetch("${R}/ping"); out.fetch = "allowed"; } catch (e) { out.fetch = "blocked"; }
  out.rtc = typeof RTCPeerConnection;
  postMessage(out);
})();`;
const page = (body) => `<!doctype html><meta charset=utf-8><body><script src="${body}"></script></body>`;
http.createServer((req, res) => {
  const u = new URL(req.url, R);
  const js = (s) => res.writeHead(200, { "Content-Type": "text/javascript" }).end(s);
  if (u.pathname === "/ping") return res.writeHead(200, { "Access-Control-Allow-Origin": "*" }).end("pong");
  if (u.pathname === "/data.html") return res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": `default-src 'self'; worker-src data:; connect-src 'none'` }).end(page("/data.js"));
  if (u.pathname === "/data.js") return js(`const w = new Worker("data:text/javascript;base64," + btoa(${JSON.stringify(WORKER)})); w.onmessage = (e) => { window.result = e.data; }; w.onerror = (e) => { window.result = { error: String(e.message || "worker error") }; };`);
  if (u.pathname === "/outer.html") return res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": `default-src 'self'; frame-src 'self'` }).end(`<!doctype html><body><iframe src="/sandbox.html"></iframe><script src="/outer.js"></script></body>`);
  if (u.pathname === "/outer.js") return js(`addEventListener("message", (e) => { window.result = e.data; });`);
  if (u.pathname === "/sandbox.html") return res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": `sandbox allow-scripts; default-src 'none'; script-src ${R}; worker-src blob:; connect-src 'none'` }).end(page(`${R}/sandbox.js`));
  if (u.pathname === "/sandbox.js") return js(`try { const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: "text/javascript" }))); w.onmessage = (e) => parent.postMessage({ ...e.data, docOrigin: self.origin }, "*"); w.onerror = (e) => parent.postMessage({ error: String(e.message || "worker error") }, "*"); } catch (e) { parent.postMessage({ error: e.name + ": " + e.message }, "*"); }`);
  res.writeHead(404).end();
}).listen(9100, "127.0.0.1", () => console.log("probe on " + R));
