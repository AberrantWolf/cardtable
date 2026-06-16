// content.js — runs on every http(s) page. Reports metadata, requests screenshots while
// visible, saves scroll, and restores scroll exactly once after a cold reopen.
(function () {
  const X = globalThis.browser || globalThis.chrome;
  if (!X || !X.runtime || typeof CT === "undefined") return;
  const send = (m) => { try { return Promise.resolve(X.runtime.sendMessage(m)); } catch (e) { return Promise.resolve(); } };

  const favicon = () => {
    const link = document.querySelector("link[rel~='icon'], link[rel='shortcut icon']");
    return link ? link.href : location.origin + "/favicon.ico";
  };
  const sendMeta = () => send({ type: CT.MSG.META, url: location.href, title: document.title, favicon: favicon() });

  let lastCap = 0;
  const pingCapture = () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastCap < 1200) return;
    lastCap = now;
    send({ type: CT.MSG.CAPTURE });
  };

  async function restoreScrollOnce() {
    try { const r = await send({ type: CT.MSG.GET_SCROLL }); if (r && r.y) window.scrollTo(0, r.y); } catch (e) {}
  }

  let scrollT = null, lastY = -1;
  window.addEventListener("scroll", () => {
    if (scrollT) return;
    scrollT = setTimeout(() => {
      scrollT = null;
      const y = window.scrollY | 0;
      if (y !== lastY) { lastY = y; send({ type: CT.MSG.SCROLL, y }); }
      pingCapture();
    }, 600);
  }, { passive: true });

  function start() {
    sendMeta();
    restoreScrollOnce();
    setTimeout(pingCapture, 500);
    window.addEventListener("load", () => setTimeout(pingCapture, 250));   // grab it again once images/layout settle
    if (document.head) {
      let metaT = null;
      const mo = new MutationObserver(() => { clearTimeout(metaT); metaT = setTimeout(sendMeta, 400); });
      mo.observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "rel"] });
    }
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") setTimeout(pingCapture, 400); });
    setInterval(pingCapture, 6000);
  }
  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else window.addEventListener("DOMContentLoaded", start);
})();
