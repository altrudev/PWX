// PWX sealed runtime (Quarantine Part 1). Runs inline in a sandboxed frame the loader builds
// (sandbox="allow-scripts", no allow-same-origin): the frame has an opaque origin, so it has no
// storage, no cookies and no access to the loader or to any other app. Its exact bytes are
// pinned by hash in the loader's CSP and in the frame's own CSP, so no other script can run here.
// App code never runs in this document. It runs in a worker started from a data: URL, sends
// UI operations through the fixed allowlist below, and reaches storage only by asking the
// loader over the port. The loader decides what the app may do from the verified manifest.
(() => {
  "use strict";
  let port = null, mode = "passive", unsafe = false;
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

  // ---------- storage: kept by the loader, per app; the loader checks the grant ----------
  let grants = { storage: false }, srid = 0;
  const waiting = new Map();
  function store(op, key, value) {
    if (!grants.storage) return Promise.reject(new Error("storage not declared in the manifest"));
    return new Promise((resolve, reject) => {
      const id = ++srid; waiting.set(id, { resolve, reject });
      port.postMessage({ type: "store", rid: id, op, key, value });
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

  // The loader hands over a port once; after that, only messages on it count.
  addEventListener("message", function connect(e) {
    if (port || e.source !== parent || e.data?.type !== "pwx-connect" || !e.ports[0]) return;
    removeEventListener("message", connect);
    port = e.ports[0];
    port.onmessage = (m) => {
      const d = m.data || {};
      if (d.type === "store-result") { const q = waiting.get(d.rid); if (q) { waiting.delete(d.rid); d.ok ? q.resolve(d.value) : q.reject(new Error(d.error)); } }
      if (d.type === "start" && !worker) start(d);
    };
    port.postMessage({ type: "connected" });
  });

  function start(d) {
    if (typeof d.code !== "string") return reject({ t: "load" }, "missing-entry");
    grants = { storage: d.grants?.storage === true };
    mode = typeof d.mode === "string" ? d.mode : "passive";
    unsafe = d.unsafe === true;
    const prelude = PRELUDE.replace("/*STORE*/", grants.storage ? STORE_API : "");
    worker = new Worker(toDataUrl(prelude + "\n;\n" + d.code));
    worker.onmessage = async (e) => {
      const w = e.data || {};
      if (Array.isArray(w.ops)) w.ops.forEach(apply);
      if (w.t === "store") {
        try { toWorker({ t: "store-result", rid: w.rid, ok: true, value: await store(String(w.op), w.key, w.value) }); }
        catch (err) { toWorker({ t: "store-result", rid: w.rid, ok: false, error: String(err && err.message || err) }); }
      }
      if (w.report) port.postMessage({ type: "report", report: { ...w.report, rejected } });
    };
    toWorker({ t: "init", mode });
  }
  parent.postMessage({ type: "pwx-sealed-ready" }, "*");
})();
