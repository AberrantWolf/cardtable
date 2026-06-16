import { groupOutline, chalkPaths, pointInPolygon, bbox, hashStr } from "./geometry.js";

// SVG sits in world space but offset so negative world coords never clip.
const OFF = 20000;
const SVGNS = "http://www.w3.org/2000/svg";
const CARD_W = 230, CARD_H = 230;        // footprint used for grouping math
const GROUP_PAD = 50;                    // visual outline padding around members
const ADD_PAD = 170;                     // generous: a card joins when its center enters this inflated hull (allows gaps, no overlap needed)
const REMOVE_PAD = 300;                  // sticky: a member only leaves after its center exits this larger hull (hysteresis)
const NEW_GROUP_DIST = 340;              // two loose cards this close (center-to-center), or overlapping, form a new group on drop
const HAND_ZONE_H = 150;                 // bottom band that catches a card dropped back into the hand

const $ = (id) => document.getElementById(id);
const tableEl = $("table"), worldEl = $("world"), cardsEl = $("cards"),
  labelsEl = $("labels"), pathsEl = $("group-paths"), handEl = $("hand"), trashEl = $("trash");

const SITES = [
  { title: "Bug 4471203 — hang on resume", fav: "🐞", color: "#3b6ea5" },
  { title: "GitLab !128 — fix IME focus", fav: "🦊", color: "#c95b27" },
  { title: "Confluence — Canvas browser design", fav: "📘", color: "#2f6f6f" },
  { title: "Jira PROJ-2231", fav: "🟦", color: "#2457a7" },
  { title: "arXiv 2403.01234 — spatial UIs", fav: "📄", color: "#7a3b8f" },
  { title: "Outlook — re: design review", fav: "📨", color: "#1f6fb2" },
  { title: "Slack — #cardtable", fav: "💬", color: "#5a2f8f" },
  { title: "Grafana — nightly build queue", fav: "📊", color: "#b5832f" },
  { title: "Stack Overflow — pointer capture", fav: "📚", color: "#b5602f" },
  { title: "MDN — tabs.captureVisibleTab", fav: "🧭", color: "#2f7f5a" },
];

let uid = 1, topZ = 1;
const nid = (p) => p + (uid++);
const rot = () => (Math.random() * 2 - 1) * 3.2;

function newCard(site, x, y, group) {
  return { id: nid("c"), title: site.title, fav: site.fav, color: site.color,
    shot: null, x, y, rot: rot(), group: group ?? null, note: "", z: ++topZ };
}

function seed() {
  const groups = [
    { id: "gA", name: "resume bug", seed: hashStr("gA") },
    { id: "gB", name: "design review", seed: hashStr("gB") },
  ];
  const cards = [
    newCard(SITES[0], 120, 140, "gA"), newCard(SITES[3], 400, 90, "gA"), newCard(SITES[7], 250, 430, "gA"),
    newCard(SITES[2], 900, 360, "gB"), newCard(SITES[5], 1190, 300, "gB"), newCard(SITES[6], 1040, 640, "gB"),
    newCard(SITES[4], 700, 760, null), newCard(SITES[8], 60, 760, null),
  ];
  const hand = [];
  for (const i of [1, 9]) { const c = newCard(SITES[i], 0, 0, null); cards.push(c); hand.push(c.id); }
  return { cards, groups, hand, view: { x: 0, y: 0, zoom: 1 } };
}

// ---- persistence ----
const KEY = "cardtable.v1";
function save() { try { state._uid = uid; state._topz = topZ; localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
function load() { try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.cards) { uid = s._uid || 1000; return s; } } catch {} return null; }

