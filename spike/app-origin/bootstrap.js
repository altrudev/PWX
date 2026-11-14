// Receives verified files from the loader and installs them into the app origin's cache.
// Accepts messages only from the loader origin.
const LOADER = "http://127.0.0.1:8100";
const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", wasm: "application/wasm", svg: "image/svg+xml", png: "image/png" };
const ready = navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready);

addEventListener("message", async (e) => {
  if (e.origin !== LOADER || e.data?.type !== "install") return;
  try {
    await ready;
    await caches.delete("pwx-verified");
    const cache = await caches.open("pwx-verified");
    for (const [path, bytes] of Object.entries(e.data.files)) {
      const ext = path.split(".").pop();
      await cache.put("/" + path, new Response(bytes, {
        headers: { ...e.data.headers, "Content-Type": TYPES[ext] ?? "application/octet-stream" },
      }));
    }
    e.source.postMessage({ type: "installed" }, LOADER);
  } catch (err) {
    e.source.postMessage({ type: "install-failed", error: String(err) }, LOADER);
  }
});
parent.postMessage({ type: "bootstrap-ready" }, LOADER);
