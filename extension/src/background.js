// background.js — classic script. Runs as a Chromium MV3 service worker (via importScripts)
// and as a Firefox MV3 event page (shared.js is listed before it in the manifest).
if (typeof CT === "undefined") { try { importScripts("shared.js"); } catch (e) {} }
const X = globalThis.browser || globalThis.chrome;

// ---------------- IndexedDB (background owns: tabs, shots) ----------------
let _db = null;
function idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(CT.DB, CT.DBV);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CT.STORES.tabs)) {
        const s = db.createObjectStore(CT.STORES.tabs, { keyPath: "cardId" });
        s.createIndex("tabId", "tabId", { unique: false });
        s.createIndex("url", "url", { unique: false });
      }
      if (!db.objectStoreNames.contains(CT.STORES.shots)) db.createObjectStore(CT.STORES.shots, { keyPath: "cardId" });
      if (!db.objectStoreNames.contains(CT.STORES.layout)) db.createObjectStore(CT.STORES.layout, { keyPath: "cardId" });
      if (!db.objectStoreNames.contains(CT.STORES.groups)) db.createObjectStore(CT.STORES.groups, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CT.STORES.notes)) db.createObjectStore(CT.STORES.notes, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const conn = req.result;
      // A suspended/torn-down event page can leave a stale or closed handle cached in `_db`; null it
      // so the next call reopens instead of every transaction throwing silently until a restart.
      conn.onclose = () => { if (_db === conn) _db = null; };
      conn.onversionchange = () => { try { conn.close(); } catch (e) {} if (_db === conn) _db = null; };
      res(conn);
    };
    req.onerror = () => rej(req.error);
  });
}
async function db() { if (!_db) _db = await idbOpen(); return _db; }
function pReq(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
async function st(store, mode) { return (await db()).transaction(store, mode).objectStore(store); }
async function idbGet(store, key) { return pReq((await st(store, "readonly")).get(key)); }
async function idbAll(store) { return pReq((await st(store, "readonly")).getAll()); }
async function idbPut(store, val) { return pReq((await st(store, "readwrite")).put(val)); }
async function idbDel(store, key) { return pReq((await st(store, "readwrite")).delete(key)); }
async function cardByTab(tabId) { const r = await pReq((await st(CT.STORES.tabs, "readonly")).index("tabId").getAll(tabId)); return r[0] || null; }

// ---------------- settings ----------------
let settings = { ...CT.DEFAULTS };
async function loadSettings() {
  try { const r = await X.storage.local.get("settings"); settings = { ...CT.DEFAULTS, ...(r.settings || {}) }; } catch (e) {}
}
X.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings) settings = { ...CT.DEFAULTS, ...(ch.settings.newValue || {}) };
});

// ---------------- helpers ----------------
const isCanvas = (url) => !!url && url.startsWith(X.runtime.getURL(""));
const broadcastChanged = () => { try { X.runtime.sendMessage({ type: CT.MSG.CHANGED }).catch(() => {}); } catch (e) {} };
const broadcastShot = (cardId) => { try { X.runtime.sendMessage({ type: CT.MSG.SHOT, cardId }).catch(() => {}); } catch (e) {} };

const creating = new Map();   // tabId -> in-flight create promise; collapses concurrent creates into one card
async function ensureCardForTab(tab) {
  if (!tab || !CT.isTrackable(tab.url) || isCanvas(tab.url)) return null;
  const existing = await cardByTab(tab.id);
  if (existing) return existing;
  if (creating.has(tab.id)) return creating.get(tab.id);
  const p = (async () => {
    const card = {
      cardId: CT.uuid(), tabId: tab.id, url: tab.url, title: tab.title || tab.url,
      favicon: tab.favIconUrl || "", state: tab.discarded ? "sleeping" : "live",
      windowId: tab.windowId, createdAt: Date.now(), lastSeen: Date.now(), scrollY: 0,
    };
    await idbPut(CT.STORES.tabs, card);
    broadcastChanged();
    return card;
  })();
  creating.set(tab.id, p);
  try { return await p; } finally { creating.delete(tab.id); }
}

