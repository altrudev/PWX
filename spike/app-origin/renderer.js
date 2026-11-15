// PWX strict runtime: loader-owned renderer. App code never runs in this document.
// It runs only in a worker (no DOM, and no WebRTC in current engines) and sends declarative
// UI operations, which this renderer applies through a fixed allowlist. No element that can
// fetch, connect or hint (link, iframe, script, style, a, object, ...) can be created.
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
  const worker = new Worker("/" + entry);

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
        n.addEventListener(type, (e) => worker.postMessage({
          t: "event", id: op.id, type, value: e.target.value ?? null, key: e.key ?? null,
        }));
        return;
      }
      default: return reject(op || {}, "op");
    }
  }

  worker.onmessage = (e) => {
    const d = e.data || {};
    if (Array.isArray(d.ops)) d.ops.forEach(apply);
    if (d.report) parent.postMessage({ ...d.report, rejected }, "*");
  };
  worker.postMessage({ t: "init", mode });
})();
