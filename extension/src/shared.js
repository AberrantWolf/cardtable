// shared.js — classic script loaded in ALL contexts (background, content, page).
// Defines a single global `CT` with constants + defaults. No DOM, no API calls at load.
(function (g) {
  if (g.CT) return;
  g.CT = {
    DB: "cardtable",
    DBV: 2,
    STORES: { tabs: "tabs", shots: "shots", layout: "layout", groups: "groups", notes: "notes", meta: "meta" },

    // message types (page/content -> background, and broadcasts)
    MSG: {
      MUTATE: "mutate",
      COMMAND: "command",
      OPEN: "open",            // open/activate a card's tab (double-click)
      DELETE: "delete",        // close tab + delete card ("close for good")
      GET_ALL: "getAll",       // page boot: fetch tabs + shots refs
      CAPTURE: "capture",      // content -> bg: capture me (I'm visible)
      META: "meta",            // content -> bg: title/favicon/url update
      SCROLL: "scroll",        // content -> bg: save scroll position
      GET_SCROLL: "getScroll", // content -> bg: restore scroll (cold reopen)
      FOCUS_CANVAS: "focusCanvas",
      CHANGED: "changed",      // bg -> page: cards changed, re-read
    },

    DEFAULTS: {
      theme: "slate",                 // slate | paper
      feltColor: "#262a32",
      cardWidth: 230,
      titleLines: 1,
      labelSize: 18,                  // card title
      labelFont: '"Caveat","Bradley Hand","Segoe Print","Comic Sans MS",cursive',
      noteSize: 11.5,                 // card note
      noteFont: 'ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
      groupSize: 27,                  // group label
      groupFont: '"Permanent Marker","Marker Felt","Comic Sans MS",cursive',   // bundled (Apache 2.0)
      // sticky notes — standalone annotations on the canvas (stored in the `notes` store). Size and
      // color are fixed for every note (configured here, not per-note); font is editable too.
      stickyColor: "#fdf3a3",         // soft yellow Post-it
      stickySize: 180,                // square, in px (world units)
      stickyFont: '"Caveat","Bradley Hand","Segoe Print","Comic Sans MS",cursive',   // bundled handwriting
      stickyFontSize: 18,
      shotQuality: 0.7,
      shotMaxWidth: 480,
      handOnNewTab: true,
      keepHandCardsOnTabClose: false, // off = closing an unplaced/hand tab removes its card instead of making it cold
      newTabOpensCanvas: false,       // opt-in: route the browser's new tab to the single canvas tab
      pinCanvasTab: true,             // pin the canvas tab (compact, leftmost, can't be closed by accident)
      soloGroups: false,
      showFavicons: true,             // off = hide locally cached site favicons
      reducedMotion: false,
    },

    // Keep saved/imported preferences limited to supported settings.
    normalizeSettings: function (saved = {}) {
      return Object.fromEntries(Object.entries(g.CT.DEFAULTS).map(([key, value]) =>
        [key, saved?.[key] ?? value]));
    },

    localFavicon: function (url) {
      return typeof url === 'string' && url.length <= 131072 && /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/i.test(url) ? url : '';
    },

    // URL helpers (pure)
    isTrackable: function (url) {
      return typeof url === "string" && /^https?:\/\//i.test(url);
    },
    normUrl: function (u) {
      try { return new URL(u).href; } catch { return u; }
    },
    uuid: function () {
      if (g.crypto && g.crypto.randomUUID) return g.crypto.randomUUID();
      return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
    },
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