let state = load() || seed();
topZ = Math.max(topZ, state._topz || 0, ...state.cards.map((c) => c.z || 0));
const card = (id) => state.cards.find((c) => c.id === id);
const placed = () => state.cards.filter((c) => !state.hand.includes(c.id));
const rectOf = (c) => ({ x: c.x, y: c.y, w: CARD_W, h: CARD_H });
const centerOf = (c) => ({ x: c.x + CARD_W / 2, y: c.y + CARD_H / 2 });
const membersOf = (gid) => placed().filter((c) => c.group === gid);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const overlaps = (a, b) => a.x < b.x + CARD_W && a.x + CARD_W > b.x && a.y < b.y + CARD_H && a.y + CARD_H > b.y;

// ---- view ----
function applyView() { worldEl.style.transform = `translate(${state.view.x}px,${state.view.y}px) scale(${state.view.zoom})`; positionLabels(); }
function toWorld(sx, sy) { return { x: (sx - state.view.x) / state.view.zoom, y: (sy - state.view.y) / state.view.zoom }; }
function worldToScreen(wx, wy) { return { x: wx * state.view.zoom + state.view.x, y: wy * state.view.zoom + state.view.y }; }
function placeLabel(v) { if (!v.anchor) return; const s = worldToScreen(v.anchor.x, v.anchor.y); v.label.style.left = s.x + "px"; v.label.style.top = s.y + "px"; }
function positionLabels() { for (const v of groupViews.values()) placeLabel(v); }

