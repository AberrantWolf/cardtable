import { groupOutline, chalkPaths, pointInPolygon, bbox, hashStr } from "./geometry.js";
import DBP from "./db.js";

const X = globalThis.browser || globalThis.chrome;
const OFF = 20000, SVGNS = "http://www.w3.org/2000/svg";
const GROUP_PAD = 50, ADD_PAD = 170, REMOVE_PAD = 300, NEW_GROUP_DIST = 340, HAND_ZONE_H = 180;
const HAND_W = 158, HAND_STEP = 82;   // hand card width and per-card footprint after -38px side margins

const $ = (id) => document.getElementById(id);
const tableEl = $("table"), worldEl = $("world"), cardsEl = $("cards"), labelsEl = $("labels"),
  pathsEl = $("group-paths"), handEl = $("hand"), trashEl = $("trash"), menuEl = $("menu"),
  searchEl = $("search"), countEl = $("count"), emptyEl = $("empty"), toastEl = $("toast");

let S = { ...CT.DEFAULTS };
let CARD_W = 230, CARD_H = 245;
const state = { cards: [], groups: [], view: { x: 0, y: 0, zoom: 1 }, zmax: 1 };
const selection = new Set();
const shotUrls = new Map();
let filter = "";
let near = null;   // group id whose outline the pointer is hovering near (a press would grab it)
// "Interacting" = a pointer drag is in flight, or an async critical section holds a lease. It is a
// DERIVED predicate, never a hand-set flag — both sources release through guaranteed teardown
// (AbortController for drags, try/finally for async), so it cannot latch. See the interaction section.
let activeGesture = null, criticalDepth = 0, pendingReload = false;
const isInteracting = () => activeGesture !== null || criticalDepth > 0;

// ---------------- helpers ----------------
const card = (id) => state.cards.find((c) => c.cardId === id);
const placed = () => state.cards.filter((c) => c.placed && (!filter || matches(c)));
const handCards = () => state.cards.filter((c) => !c.placed);
const membersOf = (gid) => state.cards.filter((c) => c.placed && c.group === gid);
const rectOf = (c) => ({ x: c.x, y: c.y, w: CARD_W, h: CARD_H });
const centerOf = (c) => ({ x: c.x + CARD_W / 2, y: c.y + CARD_H / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const overlaps = (a, b) => a.x < b.x + CARD_W && a.x + CARD_W > b.x && a.y < b.y + CARD_H && a.y + CARD_H > b.y;
const rotFor = (id) => ((hashStr(id) % 640) / 100) - 3.2;
const matches = (c) => { const q = filter.toLowerCase(); return (c.title || "").toLowerCase().includes(q) || (c.url || "").toLowerCase().includes(q); };
const send = (m) => { try { return Promise.resolve(X.runtime.sendMessage(m)); } catch (e) { return Promise.resolve(); } };

// ---------------- settings / theme ----------------
async function loadSettings() {
  try { const r = await X.storage.local.get(["settings", "view"]); S = { ...CT.DEFAULTS, ...(r.settings || {}) }; if (r.view) state.view = r.view; } catch (e) {}
  applyTheme();
}
function applyTheme() {
  CARD_W = S.cardWidth || 230; CARD_H = Math.round(CARD_W * 0.75) + 74;
  const r = document.documentElement;
  r.style.setProperty("--card-w", CARD_W + "px");
  r.style.setProperty("--label-font", S.labelFont || CT.DEFAULTS.labelFont);
  r.style.setProperty("--title-lines", S.titleLines || 1);
  r.style.setProperty("--label-size", (S.labelSize || 18) + "px");
  r.style.setProperty("--note-font", S.noteFont || CT.DEFAULTS.noteFont);
  r.style.setProperty("--note-size", (S.noteSize || CT.DEFAULTS.noteSize) + "px");
  r.style.setProperty("--group-font", S.groupFont || CT.DEFAULTS.groupFont);
  r.style.setProperty("--group-size", (S.groupSize || CT.DEFAULTS.groupSize) + "px");
  if (S.theme === "paper") r.style.removeProperty("--table-bg");
  else r.style.setProperty("--table-bg", S.feltColor || CT.DEFAULTS.feltColor);
  document.body.classList.toggle("theme-paper", S.theme === "paper");
  document.body.classList.toggle("reduce", !!S.reducedMotion);
}
async function saveSettings() { try { await X.storage.local.set({ settings: S }); send({ type: CT.MSG.SETTINGS_CHANGED }); } catch (e) {} }
let viewT = null;
const saveView = () => { clearTimeout(viewT); viewT = setTimeout(() => X.storage.local.set({ view: state.view }).catch(() => {}), 300); };

// ---------------- persistence (layout/groups owned by the page) ----------------
const dirty = new Set();
let flushT = null;
function persist(c) { dirty.add(c.cardId); clearTimeout(flushT); flushT = setTimeout(flush, 250); }
async function flush() {
  const ids = [...dirty]; dirty.clear();
  for (const id of ids) {
    const c = card(id); if (!c) continue;
    try { await DBP.put(CT.STORES.layout, { cardId: c.cardId, x: c.x, y: c.y, rot: c.rot, group: c.group, note: c.note, z: c.z, placed: c.placed }); } catch (e) {}
  }
}
const saveGroup = (g) => DBP.put(CT.STORES.groups, g).catch(() => {});
const delGroupRec = (id) => DBP.del(CT.STORES.groups, id).catch(() => {});

// ---------------- data load ----------------
async function loadShot(cardId) {
  try {
    const s = await DBP.get(CT.STORES.shots, cardId);
    if (s && s.blob) {
      const old = shotUrls.get(cardId); if (old) URL.revokeObjectURL(old);
      const u = URL.createObjectURL(s.blob); shotUrls.set(cardId, u);
      const c = card(cardId); if (c) c.shotUrl = u;
      return u;
    }
  } catch (e) {}
  return null;
}
// loadAll rebuilds all page state from the DB; it awaits screenshot blobs, so two overlapping
// calls (a direct reload racing a CHANGED-triggered one) could interleave and corrupt state.
// Serialize them onto a chain — callers still get a promise that resolves after their own run.
let loadChain = Promise.resolve();
function loadAll() { loadChain = loadChain.then(_loadAll, _loadAll); return loadChain; }
async function _loadAll() {
  const [tabs, layouts, groups] = await Promise.all([
    DBP.all(CT.STORES.tabs), DBP.all(CT.STORES.layout), DBP.all(CT.STORES.groups),
  ]);
  const lay = new Map(layouts.map((l) => [l.cardId, l]));
  state.groups = groups;
  let zmax = 1;
  let cascade = 0;
  const newPlacements = [];
  state.cards = tabs.map((t) => {
    const l = lay.get(t.cardId);
    const c = {
      cardId: t.cardId, url: t.url, title: t.title || t.url, favicon: t.favicon || "", state: t.state || "cold",
      x: 0, y: 0, rot: rotFor(t.cardId), group: null, note: "", z: ++zmax, placed: false,
      shotUrl: shotUrls.get(t.cardId) || null,
    };
    if (l) {
      c.x = l.x || 0; c.y = l.y || 0; c.rot = l.rot ?? c.rot; c.group = l.group ?? null;
      c.note = l.note || ""; c.z = l.z || c.z; c.placed = l.placed === true;
      if (c.z > zmax) zmax = c.z;
    } else if (!S.handOnNewTab) {
      c.placed = true; c.x = 60 + (cascade % 6) * 60; c.y = 60 + (cascade % 6) * 50; cascade++;
      newPlacements.push(c);
    }
    return c;
  });
  state.zmax = zmax;
  for (const c of newPlacements) persist(c);
  // drop empty groups; in "outline around lone cards" mode give every lone card its own group
  state.groups = state.groups.filter((g) => { if (!state.cards.some((c) => c.group === g.id)) { delGroupRec(g.id); return false; } return true; });
  const gids = new Set(state.groups.map((g) => g.id));
  for (const c of state.cards) if (c.group && !gids.has(c.group)) c.group = null;   // heal refs to a pruned group (e.g. after undoing a delete) so the card isn't stuck outline-less
  if (S.soloGroups) for (const c of state.cards) if (c.placed && !c.group) ensureSoloGroup(c);
  // prune selection of vanished cards
  for (const id of [...selection]) if (!card(id)) selection.delete(id);
  // load any missing screenshots
  await Promise.all(state.cards.filter((c) => !c.shotUrl).map((c) => loadShot(c.cardId)));
}

// ---------------- view ----------------
function applyView() { worldEl.style.transform = `translate(${state.view.x}px,${state.view.y}px) scale(${state.view.zoom})`; positionLabels(); }
function toWorld(sx, sy) { return { x: (sx - state.view.x) / state.view.zoom, y: (sy - state.view.y) / state.view.zoom }; }
function worldToScreen(wx, wy) { return { x: wx * state.view.zoom + state.view.x, y: wy * state.view.zoom + state.view.y }; }

// ---------------- card rendering ----------------
function placeholderLetter(c) { try { return (new URL(c.url).hostname.replace(/^www\./, "")[0] || "•").toUpperCase(); } catch { return (c.title || "•")[0].toUpperCase(); } }
// Small DOM helpers — cards are built without innerHTML so untrusted page text
// (titles, favicons) can never be interpreted as markup on this privileged page.
function elem(tag, className, props) { const e = document.createElement(tag); if (className) e.className = className; if (props) Object.assign(e, props); return e; }
function snapImg(url) { return elem("img", "snap", { src: url, alt: "", draggable: false }); }
// This new-tab page is a secure (moz-/chrome-extension:) context, so an http favicon gets
// auto-upgraded by the browser — which spams a "Upgrading insecure request" CSP warning per card.
// Request https ourselves so there's nothing to upgrade; if the host has no https icon the load
// fails and the existing onerror just hides it (same outcome the auto-upgrade would reach, quietly).
function httpsFavicon(url) { return url && url.startsWith("http://") ? "https://" + url.slice(7) : url; }
function buildCard(c, inHand) {
  const el = elem("div", "card"); el.dataset.id = c.cardId;
  if (!inHand) {
    el.style.left = c.x + "px"; el.style.top = c.y + "px"; el.style.transform = `rotate(${c.rot}deg)`; el.style.zIndex = c.z || 1;
    if (selection.has(c.cardId)) el.classList.add("selected");
    if (filter && !matches(c)) el.classList.add("dim");
  }
  const shot = elem("div", "shot");
  shot.append(c.shotUrl ? snapImg(c.shotUrl) : elem("div", "ph", { textContent: placeholderLetter(c) }));
  el.append(shot);
  if (c.favicon && S.showFavicons !== false) {   // favicon is a corner sticker so the caption can be all title (and it stays legible zoomed out)
    const fav = elem("img", "fav", { src: httpsFavicon(c.favicon), alt: "", draggable: false });
    fav.addEventListener("error", () => { fav.style.display = "none"; });   // inline onerror is blocked by the MV3 page CSP
    el.append(fav);
  }
  if (!inHand) el.append(elem("div", "status " + (c.state || "cold"), { title: c.state || "cold" }));
  const label = elem("div", "label");
  label.append(elem("span", "title", { textContent: c.title || "" }));
  el.append(label);
  if (!inHand) {
    el.append(elem("div", "note", { contentEditable: "true", spellcheck: false, textContent: c.note || "" }));
    el.append(elem("div", "close", { title: "close for good", textContent: "✕" }));
  }
  el.addEventListener("dragstart", (e) => e.preventDefault());   // never let the browser native-drag the screenshot
  return el;
}
function plainPaste(e) { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData("text/plain") || ""; document.execCommand("insertText", false, t); }

function renderCards() {
  cardsEl.replaceChildren();
  for (const c of state.cards.filter((c) => c.placed)) {
    const el = buildCard(c, false);
    const close = el.querySelector(".close");
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => { e.stopPropagation(); removeCards([c.cardId]); });
    const note = el.querySelector(".note");
    note.addEventListener("pointerdown", (e) => e.stopPropagation());
    note.addEventListener("paste", plainPaste);
    note.addEventListener("input", () => { if (!note.textContent.trim() && note.innerHTML) note.innerHTML = ""; });   // restore :empty → placeholder
    note.addEventListener("blur", () => { const v = note.innerText.trim(); if (!v) note.innerHTML = ""; if (c.note !== v) { c.note = v; persist(c); } });
    el.addEventListener("pointerdown", (e) => startCardDrag(e, c, el));
    el.addEventListener("dblclick", (e) => { if (!e.target.closest(".note") && !e.target.closest(".close")) openCard(c.cardId); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!selection.has(c.cardId)) selectOnly(c.cardId); openMenu(e.clientX, e.clientY, c); });
    el.addEventListener("pointerenter", () => scheduleUrlPop(el, c.url));
    el.addEventListener("pointerleave", hideUrlPop);
    cardsEl.appendChild(el);
  }
}

