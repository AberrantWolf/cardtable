import { groupOutline, chalkPaths, pointInPolygon, bbox, hashStr } from "./geometry.js";
import DBP from "./db.js";

const X = globalThis.browser || globalThis.chrome;
const OFF = 20000, SVGNS = "http://www.w3.org/2000/svg";
const GROUP_PAD = 50, ADD_PAD = 170, REMOVE_PAD = 300, NEW_GROUP_DIST = 340, HAND_ZONE_H = 150;

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
let busy = false, pendingReload = false;

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
async function loadAll() {
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
function buildCard(c, inHand) {
  const el = document.createElement("div");
  el.className = "card"; el.dataset.id = c.cardId;
  if (!inHand) {
    el.style.left = c.x + "px"; el.style.top = c.y + "px"; el.style.transform = `rotate(${c.rot}deg)`; el.style.zIndex = c.z || 1;
    if (selection.has(c.cardId)) el.classList.add("selected");
    if (filter && !matches(c)) el.classList.add("dim");
  }
  const shot = c.shotUrl ? `<img class="snap" src="${c.shotUrl}" draggable="false" alt="">` : `<div class="ph">${placeholderLetter(c)}</div>`;
  const fav = c.favicon ? `<img class="fav" src="${escapeHtml(c.favicon)}" draggable="false" alt="" onerror="this.style.display='none'">` : "";
  el.innerHTML =
    `<div class="shot">${shot}</div>` +
    (inHand ? "" : `<div class="status ${c.state || "cold"}" title="${c.state}"></div>`) +
    `<div class="label">${fav}<span class="title">${escapeHtml(c.title)}</span></div>` +
    (inHand ? "" : `<div class="note" contenteditable="true" spellcheck="false">${escapeHtml(c.note)}</div><div class="close" title="close for good">✕</div>`);
  el.addEventListener("dragstart", (e) => e.preventDefault());   // never let the browser native-drag the screenshot
  return el;
}
function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
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
    const txt = name.textContent.trim();
    const mem = membersOf(g.id);
    const auto = mem.length === 1 && mem[0] ? mem[0].title : "";   // lone card's auto-title
    const v = txt === auto ? "" : txt;          // leaving the auto-title unchanged keeps it auto; a real edit sticks
    if (v !== g.name) { g.name = v; saveGroup(g); }
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

// ---------------- hand ----------------
function renderHand() {
  handEl.replaceChildren();
  const ids = handCards(); const n = ids.length;
  const HAND_W = 158, SPREAD = HAND_W / 4, LIFT = 47;     // lift on hover; neighbours slide out a quarter-width
  const items = [];
  let hoverRAF = null;
  function applyHover(h) {
    items.forEach((it, k) => {
      if (it.el.classList.contains("dragging")) return;
      if (h < 0) it.el.style.transform = it.fan;                                   // rest
      else if (k === h) it.el.style.transform = `translateY(-${LIFT}px) scale(1.12)`;
      else it.el.style.transform = `translateX(${k < h ? -SPREAD : SPREAD}px) ${it.fan}`;   // slide away from the hovered card
    });
  }
  ids.forEach((c, i) => {
    const el = buildCard(c, true);
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    const fan = `rotate(${t * 16}deg) translateY(${Math.abs(t) * 26}px)`;
    el.style.transform = fan;
    items.push({ el, fan });
    el.addEventListener("pointerenter", () => { if (hoverRAF) { cancelAnimationFrame(hoverRAF); hoverRAF = null; } applyHover(i); });
    el.addEventListener("pointerleave", () => { hoverRAF = requestAnimationFrame(() => applyHover(-1)); });
    el.addEventListener("pointerdown", (e) => startHandDrag(e, c, el));
    el.addEventListener("dblclick", () => openCard(c.cardId));
    handEl.appendChild(el);
  });
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
  const ng = { id: "g-" + CT.uuid(), name: "", seed: hashStr(c.cardId) };
  state.groups.push(ng); saveGroup(ng); c.group = ng.id; persist(c);
  return ng.id;
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

// ---------------- card dragging (select / move / open) ----------------
function bumpZ(c, el) { c.z = ++state.zmax; if (el) el.style.zIndex = c.z; persist(c); }
function startCardDrag(e, c, el) {
  if (e.button !== 0) { if (e.button === 2) return; return; }
  e.stopPropagation();
  closeMenu();
  el.setPointerCapture(e.pointerId);
  bumpZ(c, el);
  const multi = (e.shiftKey || e.ctrlKey || e.metaKey);
  if (multi) toggleSel(c.cardId);
  else if (!selection.has(c.cardId)) selectOnly(c.cardId);
  const movingMany = selection.size > 1 && selection.has(c.cardId);
  const group = movingMany ? state.cards.filter((k) => selection.has(k.cardId)) : [c];
  const starts = group.map((k) => ({ k, x: k.x, y: k.y }));
  const start = toWorld(e.clientX, e.clientY);
  const downX = e.clientX, downY = e.clientY; let moved = false;
  el.classList.add("dragging"); busy = true;

  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) moved = true;
    const w = toWorld(ev.clientX, ev.clientY);
    const dx = w.x - start.x, dy = w.y - start.y;
    for (const s of starts) {
      s.k.x = s.x + dx; s.k.y = s.y + dy;
      const ke = cardsEl.querySelector(`[data-id="${s.k.cardId}"]`);
      if (ke) { ke.style.left = s.k.x + "px"; ke.style.top = s.k.y + "px"; }
    }
    if (!movingMany) {
      if (S.soloGroups) { c.group = liveGroup(c) || ensureSoloGroup(c); hidePreview(); }   // outline always follows the lone card
      else {
        c.group = liveGroup(c);
        if (c.group) hidePreview();
        else { const p = newGroupPartner(c); p ? showPreview([c, p]) : hidePreview(); }
      }
    }
    renderGroups();
    hotZones(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    el.releasePointerCapture(e.pointerId); el.classList.remove("dragging");
    el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
    clearZones(); hidePreview(); busy = false;
    if (!moved) { afterDrag(); return; }                         // a click: selection already handled
    if (overTrash(ev.clientX, ev.clientY)) { removeCards(group.map((k) => k.cardId)); afterDrag(); return; }
    if (overHand(ev.clientX, ev.clientY)) { group.forEach((k) => { k.placed = false; k.group = null; persist(k); }); pruneGroups(); render(); afterDrag(); return; }
    pushUndoLayouts(group.map((k) => k.cardId), "Move");
    if (!movingMany) finalizeGroup(c);
    group.forEach((k) => persist(k));
    render(); afterDrag();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}
function afterDrag() { if (pendingReload) { pendingReload = false; scheduleReload(); } }

// ---------------- group dragging ----------------
function startGroupDrag(e, g) {                       // initiated by pressing on/near the outline (no grip)
  e.stopPropagation(); closeMenu(); setNear(null); busy = true;
  tableEl.setPointerCapture(e.pointerId);
  const start = toWorld(e.clientX, e.clientY);
  const orig = membersOf(g.id).map((c) => ({ c, x: c.x, y: c.y }));
  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY); const dx = w.x - start.x, dy = w.y - start.y;
    for (const o of orig) {
      o.c.x = o.x + dx; o.c.y = o.y + dy;
      const el = cardsEl.querySelector(`[data-id="${o.c.cardId}"]`);
      if (el) { el.style.left = o.c.x + "px"; el.style.top = o.c.y + "px"; }
    }
    renderGroups();
  };
  const up = () => {
    try { tableEl.releasePointerCapture(e.pointerId); } catch (er) {}
    tableEl.removeEventListener("pointermove", move); tableEl.removeEventListener("pointerup", up);
    busy = false; tableEl.style.cursor = ""; orig.forEach((o) => persist(o.c)); afterDrag();
  };
  tableEl.addEventListener("pointermove", move); tableEl.addEventListener("pointerup", up);
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
    if (busy || tableEl.classList.contains("panning")) return;
    if (hoverEv.target.closest(".card") || hoverEv.target.closest(".group-label")) { setNear(null); return; }
    const g = nearestGroupOutline(toWorld(hoverEv.clientX, hoverEv.clientY));
    setNear(g ? g.id : null);
  });
});