// ---------------- screenshots ----------------
const lastCap = new Map();
const MIN_CAP_MS = 1500;
// Capture/store failures were historically swallowed silently, which hid a total screenshot
// blackout (empty `shots` store) until a browser restart. Log each distinct failure once: the
// common "tab not visible/focused" cases collapse to a single line, while a real problem —
// missing host permission, a wedged OffscreenCanvas, a stuck IndexedDB handle — shows its message.
const loggedCapErrs = new Set();
function logCapErr(stage, tab, e) {
  const msg = (e && e.message) || String(e);
  const key = stage + "|" + msg;
  if (loggedCapErrs.has(key)) return;
  loggedCapErrs.add(key);
  console.warn(`[cardtable] screenshot ${stage} failed:`, msg, "—", tab && tab.url);
}
async function downscale(dataUrl, maxW, quality) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxW / bmp.width);
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const oc = new OffscreenCanvas(w, h);
  oc.getContext("2d").drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return oc.convertToBlob({ type: "image/jpeg", quality });
}
async function captureTab(tab) {
  if (!tab || !CT.isTrackable(tab.url) || isCanvas(tab.url)) return;
  const now = Date.now();
  if (now - (lastCap.get(tab.id) || 0) < MIN_CAP_MS) return;
  lastCap.set(tab.id, now);
  let dataUrl;
  try { dataUrl = await X.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: Math.round((settings.shotQuality || 0.7) * 100) }); }
  catch (e) { logCapErr("capture", tab, e); return; }   // often benign (tab not visible/focused); a permission error surfaces here too
  try {
    const blob = await downscale(dataUrl, settings.shotMaxWidth || 480, settings.shotQuality || 0.7);
    const card = await ensureCardForTab(tab);
    if (!card) return;
    await idbPut(CT.STORES.shots, { cardId: card.cardId, blob, ts: now });
    card.title = tab.title || card.title; card.favicon = tab.favIconUrl || card.favicon;
    card.url = tab.url; card.state = "live"; card.lastSeen = now;
    await idbPut(CT.STORES.tabs, card);
    broadcastShot(card.cardId);
  } catch (e) { logCapErr("store", tab, e); }
}
const scheduleCapture = (tab) => setTimeout(() => captureTab(tab), 400);

// ---------------- sleep policy (one knob; tiering hooks in here later) ----------------
let sleepT = null;
const debouncedSleep = () => { clearTimeout(sleepT); sleepT = setTimeout(applySleepPolicy, 1500); };
async function applySleepPolicy() {
  try {
    const tabs = (await X.tabs.query({})).filter((t) => CT.isTrackable(t.url) && !isCanvas(t.url) && !t.discarded);
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const maxLive = Math.max(1, settings.maxLiveTabs || 1);
    let changed = false;
    for (const t of tabs.slice(maxLive)) {
      if (t.active) continue;
      try {
        await X.tabs.discard(t.id);
        const c = await cardByTab(t.id);
        if (c && c.state !== "sleeping") { c.state = "sleeping"; await idbPut(CT.STORES.tabs, c); changed = true; }
      } catch (e) {}
      // TIERING HOOK: when scaling past dozens, oldest tabs could be fully closed
      // (tabs.remove) here and marked 'cold' instead of merely discarded.
    }
    if (changed) broadcastChanged();
  } catch (e) {}
}

// ---------------- transient state, session-backed (survives SW suspension) ----------------
// MV3 service workers are killed when idle; in-memory Maps would drop the SSO guard mid-redirect
// and the one-shot scroll restore. storage.session is in-memory, per-session, cleared on browser close.
const SES = X.storage.session;
const gkey = (id) => "guard:" + id, rkey = (id) => "restore:" + id;
async function getGuard(id) { try { const r = await SES.get(gkey(id)); return r[gkey(id)] || null; } catch (e) { return null; } }
async function setGuard(id, g) { try { await SES.set({ [gkey(id)]: g }); } catch (e) {} }
async function delGuard(id) { try { await SES.remove(gkey(id)); } catch (e) {} }
async function setRestore(id, y) { try { await SES.set({ [rkey(id)]: y }); } catch (e) {} }
async function delRestore(id) { try { await SES.remove(rkey(id)); } catch (e) {} }
async function getRestore(id) { try { const r = await SES.get(rkey(id)); return r[rkey(id)] || 0; } catch (e) { return 0; } }

// ---------------- SSO deep-link guard ----------------
async function armGuard(tabId, url) { if (settings.deepLinkGuard) await setGuard(tabId, { expectedUrl: url, sawAuth: false, ts: Date.now() }); }
X.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const g = await getGuard(d.tabId); if (!g) return;
  try { if (CT.isAuthHost(new URL(d.url).hostname, settings.authHosts)) { g.sawAuth = true; await setGuard(d.tabId, g); } } catch (e) {}
});
X.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  const g = await getGuard(d.tabId); if (!g) return;
  if (Date.now() - g.ts > 90000) { await delGuard(d.tabId); return; }
  if (!g.sawAuth) return;                                   // only act after an actual auth bounce
  if (CT.normUrl(d.url) === CT.normUrl(g.expectedUrl)) { await delGuard(d.tabId); return; }
  if (!CT.sameOrigin(d.url, g.expectedUrl)) return;         // landed on a different site on purpose → leave it
  await delGuard(d.tabId);
  try { await X.tabs.update(d.tabId, { url: g.expectedUrl }); } catch (e) {}
});

