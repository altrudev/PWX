// PWX Notes: a strict-runtime app. Runs only in a worker, stores notes in this app's
// own IndexedDB, and has no network capability at all.
importScripts("pwx-ui.js");
const { el, text, attr, prop, append, remove, focus, mount } = self.PwxUI;

// ---------- storage ----------
const db = new Promise((resolve, reject) => {
  const r = indexedDB.open("pwx-notes", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("notes", { keyPath: "id" });
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function tx(mode, fn) {
  const d = await db;
  return new Promise((resolve, reject) => {
    const t = d.transaction("notes", mode);
    const req = fn(t.objectStore("notes"));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const store = {
  all: () => tx("readonly", (s) => s.getAll()),
  put: (n) => tx("readwrite", (s) => s.put(n)),
  del: (id) => tx("readwrite", (s) => s.delete(id)),
};

// ---------- state ----------
let notes = [];          // newest first
let current = null;      // id of the open note
const itemFor = new Map(); // note id -> list button id
let listItems = [];
let saveTimer = null;
const label = (n) => n.title.trim() || n.body.trim().split("\n")[0] || "Untitled";
const find = (id) => notes.find((n) => n.id === id);

// ---------- UI ----------
let titleId, bodyId, savedId, listId, editorId, emptyId;
const app = el("div", { class: "app" },
  el("header", { class: "bar" },
    el("h1", { class: "title" }, "Notes"),
    el("small", { class: "muted" }, "Stored only on this device"),
    el("button", { class: "btn btn-primary", onclick: newNote }, "New note")),
  el("div", { class: "split" },
    (listId = el("ul", { class: "list", "aria-label": "Notes" })),
    (editorId = el("main", { class: "editor hidden" },
      (titleId = el("input", { class: "field field-title", placeholder: "Title", "aria-label": "Title",
        oninput: (v) => edit("title", v) })),
      (bodyId = el("textarea", { class: "field field-body", placeholder: "Write something", "aria-label": "Note",
        spellcheck: "true", oninput: (v) => edit("body", v) })),
      el("div", { class: "row" },
        (savedId = el("small", { class: "muted" }, "")),
        el("button", { class: "btn btn-danger", onclick: deleteNote }, "Delete")))),
    (emptyId = el("p", { class: "empty" }, "No notes yet. Create one to start."))));
mount(app);

function renderList() {
  for (const id of listItems) remove(id);
  listItems = []; itemFor.clear();
  for (const n of notes) {
    const btn = el("button", { class: "item", "aria-current": n.id === current ? "true" : "false",
      onclick: () => select(n.id) }, label(n));
    const li = el("li", {}, btn);
    append(listId, li);
    listItems.push(li); itemFor.set(n.id, btn);
  }
  const has = notes.length > 0;
  attr(editorId, "class", has ? "editor" : "editor hidden");
  attr(emptyId, "class", has ? "empty hidden" : "empty");
}

function select(id) {
  const n = find(id); if (!n) return;
  current = id;
  prop(titleId, "value", n.title);
  prop(bodyId, "value", n.body);
  text(savedId, "");
  renderList();
}

function edit(field, value) {
  const n = find(current); if (!n) return;
  n[field] = value; n.updated = Date.now();
  const btn = itemFor.get(n.id); if (btn) text(btn, label(n));
  text(savedId, "Saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await store.put(n); text(savedId, "Saved on this device"); }, 250);
}

async function newNote() {
  const n = { id: crypto.randomUUID(), title: "", body: "", updated: Date.now() };
  notes.unshift(n);
  await store.put(n);
  select(n.id);
  focus(titleId);
}

async function deleteNote() {
  if (!current) return;
  clearTimeout(saveTimer);
  await store.del(current);
  notes = notes.filter((n) => n.id !== current);
  current = null;
  if (notes.length) select(notes[0].id); else renderList();
}

store.all().then((saved) => {
  notes = saved.sort((a, b) => b.updated - a.updated);
  if (notes.length) select(notes[0].id); else renderList();
});