// ---- cards ----
function shotMarkup(c) {
  if (c.shot) return `<img src="${c.shot}" alt="">`;
  return `<div class="ph" style="background:linear-gradient(150deg, ${c.color}, ${shade(c.color, -28)})">${c.fav}</div>`;
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
function escapeHtml(s) { return (s || "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }

function buildCard(c, inHand) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = c.id;
  if (!inHand) { el.style.left = c.x + "px"; el.style.top = c.y + "px"; el.style.transform = `rotate(${c.rot}deg)`; el.style.zIndex = c.z || 1; }
  el.innerHTML =
    `<div class="shot">${shotMarkup(c)}</div>` +
    `<div class="label"><span class="fav">${c.fav}</span><span class="title">${escapeHtml(c.title)}</span></div>` +
    (inHand ? "" : `<div class="note" contenteditable="true" spellcheck="false">${escapeHtml(c.note)}</div><div class="close" title="delete card">✕</div>`);
  return el;
}

function renderCards() {
  cardsEl.replaceChildren();
  for (const c of placed()) {
    const el = buildCard(c, false);
    const close = el.querySelector(".close");
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => { e.stopPropagation(); discard(c.id); });
    const note = el.querySelector(".note");
    note.addEventListener("pointerdown", (e) => e.stopPropagation());
    note.addEventListener("blur", () => { c.note = note.innerText.trim(); save(); });
    el.addEventListener("pointerdown", (e) => startCardDrag(e, c, el));
    cardsEl.appendChild(el);
  }
}

// ---- groups (incremental render so live updates + fades work) ----
const groupViews = new Map(); // gid -> { wrap, paths:[p1,p2], label, name }
let previewView = null;       // transient outline shown while a drag would form a NOT-yet-created group
const PREVIEW_SEED = 1337;

function createGroupView(g) {
  const wrap = document.createElementNS(SVGNS, "g");
  wrap.setAttribute("class", "group-wrap");
  const p1 = document.createElementNS(SVGNS, "path"), p2 = document.createElementNS(SVGNS, "path");
  wrap.append(p1, p2);
  pathsEl.appendChild(wrap);

  const label = document.createElement("div");
  label.className = "group-label";
  const grip = document.createElement("span"); grip.className = "grip"; grip.textContent = "⠿"; grip.title = "drag group";
  const name = document.createElement("span"); name.className = "gname"; name.contentEditable = "true"; name.spellcheck = false; name.textContent = g.name;
  label.append(grip, name);
  labelsEl.appendChild(label);
  grip.addEventListener("pointerdown", (e) => startGroupDrag(e, g));
  name.addEventListener("pointerdown", (e) => e.stopPropagation());
  name.addEventListener("blur", () => { g.name = name.textContent.trim() || g.name; save(); });

  wrap.style.opacity = "0"; label.style.opacity = "0";
  requestAnimationFrame(() => { wrap.style.opacity = "1"; label.style.opacity = "1"; });
  const v = { wrap, paths: [p1, p2], label, name };
  groupViews.set(g.id, v);
  return v;
}

function renderGroups() {
  const visible = new Set();
  for (const g of state.groups) {
    const mem = membersOf(g.id);
    if (mem.length < 2) continue;              // a group is only "a thing" at 2+ cards
    visible.add(g.id);
    const outline = groupOutline(mem.map(rectOf), GROUP_PAD);
    const ds = chalkPaths(outline.map((p) => ({ x: p.x + OFF, y: p.y + OFF })), g.seed);
    const v = groupViews.get(g.id) || createGroupView(g);
    v.paths.forEach((p, i) => p.setAttribute("d", ds[i] || ds[0]));
    const bb = bbox(outline);
    v.anchor = { x: (bb.minX + bb.maxX) / 2, y: bb.minY + 8 };
    placeLabel(v);
    if (document.activeElement !== v.name && v.name.textContent !== g.name) v.name.textContent = g.name;
  }
  for (const [gid, v] of [...groupViews]) {
    if (!visible.has(gid)) { v.wrap.remove(); v.label.remove(); groupViews.delete(gid); }
  }
}

function showPreview(cards) {
  const outline = groupOutline(cards.map(rectOf), GROUP_PAD);
  const ds = chalkPaths(outline.map((p) => ({ x: p.x + OFF, y: p.y + OFF })), PREVIEW_SEED);
  if (!previewView) {
    const wrap = document.createElementNS(SVGNS, "g");
    wrap.setAttribute("class", "group-wrap preview");
    const p1 = document.createElementNS(SVGNS, "path"), p2 = document.createElementNS(SVGNS, "path");
    wrap.append(p1, p2); pathsEl.appendChild(wrap);
    previewView = { wrap, paths: [p1, p2] };
  }
  previewView.paths.forEach((p, i) => p.setAttribute("d", ds[i] || ds[0]));
}
function hidePreview() { if (previewView) { previewView.wrap.remove(); previewView = null; } }

function render() { applyView(); renderGroups(); renderCards(); renderHand(); }

// ---- grouping logic with hysteresis ----
// Existing-group membership only (no new-group creation) — safe to call every frame.
function liveGroup(c) {
  const center = centerOf(c);
  if (c.group) {                               // already a member → sticky: must exit the large REMOVE hull to leave
    const others = membersOf(c.group).filter((m) => m.id !== c.id);
    if (others.length >= 1 && pointInPolygon(center, groupOutline(others.map(rectOf), REMOVE_PAD))) return c.group;
  }
  for (const g of state.groups) {              // not a member → generous: join when center enters the ADD hull
    if (g.id === c.group) continue;
    const mem = membersOf(g.id).filter((m) => m.id !== c.id);
    if (mem.length >= 1 && pointInPolygon(center, groupOutline(mem.map(rectOf), ADD_PAD))) return g.id;
  }
  return null;
}

// Nearest solo card this card would form a new group with (overlapping, or within range).
function newGroupPartner(c) {
  const center = centerOf(c);
  let best = null, bestD = Infinity;
  for (const o of placed()) {
    if (o.id === c.id || o.group) continue;
    const d = dist(centerOf(o), center);
    if ((overlaps(c, o) || d < NEW_GROUP_DIST) && d < bestD) { best = o; bestD = d; }
  }
  return best;
}

// On drop: existing groups first, else form a new group with the nearest loose card.
function finalizeGroup(c) {
  const g = liveGroup(c);
  if (g) { c.group = g; pruneGroups(); return; }
  const partner = newGroupPartner(c);
  if (partner) {
    const ng = { id: nid("g"), name: "new group", seed: hashStr(nid("s")) };
    state.groups.push(ng); partner.group = ng.id; c.group = ng.id; pruneGroups(); return;
  }
  c.group = null; pruneGroups();
}

// Dissolve any group that has dropped below 2 members; orphan its lone card.
function pruneGroups() {
  state.groups = state.groups.filter((g) => {
    const m = state.cards.filter((c) => c.group === g.id);
    if (m.length < 2) { m.forEach((c) => (c.group = null)); return false; }
    return true;
  });
}

// ---- card dragging ----
function startCardDrag(e, c, el) {
  if (e.button !== 0) return;
  e.stopPropagation();
  el.setPointerCapture(e.pointerId);
  el.classList.add("dragging");
  c.z = ++topZ; el.style.zIndex = c.z;         // clicking/dragging brings the card to the top of the stack
  const start = toWorld(e.clientX, e.clientY);
  const ox = start.x - c.x, oy = start.y - c.y;
  const downX = e.clientX, downY = e.clientY;
  let moved = false;

  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) moved = true;
    const w = toWorld(ev.clientX, ev.clientY);
    c.x = w.x - ox; c.y = w.y - oy;
    el.style.left = c.x + "px"; el.style.top = c.y + "px";
    c.group = liveGroup(c);                    // live join/leave existing groups → real outline tracks the card
    if (c.group) hidePreview();                // joining an existing group is already shown by its real outline
    else { const p = newGroupPartner(c); p ? showPreview([c, p]) : hidePreview(); }
    renderGroups();
    hotZones(ev.clientX, ev.clientY);
  };
  const up = (ev) => {
    el.releasePointerCapture(e.pointerId);
    el.classList.remove("dragging");
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    clearZones(); hidePreview();
    if (!moved) { save(); render(); return; }  // pure click: just raise to top, never regroup
    if (overTrash(ev.clientX, ev.clientY)) return discard(c.id);
    if (overHand(ev.clientX, ev.clientY)) return toHand(c.id);
    finalizeGroup(c); save(); render();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
}