// ---------------- commands ----------------
async function openCard(cardId) {
  const card = await idbGet(CT.STORES.tabs, cardId);
  if (!card) return;
  if (card.tabId != null) {
    try {
      const tab = await X.tabs.get(card.tabId);
      await armGuard(card.tabId, card.url);                 // activating a sleeping tab reloads it → guard catches re-auth
      await X.tabs.update(card.tabId, { active: true });
      await X.windows.update(tab.windowId, { focused: true });
      card.state = "live"; card.lastSeen = Date.now(); await idbPut(CT.STORES.tabs, card);
      broadcastChanged(); debouncedSleep(); return;
    } catch (e) { /* tab is gone → fall through to cold reopen */ }
  }
  const tab = await X.tabs.create({ url: card.url, active: true });
  await armGuard(tab.id, card.url);
  await setRestore(tab.id, card.scrollY || 0);       // restore scroll once, only on this cold reopen
  card.tabId = tab.id; card.state = "live"; card.windowId = tab.windowId; card.lastSeen = Date.now();
  await idbPut(CT.STORES.tabs, card);
  broadcastChanged(); debouncedSleep();
}
const deleting = new Set();
async function deleteCard(cardId) {
  const card = await idbGet(CT.STORES.tabs, cardId);
  if (card && card.tabId != null) { deleting.add(card.tabId); try { await X.tabs.remove(card.tabId); } catch (e) {} }
  await idbDel(CT.STORES.tabs, cardId);
  await idbDel(CT.STORES.shots, cardId);
  broadcastChanged();
}
async function focusCanvas() {
  const url = X.runtime.getURL("newtab.html");
  const all = await X.tabs.query({});
  const existing = all.find((t) => isCanvas(t.url));
  if (existing) {
    await X.tabs.update(existing.id, { active: true });
    try { const t = await X.tabs.get(existing.id); await X.windows.update(t.windowId, { focused: true }); } catch (e) {}
  } else {
    await X.tabs.create({ url });
  }
  debouncedSleep();
}

// ---------------- tab events ----------------
X.tabs.onCreated.addListener((tab) => { if (CT.isTrackable(tab.url) && !isCanvas(tab.url)) ensureCardForTab(tab); });
X.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (isCanvas(tab.url) || !CT.isTrackable(tab.url)) return;
  if (!(info.url || info.title || info.favIconUrl || info.status === "complete")) return;
  const card = await ensureCardForTab(tab);
  if (card) {
    let ch = false;
    if (tab.url && tab.url !== card.url) { card.url = tab.url; ch = true; }
    if (tab.title && tab.title !== card.title) { card.title = tab.title; ch = true; }
    if (tab.favIconUrl && tab.favIconUrl !== card.favicon) { card.favicon = tab.favIconUrl; ch = true; }
    if (info.status === "complete") { card.state = tab.discarded ? "sleeping" : "live"; ch = true; }
    if (ch) { card.lastSeen = Date.now(); await idbPut(CT.STORES.tabs, card); broadcastChanged(); }
  }
  if (info.status === "complete" && tab.active) scheduleCapture(tab);
});
X.tabs.onActivated.addListener(async ({ tabId }) => {
  try { const tab = await X.tabs.get(tabId); if (!isCanvas(tab.url)) scheduleCapture(tab); } catch (e) {}
  debouncedSleep();
});
X.tabs.onRemoved.addListener(async (tabId) => {
  delGuard(tabId); delRestore(tabId);                       // drop any session-backed state for this tab
  if (deleting.has(tabId)) { deleting.delete(tabId); return; }
  const card = await cardByTab(tabId);
  if (card) { card.state = "cold"; card.tabId = null; await idbPut(CT.STORES.tabs, card); broadcastChanged(); }
});
if (X.tabs.onReplaced) X.tabs.onReplaced.addListener(async (added, removed) => {
  const card = await cardByTab(removed); if (card) { card.tabId = added; await idbPut(CT.STORES.tabs, card); }
});
if (X.windows && X.windows.onFocusChanged) X.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === X.windows.WINDOW_ID_NONE) return;
  try { const [tab] = await X.tabs.query({ active: true, windowId: winId }); if (tab && !isCanvas(tab.url)) scheduleCapture(tab); } catch (e) {}
});

