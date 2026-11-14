// App-origin service worker. Serves only verified files the loader installed into the
// cache, with the headers the loader built from the manifest. Never fetches app code.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith("/app/")) return;
  e.respondWith((async () => {
    const hit = await caches.match(u.pathname, { cacheName: "pwx-verified" });
    return hit ?? new Response("not a verified file", { status: 404 });
  })());
});
