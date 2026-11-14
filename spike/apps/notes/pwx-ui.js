// Worker-side client for the PWX strict renderer protocol.
// Apps build UI with el(tag, attrs, ...children); "on<event>" attrs register handlers.
// Operations are batched per microtask and sent to the loader's renderer.
self.PwxUI = (() => {
  let nextId = 1, queue = [], scheduled = false;
  const handlers = new Map();
  const op = (o) => {
    queue.push(o);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => { scheduled = false; const ops = queue; queue = []; postMessage({ ops }); });
    }
  };
  function el(tag, attrs = {}, ...children) {
    const kids = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
    const id = nextId++;
    op({ t: "create", id, tag });
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on") && typeof v === "function") {
        handlers.set(`${id}:${k.slice(2)}`, v);
        op({ t: "listen", id, type: k.slice(2) });
      } else if (v !== undefined && v !== null && v !== false) {
        op({ t: "attr", id, name: k, value: v === true ? "" : String(v) });
      }
    }
    if (kids.length === 1 && typeof kids[0] === "string") op({ t: "text", id, value: kids[0] });
    else for (const c of kids) op({ t: "append", parent: id, id: typeof c === "number" ? c : el("span", {}, String(c)) });
    return id;
  }
  self.addEventListener("message", (e) => {
    const d = e.data || {};
    if (d.t === "event") handlers.get(`${d.id}:${d.type}`)?.(d.value, d.key);
  });
  return {
    el,
    text: (id, value) => op({ t: "text", id, value: String(value) }),
    attr: (id, name, value) => op({ t: "attr", id, name, value: String(value) }),
    prop: (id, name, value) => op({ t: "prop", id, name, value }),
    append: (parent, id) => op({ t: "append", parent, id }),
    remove: (id) => { op({ t: "remove", id }); for (const k of handlers.keys()) if (k.startsWith(`${id}:`)) handlers.delete(k); },
    focus: (id) => op({ t: "focus", id }),
    mount: (id) => op({ t: "append", parent: 0, id }),
  };
})();
