// shared.js — classic script loaded in ALL contexts (background, content, page).
// Defines a single global `CT` with constants + defaults. No DOM, no API calls at load.
(function (g) {
  if (g.CT) return;
  g.CT = {
    DB: "cardtable",
    DBV: 1,
    STORES: { tabs: "tabs", shots: "shots", layout: "layout", groups: "groups", notes: "notes" },

    // message types (page/content -> background, and broadcasts)
    MSG: {
      OPEN: "open",            // open/activate a card's tab (double-click)
      DELETE: "delete",        // close tab + delete card ("close for good")
      SEND_TO_HAND: "toHand",  // discard tab back into the hand
      CREATE_TAB: "createTab", // open a brand-new tab at a url
      GET_ALL: "getAll",       // page boot: fetch tabs + shots refs
      GET_SHOT: "getShot",
      CAPTURE: "capture",      // content -> bg: capture me (I'm visible)
      META: "meta",            // content -> bg: title/favicon/url update
      SCROLL: "scroll",        // content -> bg: save scroll position
      GET_SCROLL: "getScroll", // content -> bg: restore scroll (cold reopen)
      FOCUS_CANVAS: "focusCanvas",
      SETTINGS_CHANGED: "settingsChanged",
      CHANGED: "changed",      // bg -> page: cards changed, re-read
      SHOT: "shot",            // bg -> page: a screenshot updated {cardId}
    },

    DEFAULTS: {
      theme: "slate",                 // slate | paper
      feltColor: "#262a32",
      cardWidth: 230,
      titleLines: 1,
      labelSize: 18,
      labelFont: '"Caveat","Bradley Hand","Segoe Print","Comic Sans MS",cursive',
      shotQuality: 0.7,
      shotMaxWidth: 480,
      captureIntervalMs: 6000,
      maxLiveTabs: 1,                 // sleep policy knob; raise (or add tiering) later
      handOnNewTab: true,
      soloGroups: false,
      reducedMotion: false,
      deepLinkGuard: true,
      // substring/suffix matches against a navigation hostname; user-editable in Settings.
      authHosts: [
        "login.microsoftonline.com", "login.microsoft.com", "login.live.com",
        "okta.com", "accounts.google.com",
        "ping", "adfs", "sts.", "idp.", "sso.", "login.", "auth.", "saml",
      ],
    },

    // host classification helpers (pure)
    isAuthHost: function (host, hosts) {
      if (!host) return false;
      host = host.toLowerCase();
      return (hosts || g.CT.DEFAULTS.authHosts).some((p) => host.includes(p.toLowerCase()));
    },
    isTrackable: function (url) {
      return typeof url === "string" && /^https?:\/\//i.test(url);
    },
    sameOrigin: function (a, b) {
      try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
    },
    normUrl: function (u) {
      try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, "") + x.search; } catch { return u; }
    },
    uuid: function () {
      if (g.crypto && g.crypto.randomUUID) return g.crypto.randomUUID();
      return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