// ---- group dragging (grip handle) ----
function startGroupDrag(e, g) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const start = toWorld(e.clientX, e.clientY);
  const orig = membersOf(g.id).map((c) => ({ c, x: c.x, y: c.y }));

  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY);
    const dx = w.x - start.x, dy = w.y - start.y;
    for (const o of orig) {
      o.c.x = o.x + dx; o.c.y = o.y + dy;
      const el = cardsEl.querySelector(`[data-id="${o.c.id}"]`);
      if (el) { el.style.left = o.c.x + "px"; el.style.top = o.c.y + "px"; }
    }
    renderGroups();                            // outline (and name) translate with the group
  };
  const up = () => {
    handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    save(); render();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
}

// ---- hand ----
function renderHand() {
  handEl.replaceChildren();
  const ids = state.hand, n = ids.length;
  ids.forEach((id, i) => {
    const c = card(id); if (!c) return;
    const el = buildCard(c, true);
    const t = n === 1 ? 0 : i / (n - 1) - 0.5;
    el.style.transform = `rotate(${t * 16}deg) translateY(${Math.abs(t) * 26}px)`;
    el.addEventListener("pointerdown", (e) => startHandDrag(e, c, el));
    handEl.appendChild(el);
  });
}

function startHandDrag(e, c, el) {
  if (e.button !== 0) return;
  c.z = ++topZ;                                // placed on top of the stack
  const floater = buildCard(c, false);
  floater.classList.add("dragging");
  floater.style.transform = "rotate(0deg)";
  cardsEl.appendChild(floater);
  floater.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY);
    c.x = w.x - CARD_W / 2; c.y = w.y - CARD_H / 2;
    floater.style.left = c.x + "px"; floater.style.top = c.y + "px";
    const g = liveGroup(c);                    // c is still in-hand → preview what dropping here would form
    if (g) showPreview(membersOf(g).concat(c));
    else { const p = newGroupPartner(c); p ? showPreview([c, p]) : hidePreview(); }
    hotZones(ev.clientX, ev.clientY);
  };
  const drop = (ev) => {
    floater.releasePointerCapture(e.pointerId);
    floater.removeEventListener("pointermove", move);
    floater.removeEventListener("pointerup", drop);
    clearZones(); hidePreview();
    if (overTrash(ev.clientX, ev.clientY)) { discard(c.id); return; }
    if (overHand(ev.clientX, ev.clientY)) { render(); return; }   // stays in hand
    state.hand = state.hand.filter((x) => x !== c.id);
    finalizeGroup(c); save(); render();
  };
  floater.addEventListener("pointermove", move);
  floater.addEventListener("pointerup", drop);
}

