// PWX strict runtime: loader-owned renderer. App code never runs in this document.
// App code runs in a worker started from a data: URL, which gives it an OPAQUE origin: it has
// no access to this origin's CacheStorage or IndexedDB (and, in every engine, no WebRTC and no
// DOM). It can only send messages. UI requests go through a fixed allowlist; storage requests
// go to a per-app store this renderer keeps on the app origin. So the app can't rewrite the
// PWX runtime or its own verified code, and it can't reach any other app's data.
(() => {
  "use strict";
  const p = new URLSearchParams(location.hash.slice(1));
  const entry = p.get("entry");
  const mode = p.get("mode") || "passive";
  // Positive control with the allowlist off. Only test servers serve strict-unsafe.html.
  const unsafe = location.pathname === "/__pwx/strict-unsafe.html";
  if (!/^app\/[A-Za-z0-9._/-]+\.js$/.test(entry || "")) return;

  const TAGS = new Set(["div", "p", "span", "h1", "h2", "h3", "ul", "ol", "li", "button",
    "input", "label", "strong", "em", "img", "section", "header", "footer",
    "textarea", "nav", "aside", "main", "article", "small"]);
  const ATTRS = new Set(["class", "id", "type", "value", "placeholder", "alt", "title", "disabled",
    "checked", "rows", "maxlength", "aria-label", "aria-current", "spellcheck"]);
  const PROPS = new Set(["value", "checked", "disabled"]);
  const EVENTS = new Set(["click", "input", "change", "keydown"]);
  // Node 0 is the body. Resolved at use time: this script runs in <head>, before <body> exists.
  const nodes = new Map();
  const node = (id) => (id === 0 ? document.body : nodes.get(id));
  const rejected = [];
  const reject = (op, why) => rejected.push(`${op.t}:${why}:${String(op.tag || op.name || "")}`);
  window.__pwxRejected = rejected; // test visibility; no app code runs in this document
  let worker = null;
  const toWorker = (msg) => worker && worker.postMessage(msg);

  function apply(op) {
    switch (op && op.t) {
      case "create": {
        const tag = String(op.tag).toLowerCase();
        if (!unsafe && !TAGS.has(tag)) return reject(op, "tag");
        nodes.set(op.id, document.createElement(tag));
        return;
      }
      case "attr": {
        const n = nodes.get(op.id); if (!n) return;
        const name = String(op.name).toLowerCase(), value = String(op.value);
        if (unsafe) return n.setAttribute(name, value);
        if (name === "src" && n.localName === "img" && value.startsWith("blob:")) return n.setAttribute(name, value);
        if (!ATTRS.has(name)) return reject(op, "attr");
        return n.setAttribute(name, value);
      }
      case "text": { const n = nodes.get(op.id); if (n) n.textContent = String(op.value); return; }
      case "prop": {
        const n = nodes.get(op.id), name = String(op.name);
        if (!n || !PROPS.has(name)) return reject(op, "prop");
        n[name] = name === "value" ? String(op.value) : Boolean(op.value);
        return;
      }
      case "focus": { const n = nodes.get(op.id); if (n && n.focus) n.focus(); return; }
      case "append": { const a = node(op.parent), c = node(op.id); if (a && c) a.append(c); return; }
      case "remove": { const n = nodes.get(op.id); if (n) n.remove(); nodes.delete(op.id); return; }
      case "listen": {
        const n = nodes.get(op.id), type = String(op.type);
        if (!n || !EVENTS.has(type)) return reject(op, "event");
        n.addEventListener(type, (e) => toWorker({
          t: "event", id: op.id, type, value: e.target.value ?? null, key: e.key ?? null,
        }));
        return;
      }
      default: return reject(op || {}, "op");
    }
  }

  // ---------- grants: written by the bootstrap from the verified manifest at every launch ----------
  // Opened and closed per read, so it never blocks a wipe. No pin or no grant means no access.
  async function readGrants() {
    try {
      const d = await new Promise((ok, no) => {
        const r = indexedDB.open("pwx-origin", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("pin");
        r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
      });
      try {
        const pin = await new Promise((ok, no) => {
          const q = d.transaction("pin", "readonly").objectStore("pin").get("app");
          q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error);
        });
        return { storage: pin?.grants?.storage === true };
      } finally { d.close(); }
    } catch { return { storage: false }; }
  }

  // ---------- storage capability: a key-value store kept here, on the app's own origin ----------
  // Only for apps whose manifest declares capabilities.storage.local; the database isn't
  // even opened otherwise.
  let grants = { storage: false };
  let db = null;
  const openStore = () => db ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("pwx-app-store", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  async function store(op, key, value) {
    if (!grants.storage) throw new Error("storage not declared in the manifest");
    if (op !== "all" && (typeof key !== "string" || key.length === 0 || key.length > 256)) throw new Error("bad key");
    const d = await openStore();
    return new Promise((resolve, reject) => {
      const t = d.transaction("kv", op === "get" || op === "all" ? "readonly" : "readwrite");
      const s = t.objectStore("kv");
      const req = op === "get" ? s.get(key) : op === "put" ? s.put(value, key) : op === "delete" ? s.delete(key) : op === "all" ? s.getAll() : null;
      if (!req) return reject(new Error("bad op"));
      t.oncomplete = () => resolve(op === "get" || op === "all" ? req.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  // ---------- the client library every app worker gets, ahead of its own code ----------
  const PRELUDE = `self.PwxUI = (() => {
  let nextId = 1, queue = [], scheduled = false, rid = 0;
  const handlers = new Map(), pending = new Map();
  const op = (o) => {
    queue.push(o);
    if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; const ops = queue; queue = []; postMessage({ ops }); }); }
  };
  function el(tag, attrs = {}, ...children) {
    const kids = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
    const id = nextId++;
    op({ t: "create", id, tag });
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on") && typeof v === "function") { handlers.set(id + ":" + k.slice(2), v); op({ t: "listen", id, type: k.slice(2) }); }
      else if (v !== undefined && v !== null && v !== false) op({ t: "attr", id, name: k, value: v === true ? "" : String(v) });
    }
    if (kids.length === 1 && typeof kids[0] === "string") op({ t: "text", id, value: kids[0] });
    else for (const c of kids) op({ t: "append", parent: id, id: typeof c === "number" ? c : el("span", {}, String(c)) });
    return id;
  }
  const call = (o, key, value) => new Promise((resolve, reject) => { const id = ++rid; pending.set(id, { resolve, reject }); postMessage({ t: "store", rid: id, op: o, key, value }); });
  self.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.t === "event") handlers.get(d.id + ":" + d.type)?.(d.value, d.key);
    if (d.t === "store-result") { const q = pending.get(d.rid); if (q) { pending.delete(d.rid); d.ok ? q.resolve(d.value) : q.reject(new Error(d.error)); } }
  });
  return {
    el,
    text: (id, value) => op({ t: "text", id, value: String(value) }),
    attr: (id, name, value) => op({ t: "attr", id, name, value: String(value) }),
    prop: (id, name, value) => op({ t: "prop", id, name, value }),
    append: (parent, id) => op({ t: "append", parent, id }),
    remove: (id) => { op({ t: "remove", id }); for (const k of handlers.keys()) if (k.startsWith(id + ":")) handlers.delete(k); },
    focus: (id) => op({ t: "focus", id }),
    mount: (id) => op({ t: "append", parent: 0, id }),
    /*STORE*/
  };
})();
`;
  // Added to PwxUI only when the manifest declares storage, so apps can feature-detect it.
  const STORE_API = `store: { get: (k) => call("get", k), put: (k, v) => call("put", k, v), del: (k) => call("delete", k), all: () => call("all") },`;

  function toDataUrl(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return "data:text/javascript;base64," + btoa(bin);
  }

  // The app's verified code comes from the cache only the bootstrap writes (app code can't
  // reach this origin's caches), then runs in an opaque-origin worker.
  (async () => {
    const res = await caches.match("/" + entry, { cacheName: "pwx-verified" });
    if (!res) return reject({ t: "load" }, "missing-entry");
    grants = await readGrants();
    const prelude = PRELUDE.replace("/*STORE*/", grants.storage ? STORE_API : "");
    worker = new Worker(toDataUrl(prelude + "\n;\n" + await res.text()));
    worker.onmessage = async (e) => {
      const d = e.data || {};
      if (Array.isArray(d.ops)) d.ops.forEach(apply);
      if (d.t === "store") {
        try { toWorker({ t: "store-result", rid: d.rid, ok: true, value: await store(String(d.op), d.key, d.value) }); }
        catch (err) { toWorker({ t: "store-result", rid: d.rid, ok: false, error: String(err && err.message || err) }); }
      }
      if (d.report) parent.postMessage({ ...d.report, rejected }, "*");
    };
    toWorker({ t: "init", mode });
  })();
})();
