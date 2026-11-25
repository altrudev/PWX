// Inside the sealed frame: report what this frame can and can't reach, then start a data: worker.
(async () => {
  const variant = document.currentScript && document.currentScript.src ? new URL(document.currentScript.src).hash.slice(1) : "inline";
  const CAN = "http://127.0.0.1:8399/" + variant + "-", r = { variant, origin: String(self.origin) };
  const t = async (name, fn) => { try { const v = await fn(); r[name] = v === undefined ? "ok" : (typeof v === "object" && !(v.constructor === Object) ? "ran" : v); } catch (e) { r[name] = "blocked: " + (e && e.name || e); } };
  await t("localStorage", () => { localStorage.setItem("x", "1"); return "WRITABLE"; });
  await t("indexedDB", () => new Promise((ok, bad) => { const q = indexedDB.open("x"); q.onsuccess = () => ok("OPENED"); q.onerror = () => bad(q.error); }));
  await t("caches", () => caches.keys().then(() => "READABLE"));
  await t("cookie", () => { document.cookie = "a=1"; return document.cookie ? "SET" : "empty"; });
  await t("parentDOM", () => parent.document.title);
  await t("swController", () => String(!!(navigator.serviceWorker && navigator.serviceWorker.controller)));
  r.rtcInFrame = typeof RTCPeerConnection;
  // network vectors (each names itself in the canary path)
  await t("fetch", () => fetch(CAN + "fetch").then(() => "SENT"));
  await t("fetchLoader", () => fetch("http://127.0.0.1:8300/loader-probe").then(() => "SENT"));
  await t("ws", () => { new WebSocket("ws://127.0.0.1:8399/" + variant + "-ws"); return "attempted"; });
  await t("beacon", () => String(navigator.sendBeacon(CAN + "beacon", "x")));
  await t("eventsource", () => { new EventSource(CAN + "es"); return "attempted"; });
  for (const [n, make] of [["img", () => Object.assign(new Image(), { src: CAN + "img" })],
                           ["preconnect", () => document.head.append(Object.assign(document.createElement("link"), { rel: "preconnect", href: "http://127.0.0.1:8399" }))],
                           ["prefetch", () => document.head.append(Object.assign(document.createElement("link"), { rel: "prefetch", href: CAN + "prefetch" }))],
                           ["script", () => document.head.append(Object.assign(document.createElement("script"), { src: CAN + "script" }))],
                           ["iframe", () => document.body.append(Object.assign(document.createElement("iframe"), { src: CAN + "iframe" }))],
                           ["popup", () => String(!!open(CAN + "popup"))]]) await t(n, make);
  await t("rtcStun", async () => {
    if (typeof RTCPeerConnection !== "function") return "no RTCPeerConnection";
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:3490" }] }); pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer()); return "attempted";
  });
  // the app's own code runs here
  const code = `const out = { origin: String(self.origin), rtc: typeof RTCPeerConnection, idb: typeof indexedDB };
    const C = "http://127.0.0.1:8399/${variant}-w-";
    (async () => {
      try { await fetch(C + "fetch"); out.fetch = "SENT"; } catch (e) { out.fetch = "blocked"; }
      try { new WebSocket("ws://127.0.0.1:8399/${variant}-w-ws"); out.ws = "attempted"; } catch (e) { out.ws = "blocked"; }
      try { importScripts(C + "import"); out.import = "LOADED"; } catch (e) { out.import = "blocked"; }
      try { const k = await caches.keys(); out.caches = "READABLE " + JSON.stringify(k); } catch (e) { out.caches = "blocked"; }
      postMessage(out);
    })();`;
  await t("worker", () => new Promise((ok) => {
    const w = new Worker("data:text/javascript," + encodeURIComponent(code));
    w.onmessage = (m) => ok(m.data); w.onerror = (e) => ok("FAILED: " + (e.message || "error"));
    setTimeout(() => ok("no answer"), 3000);
  }));
  setTimeout(() => parent.postMessage(r, "*"), 1500);
})();