// ---- drop zones ----
function overTrash(x, y) { const r = trashEl.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
function overHand(x, y) { return y > innerHeight - HAND_ZONE_H; }
function hotZones(x, y) { const t = overTrash(x, y); trashEl.classList.toggle("hot", t); handEl.classList.toggle("receiving", !t && overHand(x, y)); }
function clearZones() { trashEl.classList.remove("hot"); handEl.classList.remove("receiving"); }

function toHand(id) { const c = card(id); if (c) c.group = null; if (!state.hand.includes(id)) state.hand.push(id); pruneGroups(); save(); render(); }
function discard(id) { state.cards = state.cards.filter((c) => c.id !== id); state.hand = state.hand.filter((x) => x !== id); pruneGroups(); save(); render(); }

// ---- table pan / zoom ----
tableEl.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest(".card") || e.target.closest(".group-label")) return;
  tableEl.classList.add("panning");
  tableEl.setPointerCapture(e.pointerId);
  const sx = e.clientX, sy = e.clientY, ox = state.view.x, oy = state.view.y;
  const move = (ev) => { state.view.x = ox + (ev.clientX - sx); state.view.y = oy + (ev.clientY - sy); applyView(); };
  const up = () => { tableEl.classList.remove("panning"); tableEl.removeEventListener("pointermove", move); tableEl.removeEventListener("pointerup", up); save(); };
  tableEl.addEventListener("pointermove", move);
  tableEl.addEventListener("pointerup", up);
});

tableEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  const z = Math.max(0.25, Math.min(3, state.view.zoom * Math.exp(-e.deltaY * 0.0015)));
  const w = toWorld(e.clientX, e.clientY);
  state.view.x = e.clientX - w.x * z; state.view.y = e.clientY - w.y * z; state.view.zoom = z;
  applyView(); save();
}, { passive: false });

// ---- toolbar ----
$("btn-open").addEventListener("click", () => {
  const c = newCard(SITES[Math.floor(Math.random() * SITES.length)], 0, 0, null);
  state.cards.push(c); state.hand.push(c.id); save(); renderHand();
});
$("btn-fit").addEventListener("click", () => {
  const ps = placed(); if (!ps.length) return;
  const bb = bbox(ps.flatMap((c) => [{ x: c.x, y: c.y }, { x: c.x + CARD_W, y: c.y + CARD_H }]));
  const pad = 120, vw = innerWidth, vh = innerHeight - 160;
  const z = Math.max(0.25, Math.min(1.5, Math.min(vw / (bb.maxX - bb.minX + pad * 2), vh / (bb.maxY - bb.minY + pad * 2))));
  state.view.zoom = z;
  state.view.x = (vw - (bb.minX + bb.maxX) * z) / 2;
  state.view.y = (vh - (bb.minY + bb.maxY) * z) / 2;
  applyView(); save();
});
$("btn-reset").addEventListener("click", () => { localStorage.removeItem(KEY); for (const [, v] of groupViews) { v.wrap.remove(); v.label.remove(); } groupViews.clear(); state = seed(); render(); });

render();
