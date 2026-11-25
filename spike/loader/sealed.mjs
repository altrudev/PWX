// Quarantine Part 1: run a Strict app in a sealed frame instead of on an app origin.
// The frame is sandboxed without allow-same-origin, so its origin is opaque: no storage, no
// cookies, no access to this page or to other apps. Its only script is the sealed runtime,
// inlined, with its hash pinned in this page's CSP (by the signed loader release) and in the
// frame's own CSP. App data is kept here, on the loader origin, separately for each app, and
// only for apps whose verified manifest declares storage.

const enc = new TextEncoder();
async function hashOf(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  let s = ""; for (const b of d) s += String.fromCharCode(b);
  return "sha256-" + btoa(s);
}

// The runtime and its stylesheet come from this origin, served by the loader's service worker
// from the signed release. If either were changed, its hash wouldn't match the one pinned in
// this page's CSP and the browser would refuse to run it: the frame stays empty.
let parts = null;
const runtimeParts = () => parts ??= Promise.all(["/sealed-runtime.js", "/sealed.css"].map(async (p) => {
  const r = await fetch(p); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.text();
})).then(async ([js, css]) => ({ js, css, jsHash: await hashOf(js), cssHash: await hashOf(css) }));

const frameCsp = (p) => [
  "default-src 'none'", `script-src '${p.jsHash}'`, `style-src '${p.cssHash}'`, "worker-src data:", "img-src blob:",
  "connect-src 'none'", "font-src 'none'", "media-src 'none'", "frame-src 'none'", "manifest-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join("; ");

// ---------- app data, kept per app on the loader origin ----------
const MAX_VALUE = 1 << 20; // 1 MiB per value: a store for app state, not a file system
function db() {
  return new Promise((ok, no) => {
    const r = indexedDB.open("pwx-app-data", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  });
}
const range = (appId) => IDBKeyRange.bound([appId, ""], [appId, "￿"]);
async function tx(mode, fn) {
  const d = await db();
  try {
    return await new Promise((ok, no) => {
      const t = d.transaction("kv", mode); const q = fn(t.objectStore("kv"));
      t.oncomplete = () => ok(q?.result); t.onerror = () => no(t.error); t.onabort = () => no(t.error);
    });
  } finally { d.close(); }
}
export async function storeOp(appId, op, key, value) {
  if (op !== "all" && (typeof key !== "string" || key.length === 0 || key.length > 256)) throw new Error("bad key");
  if (op === "get") return tx("readonly", (s) => s.get([appId, key]));
  if (op === "all") return tx("readonly", (s) => s.getAll(range(appId)));
  if (op === "delete") return void await tx("readwrite", (s) => s.delete([appId, key]));
  if (op === "put") {
    let size = 0; try { size = enc.encode(JSON.stringify(value) ?? "").length; } catch { throw new Error("value can't be stored"); }
    if (size > MAX_VALUE) throw new Error("value too large");
    return void await tx("readwrite", (s) => s.put(value, [appId, key]));
  }
  throw new Error("bad op");
}
// Remove: erase this app's data, and nothing else.
export const eraseAppData = (appId) => tx("readwrite", (s) => s.delete(range(appId)));
export const appDataCount = (appId) => tx("readonly", (s) => s.count(range(appId)));

// ---------- the sealed frame ----------
// files: the package's verified files ({ path: Uint8Array }); manifest: the verified manifest.
// Returns the frame element (already in the page) and a promise for when the app has started.
export async function launchSealed({ stage, manifest, files, mode, unsafe, onReport }) {
  const p = await runtimeParts();
  const entry = files[manifest.entry];
  if (!entry) throw new Error("the package has no entry file");
  const code = new TextDecoder().decode(entry);
  const grants = { storage: manifest.capabilities?.storage?.local === true };
  const frame = document.createElement("iframe");
  frame.className = "app sealed";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'");
  frame.title = String(manifest.name ?? manifest.id);
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(p)}"><style>${p.css}</style><script>${p.js}</script></head><body></body></html>`;
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the sealed runtime didn't start")), 15000);
    addEventListener("message", function ready(e) {
      if (e.source !== frame.contentWindow || e.data?.type !== "pwx-sealed-ready") return;
      removeEventListener("message", ready);
      const ch = new MessageChannel();
      ch.port1.onmessage = async (m) => {
        const d = m.data || {};
        if (d.type === "connected") {
          clearTimeout(timer);
          ch.port1.postMessage({ type: "start", code, grants, mode, unsafe });
          resolve();
        }
        if (d.type === "store") {
          try {
            if (!grants.storage) throw new Error("storage not declared in the manifest");
            ch.port1.postMessage({ type: "store-result", rid: d.rid, ok: true, value: await storeOp(manifest.id, String(d.op), d.key, d.value) });
          } catch (err) { ch.port1.postMessage({ type: "store-result", rid: d.rid, ok: false, error: String(err?.message ?? err) }); }
        }
        if (d.type === "report") onReport?.(d.report);
      };
      // The frame's origin is opaque, so it can't be named as a target; the port is only
      // handed to the frame this page created, checked by window reference above.
      frame.contentWindow.postMessage({ type: "pwx-connect" }, "*", [ch.port2]);
    });
  });
  stage.append(frame);
  return { frame, started };
}
