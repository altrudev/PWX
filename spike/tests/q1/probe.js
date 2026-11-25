// Runs the sealed-frame probe in two variants (srcdoc and blob:) and collects the frames' reports.
const L = location.origin, CAN = "http://127.0.0.1:8399";
window.__q1 = { phase: "start", results: {} };
const META = `default-src 'none'; script-src ${L}/frame.js; worker-src data:; img-src blob:; style-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
const doc = (variant) => `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${META}"><script src="${L}/frame.js#${variant}"></script>`;
async function inlineDoc() {
  const code = await (await fetch("/frame.js")).text(), hash = await (await fetch("/frame-hash")).text();
  const meta = META.replace(`script-src ${L}/frame.js`, `script-src '${hash}'`);
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${meta}"><script>${code}</script>`;
}
async function run(variant) {
  const f = document.createElement("iframe");
  f.setAttribute("sandbox", "allow-scripts");
  const got = new Promise((resolve) => {
    addEventListener("message", function on(e) { if (e.source === f.contentWindow && e.data?.variant === variant) { removeEventListener("message", on); resolve(e.data); } });
    setTimeout(() => resolve({ variant, error: "no report from frame" }), 8000);
  });
  if (variant === "inline") f.srcdoc = await inlineDoc();
  else if (variant === "srcdoc") f.srcdoc = doc(variant);
  else f.src = URL.createObjectURL(new Blob([doc(variant)], { type: "text/html" }));
  document.body.append(f);
  return got;
}
(async () => {
  if (!navigator.serviceWorker.controller) {
    await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) { location.reload(); return; }
  }
  await (await caches.open("LOADER-SECRET")).put("/secret", new Response("loader data"));
  window.__q1.phase = "running";
  for (const v of ["inline", "srcdoc", "blob"]) window.__q1.results[v] = await run(v);
  const ch = new MessageChannel();
  window.__q1.swServed = await new Promise((r) => { ch.port1.onmessage = (m) => r(m.data.served); navigator.serviceWorker.controller.postMessage(0, [ch.port2]); setTimeout(() => r(null), 2000); });
  window.__q1.phase = "done";
})();
