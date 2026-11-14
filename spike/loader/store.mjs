// Local app library: installed packages, kept only on this device (loader origin IndexedDB).
// Records hold the full signed package text, so every launch re-verifies it from scratch.
function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("pwx-loader", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("packages", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction("packages", mode);
    const req = fn(t.objectStore("packages"));
    t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}
export const library = {
  list: () => tx("readonly", (s) => s.getAll()),
  get: (id) => tx("readonly", (s) => s.get(id)),
  put: (record) => tx("readwrite", (s) => s.put(record)),
  remove: (id) => tx("readwrite", (s) => s.delete(id)),
};
