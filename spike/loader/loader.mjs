import { verifyPackage, buildHeaders, cmpVersion, canonicalize, sha256, strictParse, PwxError } from "/lib/pwx-verify.mjs";
import { library } from "/store.mjs";
import { TEST } from "/config.mjs";

const LOADER = location.origin;
// Hosted spike: each app gets its own origin from a fixed pool (ports stand in for per-app
// subdomains). The assignment is kept with the installed app, so it never changes.
// App origins follow from the loader's own address, so the same signed files work on any host:
//   test host  http://127.0.0.1:8100 -> http://127.0.0.1:8110 ... :8129 (20 origins)
//   real host  https://pwx.example   -> https://app1.pwx.example ... app4 (one subdomain each)
const HOSTED_POOL = location.hostname === "127.0.0.1"
  ? Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${8110 + i}`)
  : Array.from({ length: 4 }, (_, i) => `${location.protocol}//app${i + 1}.${location.host}`);
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
// Where an app's own home address points; it names the app's source when known, so a fresh
// home-screen copy (iPhone) can install it the same way.
const appHomeUrl = (r) => `/app/${r.id}/` + (/^[a-z0-9-]+$/.test(r.source ?? "") ? `?src=${r.source}` : "");
// An app's own home address, /app/<id>/, opens that app directly. It can be installed on its own,
// so the home screen shows the app, not the library. (The service worker gives the page that
// app's install manifest and icon.)
const appHome = location.pathname.match(/^\/app\/([a-z0-9][a-z0-9.-]{0,99})\/$/)?.[1] ?? null;
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

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

// ---------- loader updates (hosted tier) ----------
// The service worker holds the signed loader release and checks every file against it. Updates
// happen only from here, when the user asks; nothing checks the host in the background.
async function controller() {
  if (navigator.serviceWorker.controller) return navigator.serviceWorker.controller;
  await new Promise((resolve) => {
    navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
    setTimeout(resolve, 10000);
  });
  return navigator.serviceWorker.controller;
}
async function askSw(type) {
  const sw = await controller();
  if (!sw) return { ok: false, error: "the loader isn't installed for offline use" };
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false, error: "the loader's service worker didn't answer" }), 60000);
    ch.port1.onmessage = (m) => { clearTimeout(timer); resolve(m.data); };
    sw.postMessage({ type }, [ch.port2]);
  });
}
const updateMsg = (t, cls = "") => { $("update-msg").textContent = t; $("update-msg").className = cls; };
// The page and its worker come from the same signed release, but the browser swaps in a new
// sw.js only when its own cache allows (up to a day). After an update, fetch sw.js past that
// cache and let the browser install it now. The usual check (checkServiceWorkerChange) still
// locks the loader if that sw.js isn't the one the signed release names.
const WORKER = 2;
async function refreshWorker() {
  try {
    await fetch("/sw.js", { cache: "reload" });
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const took = new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 15000);
    });
    await reg.update();
    return (reg.installing || reg.waiting) ? await took : false;
  } catch { return false; }
}
async function showLoaderVersion() {
  const s = await askSw("status");
  if (s.ok && s.worker !== WORKER && !state.locked) {
    let tried = null;
    try { tried = sessionStorage.getItem("pwx-worker-refresh"); } catch {}
    if (tried !== s.version) {
      try { sessionStorage.setItem("pwx-worker-refresh", s.version); } catch {}
      status("Finishing the loader update…");
      if (await refreshWorker() && !state.locked) return location.reload();
    }
  }
  state.loaderVersion = s.ok ? s.version : null;
  $("loader-version").textContent = s.ok ? `Loader ${s.version} (signed release).` : `Loader integrity: ${s.error}.`;
  $("loader-update").hidden = false;
}
$("update-check").addEventListener("click", async () => {
  $("update-apply").hidden = true;
  updateMsg("Checking the host for a signed loader update…");
  const r = (state.loaderCheck = await askSw("check-update"));
  if (!r.ok) return updateMsg(`Update refused: ${r.error}.`, "error");
  if (r.upToDate) return updateMsg(`Up to date (${r.version}).`);
  updateMsg(`Signed loader ${r.available} is available. Your apps and their data stay as they are.`);
  $("update-apply").hidden = false;
});
$("update-apply").addEventListener("click", async () => {
  updateMsg("Downloading the update and checking every file against its signature…");
  const r = (state.loaderApply = await askSw("apply-update"));
  if (!r.ok) return updateMsg(`Update refused: ${r.error}. You're still on ${state.loaderVersion}.`, "error");
  updateMsg("Installing the updated loader…");
  await refreshWorker();
  if (!state.locked) location.reload();
});
// The browser re-fetches sw.js from the host by itself and can't be stopped. When it brings a
// new one, compare it with what a signed release says sw.js should be, and say so if it isn't.
// (Advisory: a hostile host can serve this check a different copy than the browser got.)
async function checkServiceWorkerChange() {
  try {
    const body = new Uint8Array(await (await fetch("/sw.js", { cache: "no-store" })).arrayBuffer());
    const got = await sha256(body);
    const cur = await askSw("status");
    if (cur.ok && got === cur.sw) { state.swChange = "same"; return; }
    const next = await askSw("check-update");
    if (next.ok && next.sw === got) {
      state.swChange = "signed";
      updateMsg(`The loader's service worker was updated to match signed release ${next.available ?? next.version}.`);
      if (next.available) $("update-apply").hidden = false;
      return;
    }
    state.swChange = "unsigned";
    lockdown();
  } catch (err) { if (!state.swChange) state.swChange = "error"; }
}
// Lockdown: this page is still the verified loader, but the browser has accepted a service
// worker that no signed release matches. From here this page opens, installs, updates and
// removes nothing. It can't stop the replaced worker from serving the next page load, so it
// says so plainly.
function lockdown() {
  if (state.locked) return;
  state.locked = true;
  for (const id of ["library", "consent", "loader-update"]) $(id).hidden = true;
  showIntro(false);
  for (const f of document.querySelectorAll("iframe.bootstrap")) f.remove();
  for (const el of document.querySelectorAll("button, input, a.btn")) { el.disabled = true; el.removeAttribute("href"); }
  const lines = [
    "PWX locked this loader.",
    "The host replaced the loader's service worker with one that no signed PWX release matches. The host may be compromised.",
    "Since then this page has opened, installed, updated and removed nothing. Your apps' data is still on this device, and each app's origin accepts only correctly signed packages from that app's own publisher.",
    "What to do: close this tab, and don't open this loader again until its operator explains the change. If you reopen it, the replaced loader will be running and this warning may not appear again.",
  ];
  $("lock").replaceChildren(...lines.map((t, i) => Object.assign(document.createElement(i ? "p" : "h2"), { textContent: t })));
  $("lock").hidden = false;
  status("Locked: the loader's service worker was replaced without a signed release.", "error");
}
loaderReady.then((reg) => {
  if (!reg) return;
  reg.addEventListener("updatefound", () => {
    const w = reg.installing;
    // Check as soon as the new worker exists, and again once it has taken over.
    checkServiceWorkerChange();
    w?.addEventListener("statechange", () => { if (w.state === "activated") checkServiceWorkerChange(); });
  });
  showLoaderVersion();
});

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
const INTRO = ["intro", "how", "why"];
const showIntro = (on) => { for (const id of INTRO) { const el = $(id); if (el) el.hidden = !on; } };
function showLines(lines) {
  showIntro(false);
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
async function install(text, source = null) {
  if (state.locked) throw new PwxError("loader", "this loader is locked");
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
    publisher: manifest.publisher, runtime: manifest.runtime ?? "standard", manifestHash: hash, text, installedAt: Date.now(),
    ...(source && /^[a-z0-9-]+$/.test(source) ? { source } : {}) });
  return manifest.id;
}

