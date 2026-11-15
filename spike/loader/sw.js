// Loader service worker: keeps the loader itself on the device so installed apps launch
// with no network at all. It contacts the host only when the user installs from it.
const CACHE = "pwx-loader-v1";
const SHELL = ["/", "/loader.mjs", "/loader.css", "/store.mjs", "/config.mjs", "/lib/pwx-verify.mjs"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;
  // Installs and test hooks always go to the host; everything else is local first.
  if (u.pathname.startsWith("/packages/") || u.pathname.startsWith("/__test/")) return;
  if (u.pathname === "/__pwx/mode") {
    e.respondWith(new Response('{"local":false}', { headers: { "Content-Type": "application/json" } }));
    return;
  }
  e.respondWith((async () => {
    const key = e.request.mode === "navigate" ? "/" : e.request;
    const hit = await caches.match(key, { ignoreSearch: e.request.mode === "navigate", cacheName: CACHE });
    return hit ?? fetch(e.request);
  })());
});