// ---------------- groups (incremental) ----------------
const groupViews = new Map();
let previewView = null;
const PREVIEW_SEED = 1337;
function createGroupView(g) {
  const wrap = document.createElementNS(SVGNS, "g"); wrap.setAttribute("class", "group-wrap");
  const p1 = document.createElementNS(SVGNS, "path"), p2 = document.createElementNS(SVGNS, "path");
  wrap.append(p1, p2); pathsEl.appendChild(wrap);
  const label = document.createElement("div"); label.className = "group-label";
  const name = document.createElement("span"); name.className = "gname"; name.contentEditable = "true"; name.spellcheck = false; name.textContent = g.name;
  label.append(name); labelsEl.appendChild(label);
  name.addEventListener("pointerdown", (e) => e.stopPropagation());
  name.addEventListener("paste", plainPaste);
  name.addEventListener("input", () => { if (!name.textContent.trim() && name.innerHTML) name.innerHTML = ""; });
  name.addEventListener("blur", () => {
    // loadAll() rebuilds state.groups with fresh objects on every CHANGED broadcast, so the
    // captured `g` may be orphaned — write to the object renderGroups actually reads, by id.
    const grp = state.groups.find((x) => x.id === g.id) || g;
    const txt = name.textContent.trim();
    const mem = membersOf(grp.id);
    const auto = mem.length === 1 && mem[0] ? mem[0].title : "";   // lone card's auto-title
    const v = txt === auto ? "" : txt;          // leaving the auto-title unchanged keeps it auto; a real edit sticks
    if (v !== grp.name) { grp.name = v; saveGroup(grp); }
  });
  wrap.style.opacity = "0"; label.style.opacity = "0";
  requestAnimationFrame(() => { wrap.style.opacity = "1"; label.style.opacity = "1"; });
  const v = { wrap, paths: [p1, p2], label, name, anchor: null };
  groupViews.set(g.id, v); return v;
}
function placeLabel(v) { if (!v.anchor) return; const s = worldToScreen(v.anchor.x, v.anchor.y); v.label.style.left = s.x + "px"; v.label.style.top = s.y + "px"; }
function positionLabels() { for (const v of groupViews.values()) placeLabel(v); }
function renderGroups() {
  const visible = new Set();
  for (const g of state.groups) {
    const mem = membersOf(g.id);
    if (mem.length < (S.soloGroups ? 1 : 2)) continue;
    visible.add(g.id);
    const outline = groupOutline(mem.map(rectOf), GROUP_PAD);
    const ds = chalkPaths(outline.map((p) => ({ x: p.x + OFF, y: p.y + OFF })), g.seed);
    const v = groupViews.get(g.id) || createGroupView(g);
    v.outline = outline;                                   // world-space points, for outline hit-testing
    v.paths.forEach((p, i) => p.setAttribute("d", ds[i] || ds[0]));
    const bb = bbox(outline); v.anchor = { x: (bb.minX + bb.maxX) / 2, y: bb.minY + 8 }; placeLabel(v);
    const labelText = g.name || (mem.length === 1 ? mem[0].title : "");   // lone card → show its title (stays readable zoomed out)
    if (document.activeElement !== v.name && v.name.textContent !== labelText) v.name.textContent = labelText;
  }
  for (const [gid, v] of [...groupViews]) if (!visible.has(gid)) { v.wrap.remove(); v.label.remove(); groupViews.delete(gid); }
}
function showPreview(cards) {
  const outline = groupOutline(cards.map(rectOf), GROUP_PAD);
  const ds = chalkPaths(outline.map((p) => ({ x: p.x + OFF, y: p.y + OFF })), PREVIEW_SEED);
  if (!previewView) {
    const wrap = document.createElementNS(SVGNS, "g"); wrap.setAttribute("class", "group-wrap preview");
    const p1 = document.createElementNS(SVGNS, "path"), p2 = document.createElementNS(SVGNS, "path");
    wrap.append(p1, p2); pathsEl.appendChild(wrap); previewView = { wrap, paths: [p1, p2] };
  }
  previewView.paths.forEach((p, i) => p.setAttribute("d", ds[i] || ds[0]));
}
function hidePreview() { if (previewView) { previewView.wrap.remove(); previewView = null; } }

