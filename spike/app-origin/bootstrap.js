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
    const GUARD = '<script src="/__pwx/guard.js"></script>';
    for (const [path, raw] of Object.entries(e.data.files)) {
      const ext = path.split(".").pop();
      // Optional guard: loader code placed ahead of the verified bytes, which are unchanged.
      let bytes = raw;
      if (e.data.guard && ext === "html") {
        const text = new TextDecoder().decode(raw);
        const at = text.search(/<head[^>]*>/i);
        const cut = at < 0 ? 0 : at + text.slice(at).indexOf(">") + 1;
        bytes = new TextEncoder().encode(text.slice(0, cut) + GUARD + text.slice(cut));
      }
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
