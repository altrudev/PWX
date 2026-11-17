// PWX Guard (spike): a check that lives outside the web host.
// A web page can't stop the browser from installing whatever sw.js the host serves. An extension
// can: it blocks the loader's sw.js by default, fetches it itself, and lets the browser fetch it
// only for a few seconds after the bytes matched a release signed with the pinned PWX release
// key. If the browser's fetch is blocked, the update fails and the old, verified worker stays.
// Known gap (Chromium): the extension can't check the exact bytes the browser receives, so a
// host that serves the extension a good copy and the browser a bad one inside the open window
// still gets through. See docs/AUDIT.md.
// No top-level await: service workers don't allow it. Everything below waits for `ready`.
let cfg, LOADERS;
const BLOCK = 1, ALLOW = 2, WINDOW_MS = 5000;

const b64dec = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64enc = (u) => { let s = ""; for (const b of new Uint8Array(u)) s += String.fromCharCode(b); return btoa(s); };
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",")}}`
  : JSON.stringify(v);
const cmpVersion = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };

const swUrl = (origin) => `${origin}/sw.js`;
const ruleId = (origin, base) => base * 1000 + [...LOADERS].indexOf(origin);
const blockRule = (origin) => ({ id: ruleId(origin, BLOCK), priority: 1, action: { type: "block" },
  condition: { urlFilter: `|${swUrl(origin)}`, excludedInitiatorDomains: [chrome.runtime.id] } });
const allowRule = (origin) => ({ id: ruleId(origin, ALLOW), priority: 2, action: { type: "allow" },
  condition: { urlFilter: `|${swUrl(origin)}` } });

// Blocked by default, from the moment the extension is installed.
async function blockAll() {
  const rules = [...LOADERS].map(blockRule);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules });
}
const ready = fetch(chrome.runtime.getURL("config.json")).then((r) => r.json())
  .then((c) => { cfg = c; LOADERS = new Set(c.loaders); return blockAll(); });

async function verify(origin) {
  await ready;
  const [swRes, relRes] = await Promise.all([
    fetch(swUrl(origin), { cache: "no-store" }), fetch(`${origin}/loader-release.json`, { cache: "no-store" })]);
  if (!swRes.ok || !relRes.ok) throw new Error("the host didn't provide sw.js and a release");
  const got = "sha256-" + b64enc(await crypto.subtle.digest("SHA-256", await swRes.arrayBuffer()));
  const { release, sig } = await relRes.json();
  if (sig?.alg !== "ed25519" || sig.key !== cfg.releaseKey) throw new Error("release isn't signed with the PWX release key");
  const key = await crypto.subtle.importKey("raw", b64dec(cfg.releaseKey), { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, b64dec(sig.sig), new TextEncoder().encode(canon(release))))) throw new Error("release signature is invalid");
  if (!/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(release.version)) throw new Error("release version is malformed");
  const seen = (await chrome.storage.local.get("versions")).versions ?? {};
  if (seen[origin] && cmpVersion(release.version, seen[origin]) < 0) throw new Error(`release ${release.version} is older than ${seen[origin]}`);
  if (release.files?.["loader/sw.js"] !== got) throw new Error("sw.js doesn't match the signed release");
  await chrome.storage.local.set({ versions: { ...seen, [origin]: release.version } });
  return release.version;
}

async function check(origin) {
  await ready;
  let state;
  try {
    const version = await verify(origin);
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(origin, ALLOW)], addRules: [allowRule(origin)] });
    setTimeout(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(origin, ALLOW)] }), WINDOW_MS);
    state = { ok: true, version, at: Date.now() };
    chrome.action.setBadgeText({ text: "" });
  } catch (err) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(origin, ALLOW)] });
    state = { ok: false, error: String(err.message || err), at: Date.now() };
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setTitle({ title: `PWX Guard blocked ${origin}: ${state.error}` });
  }
  const all = (await chrome.storage.local.get("state")).state ?? {};
  await chrome.storage.local.set({ state: { ...all, [origin]: state } });
  return state;
}

// Check whenever the user opens the loader, before its page asks the browser for sw.js.
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  const origin = new URL(d.url).origin;
  ready.then(() => { if (LOADERS.has(origin)) check(origin); });
});
self.pwxGuardCheck = check; // the spike's test calls this directly
