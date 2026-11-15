import { verifyPackage, buildHeaders, cmpVersion, canonicalize, sha256, strictParse, PwxError } from "/lib/pwx-verify.mjs";
import { library } from "/store.mjs";
import { TEST } from "/config.mjs";

const LOADER = location.origin;
// Hosted spike: each app gets its own origin from a fixed pool (ports stand in for per-app
// subdomains). The assignment is kept with the installed app, so it never changes.
const HOSTED_POOL = Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${8110 + i}`);
const $ = (id) => document.getElementById(id);
const state = (window.__pwx = { phase: "start", messages: [] });
const status = (t, cls = "") => { $("status").textContent = t; $("status").className = cls; };
const params = new URLSearchParams(location.search);
// Test switches exist only when the server provides a test config. Production builds (and
// pwx-local) ship TEST = false, so no link can change how the loader behaves.
const test = (name) => (TEST && params.has(name) ? params.get(name) : null);
const dev = test("dev") === "1";           // accept http/ws loopback hosts (test canary)
const mode = test("mode") ?? "";           // passed to leak-test apps
const guard = test("guard") === "1";       // inject the guard script
const unsafe = dev && test("unsafe") === "1"; // positive control: renderer allowlist off
if (!/^[a-z-]*$/.test(mode)) throw new PwxError("loader", "bad mode");

// A local loader (pwx-local) answers /__pwx/mode itself; the hosted loader's service worker
// answers it on the device, so asking never reaches a remote host after the first visit.
const modeReady = fetch("/__pwx/mode").then((r) => (r.ok ? r.json() : { local: false })).catch(() => ({ local: false }));
const loaderReady = modeReady.then((m) => {
  state.local = Boolean(m.local);
  if (m.local || !("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "all" })
    .then(() => navigator.serviceWorker.ready).catch(() => null);
});
state.loaderReady = loaderReady.then((r) => { state.offlineReady = Boolean(r); });

// Local mode gives every app its own origin. Allocation changes state, so it's a POST that
// pwx-local accepts only from this page's own origin.
async function appOrigin(id, record) {
  if (!state.local) {
    if (record.origin) return record.origin;
    const taken = new Set((await library.list()).map((r) => r.origin).filter(Boolean));
    let h = 0x811c9dc5; for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    for (let n = 0; n < HOSTED_POOL.length; n++) {
      const origin = HOSTED_POOL[(h + n) % HOSTED_POOL.length];
      if (!taken.has(origin)) { await library.put({ ...record, origin }); return origin; }
    }
    throw new PwxError("loader", "no free app origin");
  }
  const r = await fetch(`/__pwx/origin?id=${encodeURIComponent(id)}`, { method: "POST" });
  if (!r.ok) throw new PwxError("loader", "no app origin");
  const { origin, fresh } = await r.json();
  if (fresh) { location.reload(); await new Promise(() => {}); }
  return origin;
}

const enc = new TextEncoder();
const manifestHash = (m) => sha256(enc.encode(canonicalize(m)));
// A short, readable fingerprint of the publisher key, shown before every install.
async function fingerprint(publisher) {
  const b = (await sha256(enc.encode(publisher))).slice(7, 23);
  return b.match(/.{4}/g).join(" ");
}

function describe(m, fp) {
  const c = m.capabilities ?? {};
  const hosts = c.network?.connect ?? [];
  return [
    `${m.name ?? m.id} ${m.version}`,
    `Publisher key ${fp}`,
    hosts.length ? `Can send data to: ${hosts.join(", ")}` : "Cannot send data to any host.",
    // Spike finding: no engine enforces CSP "webrtc 'block'" for pages, and WebKit also
    // lets preconnect through. Strict apps run only in a worker, so neither applies.
    m.runtime === "strict"
      ? "Strict runtime: app code runs in a worker and can't touch the page, open connections from it, or use WebRTC."
      : "Warning: this browser can't fully block WebRTC (or preconnect, in Safari) for this app, so it could still reach other hosts that way.",
    ...["camera", "microphone", "location", "notifications"].filter((k) => c[k]).map((k) => `Can use ${k}`),
  ];
}
function showLines(lines) {
  $("consent").hidden = false;
  $("consent").replaceChildren(...lines.map((line) => Object.assign(document.createElement("div"), { textContent: line })));
}

// Consent is a decision: nothing is installed until the user confirms (test builds auto-confirm).
function confirmInstall(manifest, fp, existing) {
  showLines([existing ? `Update from ${existing.version}` : "Install this app?", ...describe(manifest, fp)]);
  state.phase = "consent";
  if (TEST) return Promise.resolve(true);
  return new Promise((resolve) => {
    const yes = Object.assign(document.createElement("button"), { id: "install-confirm", className: "btn", type: "button", textContent: existing ? "Update" : "Install" });
    const no = Object.assign(document.createElement("button"), { id: "install-cancel", className: "btn", type: "button", textContent: "Cancel" });
    yes.addEventListener("click", () => resolve(true), { once: true });
    no.addEventListener("click", () => resolve(false), { once: true });
    $("consent").append(yes, " ", no);
    status("Review this app before installing it.");
  });
}

function waitFor(type, from) {
  return new Promise((resolve) => {
    const on = (e) => {
      if (e.origin !== from || e.data?.type !== type) return;
      removeEventListener("message", on); resolve(e);
    };
    addEventListener("message", on);
  });
}

// Install: verify, ask, then keep the signed package locally. The first install pins the
// publisher key; later versions must come from the same key, never go backwards, and a
// version number can't be reused for different content.
async function install(text) {
  const { manifest } = await verifyPackage(text, { allowLoopbackHttp: dev });
  const hash = await manifestHash(manifest);
  const existing = await library.get(manifest.id);
  if (existing && existing.publisher !== manifest.publisher) throw new PwxError("signature", "publisher changed");
  if (existing) {
    const order = cmpVersion(manifest.version, existing.version);
    if (order < 0) throw new PwxError("rollback", `${manifest.version} is older than installed ${existing.version}`);
    const prev = existing.manifestHash ?? await manifestHash(strictParse(strictParse(existing.text).manifest));
    if (order === 0 && prev !== hash) throw new PwxError("rollback", `version ${manifest.version} was already installed with different content`);
  }
  const unchanged = existing && existing.version === manifest.version;
  if (!unchanged && !(await confirmInstall(manifest, await fingerprint(manifest.publisher), existing))) {
    throw new PwxError("loader", "install cancelled");
  }
  await library.put({ ...(existing ?? {}), id: manifest.id, name: manifest.name ?? manifest.id, version: manifest.version,
    publisher: manifest.publisher, runtime: manifest.runtime ?? "standard", manifestHash: hash, text, installedAt: Date.now() });
  return manifest.id;
}

// Launch: re-verify the stored package from scratch every time, offline, then run it.
async function launch(id) {
  const record = await library.get(id);
  if (!record) throw new PwxError("loader", `${id} is not installed`);
  status("Verifying installed package…");
  const { manifest, files } = await verifyPackage(record.text, { allowLoopbackHttp: dev, trustedPublisher: record.publisher });
  state.manifest = manifest;
  const headers = buildHeaders(manifest, LOADER);
  state.headers = headers;
  const APP = await appOrigin(manifest.id, record);
  state.appOrigin = APP;
  $("library").hidden = true;
  showLines(describe(manifest, await fingerprint(manifest.publisher)));

  status("Installing verified files on the app origin…");
  await bootstrapCall(APP, { type: "install", files, headers, guard }, "installed", "install-failed");

  status("Running app (sandboxed: no popups, no top navigation, no forms, no downloads).");
  addEventListener("message", (e) => { if (e.origin === APP) state.messages.push(e.data); });
  const app = document.createElement("iframe");
  app.className = "app";
  app.setAttribute("sandbox", "allow-scripts allow-same-origin");
  app.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
  if (manifest.runtime === "strict") {
    app.src = `${APP}/__pwx/${unsafe ? "strict-unsafe" : "strict"}.html#entry=${encodeURIComponent(manifest.entry)}&mode=${mode || "passive"}`;
  } else {
    app.src = `${APP}/${manifest.entry}${mode ? "#" + mode : ""}`;
  }
  $("stage").append(app);
  state.phase = "running";
}