// Launch: re-verify the stored package from scratch every time, offline, then run it.
async function launch(id) {
  const record = await library.get(id);
  if (!record) throw new PwxError("loader", `${id} is not installed`);
  status("Verifying installed package…");
  if (state.locked) throw new PwxError("loader", "this loader is locked");
  const { manifest } = await verifyPackage(record.text, { allowLoopbackHttp: dev, trustedPublisher: record.publisher });
  state.manifest = manifest;
  const headers = buildHeaders(manifest, LOADER);
  state.headers = headers;
  const APP = await appOrigin(manifest.id, record);
  state.appOrigin = APP;
  $("library").hidden = true;
  showLines(describe(manifest, await fingerprint(manifest.publisher)));

  status("Installing verified files on the app origin…");
  // The app origin verifies the package again itself; it doesn't take files or headers from here.
  await bootstrapCall(APP, { type: "install", text: record.text, dev, guard }, "installed", "install-failed");

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
  offerAppInstall({ ...record, id }, record.name ?? manifest.name);
}

// The bootstrap only listens to its parent, and only on a channel the parent hands it.
async function bootstrapCall(APP, msg, ok, failed, { keep = true, visible = false } = {}) {
  const boot = Object.assign(document.createElement("iframe"), { className: visible ? "bootstrap confirm" : "bootstrap", src: `${APP}/__pwx/bootstrap.html` });
  if (visible) boot.title = "Confirmation from the app's own origin";
  const booted = waitFor("bootstrap-ready", APP);
  $("stage").append(boot);
  await booted;
  // A confirmation box sits below the library; bring it into view so the person sees it.
  if (visible) boot.scrollIntoView({ block: "center" });
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
  if (state.locked) throw new PwxError("loader", "this loader is locked");
  const APP = await appOrigin(r.id, r);
  // The app's own origin asks the user; this page can't answer for them.
  status(`To remove ${r.name}, confirm in the box below. It comes from the app's own origin, so only you can approve erasing its data.`);
  state.phase = "remove-confirm";
  await bootstrapCall(APP, { type: "wipe" }, "wiped", "wipe-failed", { keep: false, visible: true });
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
      catch (err) {
        if (/cancelled$/.test(err.message)) { status(`Kept ${r.name}. Nothing was erased.`); state.phase = "remove-cancelled"; }
        else { status(`Couldn't remove ${r.name}: ${err.message}. It's still installed.`, "error"); state.phase = "remove-failed"; }
      }
    });
    li.append(name, meta, " ", open, " ", del);
    if (/^[a-z0-9][a-z0-9.-]{0,99}$/.test(r.id) && !standalone) {
      const home = Object.assign(document.createElement("a"), { className: "btn quiet", textContent: "Add to home screen", href: appHomeUrl(r) });
      home.setAttribute("aria-label", `Put ${r.name} on your home screen`);
      li.append(" ", home);
    }
    return li;
  }));
  $("empty").hidden = apps.length > 0;
  $("library").hidden = false;
  showIntro(true);
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
  const name = params.get("pkg"), open = appHome ?? params.get("open");
  if (appHome && !(await library.get(appHome))) {
    // A home-screen app can start with an empty library (iPhone keeps each home-screen app's
    // storage separate). If its address names where it came from, install it from there, with
    // the same checks and the same consent as any install, and only if it's the same app.
    const src = params.get("src");
    if (src && /^[a-z0-9-]+$/.test(src)) {
      status("Downloading and verifying package…");
      const res = await fetch(`/packages/${src}.pwx.json`);
      if (!res.ok) throw new PwxError("loader", `download failed (${res.status})`);
      const text = await res.text();
      if (strictParse(strictParse(text).manifest).id !== appHome) throw new PwxError("loader", "that package is a different app");
      return launch(await install(text, src));
    }
    await showLibrary();
    return status("That app isn't in your PWX library on this device anymore. Open another app below, or install it again from its publisher.", "error");
  }
  if (name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new PwxError("loader", "bad ?pkg=");
    status("Downloading and verifying package…");
    const res = await fetch(`/packages/${name}.pwx.json`);
    if (!res.ok) throw new PwxError("loader", `download failed (${res.status})`);
    return launch(await install(await res.text(), name));
  }
  if (open) return launch(open);
  return showLibrary();
}

