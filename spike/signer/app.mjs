// Signer page: approval card built from the package itself.
import * as device from "./device.mjs";
const $ = (id) => document.getElementById(id);
// Shows the approval card built from the package itself; resolves with the person's answer.
async function ask(pkgText, prevPkgText, authorId) {
  const { summary } = await device.review(pkgText, prevPkgText);
  $("title").textContent = summary.title + (summary.from ? ` (from ${summary.from})` : "");
  $("added").hidden = !summary.added.length;
  $("added").textContent = summary.added.length ? "New: " + summary.added.join(", ") : "";
  $("all").replaceChildren(...(summary.all.length ? summary.all : ["nothing beyond showing its own screens"])
    .map((t) => Object.assign(document.createElement("li"), { textContent: t })));
  $("card").hidden = false;
  window.signer.shown = summary;
  $("pass").value = ""; $("err").hidden = true;
  for (;;) {
    const yes = await new Promise((r) => { $("approve").onclick = () => r(true); $("deny").onclick = () => r(false); });
    if (!yes) { $("card").hidden = true; return null; }
    try { const a = await device.approve(pkgText, authorId, $("pass").value); $("card").hidden = true; return a; }
    catch (e) { $("err").textContent = e.message; $("err").hidden = false; window.signer.lastError = e.message; }
  }
}
window.signer = { ...device, ask, shown: null };
$("status").textContent = "PWX Signer ready";
window.signerReady = true;
