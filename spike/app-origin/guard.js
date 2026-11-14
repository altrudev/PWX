// PWX guard: loader code injected ahead of app code in every app document.
// Best effort. It closes WebRTC and resource-hint paths that CSP does not cover in some
// engines, but page-level JavaScript can't fully seal a realm, so this is a speed bump,
// not a boundary. The spike measures what gets past it.
(() => {
  "use strict";
  const RTC = ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "RTCDataChannel",
    "RTCIceTransport", "RTCSctpTransport", "RTCDtlsTransport", "RTCRtpSender", "RTCRtpReceiver",
    "RTCRtpTransceiver", "RTCIceCandidate", "RTCSessionDescription", "RTCCertificate"];
  const HINT = /(^|\s)(preconnect|dns-prefetch|prefetch|prerender|preload|modulepreload)(\s|$)/i;
  const sealed = new WeakSet();

  function strip(node) {
    if (!node || node.nodeType !== 1) return;
    const links = node.localName === "link" ? [node] : node.querySelectorAll ? node.querySelectorAll("link") : [];
    for (const l of links) if (HINT.test(l.getAttribute("rel") || "")) l.remove();
  }

  function seal(w) {
    if (!w || sealed.has(w)) return;
    sealed.add(w);
    try {
      for (const k of RTC) {
        try { Object.defineProperty(w, k, { value: undefined, configurable: false, writable: false }); } catch (_) {}
      }
      // Child frames: seal their window as soon as script reaches it through the element.
      const ifr = w.HTMLIFrameElement.prototype;
      for (const prop of ["contentWindow", "contentDocument"]) {
        const d = Object.getOwnPropertyDescriptor(ifr, prop);
        Object.defineProperty(ifr, prop, {
          configurable: false,
          get() { const v = d.get.call(this); try { seal(prop === "contentWindow" ? v : v && v.defaultView); } catch (_) {} return v; },
        });
      }
      // Resource hints set through properties or attributes.
      const L = w.HTMLLinkElement.prototype;
      const rel = Object.getOwnPropertyDescriptor(L, "rel");
      Object.defineProperty(L, "rel", { configurable: false, get: rel.get, set(v) { if (!HINT.test(v)) rel.set.call(this, v); } });
      const setAttr = w.Element.prototype.setAttribute;
      w.Element.prototype.setAttribute = function (n, v) {
        if (this instanceof w.HTMLLinkElement && String(n).toLowerCase() === "rel" && HINT.test(v)) return;
        return setAttr.call(this, n, v);
      };
      // Markup insertion (innerHTML etc.) and new frames: handled after the fact.
      new w.MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) {
          strip(n);
          if (n.localName === "iframe") { try { seal(n.contentWindow); } catch (_) {} }
        }
      }).observe(w.document, { childList: true, subtree: true });
    } catch (_) {}
  }
  seal(window);
})();
