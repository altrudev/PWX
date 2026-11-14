import { verifyPackage, buildHeaders, cmpVersion, PwxError } from "/lib/pwx-verify.mjs";
import { library } from "/store.mjs";

const LOADER = location.origin;
const HOSTED_APP = "http://127.0.0.1:8101"; // hosted spike: one shared app origin
const $ = (id) => document.getElementById(id);
const state = (window.__pwx = { phase: "start", messages: [] });
const status = (t, cls = "") => { $("status").textContent = t; $("status").className = cls; };
const params = new URLSearchParams(location.search);
// Dev-only hook: accept http/ws loopback origins (spike tests). Never in a real loader.
const dev = params.get("dev") === "1";

// A local loader (pwx-local) answers /__pwx/mode itself; the hosted loader's service worker
// answers it on the device, so asking never reaches a remote host after the first visit.
const modeReady = fetch("/__pwx/mode").then((r) => (r.ok ? r.json() : { local: false })).catch(() => ({ local: false }));
// Hosted mode: the loader keeps itself on the device, so installed apps open with no network.
// Local mode: the loader already lives on this machine, so no service worker is needed.
const loaderReady = modeReady.then((m) => {
  state.local = Boolean(m.local);
  if (m.local || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "all" })
    .then(() => navigator.serviceWorker.ready).catch(() => null);
});
// Local mode gives every app its own origin (its own port), so apps can't share storage.
async function appOrigin(id) {
  if (!state.local) return HOSTED_APP;
  const r = await fetch(`/__pwx/origin?id=${encodeURIComponent(id)}`);
  if (!r.ok) throw new PwxError("loader", "no app origin");
  const { origin, fresh } = await r.json();
  if (fresh) { location.reload(); await new Promise(() => {}); }
  return origin;
}
state.loaderReady = loaderReady.then((r) => { state.offlineReady = Boolean(r); });