// Install: offer the browser's own install prompt where it has one; elsewhere on a phone, say how.
// On the front page that installs the library. On an app's home address it installs that app
// alone, with its own name and icon; from anywhere else a running app links to its home address.
const installUi = (prefix) => ({ box: $(`${prefix}install`), btn: $(`${prefix}install-btn`), hint: $(`${prefix}install-hint`) });
let installPrompt = null;
function sayInstall(ui, text) { ui.hint.textContent = text; ui.hint.hidden = false; ui.box.hidden = false; }
function howToInstall(ui, what) {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    sayInstall(ui, `To put ${what} on your home screen: tap Share, then Add to Home Screen.`);
  } else if (/Android/.test(ua)) {
    setTimeout(() => { if (!installPrompt && ui.btn.hidden) sayInstall(ui, `To install ${what}: open your browser's menu and tap Install app or Add to Home screen.`); }, 3000);
  }
}
function setupInstall() {
  if (standalone) return;
  const ui = installUi(appHome ? "app-" : "");
  if (!ui.box) return;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); installPrompt = e;
    if (appHome && state.phase !== "running") return; // shown once the app is running
    ui.btn.hidden = false; ui.hint.hidden = true; ui.box.hidden = false;
  });
  addEventListener("appinstalled", () => { ui.box.hidden = true; installPrompt = null; });
  ui.btn.addEventListener("click", async () => {
    if (!installPrompt) return;
    const p = installPrompt; installPrompt = null; ui.btn.hidden = true;
    p.prompt();
    const choice = await p.userChoice.catch(() => null);
    if (choice?.outcome !== "accepted") sayInstall(ui, "Not installed. You can install later from your browser's menu.");
  });
  if (!appHome) howToInstall(ui, "PWX");
}
setupInstall();
function offerAppInstall(r, name) {
  const id = r.id;
  if (standalone || state.locked) return;
  const ui = installUi("app-");
  if (appHome) {
    ui.btn.textContent = `Install ${name} on this device`;
    if (installPrompt) { ui.btn.hidden = false; ui.box.hidden = false; }
    howToInstall(ui, name);
    return;
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(id)) return;
  const link = $("app-install-link");
  link.textContent = `Put ${name} on your home screen`;
  link.href = appHomeUrl(r);
  link.hidden = false; ui.box.hidden = false;
}

main().catch((err) => {
  state.phase = "rejected";
  state.error = err.code ?? "error";
  status(`Rejected: ${err.message}`, "error");
});
