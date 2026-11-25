// Serves frame.js from its own cache once installed, and counts which clients asked for it.
const C = "q1-v1"; let served = 0;
self.addEventListener("install", (e) => e.waitUntil(caches.open(C).then((c) => c.addAll(["/frame.js", "/", "/probe.js", "/frame-hash"])).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  if (u.pathname === "/frame.js") served++;
  if (["/frame.js", "/", "/probe.js", "/frame-hash"].includes(u.pathname))
    e.respondWith(caches.match(u.pathname).then((r) => r || fetch(e.request)));
});
self.addEventListener("message", (e) => e.ports[0]?.postMessage({ served }));