// Ghost card(s) docked in the hand while a drag hovers the hand area — the predicted resting
// place, the hand-bound analogue of the dashed group preview.
function showHandPreview(cards) {
  const want = new Set(cards.map((c) => c.cardId));
  for (const g of [...handEl.querySelectorAll(".ghost")]) if (!want.has(g.dataset.id)) g.remove();
  for (const c of cards) {
    if (handEl.querySelector(`.ghost[data-id="${c.cardId}"]`)) continue;
    const el = buildCard(c, true); el.classList.add("ghost"); handEl.appendChild(el);
  }
  layoutHand();
}
function hideHandPreview() { const g = handEl.querySelectorAll(".ghost"); if (g.length) { g.forEach((e) => e.remove()); layoutHand(); } }

// ---------------- hand ----------------
// Fan layout is recomputed from the live DOM children so transient ghost previews re-fan with
// the rest. Each card's resting transform is stashed on `el._fan` for the hover effect to read.
let handHovered = null;
function layoutHand() {
  const cards = [...handEl.children]; const n = cards.length;
  cards.forEach((el, i) => {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    el._fan = `rotate(${t * 16}deg) translateY(${Math.abs(t) * 26}px)`;
    if (!el.classList.contains("dragging") && el !== handHovered) el.style.transform = el._fan;
  });
}
function handHover(el) {
  handHovered = el;
  const cards = [...handEl.children]; const hi = el ? cards.indexOf(el) : -1;
  const SPREAD = HAND_W / 4, LIFT = 47;                   // lift on hover; neighbours slide out a quarter-width
  cards.forEach((it, k) => {
    if (it.classList.contains("dragging")) return;
    if (hi < 0) it.style.transform = it._fan;                                     // rest
    else if (k === hi) it.style.transform = `translateY(-${LIFT}px) scale(1.12)`;
    else it.style.transform = `translateX(${k < hi ? -SPREAD : SPREAD}px) ${it._fan}`;   // slide away from the hovered card
  });
}
function renderHand() {
  handHovered = null;
  handEl.replaceChildren();
  for (const c of handCards()) {
    const el = buildCard(c, true);
    el.addEventListener("pointerenter", () => { handHover(el); scheduleUrlPop(el, c.url); });
    el.addEventListener("pointerleave", () => { handHover(null); hideUrlPop(); });
    el.addEventListener("pointerdown", (e) => startHandDrag(e, c, el));
    el.addEventListener("dblclick", () => openCard(c.cardId));
    handEl.appendChild(el);
  }
  layoutHand();
}

function render() { applyView(); renderGroups(); renderCards(); renderHand(); updateChrome(); }
function updateChrome() {
  const total = state.cards.length;
  countEl.textContent = total ? `${total} card${total === 1 ? "" : "s"}` : "";
  emptyEl.classList.toggle("show", total === 0);
}

// ---------------- grouping logic (hysteresis + preview) ----------------
function liveGroup(c) {
  const center = centerOf(c);
  if (c.group) {
    const others = membersOf(c.group).filter((m) => m.cardId !== c.cardId);
    if (others.length >= 1 && pointInPolygon(center, groupOutline(others.map(rectOf), REMOVE_PAD))) return c.group;
  }
  for (const g of state.groups) {
    if (g.id === c.group) continue;
    const mem = membersOf(g.id).filter((m) => m.cardId !== c.cardId);
    if (mem.length >= 1 && pointInPolygon(center, groupOutline(mem.map(rectOf), ADD_PAD))) return g.id;
  }
  return null;
}
function newGroupPartner(c) {
  const center = centerOf(c); let best = null, bestD = Infinity;
  for (const o of placed()) {
    if (o.cardId === c.cardId || o.group) continue;
    const d = dist(centerOf(o), center);
    if ((overlaps(c, o) || d < NEW_GROUP_DIST) && d < bestD) { best = o; bestD = d; }
  }
  return best;
}
function finalizeGroup(c) {
  const g = liveGroup(c);
  if (g) { c.group = g; pruneGroups(); return; }              // joins the target's group, keeping its name
  if (S.soloGroups) { c.group = ensureSoloGroup(c); pruneGroups(); return; }
  const partner = newGroupPartner(c);
  if (partner) {
    const ng = { id: "g-" + CT.uuid(), name: "new group", seed: hashStr(c.cardId + partner.cardId) };
    state.groups.push(ng); saveGroup(ng);
    partner.group = ng.id; c.group = ng.id; persist(partner); pruneGroups(); return;
  }
  c.group = null; pruneGroups();
}
function pruneGroups() {
  const min = S.soloGroups ? 1 : 2;
  state.groups = state.groups.filter((g) => {
    const m = state.cards.filter((c) => c.group === g.id);
    if (m.length < min) { if (!S.soloGroups) m.forEach((c) => { c.group = null; persist(c); }); delGroupRec(g.id); return false; }
    return true;
  });
}
// A lone card's own 1-member group (reused if it already has one). Powers "outline around lone cards".
function ensureSoloGroup(c) {
  if (c.group) { const m = membersOf(c.group); if (m.length === 1 && m[0].cardId === c.cardId) return c.group; }
  // Derive the id from the card (not a random uuid) so two open canvas tabs both ensuring the same
  // lone card converge on ONE record via upsert instead of each writing a duplicate orphan group.
  const id = "solo-" + c.cardId;
  if (!state.groups.some((g) => g.id === id)) { const ng = { id, name: "", seed: hashStr(c.cardId) }; state.groups.push(ng); saveGroup(ng); }
  c.group = id; persist(c);
  return id;
}
function ensureGroups() {
  if (S.soloGroups) { for (const c of state.cards) if (c.placed && !c.group) ensureSoloGroup(c); }
  else pruneGroups();
}

// ---------------- selection ----------------
function selectOnly(id) { selection.clear(); selection.add(id); reflectSelection(); }
function toggleSel(id) { selection.has(id) ? selection.delete(id) : selection.add(id); reflectSelection(); }
function clearSel() { if (selection.size) { selection.clear(); reflectSelection(); } }
function reflectSelection() { cardsEl.querySelectorAll(".card").forEach((el) => el.classList.toggle("selected", selection.has(el.dataset.id))); }

