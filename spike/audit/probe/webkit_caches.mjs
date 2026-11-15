// Does WebKit's opaque-origin worker CacheStorage reach the creating origin's caches?
import http from "node:http";
const R = "http://127.0.0.1:9101";
const WORKER = `(async () => {
  const out = {};
  try { out.workerSees = await caches.keys(); } catch (e) { out.keysError = e.name; }
  try { const c = await caches.open("pwx-runtime-v1"); await c.put("https://example.invalid/x", new Response("poisoned")); out.put = "ok"; } catch (e) { out.putError = e.name + " " + e.message; }
  postMessage(out);
})();`;
http.createServer((req, res) => {
  const u = new URL(req.url, R);
  if (u.pathname === "/") return res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'; worker-src data:" }).end(`<!doctype html><script src="/p.js"></script>`);
  if (u.pathname === "/p.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(`(async () => {
    await (await caches.open("page-marker")).put("/x", new Response("x"));
    const w = new Worker("data:text/javascript;base64," + btoa(${JSON.stringify(WORKER)}));
    w.onerror = (e) => { window.result = { workerError: String(e.message) }; };
    w.onmessage = async (e) => {
      const hit = await (await caches.open("pwx-runtime-v1")).match("https://example.invalid/x");
      window.result = { ...e.data, pageSeesWorkerWrite: Boolean(hit), pageKeys: await caches.keys() };
    };
  })();`);
  res.writeHead(404).end();
}).listen(9101, "127.0.0.1");