// ---------------- hand dragging ----------------
function startHandDrag(e, c, el) {
  if (e.button !== 0) return;
  bumpZ(c); busy = true;
  const floater = buildCard(c, false); floater.classList.add("dragging");
  floater.style.transform = "rotate(0deg)"; cardsEl.appendChild(floater); floater.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY); c.x = w.x - CARD_W / 2; c.y = w.y - CARD_H / 2;
    floater.style.left = c.x + "px"; floater.style.top = c.y + "px";
    const g = liveGroup(c);
    if (g) showPreview(membersOf(g).concat(c));
    else { const p = newGroupPartner(c); p ? showPreview([c, p]) : hidePreview(); }
    hotZones(ev.clientX, ev.clientY);
  };
  const drop = (ev) => {
    floater.releasePointerCapture(e.pointerId);
    floater.removeEventListener("pointermove", move); floater.removeEventListener("pointerup", drop);
    clearZones(); hidePreview(); busy = false;
    if (overTrash(ev.clientX, ev.clientY)) { removeCards([c.cardId]); afterDrag(); return; }
    if (overHand(ev.clientX, ev.clientY)) { render(); afterDrag(); return; }   // stays in hand
    c.placed = true; finalizeGroup(c); persist(c); render(); afterDrag();
  };
  floater.addEventListener("pointermove", move); floater.addEventListener("pointerup", drop);
}