// ---------------- interaction lifecycle (RAII, replaces the old `busy` boolean) ----------------
// A pointer drag owns an AbortController; every listener it adds uses {signal}, so one abort()
// removes them all. endGesture() is idempotent and is the ONLY teardown path — reached via the
// drag's own pointerup/pointercancel, the lostpointercapture safety net, a tab-hide, or the
// defensive call below. There is no flag to forget, so the interaction state cannot latch.
function beginGesture(el, pointerId, onTeardown) {
  endGesture();                                   // never nest: close any prior gesture first
  const ac = new AbortController();
  const g = { el, pointerId, ac, onTeardown };
  activeGesture = g;
  el.addEventListener("lostpointercapture", () => {        // safety net: capture yanked without an up/cancel
    if (activeGesture !== g) return;                        // the normal terminal already handled it
    endGesture(); render(); drainPending();
  }, { signal: ac.signal });
  try { el.setPointerCapture(pointerId); } catch (e) {}
  return ac.signal;
}
function endGesture() {                            // teardown only — never renders or drains
  const g = activeGesture;
  if (!g) return;
  activeGesture = null;                            // null FIRST so re-entrant calls (via abort) no-op
  try { g.onTeardown && g.onTeardown(); }          // gesture-specific visual cleanup
  finally {
    try { g.el.releasePointerCapture(g.pointerId); } catch (e) {}
    g.ac.abort();                                  // removes every listener registered with this signal
  }
}
// Async critical sections (e.g. removeCards) hold a lease for the function's scope; try/finally
// guarantees release on return AND on throw — the scope-bound RAII analogue of the pointer gesture.
async function withInteraction(fn) {
  criticalDepth++;
  try { return await fn(); }
  finally { criticalDepth--; drainPending(); }
}
// Run a reload that was deferred while interacting — but only once we're fully idle.
function drainPending() {
  if (isInteracting() || !pendingReload) return;
  pendingReload = false;
  scheduleReload();
}

// ---------------- card dragging (select / move / open) ----------------
function bumpZ(c, el) { c.z = ++state.zmax; if (el) el.style.zIndex = c.z; persist(c); }
function startCardDrag(e, c, el) {
  if (e.button !== 0) return;
  e.stopPropagation();
  closeMenu(); hideUrlPop();
  bumpZ(c, el);
  const multi = (e.shiftKey || e.ctrlKey || e.metaKey);
  if (multi) toggleSel(c.cardId);
  else if (!selection.has(c.cardId)) selectOnly(c.cardId);
  const movingMany = selection.size > 1 && selection.has(c.cardId);
  const group = movingMany ? state.cards.filter((k) => selection.has(k.cardId)) : [c];
  const starts = group.map((k) => ({ k, x: k.x, y: k.y }));
  const start = toWorld(e.clientX, e.clientY);
  const downX = e.clientX, downY = e.clientY; let moved = false;
  el.classList.add("dragging");
  const signal = beginGesture(el, e.pointerId, () => { el.classList.remove("dragging"); clearZones(); hidePreview(); });

  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) { moved = true; hideUrlPop(); }
    const w = toWorld(ev.clientX, ev.clientY);
    const dx = w.x - start.x, dy = w.y - start.y;
    for (const s of starts) {
      s.k.x = s.x + dx; s.k.y = s.y + dy;
      const ke = cardsEl.querySelector(`[data-id="${s.k.cardId}"]`);
      if (ke) { ke.style.left = s.k.x + "px"; ke.style.top = s.k.y + "px"; }
    }
    if (overHand(ev.clientX, ev.clientY)) { hidePreview(); showHandPreview(group); }   // headed for the hand → show it docking there
    else {
      hideHandPreview();
      if (!movingMany) {
        if (S.soloGroups) { c.group = liveGroup(c) || ensureSoloGroup(c); hidePreview(); }   // outline always follows the lone card
        else {
          c.group = liveGroup(c);
          if (c.group) hidePreview();
          else { const p = newGroupPartner(c); p ? showPreview([c, p]) : hidePreview(); }
        }
      }
    }
    renderGroups();
    hotZones(ev.clientX, ev.clientY);
  };
  const finish = (ev) => {
    const wasMoved = moved, cancel = ev.type === "pointercancel";
    endGesture();                                                // teardown (capture, listeners, dragging class, zones, preview)
    try {
      if (cancel) {   // tab hidden mid-drag (e.g. a card opened a page): no real drop — commit positions, never trash/hand
        if (wasMoved) { if (!movingMany) finalizeGroup(c); group.forEach((k) => persist(k)); }
        render();
      } else if (wasMoved) {
        if (overTrash(ev.clientX, ev.clientY)) removeCards(group.map((k) => k.cardId));
        else if (overHand(ev.clientX, ev.clientY)) { group.forEach((k) => { k.placed = false; k.group = null; persist(k); }); pruneGroups(); render(); }
        else { pushUndoLayouts(group.map((k) => k.cardId), "Move"); if (!movingMany) finalizeGroup(c); group.forEach((k) => persist(k)); render(); }
      }   // (!cancel && !wasMoved) → a click: selection already handled, nothing to commit
    } finally { drainPending(); }
  };
  el.addEventListener("pointermove", move, { signal });
  el.addEventListener("pointerup", finish, { signal });
  el.addEventListener("pointercancel", finish, { signal });
}

// ---------------- group dragging ----------------
function startGroupDrag(e, g) {                       // initiated by pressing on/near the outline (no grip)
  e.stopPropagation(); closeMenu(); setNear(null);
  const start = toWorld(e.clientX, e.clientY);
  const orig = membersOf(g.id).map((c) => ({ c, x: c.x, y: c.y }));
  const signal = beginGesture(tableEl, e.pointerId, () => { tableEl.style.cursor = ""; });
  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY); const dx = w.x - start.x, dy = w.y - start.y;
    for (const o of orig) {
      o.c.x = o.x + dx; o.c.y = o.y + dy;
      const el = cardsEl.querySelector(`[data-id="${o.c.cardId}"]`);
      if (el) { el.style.left = o.c.x + "px"; el.style.top = o.c.y + "px"; }
    }
    renderGroups();
  };
  const finish = () => { endGesture(); try { orig.forEach((o) => persist(o.c)); render(); } finally { drainPending(); } };
  tableEl.addEventListener("pointermove", move, { signal });
  tableEl.addEventListener("pointerup", finish, { signal });
  tableEl.addEventListener("pointercancel", finish, { signal });
}

// --- group-by-outline: zoom-aware hit-test of the pointer against group outlines ---
function distSeg(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y, wx = p.x - a.x, wy = p.y - a.y;
  const c1 = vx * wx + vy * wy; if (c1 <= 0) return Math.hypot(wx, wy);
  const c2 = vx * vx + vy * vy; if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
  const t = c1 / c2; return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}
function nearestGroupOutline(world) {
  const thresh = 16 / state.view.zoom;               // ~16px on screen regardless of zoom
  let best = null, bestD = thresh;
  for (const [gid, v] of groupViews) {
    if (!v.outline) continue;
    let d = Infinity;
    for (let i = 0; i < v.outline.length; i++) { const dd = distSeg(world, v.outline[i], v.outline[(i + 1) % v.outline.length]); if (dd < d) d = dd; }
    if (d < bestD) { bestD = d; best = gid; }
  }
  return best ? state.groups.find((g) => g.id === best) : null;
}
function setNear(gid) {
  if (near === gid) return;
  const prev = near && groupViews.get(near); if (prev) prev.wrap.classList.remove("near");
  near = gid;
  const cur = near && groupViews.get(near); if (cur) cur.wrap.classList.add("near");
  tableEl.style.cursor = near ? "move" : "";
}
let hoverRAF = null, hoverEv = null;
tableEl.addEventListener("pointermove", (e) => {
  hoverEv = e; if (hoverRAF) return;
  hoverRAF = requestAnimationFrame(() => {
    hoverRAF = null;
    if (isInteracting() || tableEl.classList.contains("panning")) return;
    if (hoverEv.target.closest(".card") || hoverEv.target.closest(".group-label")) { setNear(null); return; }
    const g = nearestGroupOutline(toWorld(hoverEv.clientX, hoverEv.clientY));
    setNear(g ? g.id : null);
  });
});

