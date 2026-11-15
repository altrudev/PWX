// Receives verified files from the loader and installs them into the app origin's cache.
// It works only inside a frame. Its CSP frame-ancestors (sent by the server and re-applied by
// the service worker) lets only the loader frame it, so the parent IS the loader. Instructions
// arrive only on a MessageChannel port the parent hands over; nothing is read from the URL.
(() => {
  if (window.parent === window) {
    document.title = "PWX";
    return; // opened as a tab: do nothing
  }
  const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", wasm: "application/wasm", svg: "image/svg+xml", png: "image/png" };
  const GUARD = '<script src="/__pwx/guard.js"></script>';
  const ready = navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "all" }).then(() => navigator.serviceWorker.ready);
  let connected = false;

  async function installFiles({ files, headers, guard }) {
    await ready;
    await caches.delete("pwx-verified");
    const cache = await caches.open("pwx-verified");
    for (const [path, raw] of Object.entries(files)) {
      const ext = path.split(".").pop();
      // Optional guard: loader code placed ahead of the verified bytes, which are unchanged.
      let bytes = raw;
      if (guard && ext === "html") {
        const text = new TextDecoder().decode(raw);
        const at = text.search(/<head[^>]*>/i);
        const cut = at < 0 ? 0 : at + text.slice(at).indexOf(">") + 1;
        bytes = new TextEncoder().encode(text.slice(0, cut) + GUARD + text.slice(cut));
      }
      await cache.put("/" + path, new Response(bytes, {
        headers: { ...headers, "Content-Type": TYPES[ext] ?? "application/octet-stream" },
      }));
    }
  }

  addEventListener("message", (e) => {
    if (connected || e.source !== window.parent || e.data?.type !== "connect" || !e.ports[0]) return;
    connected = true;
    const port = e.ports[0];
    port.onmessage = async (m) => {
      if (m.data?.type !== "install") return;
      try { await installFiles(m.data); port.postMessage({ type: "installed" }); }
      catch (err) { port.postMessage({ type: "install-failed", error: String(err) }); }
    };
  });
  window.parent.postMessage({ type: "bootstrap-ready" }, "*");
})();