// ---------------- drop zones ----------------
function overTrash(x, y) { const r = trashEl.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
function overHand(x, y) { return y > innerHeight - HAND_ZONE_H; }
function hotZones(x, y) { const t = overTrash(x, y); trashEl.classList.toggle("hot", t); handEl.classList.toggle("receiving", !t && overHand(x, y)); }
function clearZones() { trashEl.classList.remove("hot"); handEl.classList.remove("receiving"); }

// ---------------- commands ----------------
function openCard(id) { send({ type: CT.MSG.OPEN, cardId: id }); }
async function removeCards(ids) {
  busy = true;
  const snaps = [];
  for (const id of ids) {
    const c = card(id); if (!c) continue;
    const tabRec = await DBP.get(CT.STORES.tabs, id).catch(() => null);
    const layRec = await DBP.get(CT.STORES.layout, id).catch(() => null);
    snaps.push({ tabRec, layRec });
    await send({ type: CT.MSG.DELETE, cardId: id });
    await DBP.del(CT.STORES.layout, id).catch(() => {});
    const u = shotUrls.get(id); if (u) { URL.revokeObjectURL(u); shotUrls.delete(id); }
  }
  selection.clear();
  pushUndo(`Closed ${ids.length} card${ids.length === 1 ? "" : "s"}`, async () => {
    for (const s of snaps) {
      if (s.tabRec) { s.tabRec.tabId = null; s.tabRec.state = "cold"; await DBP.put(CT.STORES.tabs, s.tabRec).catch(() => {}); }
      if (s.layRec) await DBP.put(CT.STORES.layout, s.layRec).catch(() => {});
    }
    await loadAll(); render();
  });
  busy = false; await loadAll(); render();
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
  closeMenu();
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
  e.preventDefault();
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
function openSettings() {
  $("s-theme").value = S.theme; $("s-felt").value = S.feltColor; $("s-cardw").value = S.cardWidth;
  $("s-font").value = S.labelFont; $("s-titlelines").value = S.titleLines || 1; $("s-size").value = S.labelSize || 18; $("s-quality").value = S.shotQuality; $("s-maxlive").value = S.maxLiveTabs;
  $("s-hand").checked = S.handOnNewTab; $("s-solo").checked = S.soloGroups; $("s-guard").checked = S.deepLinkGuard; $("s-reduce").checked = S.reducedMotion;
  $("s-authhosts").value = (S.authHosts || []).join("\n");
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
  S.labelSize = Math.max(10, Math.min(36, +$("s-size").value || 18));
  S.handOnNewTab = $("s-hand").checked; S.soloGroups = $("s-solo").checked; S.deepLinkGuard = $("s-guard").checked; S.reducedMotion = $("s-reduce").checked;
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
function scheduleReload() { if (busy) { pendingReload = true; return; } clearTimeout(reloadT); reloadT = setTimeout(async () => { await loadAll(); render(); }, 250); }
X.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === CT.MSG.CHANGED) scheduleReload();
  else if (msg.type === CT.MSG.SHOT) { loadShot(msg.cardId).then((u) => { if (!u || busy) return; const el = document.querySelector(`.card[data-id="${msg.cardId}"] .shot`); if (el) el.innerHTML = `<img class="snap" src="${u}" alt="">`; }); }   // document-wide: also updates cards in the hand
});

// ---------------- boot ----------------
(async function boot() {
  await loadSettings();
  await loadAll();
  render();
})();