// ---------------- hand dragging ----------------
// A press alone must NOT move the card (so a click just rests, and a double-click can open) — the
// floater is only spawned once the pointer travels past a small threshold, i.e. a genuine drag.
function startHandDrag(e, c, el) {
  if (e.button !== 0) return;
  const downX = e.clientX, downY = e.clientY;
  let floater = null, moved = false;
  // capture up front so even a fast flick lands its first move (capture doesn't change click/dblclick target)
  const signal = beginGesture(el, e.pointerId, () => {
    clearZones(); hidePreview();
    if (floater) floater.remove();
    el.style.visibility = "";
  });
  const begin = () => {
    moved = true; hideUrlPop(); handHover(null);
    bumpZ(c);
    floater = buildCard(c, false); floater.classList.add("dragging");
    floater.style.transform = "rotate(0deg)"; cardsEl.appendChild(floater);
    el.style.visibility = "hidden";   // hide the resting hand card; the floater stands in for it
  };
  const move = (ev) => {
    if (!moved) { if (Math.hypot(ev.clientX - downX, ev.clientY - downY) <= 5) return; begin(); }
    const w = toWorld(ev.clientX, ev.clientY); c.x = w.x - CARD_W / 2; c.y = w.y - CARD_H / 2;
    floater.style.left = c.x + "px"; floater.style.top = c.y + "px";
    if (overHand(ev.clientX, ev.clientY)) { hidePreview(); }   // returning to the hand → the dashed receiving box is the cue (it already has a slot here)
    else {
      const g = liveGroup(c);
      if (g) showPreview(membersOf(g).concat(c));
      else { const p = newGroupPartner(c); p ? showPreview([c, p]) : hidePreview(); }
    }
    hotZones(ev.clientX, ev.clientY);
  };
  const finish = (ev) => {
    const wasMoved = moved, cancel = ev.type === "pointercancel";
    endGesture();                                                // teardown (capture, listeners, floater, zones, preview)
    try {
      if (!wasMoved) { /* a click (or the first of a double-click): leave it in the hand */ }
      else if (cancel) render();                                 // canceled → card stays in the hand (never placed)
      else if (overTrash(ev.clientX, ev.clientY)) removeCards([c.cardId]);
      else if (overHand(ev.clientX, ev.clientY)) render();       // stays in hand
      else { c.placed = true; finalizeGroup(c); persist(c); render(); }
    } finally { drainPending(); }
  };
  el.addEventListener("pointermove", move, { signal });
  el.addEventListener("pointerup", finish, { signal });
  el.addEventListener("pointercancel", finish, { signal });
}