// ---------------- restart reconciliation (tab ids change; cards must survive) ----------------
let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    await loadSettings();
    const openTabs = (await X.tabs.query({})).filter((t) => CT.isTrackable(t.url) && !isCanvas(t.url));
    const cards = await idbAll(CT.STORES.tabs);
    const byUrl = new Map();
    for (const c of cards) { const k = CT.normUrl(c.url); if (!byUrl.has(k)) byUrl.set(k, c); }
    const matched = new Set();
    for (const t of openTabs) {
      let card = await cardByTab(t.id);
      if (!card) { const cand = byUrl.get(CT.normUrl(t.url)); if (cand && !matched.has(cand.cardId)) card = cand; }
      if (!card) {
        card = { cardId: CT.uuid(), url: t.url, title: t.title || t.url, favicon: t.favIconUrl || "", tabId: t.id, state: t.discarded ? "sleeping" : "live", windowId: t.windowId, createdAt: Date.now(), lastSeen: Date.now(), scrollY: 0 };
      } else {
        card.tabId = t.id; card.state = t.discarded ? "sleeping" : "live";
        if (t.title) card.title = t.title; if (t.favIconUrl) card.favicon = t.favIconUrl;
      }
      matched.add(card.cardId);
      await idbPut(CT.STORES.tabs, card);
    }
    for (const c of cards) {
      if (!matched.has(c.cardId) && (c.tabId != null || c.state !== "cold")) {
        c.tabId = null; c.state = "cold"; await idbPut(CT.STORES.tabs, c);
      }
    }
    broadcastChanged();
  } catch (e) {} finally { reconciling = false; }
}
X.runtime.onInstalled.addListener(reconcile);
if (X.runtime.onStartup) X.runtime.onStartup.addListener(reconcile);
reconcile();

// ---------------- message API ----------------
X.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case CT.MSG.GET_ALL: sendResponse({ tabs: await idbAll(CT.STORES.tabs) }); break;
        case CT.MSG.GET_SHOT: { const s = await idbGet(CT.STORES.shots, msg.cardId); sendResponse({ blob: s ? s.blob : null }); break; }
        case CT.MSG.OPEN: await openCard(msg.cardId); sendResponse({ ok: true }); break;
        case CT.MSG.DELETE: await deleteCard(msg.cardId); sendResponse({ ok: true }); break;
        case CT.MSG.CREATE_TAB: { const tab = await X.tabs.create({ url: msg.url, active: !!msg.active }); sendResponse({ tabId: tab.id }); break; }
        case CT.MSG.FOCUS_CANVAS: await focusCanvas(); sendResponse({ ok: true }); break;
        case CT.MSG.SETTINGS_CHANGED: await loadSettings(); sendResponse({ ok: true }); break;
        case CT.MSG.CAPTURE: if (sender.tab) await captureTab(sender.tab); sendResponse({ ok: true }); break;
        case CT.MSG.META: {
          if (sender.tab) {
            const card = await ensureCardForTab(sender.tab);
            if (card) {
              let ch = false;
              if (msg.title && msg.title !== card.title) { card.title = msg.title; ch = true; }
              if (msg.favicon && msg.favicon !== card.favicon) { card.favicon = msg.favicon; ch = true; }
              if (msg.url && msg.url !== card.url) { card.url = msg.url; ch = true; }
              if (ch) { await idbPut(CT.STORES.tabs, card); broadcastChanged(); }
            }
          }
          sendResponse({ ok: true }); break;
        }
        case CT.MSG.SCROLL: { if (sender.tab) { const c = await cardByTab(sender.tab.id); if (c) { c.scrollY = msg.y; await idbPut(CT.STORES.tabs, c); } } sendResponse({ ok: true }); break; }
        case CT.MSG.GET_SCROLL: { let y = 0; if (sender.tab) { y = await getRestore(sender.tab.id); await delRestore(sender.tab.id); } sendResponse({ y }); break; }
        default: sendResponse({});
      }
    } catch (e) { sendResponse({ error: String(e) }); }
  })();
  return true; // keep the channel open for async sendResponse
});
if (X.commands) X.commands.onCommand.addListener((cmd) => { if (cmd === "focus-canvas") focusCanvas(); });
if (X.action) X.action.onClicked.addListener(() => focusCanvas());
