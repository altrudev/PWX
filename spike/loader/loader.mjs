import { verifyPackage, buildHeaders, PwxError } from "/lib/pwx-verify.mjs";

const LOADER = location.origin;
const APP = "http://127.0.0.1:8101"; // spike: one fixed app origin; v0 derives it from the app id
const $ = (id) => document.getElementById(id);
const state = (window.__pwx = { phase: "start", messages: [] });
const status = (t, cls = "") => { $("status").textContent = t; $("status").className = cls; };

function describe(m) {
  const c = m.capabilities ?? {};
  const hosts = c.network?.connect ?? [];
  return [
    `${m.name ?? m.id} ${m.version}`,
    hosts.length ? `Can send data to: ${hosts.join(", ")}` : "Cannot send data to any host.",
    // Spike finding (Chrome 153): CSP "webrtc 'block'" is not enforced, so a WebRTC
    // STUN request still reaches undeclared hosts. Say so instead of overclaiming.
    "Warning: this browser does not yet block WebRTC, so the app could still reach other hosts that way.",
    ...["camera", "microphone", "location", "notifications"].filter((k) => c[k]).map((k) => `Can use ${k}`),
  ];
}

function waitFor(type, from) {
  return new Promise((resolve, reject) => {
    const on = (e) => {
      if (e.origin !== from) return;
      if (e.data?.type === type) { removeEventListener("message", on); resolve(e); }
      if (e.data?.type === "install-failed") { removeEventListener("message", on); reject(new Error(e.data.error)); }
    };
    addEventListener("message", on);
  });
}

async function main() {
  const params = new URLSearchParams(location.search);
  const name = params.get("pkg");
  const mode = params.get("mode") ?? ""; // test hook: passed to the app as #fragment (not part of any hash)
  if (!/^[a-z-]*$/.test(mode)) throw new PwxError("loader", "bad mode");
  if (!/^[a-z0-9-]+$/.test(name ?? "")) throw new PwxError("loader", "missing or bad ?pkg=");
  status("Verifying package…");
  const text = await (await fetch(`/packages/${name}.pwx.json`)).text();
  // Dev-only hook: accept http/ws loopback origins (spike tests). Never in a real loader.
  const dev = params.get("dev") === "1";
  const { manifest, files } = await verifyPackage(text, { allowLoopbackHttp: dev });
  state.manifest = manifest;
  const headers = buildHeaders(manifest, LOADER);
  state.headers = headers;

  $("consent").hidden = false;
  $("consent").replaceChildren(...describe(manifest).map((line) => Object.assign(document.createElement("div"), { textContent: line })));

  status("Installing verified files on the app origin…");
  const boot = Object.assign(document.createElement("iframe"), { className: "bootstrap", src: `${APP}/__pwx/bootstrap.html` });
  const booted = waitFor("bootstrap-ready", APP);
  $("stage").append(boot);
  await booted;
  const installed = waitFor("installed", APP);
  boot.contentWindow.postMessage({ type: "install", files, headers }, APP);
  await installed;

  status("Running app (sandboxed: no popups, no top navigation, no forms, no downloads).");
  addEventListener("message", (e) => { if (e.origin === APP) state.messages.push(e.data); });
  const app = document.createElement("iframe");
  app.className = "app";
  app.setAttribute("sandbox", "allow-scripts allow-same-origin");
  app.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
  app.src = `${APP}/${manifest.entry}${mode ? "#" + mode : ""}`;
  $("stage").append(app);
  state.phase = "running";
}

main().catch((err) => {
  state.phase = "rejected";
  state.error = err.code ?? "error";
  status(`Rejected: ${err.message}`, "error");
});
