// App-origin service worker. Serves only verified files the loader installed into the
// cache, with the headers the loader built from the manifest. Never fetches app code.
// It also keeps the PWX runtime (bootstrap, strict shell, renderer, styles) on the device,
// so installed apps run with no network.
const RUNTIME = "pwx-runtime-v1";
const RUNTIME_FILES = ["/__pwx/bootstrap.html", "/__pwx/bootstrap.js", "/__pwx/strict.html",
  "/__pwx/renderer.js", "/__pwx/ui.css", "/__pwx/guard.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(RUNTIME).then((c) => c.addAll(RUNTIME_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith("/app/")) {
    e.respondWith((async () => {
      const hit = await caches.match(u.pathname, { cacheName: "pwx-verified" });
      return hit ?? new Response("not a verified file", { status: 404 });
    })());
  } else if (RUNTIME_FILES.includes(u.pathname)) {
    e.respondWith((async () => (await caches.match(u.pathname, { cacheName: RUNTIME })) ?? fetch(e.request))());
  }
});
