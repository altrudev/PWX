// Installs an app's files into this origin's cache. It does NOT trust the loader for them:
// the loader hands over the signed package, and this page verifies the signature and every
// file itself, computes the CSP itself, and holds this origin's own pin (app id, publisher key,
// version). So even a loader that has been replaced can only install a genuine package from the
// same publisher, never an older one, and never another app's code next to this app's data.
// It works only inside a frame. Its CSP frame-ancestors (sent by the server and re-applied by
// the service worker) lets only the loader frame it. Instructions arrive only on a
// MessageChannel port the parent hands over; nothing is read from the URL.
(() => {
  if (window.parent === window) {
    document.title = "PWX";
    return; // opened as a tab: do nothing
  }
  const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json", wasm: "application/wasm", svg: "image/svg+xml", png: "image/png" };
  const GUARD = '<script src="/__pwx/guard.js"></script>';
  const ready = navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "all" }).then(() => navigator.serviceWorker.ready);
  const lib = import("/__pwx/verify.mjs");
  // Test builds only: the service worker says whether this is one. The loader can't.
  const isTest = ready.then((reg) => new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 3000);
    ch.port1.onmessage = (m) => { clearTimeout(timer); resolve(m.data?.test === true); };
    reg.active.postMessage({ type: "pwx-test" }, [ch.port2]);
  })).catch(() => false);
  let connected = false;

  // This origin's pin. Opened and closed per use, so it never blocks a wipe.
  async function pinStore(mode, fn) {
    const db = await new Promise((ok, no) => {
      const r = indexedDB.open("pwx-origin", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("pin");
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
    });
    try {
      return await new Promise((ok, no) => {
        const t = db.transaction("pin", mode);
        const q = fn(t.objectStore("pin"));
        t.oncomplete = () => ok(q.result); t.onerror = () => no(t.error);
      });
    } finally { db.close(); }
  }

  async function installPackage({ text, dev, guard }, loaderOrigin) {
    if (typeof text !== "string") throw new Error("expected a signed package");
    const { verifyPackage, buildHeaders, cmpVersion, canonicalize, sha256 } = await lib;
    await ready;
    const { manifest, files } = await verifyPackage(text, { allowLoopbackHttp: dev === true && (await isTest) });
    const manifestHash = await sha256(new TextEncoder().encode(canonicalize(manifest)));
    const pin = await pinStore("readonly", (s) => s.get("app"));
    if (pin) {
      if (pin.id !== manifest.id) throw new Error(`this origin belongs to ${pin.id}, not ${manifest.id}`);
      if (pin.publisher !== manifest.publisher) throw new Error("publisher changed");
      const order = cmpVersion(manifest.version, pin.version);
      if (order < 0) throw new Error(`${manifest.version} is older than installed ${pin.version}`);
      if (order === 0 && pin.manifestHash !== manifestHash) throw new Error(`version ${manifest.version} was already installed with different content`);
    }
    const headers = buildHeaders(manifest, loaderOrigin);
    await caches.delete("pwx-verified");
    const cache = await caches.open("pwx-verified");
    for (const [path, raw] of Object.entries(files)) {
      const ext = path.split(".").pop();
      // Optional guard: loader code placed ahead of the verified bytes, which are unchanged.
      let bytes = raw;
      if (guard && ext === "html") {
        const html = new TextDecoder().decode(raw);
        const at = html.search(/<head[^>]*>/i);
        const cut = at < 0 ? 0 : at + html.slice(at).indexOf(">") + 1;
        bytes = new TextEncoder().encode(html.slice(0, cut) + GUARD + html.slice(cut));
      }
      await cache.put("/" + path, new Response(bytes, {
        headers: { ...headers, "Content-Type": TYPES[ext] ?? "application/octet-stream" },
      }));
    }
    // grants: what the runtime may hand the app, read from the manifest verified just above.
    // The renderer reads them here, so neither the loader nor the app can widen them.
    const grants = { storage: manifest.capabilities?.storage?.local === true };
    await pinStore("readwrite", (s) => s.put({ id: manifest.id, publisher: manifest.publisher, version: manifest.version, manifestHash, grants, name: String(manifest.name ?? manifest.id).slice(0, 80) }, "app"));
  }

  // Remove: erase everything the app left on this origin, so the origin can be reused safely.
  // A database another tab still holds open blocks deletion; that fails the wipe (the loader
  // then keeps the app) instead of leaving data behind for the next app.
  function dropDatabase(name) {
    return new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(name);
      const timer = setTimeout(() => reject(new Error(`database ${name} is still open`)), 5000);
      r.onsuccess = () => { clearTimeout(timer); resolve(); };
      r.onerror = () => { clearTimeout(timer); reject(r.error); };
    });
  }
  async function wipe() {
    const names = new Set(["pwx-app-store", "pwx-origin"]);
    if (indexedDB.databases) for (const d of await indexedDB.databases()) if (d.name) names.add(d.name);
    for (const name of names) await dropDatabase(name);
    for (const key of await caches.keys()) await caches.delete(key);
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
  }

  // Erasing needs the user's own click, here, on this origin. The loader can ask, but it can't
  // answer: it can't script this frame or click in it. So a loader that has been replaced can't
  // erase an app's data on its own. The button stays off for a moment, and where the browser
  // can tell (Chromium), a click is ignored while this box is covered or see-through.
  let asking = null;
  function confirmWipe() {
    return (asking ??= (async () => {
      const pin = await pinStore("readonly", (s) => s.get("app")).catch(() => null);
      const what = pin ? `${pin.name ?? pin.id} (${pin.id})` : "the app on this origin";
      const make = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls, textContent: text });
      const box = make("div", "pwx-confirm", "");
      const note = make("p", "muted", "This can't be undone. Only you can approve it, here.");
      const erase = make("button", "btn btn-danger", "Erase this app and its data");
      const keep = make("button", "btn", "Keep it");
      erase.type = keep.type = "button"; erase.disabled = true;
      box.append(make("p", "pwx-confirm-title", `Erase ${what} and all its data from this device?`), note, erase, " ", keep);
      document.body.append(box);
      let seen = true; // browsers that can't report visibility: rely on the delay and the click
      if ("IntersectionObserver" in window) {
        new IntersectionObserver((entries) => {
          const e = entries[entries.length - 1];
          seen = e.isVisible === undefined ? e.isIntersecting : e.isVisible;
        }, { threshold: 1, trackVisibility: true, delay: 100 }).observe(box);
      }
      setTimeout(() => { erase.disabled = false; }, 1000);
      try {
        await new Promise((resolve, reject) => {
          erase.addEventListener("click", (e) => {
            if (!e.isTrusted) return;
            if (!seen) { note.textContent = "This box is covered or hidden, so the click was ignored."; return; }
            resolve();
          });
          keep.addEventListener("click", (e) => { if (e.isTrusted) reject(new Error("cancelled")); });
        });
      } finally { box.remove(); asking = null; }
    })());
  }

  addEventListener("message", (e) => {
    if (connected || e.source !== window.parent || e.data?.type !== "connect" || !e.ports[0]) return;
    connected = true;
    const port = e.ports[0], loaderOrigin = e.origin;
    port.onmessage = async (m) => {
      if (m.data?.type === "install") {
        try { await installPackage(m.data, loaderOrigin); port.postMessage({ type: "installed" }); }
        catch (err) { port.postMessage({ type: "install-failed", error: String(err?.message ?? err) }); }
      }
      if (m.data?.type === "wipe") {
        try { await confirmWipe(); await wipe(); port.postMessage({ type: "wiped" }); }
        catch (err) { port.postMessage({ type: "wipe-failed", error: String(err?.message ?? err) }); }
      }
    };
  });
  window.parent.postMessage({ type: "bootstrap-ready" }, "*");
})();