// ---------------- drop zones ----------------
function overTrash(x, y) { const r = trashEl.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
// The hand's real footprint (centered, sized to the resting cards) — you must aim INTO it, not just
// graze the bottom edge. Width comes from the live hand count (not getBoundingClientRect) so the
// ghost preview, which transiently widens #hand, can't feed back into the hit-test and cause flicker.
function handDropRect() {
  const n = handCards().length;
  const w = n ? HAND_W + (n - 1) * HAND_STEP : 0;
  const halfW = Math.max(w, 260) / 2 + 56;
  const cx = innerWidth / 2;
  return { left: cx - halfW, right: cx + halfW, top: innerHeight - HAND_ZONE_H, bottom: innerHeight + 60 };
}
function overHand(x, y) { const r = handDropRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
function hotZones(x, y) { const t = overTrash(x, y); trashEl.classList.toggle("hot", t); handEl.classList.toggle("receiving", !t && overHand(x, y)); }
function clearZones() { trashEl.classList.remove("hot"); handEl.classList.remove("receiving"); hideHandPreview(); }

// ---------------- commands ----------------
function openCard(id) { send({ type: CT.MSG.OPEN, cardId: id }); }
async function removeCards(ids) {
  hideUrlPop();   // the hovered card is about to vanish without a pointerleave
  await withInteraction(async () => {
    // Snapshot for undo while the records still exist in the DB.
    const snaps = [];
    for (const id of ids) {
      if (!card(id)) continue;
      const tabRec = await DBP.get(CT.STORES.tabs, id).catch(() => null);
      const layRec = await DBP.get(CT.STORES.layout, id).catch(() => null);
      snaps.push({ tabRec, layRec });
    }
    // Drop the cards from in-memory state and re-render *before* the async DB round-trip. The card and
    // any group outline it anchored then disappear together in one frame: renderGroups() retires the
    // view of a group whose last member just left. The interaction lease also defers any external
    // CHANGED reload until we exit (then drains it), so nothing can redraw the now-orphaned outline —
    // that race was the "ghost" that hung around until the next drag.
    const idset = new Set(ids);
    state.cards = state.cards.filter((c) => !idset.has(c.cardId));
    for (const id of ids) {
      selection.delete(id);
      const u = shotUrls.get(id); if (u) { URL.revokeObjectURL(u); shotUrls.delete(id); }
    }
    render();
    // Now make the deletion durable.
    for (const id of ids) {
      await send({ type: CT.MSG.DELETE, cardId: id });
      await DBP.del(CT.STORES.layout, id).catch(() => {});
    }
    pushUndo(`Closed ${ids.length} card${ids.length === 1 ? "" : "s"}`, async () => {
      for (const s of snaps) {
        if (s.tabRec) { s.tabRec.tabId = null; s.tabRec.state = "cold"; await DBP.put(CT.STORES.tabs, s.tabRec).catch(() => {}); }
        if (s.layRec) await DBP.put(CT.STORES.layout, s.layRec).catch(() => {});
      }
      await loadAll(); render();
    });
    await loadAll(); render();   // reconcile; the lease keeps external reloads deferred until we return
  });
}

// ---------------- undo ----------------
const undoStack = [];
function pushUndo(label, fn) { undoStack.push({ label, fn }); if (undoStack.length > 50) undoStack.shift(); showToast(label, true); }
async function pushUndoLayouts(ids, label) {
  const snaps = [];
  for (const id of ids) { const l = await DBP.get(CT.STORES.layout, id).catch(() => null); if (l) snaps.push(l); }
  undoStack.push({ label, fn: async () => { for (const l of snaps) await DBP.put(CT.STORES.layout, l).catch(() => {}); await loadAll(); render(); } });
  if (undoStack.length > 50) undoStack.shift();
}
async function undo() { const e = undoStack.pop(); if (!e) return; hideToast(); await e.fn(); }

// ---------------- toast ----------------
let toastT = null;
function showToast(msg, withUndo) {
  $("toast-msg").textContent = msg;
  $("toast-undo").style.display = withUndo ? "" : "none";
  toastEl.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(hideToast, 6000);
}
function hideToast() { toastEl.classList.remove("show"); }

// ---------------- url hover popup ----------------
const urlPopEl = $("urlpop");
let urlPopT = null;
function scheduleUrlPop(el, url) {
  clearTimeout(urlPopT);
  if (isInteracting() || !url) return;
  urlPopT = setTimeout(() => {
    if (isInteracting()) return;
    urlPopEl.textContent = url;
    urlPopEl.style.display = "block";                 // display first so offsetWidth/Height measure
    urlPopEl.classList.add("show");
    const r = el.getBoundingClientRect();
    let left = r.left + r.width / 2 - urlPopEl.offsetWidth / 2;
    left = Math.max(8, Math.min(left, innerWidth - urlPopEl.offsetWidth - 8));
    let top = r.top - urlPopEl.offsetHeight - 8;
    if (top < 8) top = r.bottom + 8;                  // no room above (e.g. a hand card) → drop below
    urlPopEl.style.left = left + "px"; urlPopEl.style.top = top + "px";
  }, 320);
}
function hideUrlPop() { clearTimeout(urlPopT); urlPopEl.classList.remove("show"); urlPopEl.style.display = "none"; }

// ---------------- context menu ----------------
function openMenu(x, y, c) {
  const ids = selection.size ? [...selection] : (c ? [c.cardId] : []);
  const items = [];
  if (c) {
    items.push(["Open", () => openCard(c.cardId)]);
    items.push(["Open in new window", async () => { const t = await send({ type: CT.MSG.CREATE_TAB, url: c.url, active: true }); }]);
    items.push(["Copy URL", () => navigator.clipboard && navigator.clipboard.writeText(c.url)]);
    items.push(["Send to hand", () => { ids.forEach((id) => { const k = card(id); if (k) { k.placed = false; k.group = null; persist(k); } }); pruneGroups(); render(); }]);
    items.push(["sep"]);
    items.push([`Close ${ids.length > 1 ? ids.length + " cards" : "card"}`, () => removeCards(ids), true]);
  } else {
    items.push(["Fit all", fit]);
    items.push(["Settings", openSettings]);
  }
  menuEl.replaceChildren();
  for (const it of items) {
    if (it[0] === "sep") { const s = document.createElement("div"); s.className = "sep"; menuEl.appendChild(s); continue; }
    const d = document.createElement("div"); d.className = "item" + (it[2] ? " danger" : ""); d.textContent = it[0];
    d.addEventListener("click", () => { closeMenu(); it[1](); });
    menuEl.appendChild(d);
  }
  menuEl.classList.add("open");
  menuEl.style.left = Math.min(x, innerWidth - menuEl.offsetWidth - 10) + "px";
  menuEl.style.top = Math.min(y, innerHeight - menuEl.offsetHeight - 10) + "px";
}
function closeMenu() { menuEl.classList.remove("open"); }

// ---------------- pan / zoom / canvas ----------------
tableEl.addEventListener("pointerdown", (e) => {
  closeMenu(); hideUrlPop();
  if (e.button !== 0 || e.target.closest(".card") || e.target.closest(".group-label")) return;
  const gNear = nearestGroupOutline(toWorld(e.clientX, e.clientY));
  if (gNear) { startGroupDrag(e, gNear); return; }     // press on/near an outline grabs the group
  clearSel();
  tableEl.classList.add("panning"); tableEl.setPointerCapture(e.pointerId);
  const sx = e.clientX, sy = e.clientY, ox = state.view.x, oy = state.view.y;
  const move = (ev) => { state.view.x = ox + (ev.clientX - sx); state.view.y = oy + (ev.clientY - sy); applyView(); };
  const up = () => { tableEl.classList.remove("panning"); tableEl.removeEventListener("pointermove", move); tableEl.removeEventListener("pointerup", up); saveView(); };
  tableEl.addEventListener("pointermove", move); tableEl.addEventListener("pointerup", up);
});
tableEl.addEventListener("contextmenu", (e) => { if (e.target.closest(".card")) return; e.preventDefault(); openMenu(e.clientX, e.clientY, null); });
tableEl.addEventListener("wheel", (e) => {
  e.preventDefault(); hideUrlPop();
  const z = Math.max(0.2, Math.min(3, state.view.zoom * Math.exp(-e.deltaY * 0.0015)));
  const w = toWorld(e.clientX, e.clientY);
  state.view.x = e.clientX - w.x * z; state.view.y = e.clientY - w.y * z; state.view.zoom = z;
  applyView(); saveView();
}, { passive: false });

function fit() {
  const ps = state.cards.filter((c) => c.placed); if (!ps.length) return;
  const bb = bbox(ps.flatMap((c) => [{ x: c.x, y: c.y }, { x: c.x + CARD_W, y: c.y + CARD_H }]));
  const pad = 120, vw = innerWidth, vh = innerHeight - 160;
  const z = Math.max(0.2, Math.min(1.5, Math.min(vw / (bb.maxX - bb.minX + pad * 2), vh / (bb.maxY - bb.minY + pad * 2))));
  state.view.zoom = z; state.view.x = (vw - (bb.minX + bb.maxX) * z) / 2; state.view.y = (vh - (bb.minY + bb.maxY) * z) / 2;
  applyView(); saveView();
}

// ---------------- keyboard ----------------
window.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === "/" && !typing) { e.preventDefault(); searchEl.focus(); return; }
  if (typing) { if (e.key === "Escape") e.target.blur(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selection.size) { e.preventDefault(); removeCards([...selection]); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if (e.key.toLowerCase() === "f") fit();
  else if (e.key === "Enter" && selection.size === 1) openCard([...selection][0]);
  else if (e.key === "Escape") { clearSel(); closeMenu(); }
});

// ---------------- search ----------------
let searchT = null;
searchEl.addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(() => { filter = searchEl.value.trim(); renderCards(); renderGroups(); }, 120); });

// ---------------- settings overlay ----------------
// A broad, OS-fallback-stacked font catalogue grouped by feel. Values are full font-family stacks
// (stored verbatim in settings); each <option> is rendered in its own font so the menu self-previews.
const FONTS = [
  // Packaged with the extension (see newtab.css @font-face) — these always render, on every OS.
  ["Bundled", [
    ["Caveat", '"Caveat","Bradley Hand","Segoe Print","Comic Sans MS",cursive'],
    ["Permanent Marker", '"Permanent Marker","Marker Felt","Comic Sans MS",cursive'],
  ]],
  ["Handwriting", [
    ["Bradley Hand", '"Bradley Hand","Segoe Print",cursive'],
    ["Segoe Print", '"Segoe Print","Bradley Hand",cursive'],
    ["Ink Free", '"Ink Free","Segoe Print",cursive'],
    ["Marker Felt", '"Marker Felt","Comic Sans MS",cursive'],
    ["Chalkboard", '"Chalkboard SE","Chalkboard","Comic Sans MS",cursive'],
    ["Comic", '"Comic Sans MS","Comic Neue",cursive'],
    ["Brush Script", '"Brush Script MT","Segoe Script",cursive'],
  ]],
  ["Sans-serif", [
    ["System UI", 'ui-sans-serif,system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'],
    ["Helvetica / Arial", 'Helvetica,Arial,"Helvetica Neue",sans-serif'],
    ["Segoe UI", '"Segoe UI",system-ui,sans-serif'],
    ["Verdana", 'Verdana,Geneva,sans-serif'],
    ["Tahoma", 'Tahoma,Geneva,sans-serif'],
    ["Trebuchet MS", '"Trebuchet MS",ui-rounded,"Segoe UI",sans-serif'],
    ["Calibri", 'Calibri,"Segoe UI",sans-serif'],
    ["Gill Sans", '"Gill Sans","Gill Sans MT",Calibri,sans-serif'],
    ["Futura", 'Futura,"Trebuchet MS",sans-serif'],
    ["Avenir", 'Avenir,"Avenir Next",Montserrat,sans-serif'],
    ["Optima", 'Optima,Candara,"Segoe UI",sans-serif'],
  ]],
  ["Serif", [
    ["Georgia", 'Georgia,"Times New Roman",serif'],
    ["Times New Roman", '"Times New Roman",Times,serif'],
    ["Garamond", 'Garamond,"EB Garamond",Georgia,serif'],
    ["Palatino", '"Palatino Linotype",Palatino,"Book Antiqua",serif'],
    ["Cambria", 'Cambria,Georgia,serif'],
    ["Baskerville", 'Baskerville,"Baskerville Old Face",Georgia,serif'],
    ["Didot", 'Didot,"Bodoni MT",Georgia,serif'],
  ]],
  ["Monospace", [
    ["System Mono", 'ui-monospace,"Cascadia Code","SF Mono",Consolas,monospace'],
    ["Consolas", 'Consolas,"Cascadia Code",monospace'],
    ["Courier", '"Courier New",Courier,monospace'],
    ["Menlo / Monaco", 'Menlo,Monaco,Consolas,monospace'],
  ]],
  ["Display", [
    ["Impact", 'Impact,Haettenschweiler,"Arial Narrow Bold",sans-serif'],
    ["Copperplate", 'Copperplate,"Copperplate Gothic Light",serif'],
    ["Bahnschrift", 'Bahnschrift,"DIN Alternate","Segoe UI",sans-serif'],
    ["Papyrus", 'Papyrus,fantasy'],
  ]],
];
// Only offer fonts the system can actually render. An option whose primary family isn't installed
// would silently fall back to a generic — and since every absent handwriting font collapses to the
// same `cursive`, the picker looks inert (you change the font and nothing moves). We probe each
// option's primary family with the canvas-metrics trick: a family that resolves to something other
// than the generic baseline is installed. Bundled families always render (skip the probe, and the
// async webfont load can't race us); generic-led stacks (System UI/Mono) are the OS default.
const STACK_LABEL = new Map();
for (const [, fonts] of FONTS) for (const [label, stack] of fonts) STACK_LABEL.set(stack, label);
const BUNDLED_FAMILIES = new Set(["Caveat", "Permanent Marker"]);
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy",
  "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded", "math", "emoji"]);