function describe(m) {
  const c = m.capabilities ?? {};
  const hosts = c.network?.connect ?? [];
  return [
    `${m.name ?? m.id} ${m.version}`,
    hosts.length ? `Can send data to: ${hosts.join(", ")}` : "Cannot send data to any host.",
    // Spike finding: no engine enforces CSP "webrtc 'block'" for pages, and WebKit also
    // lets preconnect through. Strict apps run only in a worker, so neither applies.
    m.runtime === "strict"
      ? "Strict runtime: app code runs in a worker and can't touch the page, open connections from it, or use WebRTC."
      : "Warning: this browser can't fully block WebRTC (or preconnect, in Safari) for this app, so it could still reach other hosts that way.",
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

// Install: verify, then keep the signed package locally. The first install pins the
// publisher key; later versions must come from the same key and never go backwards.
async function install(text) {
  const { manifest } = await verifyPackage(text, { allowLoopbackHttp: dev });
  const existing = await library.get(manifest.id);
  if (existing && existing.publisher !== manifest.publisher) throw new PwxError("signature", "publisher changed");
  if (existing && cmpVersion(manifest.version, existing.version) < 0) {
    throw new PwxError("rollback", `${manifest.version} is older than installed ${existing.version}`);
  }
  await library.put({ id: manifest.id, name: manifest.name ?? manifest.id, version: manifest.version,
    publisher: manifest.publisher, runtime: manifest.runtime ?? "standard", text, installedAt: Date.now() });
  return manifest.id;
}

// Launch: re-verify the stored package from scratch every time, offline, then run it.
async function launch(id) {
  const mode = params.get("mode") ?? ""; // test hook: passed to the app as #fragment (not part of any hash)
  if (!/^[a-z-]*$/.test(mode)) throw new PwxError("loader", "bad mode");
  const record = await library.get(id);
  if (!record) throw new PwxError("loader", `${id} is not installed`);
  status("Verifying installed package…");
  const { manifest, files } = await verifyPackage(record.text, { allowLoopbackHttp: dev, trustedPublisher: record.publisher });
  state.manifest = manifest;
  const headers = buildHeaders(manifest, LOADER);
  state.headers = headers;
  const APP = await appOrigin(manifest.id);
  state.appOrigin = APP;
  $("library").hidden = true;
  $("consent").hidden = false;
  $("consent").replaceChildren(...describe(manifest).map((line) => Object.assign(document.createElement("div"), { textContent: line })));

  status("Installing verified files on the app origin…");
  const boot = Object.assign(document.createElement("iframe"), { className: "bootstrap", src: `${APP}/__pwx/bootstrap.html#loader=${encodeURIComponent(LOADER)}` });
  const booted = waitFor("bootstrap-ready", APP);
  $("stage").append(boot);
  await booted;
  const installed = waitFor("installed", APP);
  boot.contentWindow.postMessage({ type: "install", files, headers, guard: params.get("guard") === "1" }, APP);
  await installed;

  status("Running app (sandboxed: no popups, no top navigation, no forms, no downloads).");
  addEventListener("message", (e) => { if (e.origin === APP) state.messages.push(e.data); });
  const app = document.createElement("iframe");
  app.className = "app";
  app.setAttribute("sandbox", "allow-scripts allow-same-origin");
  app.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
  if (manifest.runtime === "strict") {
    const unsafe = dev && params.get("unsafe") === "1"; // test-only positive control
    app.src = `${APP}/__pwx/${unsafe ? "strict-unsafe" : "strict"}.html#entry=${encodeURIComponent(manifest.entry)}&mode=${mode || "passive"}${unsafe ? "&unsafe=1" : ""}`;
  } else {
    app.src = `${APP}/${manifest.entry}${mode ? "#" + mode : ""}`;
  }
  $("stage").append(app);
  state.phase = "running";
}

// Library: installed apps, all local. Opening one makes no network request.
async function showLibrary() {
  const apps = (await library.list()).sort((a, b) => a.name.localeCompare(b.name));
  const list = $("apps");
  list.replaceChildren(...apps.map((r) => {
    const li = document.createElement("li");
    const name = Object.assign(document.createElement("strong"), { textContent: `${r.name} ${r.version}` });
    const meta = Object.assign(document.createElement("span"), { className: "meta", textContent: ` ${r.runtime} runtime` });
    const open = Object.assign(document.createElement("a"), { className: "btn", textContent: "Open", href: `/?open=${encodeURIComponent(r.id)}${dev ? "&dev=1" : ""}` });
    open.setAttribute("aria-label", `Open ${r.name}`);
    const del = Object.assign(document.createElement("button"), { className: "btn", textContent: "Remove", type: "button" });
    del.setAttribute("aria-label", `Remove ${r.name}`);
    del.addEventListener("click", async () => { await library.remove(r.id); showLibrary(); });
    li.append(name, meta, " ", open, " ", del);
    return li;
  }));
  $("empty").hidden = apps.length > 0;
  $("library").hidden = false;
  status(apps.length ? "Your apps. They open without any network connection." : "No apps installed yet.");
  state.phase = "library";
  state.apps = apps.map((r) => r.id);
}

// Sideload: install a .pwx file from disk. Same verification as any install.
$("file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0]; if (!file) return;
  try {
    const id = await install(await file.text());
    await showLibrary();
    status(`Installed ${id} from a file.`);
  } catch (err) {
    state.error = err.code ?? "error";
    status(`Rejected: ${err.message}`, "error");
  }
  e.target.value = "";
});

async function main() {
  await loaderReady;
  const name = params.get("pkg"), open = params.get("open");
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new PwxError("loader", "bad ?pkg=");
    status("Downloading and verifying package…");
    const res = await fetch(`/packages/${name}.pwx.json`);
    if (!res.ok) throw new PwxError("loader", `download failed (${res.status})`);
    return launch(await install(await res.text()));
  }
  if (open) return launch(open);
  return showLibrary();
}

main().catch((err) => {
  state.phase = "rejected";
  state.error = err.code ?? "error";
  status(`Rejected: ${err.message}`, "error");
});