// The bootstrap only listens to its parent, and only on a channel the parent hands it.
async function bootstrapCall(APP, msg, ok, failed, { keep = true } = {}) {
  const boot = Object.assign(document.createElement("iframe"), { className: "bootstrap", src: `${APP}/__pwx/bootstrap.html` });
  const booted = waitFor("bootstrap-ready", APP);
  $("stage").append(boot);
  await booted;
  const channel = new MessageChannel();
  const done = new Promise((resolve, reject) => {
    channel.port1.onmessage = (m) => {
      if (m.data?.type === ok) resolve();
      if (m.data?.type === failed) reject(new PwxError("loader", m.data.error));
    };
  });
  boot.contentWindow.postMessage({ type: "connect" }, APP, [channel.port2]);
  channel.port1.postMessage(msg);
  try { await done; } finally { if (!keep) boot.remove(); }
}

// Remove: wipe the app's origin first, then forget the app. If the wipe fails the app stays
// installed, so its origin is never handed to another app with data still in it.
async function removeApp(r) {
  status(`Removing ${r.name} and its data…`);
  const APP = await appOrigin(r.id, r);
  await bootstrapCall(APP, { type: "wipe" }, "wiped", "wipe-failed", { keep: false });
  await library.remove(r.id);
  state.removed = (state.removed ?? []).concat(r.id);
}

// Library: installed apps, all local. Opening one makes no network request.
async function showLibrary() {
  const apps = (await library.list()).sort((a, b) => a.name.localeCompare(b.name));
  $("apps").replaceChildren(...apps.map((r) => {
    const li = document.createElement("li");
    const name = Object.assign(document.createElement("strong"), { textContent: `${r.name} ${r.version}` });
    const meta = Object.assign(document.createElement("span"), { className: "meta", textContent: ` ${r.runtime} runtime` });
    const open = Object.assign(document.createElement("a"), { className: "btn", textContent: "Open", href: `/?open=${encodeURIComponent(r.id)}` });
    open.setAttribute("aria-label", `Open ${r.name}`);
    const del = Object.assign(document.createElement("button"), { className: "btn", textContent: "Remove", type: "button" });
    del.setAttribute("aria-label", `Remove ${r.name}`);
    del.addEventListener("click", async () => {
      try { await removeApp(r); await showLibrary(); }
      catch (err) { status(`Couldn't remove ${r.name}: ${err.message}. It's still installed.`, "error"); state.phase = "remove-failed"; }
    });
    li.append(name, meta, " ", open, " ", del);
    return li;
  }));
  $("empty").hidden = apps.length > 0;
  $("library").hidden = false;
  status(apps.length ? "Your apps. They open without any network connection." : "No apps installed yet.");
  state.phase = "library";
  state.apps = apps.map((r) => r.id);
}

// Sideload: install a .pwx file from disk. Same verification and consent as any install.
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