const _fontCtx = document.createElement("canvas").getContext("2d");
const _fontProbe = "mmmmmmmmmmlli WwQg019", _fontPx = "72px", _fontBases = ["monospace", "serif", "sans-serif"];
const _fontAvail = new Map();
let _fontBaseW = null;
function fontInstalled(family) {
  if (_fontAvail.has(family)) return _fontAvail.get(family);
  if (!_fontBaseW) { _fontBaseW = {}; for (const b of _fontBases) { _fontCtx.font = `${_fontPx} ${b}`; _fontBaseW[b] = _fontCtx.measureText(_fontProbe).width; } }
  let ok = false;
  for (const b of _fontBases) { _fontCtx.font = `${_fontPx} "${family}",${b}`; if (_fontCtx.measureText(_fontProbe).width !== _fontBaseW[b]) { ok = true; break; } }
  _fontAvail.set(family, ok);
  return ok;
}
function stackAvailable(stack) {
  const first = stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (GENERIC_FAMILIES.has(first.toLowerCase()) || BUNDLED_FAMILIES.has(first)) return true;
  return fontInstalled(first);
}
function buildFontOptions(sel) {
  sel.replaceChildren();
  for (const [cat, fonts] of FONTS) {
    const avail = fonts.filter(([, stack]) => stackAvailable(stack));
    if (!avail.length) continue;   // whole category missing on this OS — drop the empty optgroup
    const og = document.createElement("optgroup"); og.label = cat;
    for (const [label, stack] of avail) {
      const o = document.createElement("option"); o.value = stack; o.textContent = label;
      o.style.fontFamily = stack; o.style.fontSize = "15px";
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
}
function setFontValue(sel, stack) {
  if (![...sel.options].some((o) => o.value === stack)) {   // current value was filtered out (not installed here), or an old/imported board's font
    const o = document.createElement("option"); o.value = stack; o.textContent = STACK_LABEL.get(stack) || "Custom"; o.style.fontFamily = stack; sel.appendChild(o);
  }
  sel.value = stack;
}
// Build the preview through the real card builder so it always matches actual cards. Sample data
// only; strip the note's contenteditable so the static preview can't be focused/typed into.
function buildPreviewCard() {
  let favicon = ""; try { favicon = X.runtime.getURL("icons/icon-48.png"); } catch (e) {}
  const el = buildCard({
    cardId: "preview", url: "https://example.com/your/page", title: "cardtable — your tabs as cards",
    favicon, state: "live", note: "drag me onto the felt", shotUrl: null, x: 0, y: 0, rot: 0, z: 1,
  }, false);
  el.id = "s-preview-card";
  const note = el.querySelector(".note"); if (note) note.removeAttribute("contenteditable");
  $("s-preview-stage").replaceChildren(el);
}
// Live preview card — reflects the unsaved control values so changes are visible before Save.
function updatePreview() {
  const card = $("s-preview-card"); if (!card) return;
  const cw = +$("s-cardw").value || CT.DEFAULTS.cardWidth;
  const size = +$("s-size").value || CT.DEFAULTS.labelSize;
  const lines = Math.max(1, Math.min(5, +$("s-titlelines").value || 1));
  const noteSize = +$("s-notesize").value || CT.DEFAULTS.noteSize;
  const groupSize = +$("s-groupsize").value || CT.DEFAULTS.groupSize;
  card.style.setProperty("--card-w", cw + "px");
  card.style.setProperty("--label-font", $("s-font").value || CT.DEFAULTS.labelFont);
  card.style.setProperty("--label-size", size + "px");
  card.style.setProperty("--title-lines", lines);
  card.style.setProperty("--note-font", $("s-notefont").value || CT.DEFAULTS.noteFont);
  card.style.setProperty("--note-size", noteSize + "px");
  card.style.transform = `scale(${Math.max(0.5, Math.min(1.08, 200 / cw))})`;   // stage flex-centres it
  const paper = $("s-theme").value === "paper", felt = $("s-felt").value || CT.DEFAULTS.feltColor;
  $("s-preview-frame").style.background = paper
    ? "radial-gradient(135% 135% at 50% -10%, #e9e6dc, #d8d4c6)"
    : `radial-gradient(135% 135% at 50% -10%, ${felt}, #181b21)`;   // #181b21 = --table-bg-2 default, matching the real table
  const glabel = $("s-preview-glabel");
  if (glabel) {
    glabel.textContent = "Group label";
    glabel.style.fontFamily = $("s-groupfont").value || CT.DEFAULTS.groupFont;
    glabel.style.fontSize = groupSize + "px";
    glabel.style.color = paper ? "#4a4a44" : "#eef2ef";   // chalk that contrasts the previewed felt
  }
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set("s-cardw-val", cw + "px"); set("s-size-val", size + "px");
  set("s-notesize-val", noteSize + "px"); set("s-groupsize-val", groupSize + "px");
  set("s-quality-val", (+$("s-quality").value).toFixed(2));
}
function wireSettings() {
  for (const id of ["s-theme", "s-felt", "s-cardw", "s-font", "s-size", "s-titlelines",
    "s-notefont", "s-notesize", "s-groupfont", "s-groupsize", "s-quality"]) {
    $(id).addEventListener("input", updatePreview);
  }
  $("s-guard").addEventListener("change", syncGuardDep);
}
// The known-hosts list is only meaningful when the guard is on; hide it otherwise so the (long,
// vaguely alarming) SSO list isn't the first thing a new user sees.
function syncGuardDep() {
  document.querySelector(".s-guard-dep").classList.toggle("hide", !$("s-guard").checked);
}
function openSettings() {
  buildFontOptions($("s-font")); buildFontOptions($("s-notefont")); buildFontOptions($("s-groupfont"));
  $("s-theme").value = S.theme; $("s-felt").value = S.feltColor; $("s-cardw").value = S.cardWidth;
  setFontValue($("s-font"), S.labelFont || CT.DEFAULTS.labelFont);
  setFontValue($("s-notefont"), S.noteFont || CT.DEFAULTS.noteFont);
  setFontValue($("s-groupfont"), S.groupFont || CT.DEFAULTS.groupFont);
  $("s-titlelines").value = S.titleLines || 1; $("s-size").value = S.labelSize || 18;
  $("s-notesize").value = S.noteSize || CT.DEFAULTS.noteSize; $("s-groupsize").value = S.groupSize || CT.DEFAULTS.groupSize;
  $("s-quality").value = S.shotQuality; $("s-maxlive").value = S.maxLiveTabs;
  $("s-hand").checked = S.handOnNewTab; $("s-solo").checked = S.soloGroups; $("s-guard").checked = S.deepLinkGuard; $("s-reduce").checked = S.reducedMotion;
  $("s-favicons").checked = S.showFavicons !== false;
  $("s-authhosts").value = (S.authHosts || []).join("\n");
  syncGuardDep();
  refreshPermUI();
  buildPreviewCard();
  updatePreview();
  $("settings").classList.add("open");
}
function closeSettings() { $("settings").classList.remove("open"); }
$("btn-settings").addEventListener("click", openSettings);
$("s-cancel").addEventListener("click", closeSettings);
$("settings").addEventListener("click", (e) => { if (e.target.id === "settings") closeSettings(); });
$("s-save").addEventListener("click", async () => {
  S.theme = $("s-theme").value; S.feltColor = $("s-felt").value || CT.DEFAULTS.feltColor;
  S.cardWidth = +$("s-cardw").value; S.labelFont = $("s-font").value || CT.DEFAULTS.labelFont;
  S.shotQuality = +$("s-quality").value; S.maxLiveTabs = Math.max(1, +$("s-maxlive").value || 1);
  S.titleLines = Math.max(1, Math.min(5, +$("s-titlelines").value || 1));
  S.labelSize = Math.max(11, Math.min(34, +$("s-size").value || 18));
  S.noteFont = $("s-notefont").value || CT.DEFAULTS.noteFont;
  S.noteSize = Math.max(9, Math.min(22, +$("s-notesize").value || CT.DEFAULTS.noteSize));
  S.groupFont = $("s-groupfont").value || CT.DEFAULTS.groupFont;
  S.groupSize = Math.max(14, Math.min(48, +$("s-groupsize").value || CT.DEFAULTS.groupSize));
  S.handOnNewTab = $("s-hand").checked; S.soloGroups = $("s-solo").checked; S.deepLinkGuard = $("s-guard").checked; S.reducedMotion = $("s-reduce").checked;
  S.showFavicons = $("s-favicons").checked;
  S.authHosts = $("s-authhosts").value.split("\n").map((s) => s.trim()).filter(Boolean);
  await saveSettings(); applyTheme(); ensureGroups(); closeSettings(); render();
});

// import / export
$("s-export").addEventListener("click", async () => {
  const [tabs, layout, groups, notes] = await Promise.all([DBP.all(CT.STORES.tabs), DBP.all(CT.STORES.layout), DBP.all(CT.STORES.groups), DBP.all(CT.STORES.notes)]);
  const data = { v: 1, exportedAt: new Date().toISOString(), settings: S, view: state.view, tabs: tabs.map((t) => ({ ...t, tabId: null, state: "cold" })), layout, groups, notes };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "cardtable-board.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("s-import").addEventListener("click", () => $("s-file").click());
$("s-file").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.settings) { S = { ...CT.DEFAULTS, ...data.settings }; await saveSettings(); }
    if (data.view) { state.view = data.view; await X.storage.local.set({ view: state.view }); }
    for (const t of data.tabs || []) await DBP.put(CT.STORES.tabs, { ...t, tabId: null, state: "cold" });
    for (const l of data.layout || []) await DBP.put(CT.STORES.layout, l);
    for (const g of data.groups || []) await DBP.put(CT.STORES.groups, g);
    for (const n of data.notes || []) await DBP.put(CT.STORES.notes, n);
    applyTheme(); await loadAll(); render(); closeSettings(); showToast("Board imported", false);
  } catch (err) { showToast("Import failed: " + err, false); }
  e.target.value = "";
});

// ---------------- toolbar + global ----------------
$("btn-fit").addEventListener("click", fit);
$("toast-undo").addEventListener("click", undo);
window.addEventListener("click", (e) => { if (!e.target.closest("#menu")) closeMenu(); });
// Capture phase (runs before card/group drag handlers): commit an open note/group-name edit
// the instant you press elsewhere, and clear any stray text selection.
document.addEventListener("pointerdown", (e) => {
  const a = document.activeElement;
  if (a && a.isContentEditable && !a.contains(e.target)) a.blur();   // fires blur → saves before any re-render
  if (!e.target.closest('[contenteditable="true"], input, textarea')) {
    const sel = window.getSelection(); if (sel && !sel.isCollapsed) sel.removeAllRanges();
  }
}, true);
window.addEventListener("resize", positionLabels);
window.addEventListener("beforeunload", () => { for (const u of shotUrls.values()) URL.revokeObjectURL(u); });

// ---------------- reactivity ----------------
let reloadT = null;
function scheduleReload() { if (isInteracting()) { pendingReload = true; return; } clearTimeout(reloadT); reloadT = setTimeout(async () => { await loadAll(); render(); }, 250); }
X.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === CT.MSG.CHANGED) scheduleReload();
  else if (msg.type === CT.MSG.SHOT) { loadShot(msg.cardId).then((u) => { if (!u || isInteracting()) return; const el = document.querySelector(`.card[data-id="${msg.cardId}"] .shot`); if (el) el.replaceChildren(snapImg(u)); }); }   // document-wide: also updates cards in the hand
});
// Settings can change in another canvas tab (or be imported elsewhere) — keep this tab's live copy,
// theme, and groups in sync. background.js has its own storage.onChanged; this is the page's.
X.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.settings) return;
  S = { ...CT.DEFAULTS, ...(ch.settings.newValue || {}) };
  applyTheme();        // immediate visual sync (theme / font / size / width)
  scheduleReload();    // membership-affecting changes (soloGroups) reconcile from fresh DB state, not stale in-memory groups
});
// Failsafe: a drag can't outlive the canvas tab being hidden (opening a card switches tabs). If a
// pointerup/pointercancel is ever missed, the gesture would otherwise stay open. Route the tab-hide
// through the same single teardown door (endGesture); on return, pull in anything that changed.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (activeGesture) { endGesture(); render(); drainPending(); } }
  else { pendingReload = false; scheduleReload(); }
});

// ---------------- host access (screenshots) ----------------
// Firefox MV3 treats manifest host_permissions as optional: on a fresh install <all_urls> is
// ungranted, so background's tabs.captureVisibleTab is absent and nothing is ever captured.
// permissions.request must run from a user gesture, so we offer a dismissible banner and a
// Settings button and grant from the click. Chrome grants <all_urls> at install, so contains()
// is true there and none of this UI ever appears.
const ALL_URLS = { origins: ["<all_urls>"] };
async function hostAccessGranted() {
  if (!X.permissions || !X.permissions.contains) return true;
  try { return await X.permissions.contains(ALL_URLS); } catch (e) { return true; }
}
async function refreshPermUI() {
  const granted = await hostAccessGranted();
  $("s-perm-row").classList.toggle("hide", granted);
  let dismissed = false;
  try { dismissed = !!(await X.storage.local.get("permBannerDismissed")).permBannerDismissed; } catch (e) {}
  $("perm-banner").classList.toggle("hide", granted || dismissed);
}
async function grantHostAccess() {
  let ok = false;
  try { ok = await X.permissions.request(ALL_URLS); } catch (e) {}
  if (ok) showToast("Screenshots enabled — thumbnails will appear as you browse.", false);
  await refreshPermUI();
}
$("perm-grant").addEventListener("click", grantHostAccess);
$("s-perm-grant").addEventListener("click", grantHostAccess);
$("perm-dismiss").addEventListener("click", async () => {
  $("perm-banner").classList.add("hide");
  try { await X.storage.local.set({ permBannerDismissed: true }); } catch (e) {}
});

// ---------------- boot ----------------
(async function boot() {
  wireSettings();
  await loadSettings();
  await loadAll();
  render();
  refreshPermUI();
})();
