import { createHand } from "./hand.js";
import { GestureSession, movementSnapshot } from "./interactions.js";
import { BoardModel } from "./board-model.js";
import { groupOutline, chalkPaths, pointInPolygon, bbox, hashStr, fitBounds, GroupGeometry } from "./geometry.js";
import DBP from "./db.js";

const X = globalThis.browser || globalThis.chrome;
const OFF = 20000, SVGNS = "http://www.w3.org/2000/svg";
const GROUP_PAD = 50, ADD_PAD = 170, REMOVE_PAD = 300, NEW_GROUP_DIST = 340, HAND_ZONE_H = 180;

const $ = (id) => document.getElementById(id);
const tableEl = $("table"), worldEl = $("world"), cardsEl = $("cards"), labelsEl = $("labels"),
  pathsEl = $("group-paths"), handEl = $("hand"), trashEl = $("trash"), menuEl = $("menu"),
  searchEl = $("search"), countEl = $("count"), emptyEl = $("empty"), toastEl = $("toast"),
  stickiesEl = $("stickies"), pileEl = $("sticky-pile");

let S = { ...CT.DEFAULTS };
let CARD_W = 230, CARD_H = 245;
const state = { cards: [], groups: [], stickies: [], view: { x: 0, y: 0, zoom: 1 }, zmax: 1 };
const model = new BoardModel();
const editing = new Set();
const cardIndex = new Map();
const selection = new Set();
const shotUrls = new Map(), iconUrls = new Map();
let filter = "";
let near = null;   // group id whose outline the pointer is hovering near (a press would grab it)
// "Interacting" = a pointer drag is in flight, or an async critical section holds a lease. It is a
// DERIVED predicate, never a hand-set flag — both sources release through guaranteed teardown
// (AbortController for drags, try/finally for async), so it cannot latch. See the interaction section.
let activeGesture = null, criticalDepth = 0, pendingReload = false;
const isInteracting = () => activeGesture !== null || criticalDepth > 0;

// ---------------- helpers ----------------
const card = (id) => cardIndex.get(id);
const placed = () => state.cards.filter((c) => c.placed && (!filter || matches(c)));
const handCards = () => state.cards.filter((c) => !c.placed);
const membership=new Map(),geometry=new GroupGeometry();
function indexMembership(){membership.clear();for(const c of state.cards)if(c.placed&&c.group){if(!membership.has(c.group))membership.set(c.group,[]);membership.get(c.group).push(c);}}
const membersOf=gid=>membership.get(gid)||[];
const rectOf = (c) => ({ x: c.x, y: c.y, w: CARD_W, h: CARD_H });
const centerOf = (c) => ({ x: c.x + CARD_W / 2, y: c.y + CARD_H / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const overlaps = (a, b) => a.x < b.x + CARD_W && a.x + CARD_W > b.x && a.y < b.y + CARD_H && a.y + CARD_H > b.y;
const rotFor = (id) => ((hashStr(id) % 640) / 100) - 3.2;
const stickyRot = (id) => ((hashStr(id) % 500) / 100) - 2.5;   // subtle tilt, like a real note slapped down
const matches = (c) => { const q = filter.toLowerCase(); return (c.title || "").toLowerCase().includes(q) || (c.url || "").toLowerCase().includes(q); };
const send = async m=>{
  const r=await X.runtime.sendMessage(m);if(!r||r.ok===false)throw new Error(r?.error?.message||'Background unavailable');return r;
};

// ---------------- settings / theme ----------------
async function loadSettings() {
  try { const r = await X.storage.local.get(["settings", "view"]); S = CT.normalizeSettings(r.settings); if (r.view) state.view = r.view; } catch (e) {}
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
  r.style.setProperty("--sticky-color", S.stickyColor || CT.DEFAULTS.stickyColor);
  r.style.setProperty("--sticky-size", (S.stickySize || CT.DEFAULTS.stickySize) + "px");
  r.style.setProperty("--sticky-font", S.stickyFont || CT.DEFAULTS.stickyFont);
  r.style.setProperty("--sticky-font-size", (S.stickyFontSize || CT.DEFAULTS.stickyFontSize) + "px");
  if (S.theme === "paper") r.style.removeProperty("--table-bg");
  else r.style.setProperty("--table-bg", S.feltColor || CT.DEFAULTS.feltColor);
  document.body.classList.toggle("theme-paper", S.theme === "paper");
  document.body.classList.toggle("reduce", !!S.reducedMotion);
}
async function saveSettings() { await X.storage.local.set({ settings: S }); }
let viewT = null;
const saveView = () => { clearTimeout(viewT); viewT = setTimeout(() => X.storage.local.set({ view: state.view }).catch(e=>showToast("View not saved: "+e.message,false)), 300); };

// ---------------- persistence (layout/groups owned by the page) ----------------
const dirty = new Set(), pendingWrites = new Map();
let flushT=null, flushing=Promise.resolve();
function queueWrite(store,key,value) {
  const previous=pendingWrites.get(store+':'+key),base=model.rows[store].get(key);
  const fields=value===null?null:Object.fromEntries(Object.entries(value).filter(([field,v])=>JSON.stringify(v)!==JSON.stringify(base?.[field])));
  if(value===null&&!base){pendingWrites.delete(store+':'+key);return;}
  if(fields&&Object.keys(fields).length===0){pendingWrites.delete(store+':'+key);return;}
  pendingWrites.set(store+':'+key,{store,key,value,fields,create:previous?.create??!base,blockedBy:previous?.blockedBy});
  clearTimeout(flushT); flushT=setTimeout(()=>flush().catch(saveError),250);
}
function persist(c) {
  dirty.add(c.cardId);
  queueWrite('layout',c.cardId,{cardId:c.cardId,x:c.x,y:c.y,rot:c.rot,group:c.group,note:c.note,z:c.z,placed:c.placed});
}
async function flush() {
  clearTimeout(flushT);
  if(activeGesture){flushT=setTimeout(()=>flush().catch(saveError),250);return;}
  const run=async()=>{
    const entries=[...pendingWrites.entries()].filter(([,r])=>!r.blockedBy);if(!entries.length)return;
    await DBP.mutate(entries.map(([,r])=>r.value===null?{type:'delete',store:r.store,key:r.key}:{type:'patch',store:r.store,key:r.key,value:r.fields,create:r.create}),model.epoch);
    for(const [key,value]of entries)if(pendingWrites.get(key)===value){pendingWrites.delete(key);if(value.store==='layout')dirty.delete(value.key);}
    for(const [,r]of entries)if(!editing.has(r.key)&&!pendingWrites.has(r.store+':'+r.key))model.drafts.delete(r.key);
    if(!pendingWrites.size)$('toast-retry').hidden=retryActions.size>0?false:true;
  };
  flushing=flushing.then(run,run);return flushing;
}
function saveError(e){showToast('Changes not saved: '+e.message,false);$('toast-retry').hidden=false;}
const saveGroup=g=>queueWrite('groups',g.id,{...g});
const delGroupRec=id=>{queueWrite('groups',id,null);return Promise.resolve();};
const saveSticky=s=>queueWrite('notes',s.id,{id:s.id,x:s.x,y:s.y,text:s.text,rot:s.rot,z:s.z});

// ---------------- data load ----------------
async function loadShot(cardId) {
  try {
    const s = await DBP.get(CT.STORES.shots, cardId);
    if(!card(cardId))return null;
    for(const [cache,field,present]of [[shotUrls,'shotUrl',s?.blob],[iconUrls,'faviconUrl',s?.faviconBlob]])if(!present&&cache.has(cardId)){URL.revokeObjectURL(cache.get(cardId));cache.delete(cardId);card(cardId)[field]=field==='shotUrl'?null:'';}
    if(s?.faviconBlob){const old=iconUrls.get(cardId);if(old)URL.revokeObjectURL(old);const url=URL.createObjectURL(s.faviconBlob);iconUrls.set(cardId,url);card(cardId).faviconUrl=url;}
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
  const snapshot=await DBP.snapshot(),oldEpoch=model.epoch;
  if(activeGesture){pendingReload=true;return;}
  if(model.replace(snapshot)) {
    if(oldEpoch!==model.epoch){
      pendingWrites.clear();dirty.clear();retryActions.clear();undoStack.length=0;editing.clear();$("toast-retry").hidden=true;
      for(const input of cardsEl.querySelectorAll('.note-input'))input.closest('.card').remove();
      for(const input of stickiesEl.querySelectorAll('.sticky-input'))input.closest('.sticky').remove();
      for(const [id,view]of groupViews)if(view.input){view.wrap.remove();view.label.remove();groupViews.delete(id);}
    }
    for(const cache of [shotUrls,iconUrls]){for(const url of cache.values())URL.revokeObjectURL(url);cache.clear();}
    await syncModel();
  }
}
async function syncModel() {
  for(const cache of [shotUrls,iconUrls])for(const [id,url]of cache)if(!model.rows.shots.has(id)){URL.revokeObjectURL(url);cache.delete(id);}
  const previous=new Map(state.cards.map(c=>[c.cardId,c]));let zmax=state.zmax;
  state.groups=[...model.rows.groups.values()].map(g=>({...g}));
  for(const p of pendingWrites.values())if(p.store==='groups'){
    state.groups=state.groups.filter(g=>g.id!==p.key);if(p.value)state.groups.push({...model.rows.groups.get(p.key),...p.fields});
  }
  state.cards=[...model.rows.tabs.values()].map(t=>{
    const pending=pendingWrites.get('layout:'+t.cardId),saved=model.rows.layout.get(t.cardId);
    const l=pending?.value===null?undefined:(pending||saved?{...saved,...(pending?.fields||{})}:undefined);
    const c=previous.get(t.cardId)||{cardId:t.cardId,x:0,y:0,rot:rotFor(t.cardId),group:null,note:'',z:++zmax,placed:false};
    Object.assign(c,{x:0,y:0,rot:rotFor(t.cardId),group:null,note:'',placed:false,url:t.url,title:t.title||t.url,favicon:t.favicon||'',createdAt:t.createdAt||0,state:t.tabId!=null?'live':'cold',shotUrl:shotUrls.get(t.cardId)||null,faviconUrl:iconUrls.get(t.cardId)||''});
    if(l)Object.assign(c,l);
    else if(!S.handOnNewTab&&!c.placed){c.placed=true;c.x=60;c.y=60;persist(c);}
    Object.assign(c,model.drafts.get(c.cardId));zmax=Math.max(zmax,c.z||1);return c;
  });
  cardIndex.clear();for(const c of state.cards)cardIndex.set(c.cardId,c);indexMembership();
  const oldNotes=new Map(state.stickies.map(n=>[n.id,n]));
  const notes=new Map(model.rows.notes);for(const p of pendingWrites.values())if(p.store==='notes'){if(p.value)notes.set(p.key,{...notes.get(p.key),...p.fields});else notes.delete(p.key);}
  state.stickies=[...notes.values()].map(n=>{const s=oldNotes.get(n.id)||{};Object.assign(s,n,model.drafts.get(n.id));s.z||=++zmax;zmax=Math.max(zmax,s.z);return s;});
  state.zmax=zmax;
  for(const id of [...selection])if(!card(id)&&!sticky(id))selection.delete(id);
  for(const cache of [shotUrls,iconUrls])for(const [id,url]of cache)if(!card(id)){URL.revokeObjectURL(url);cache.delete(id);}
  for(const id of [...model.drafts.keys()])if(!card(id)&&!sticky(id))model.drafts.delete(id);
  if(S.soloGroups)for(const c of state.cards)if(c.placed&&!c.group)ensureSoloGroup(c);
  await Promise.all(state.cards.filter(c=>!c.shotUrl&&!c.faviconUrl&&model.rows.shots.has(c.cardId)).map(c=>loadShot(c.cardId)));
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
// Canvas icons must be locally cached bytes or packaged extension assets.
function localIcon(c){return S.showFavicons===false?'':c.faviconUrl||CT.localFavicon(c.favicon)||(c.favicon?.startsWith(X.runtime.getURL('icons/'))?c.favicon:'');}
function updateIcon(el,c){const url=localIcon(c);let img=el.querySelector('.fav');if(!url){img?.remove();return;}if(!img){img=elem('img','fav',{alt:'',draggable:false});el.append(img);}if(img.getAttribute('src')!==url)img.src=url;}
const normalizePlainText = (text) => (text || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
const noteDisplay = (text) => elem("div", "note", { textContent: text || "" });
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
  updateIcon(el,c);
  if (!inHand) el.append(elem("div", "status " + (c.state || "cold"), { title: c.state || "cold" }));
  const label = elem("div", "label");
  label.append(elem("span", "title", { textContent: c.title || "" }));
  el.append(label);
  if (!inHand) {
    el.append(noteDisplay(c.note));
    el.append(elem("div", "close", { title: "close for good", textContent: "✕" }));
  }
  el.addEventListener("dragstart", (e) => e.preventDefault());   // never let the browser native-drag the screenshot
  return el;
}
function renderCards() {
  const wanted=new Set(state.cards.filter(c=>c.placed).map(c=>c.cardId));
  for(const el of [...cardsEl.children])if(!wanted.has(el.dataset.id))el.remove();
  const nodes=new Map([...cardsEl.children].map(el=>[el.dataset.id,el]));
  for (const c of state.cards.filter((c) => c.placed)) {
    let el=nodes.get(c.cardId);
    if(el){
      el.style.left=c.x+'px';el.style.top=c.y+'px';el.style.transform=`rotate(${c.rot}deg)`;el.style.zIndex=c.z;
      el.querySelector('.title').textContent=c.title;el.classList.toggle('selected',selection.has(c.cardId));el.classList.toggle('dim',!!filter&&!matches(c));
      updateIcon(el,c);
      const status=el.querySelector('.status');status.className='status '+c.state;status.title=c.state;
      const shot=el.querySelector('.shot'),url=c.shotUrl||'';if(shot.dataset.url!==url){shot.replaceChildren(url?snapImg(url):elem('div','ph',{textContent:placeholderLetter(c)}));shot.dataset.url=url;}
      if(!el.querySelector('.note-input'))el.querySelector('.note').textContent=c.note;
      continue;
    }
    el = buildCard(c, false);
    const close = el.querySelector(".close");
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => { e.stopPropagation(); removeCards([c.cardId]); });
    wireCardNote(el.querySelector(".note"), c, el);
    el.addEventListener("pointerdown", (e) => startCardDrag(e, c, el));
    el.addEventListener("dblclick", (e) => { if (!e.target.closest(".note") && !e.target.closest(".close")) openCard(c.cardId); });
    el.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".note-input")) return;
      e.preventDefault(); if (!selection.has(c.cardId)) selectOnly(c.cardId); openMenu(e.clientX, e.clientY, c);
    });
    el.addEventListener("pointerenter", () => scheduleUrlPop(el, c.url));
    el.addEventListener("pointerleave", hideUrlPop);
    cardsEl.appendChild(el);
  }
}
function wireCardNote(note, c, el) {
  if (!note) return;
  note.addEventListener("pointerdown", (e) => e.stopPropagation());
  note.addEventListener("click", (e) => { e.stopPropagation(); startCardNoteEdit(c, el); });
}
function fitCardNoteInput(input) { input.style.height = "0px"; input.style.height = input.scrollHeight + "px"; }
function startCardNoteEdit(c, el) {
  const epoch=model.epoch;
  const existing = el.querySelector(".note-input");
  if (existing) { existing.focus(); existing.selectionStart = existing.selectionEnd = existing.value.length; fitCardNoteInput(existing); return; }
  const note = el.querySelector(".note"); if (!note) return;
  const input = elem("textarea", "note note-input", { value: c.note || "", spellcheck: false, placeholder: "note" });
  input.setAttribute("aria-label", "Card note");
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  editing.add(c.cardId);
  input.addEventListener("input",()=>{if(epoch!==model.epoch)return;c.note=input.value;model.draft(c.cardId,{note:input.value});persist(c);fitCardNoteInput(input);});
  input.addEventListener("blur", () => commitCardNote(c, input, epoch));
  note.replaceWith(input);
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  fitCardNoteInput(input);
}
function commitCardNote(c, input, epoch=model.epoch) {
  if(epoch!==model.epoch)return;
  editing.delete(c.cardId);
  const v = normalizePlainText(input.value);
  model.draft(c.cardId,{note:v});
  const el = input.closest(".card");
  const note = noteDisplay(v);
  input.replaceWith(note);
  if (el) wireCardNote(note, c, el);
  if (c.note !== v) { c.note = v; persist(c); }
  if(!pendingWrites.has('layout:'+c.cardId))model.drafts.delete(c.cardId);
}

// ---------------- sticky notes ----------------
// Standalone yellow notes on the canvas. Size/color/font are global settings (see applyTheme's
// --sticky-* vars), so a note record only carries position, text, tilt and z. You drag a note from
// anywhere on it; the corner pencil or a double-click swaps the display text for a native textarea
// editor. Records live in the `notes` store, so export/import carries them for free.
const sticky = (id) => state.stickies.find((s) => s.id === id);
const stickySize = () => S.stickySize || CT.DEFAULTS.stickySize;
const centerOfSticky = (s) => { const sz = stickySize(); return { x: s.x + sz / 2, y: s.y + sz / 2 }; };
const stickyDisplay = (text) => elem("div", "sticky-text", { textContent: text || "" });
const normalizeStickyText = normalizePlainText;
function bumpStickyZ(s, el, save=true) { s.z = ++state.zmax; if (el) el.style.zIndex = s.z; if(save)saveSticky(s); }
function buildSticky(s) {
  const el = elem("div", "sticky"); el.dataset.id = s.id;
  if (selection.has(s.id)) el.classList.add("selected");
  el.style.left = s.x + "px"; el.style.top = s.y + "px"; el.style.transform = `rotate(${s.rot}deg)`; el.style.zIndex = s.z || 1;
  el.append(stickyDisplay(s.text));
  el.append(elem("button", "sticky-edit", { type: "button", title: "Edit text", textContent: "✎" }));
  el.append(elem("button", "sticky-del", { type: "button", title: "Delete note", textContent: "🗑" }));
  el.addEventListener("dragstart", (e) => e.preventDefault());
  return el;
}
function renderStickies() {
  const wanted=new Set(state.stickies.map(s=>s.id));for(const el of [...stickiesEl.children])if(!wanted.has(el.dataset.id))el.remove();
  const nodes=new Map([...stickiesEl.children].map(el=>[el.dataset.id,el]));
  for (const s of state.stickies) {
    let el=nodes.get(s.id);
    if(el){el.style.left=s.x+'px';el.style.top=s.y+'px';el.style.zIndex=s.z;el.classList.toggle('selected',selection.has(s.id));if(!el.classList.contains('editing'))el.querySelector('.sticky-text').textContent=s.text;continue;}
    el = buildSticky(s);
    const edit = el.querySelector(".sticky-edit");
    const del = el.querySelector(".sticky-del");
    edit.addEventListener("pointerdown", (e) => e.stopPropagation());
    edit.addEventListener("click", (e) => { e.stopPropagation(); startStickyEdit(s, el); });
    del.addEventListener("pointerdown", (e) => e.stopPropagation());
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteSticky(s); });
    el.addEventListener("pointerdown", (e) => startStickyDrag(e, s, el));
    el.addEventListener("dblclick", (e) => { if (el.classList.contains("editing")) return; e.stopPropagation(); startStickyEdit(s, el); });
    el.addEventListener("contextmenu", (e) => {
      if (e.target.closest(".sticky-input")) return;
      e.preventDefault(); e.stopPropagation(); openStickyMenu(e.clientX, e.clientY, s);
    });
    stickiesEl.appendChild(el);
  }
}
function addSticky(wx, wy, edit) {
  const id = "n-" + CT.uuid();
  const sz = S.stickySize || CT.DEFAULTS.stickySize;
  const s = { id, x: Math.round(wx - sz / 2), y: Math.round(wy - sz / 2), text: "", rot: stickyRot(id), z: ++state.zmax };
  state.stickies.push(s); saveSticky(s);
  renderStickies();
  if (edit) startStickyEdit(s);   // a fresh note opens ready to type
}
function startStickyEdit(s, el) {
  const epoch=model.epoch;
  el = el || stickiesEl.querySelector(`[data-id="${s.id}"]`); if (!el) return;
  bumpStickyZ(s, el);
  const existing = el.querySelector(".sticky-input");
  if (existing) { existing.focus(); existing.selectionStart = existing.selectionEnd = existing.value.length; return; }
  const txt = el.querySelector(".sticky-text"); if (!txt) return;
  const input = elem("textarea", "sticky-input", { value: s.text || "", spellcheck: false, placeholder: "note" });
  input.setAttribute("aria-label", "Sticky note text");
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  editing.add(s.id);
  input.addEventListener('input',()=>{if(epoch!==model.epoch)return;s.text=input.value;model.draft(s.id,{text:input.value});saveSticky(s);});
  input.addEventListener("blur", () => commitSticky(s, el, input, epoch));
  el.classList.add("editing"); txt.replaceWith(input);
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}
function commitSticky(s, el, input, epoch=model.epoch) {
  if(epoch!==model.epoch)return;
  editing.delete(s.id);
  const v = normalizeStickyText(input.value);
  model.draft(s.id,{text:v});
  el.classList.remove("editing");
  input.replaceWith(stickyDisplay(v));
  if (s.text !== v) { s.text = v; saveSticky(s); }
  if(!pendingWrites.has('notes:'+s.id))model.drafts.delete(s.id);
}
const deleteSticky = (s) => deleteStickies([s.id]);
function deleteStickies(ids) { return removeEntities([],ids).catch(saveError); }
function startStickyDrag(e, s, el) {
  if (e.button !== 0 || criticalDepth || retryActions.size) return;
  e.stopPropagation();                                 // the note owns this press — don't pan/clear underneath
  if (el.classList.contains("editing")) return;        // editing: let the text field place the caret / select
  closeMenu(); hideUrlPop();
  // select like a card: a press selects (shift/ctrl/meta toggles into a multi-selection)
  if (e.shiftKey || e.ctrlKey || e.metaKey) toggleSel(s.id);
  else if (!selection.has(s.id)) selectOnly(s.id);
  const before=snapshotUI();
  if(!selection.has(s.id))return;
  const movers=movementSnapshot(state.cards,state.stickies,selection);
  bumpStickyZ(s, el, false);
  const start = toWorld(e.clientX, e.clientY), ox = s.x, oy = s.y;
  const downX = e.clientX, downY = e.clientY; let moved = false;
  el.classList.add("dragging");
  const signal = beginGesture(el, e.pointerId, () => { el.classList.remove("dragging"); trashEl.classList.remove("hot"); });
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) moved = true;
    const w = toWorld(ev.clientX, ev.clientY);
    for(const m of movers){m.value.x=m.x+w.x-start.x;m.value.y=m.y+w.y-start.y;const node=(m.kind==='card'?cardsEl:stickiesEl).querySelector(`[data-id="${m.id}"]`);if(node){node.style.left=m.value.x+'px';node.style.top=m.value.y+'px';}}
    renderGroups();
    trashEl.classList.toggle("hot", overTrash(ev.clientX, ev.clientY));
  };
  const finish = (ev) => {
    const wasMoved = moved, cancel = ev.type === "pointercancel";
    endGesture();
    try {
      if (cancel) { if (wasMoved) saveSticky(s); }                        // tab hidden mid-drag: just keep the position
      else if (wasMoved) { overTrash(ev.clientX, ev.clientY) ? removeEntities(movers.filter(m=>m.kind==='card').map(m=>m.id),movers.filter(m=>m.kind==='note').map(m=>m.id)).catch(saveError) : commitUI(before,"Move selection").catch(saveError); }
      else { saveSticky(s); } // persist the raised z-order on a plain click
    } finally { drainPending(); }
  };
  el.addEventListener("pointermove", move, { signal });
  el.addEventListener("pointerup", finish, { signal });
  el.addEventListener("pointercancel", finish, { signal });
}
// The bottom-right pile: a plain click drops a note at the viewport center; dragging off it pulls a
// fresh note that follows the pointer (a ghost in world-space, like the hand floater) and lands where
// you release — unless you drop it on the trash, which cancels. Reuses the RAII gesture so capture,
// the floater, and the hot-zone all tear down through one door.
function startPileDrag(e) {
  if (e.button !== 0 || criticalDepth || retryActions.size) return;
  e.stopPropagation(); closeMenu(); hideUrlPop();
  const downX = e.clientX, downY = e.clientY;
  const sz = S.stickySize || CT.DEFAULTS.stickySize;
  let floater = null, moved = false;
  pileEl.classList.add("pulling");
  const signal = beginGesture(pileEl, e.pointerId, () => { pileEl.classList.remove("pulling"); trashEl.classList.remove("hot"); if (floater) floater.remove(); });
  const begin = () => {
    moved = true;
    floater = elem("div", "sticky dragging"); floater.style.pointerEvents = "none"; floater.style.transform = "rotate(-2deg)";
    floater.append(elem("div", "sticky-text"));
    stickiesEl.appendChild(floater);
  };
  const move = (ev) => {
    if (!moved) { if (Math.hypot(ev.clientX - downX, ev.clientY - downY) <= 5) return; begin(); }
    const w = toWorld(ev.clientX, ev.clientY);
    floater.style.left = (w.x - sz / 2) + "px"; floater.style.top = (w.y - sz / 2) + "px";
    trashEl.classList.toggle("hot", overTrash(ev.clientX, ev.clientY));
  };
  const finish = (ev) => {
    const wasMoved = moved, cancel = ev.type === "pointercancel";
    endGesture();
    try {
      if (!wasMoved) { const w = toWorld(innerWidth / 2, innerHeight / 2); addSticky(w.x, w.y, true); }   // a click → note at center, like "+ note"
      else if (cancel || overTrash(ev.clientX, ev.clientY)) { /* canceled or dropped on the trash → make nothing */ }
      else { const w = toWorld(ev.clientX, ev.clientY); addSticky(w.x, w.y, true); }
    } finally { drainPending(); }
  };
  pileEl.addEventListener("pointermove", move, { signal });
  pileEl.addEventListener("pointerup", finish, { signal });
  pileEl.addEventListener("pointercancel", finish, { signal });
}
pileEl.addEventListener("pointerdown", startPileDrag);

// ---------------- groups (incremental) ----------------
const groupViews = new Map();
let previewView = null;
const PREVIEW_SEED = 1337;
function createGroupView(g) {
  const wrap = document.createElementNS(SVGNS, "g"); wrap.setAttribute("class", "group-wrap");
  const p1 = document.createElementNS(SVGNS, "path"), p2 = document.createElementNS(SVGNS, "path");
  wrap.append(p1, p2); pathsEl.appendChild(wrap);
  const label = document.createElement("div"); label.className = "group-label";
  const name = document.createElement("span"); name.className = "gname";
  label.append(name); labelsEl.appendChild(label);
  wireGroupName(name, g.id);
  wrap.style.opacity = "0"; label.style.opacity = "0";
  requestAnimationFrame(() => { wrap.style.opacity = "1"; label.style.opacity = "1"; });
  const v = { wrap, paths: [p1, p2], label, name, anchor: null };
  groupViews.set(g.id, v); return v;
}
function groupEditValue(grp) {
  const mem = membersOf(grp.id);
  return grp.name || (mem.length === 1 && mem[0] ? mem[0].title : "");
}
function wireGroupName(name, gid) {
  name.addEventListener("pointerdown", (e) => e.stopPropagation());
  name.addEventListener("click", (e) => { e.stopPropagation(); startGroupNameEdit(gid); });
}
function startGroupNameEdit(gid) {
  const v = groupViews.get(gid); if (!v || v.input) return;
  const grp = state.groups.find((x) => x.id === gid); if (!grp) return;
  const input = elem("input", "gname gname-input", { type: "text", value: groupEditValue(grp), spellcheck: false, placeholder: "+ name" });
  input.setAttribute("aria-label", "Group name");
  input.addEventListener("pointerdown", (e) => e.stopPropagation());
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); finishGroupNameEdit(gid, input, false); }
  });
  input.addEventListener("blur", () => finishGroupNameEdit(gid, input, true));
  v.name.replaceWith(input);
  v.name = input; v.input = input;v.editEpoch=model.epoch;
  input.focus(); input.select();
}
function finishGroupNameEdit(gid, input, commit) {
  const v = groupViews.get(gid); if (!v || v.input !== input || v.editEpoch!==model.epoch) return;
  const grp = state.groups.find((x) => x.id === gid);
  if (commit && grp) {
    const txt = input.value.trim();
    const auto = groupEditValue({ ...grp, name: "" });
    const val = txt === auto ? "" : txt;
    if (val !== grp.name) { grp.name = val; saveGroup(grp); }
  }
  const name = document.createElement("span"); name.className = "gname";
  input.replaceWith(name);
  v.name = name; v.input = null;
  wireGroupName(name, gid);
  renderGroups();
}
function placeLabel(v) { if (!v.anchor) return; const s = worldToScreen(v.anchor.x, v.anchor.y); v.label.style.left = s.x + "px"; v.label.style.top = s.y + "px"; }
function positionLabels() { for (const v of groupViews.values()) placeLabel(v); }
function renderGroups() {
  indexMembership();
  const visible = new Set();
  for (const g of state.groups) {
    const mem = membersOf(g.id);
    if (mem.length < (S.soloGroups ? 1 : 2)) continue;
    visible.add(g.id);
    const cached=geometry.get(g.id,mem.map(rectOf),GROUP_PAD,g.seed),outline=cached.outline,ds=cached.paths;
    const v = groupViews.get(g.id) || createGroupView(g);
    v.outline = outline;                                   // world-space points, for outline hit-testing
    if(v.geometry!==cached){v.paths.forEach((p,i)=>p.setAttribute("d",ds[i]||ds[0]));v.geometry=cached;}
    const bb = cached.bounds; v.anchor = { x: (bb.minX + bb.maxX) / 2, y: bb.minY + 8 }; placeLabel(v);
    const labelText = g.name || (mem.length === 1 ? mem[0].title : "");   // lone card → show its title (stays readable zoomed out)
    if (!v.input && v.name.textContent !== labelText) v.name.textContent = labelText;
  }
  geometry.prune(new Set(state.groups.map(g=>g.id)));
  for (const [gid, v] of [...groupViews]) if (!visible.has(gid)) { v.wrap.remove(); v.label.remove(); groupViews.delete(gid); }
}
let groupRAF=null;
function scheduleGroups(){if(groupRAF!==null)return;groupRAF=requestAnimationFrame(()=>{groupRAF=null;if(activeGesture)renderGroups();});}
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
function showHandPreview(){handEl.classList.add('receiving');}
function hideHandPreview(){handEl.classList.remove('receiving');}
let handDock=null;
function renderHand(){handDock?.setCards(handCards().filter(c=>!filter||matches(c)).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)||a.cardId.localeCompare(b.cardId)));}

function render() { applyView(); renderGroups(); renderCards(); renderStickies(); renderHand(); updateChrome(); }
function updateChrome() {
  const total = state.cards.length;
  countEl.textContent = total ? `${total} card${total === 1 ? "" : "s"}` : "";
  emptyEl.classList.toggle("show", total === 0);
}

// ---------------- grouping logic (hysteresis + preview) ----------------
function liveGroup(c) {
  indexMembership();
  const center = centerOf(c);
  if (c.group) {
    const others = membersOf(c.group).filter((m) => m.cardId !== c.cardId);
    if (others.length >= 1 && pointInPolygon(center, geometry.get(c.group,others.map(rectOf),REMOVE_PAD).outline)) return c.group;
  }
  for (const g of state.groups) {
    if (g.id === c.group) continue;
    const mem = membersOf(g.id).filter((m) => m.cardId !== c.cardId);
    if (mem.length >= 1 && pointInPolygon(center, geometry.get(g.id,mem.map(rectOf),ADD_PAD).outline)) return g.id;
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
  indexMembership();
  const min = S.soloGroups ? 1 : 2;
  const dels = [];
  state.groups = state.groups.filter((g) => {
    const m = membersOf(g.id);
    if (m.length < min) { if (!S.soloGroups) m.forEach((c) => { c.group = null; persist(c); }); dels.push(delGroupRec(g.id)); return false; }
    return true;
  });
  return Promise.all(dels);
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
  indexMembership();
  if (S.soloGroups) { for (const c of state.cards) if (c.placed && !c.group) ensureSoloGroup(c); }
  else pruneGroups();
}
function stickiesNearGroup(gid) {
  const mem = membersOf(gid);
  if (!mem.length) return [];
  const pad = GROUP_PAD + stickySize() / 2;
  const outline = groupOutline(mem.map(rectOf), pad);
  return state.stickies.filter((s) => pointInPolygon(centerOfSticky(s), outline));
}

// ---------------- selection ----------------
function selectOnly(id) { selection.clear(); selection.add(id); reflectSelection(); }
function toggleSel(id) { selection.has(id) ? selection.delete(id) : selection.add(id); reflectSelection(); }
function clearSel() { if (selection.size) { selection.clear(); reflectSelection(); } }
function reflectSelection() {
  cardsEl.querySelectorAll(".card").forEach((el) => el.classList.toggle("selected", selection.has(el.dataset.id)));
  stickiesEl.querySelectorAll(".sticky").forEach((el) => el.classList.toggle("selected", selection.has(el.dataset.id)));
}
// Delete the current selection — cards and stickies are partitioned to their own delete paths.
function deleteSelection() {
  const ids=[...selection];removeEntities(ids.filter(id=>card(id)),ids.filter(id=>sticky(id))).catch(saveError);
}

// ---------------- interaction lifecycle (RAII, replaces the old `busy` boolean) ----------------
// A pointer drag owns an AbortController; every listener it adds uses {signal}, so one abort()
// removes them all. endGesture() is idempotent and is the ONLY teardown path — reached via the
// drag's own pointerup/pointercancel, the lostpointercapture safety net, a tab-hide, or the
// defensive call below. There is no flag to forget, so the interaction state cannot latch.
function beginGesture(el,pointerId,onTeardown,before=snapshotUI()) {
  endGesture(true);
  const writes=new Map(pendingWrites),oldDirty=new Set(dirty),view={...state.view};
  const visuals=state.cards.map(c=>({id:c.cardId,value:structuredClone(c)}));
  const notes=structuredClone(state.stickies),groups=structuredClone(state.groups);
  let gesture;
  gesture=new GestureSession(el,pointerId,{
    onCancel:()=>{
      pendingWrites.clear();for(const [k,v]of writes)pendingWrites.set(k,v);dirty.clear();for(const id of oldDirty)dirty.add(id);
      for(const row of visuals){const c=card(row.id);if(c)Object.assign(c,row.value);}
      for(const row of before)if(row.store==='layout'&&row.value&&card(row.key))Object.assign(card(row.key),row.value);
      state.groups=groups;for(const n of notes){const current=sticky(n.id);if(current)Object.assign(current,n);}
      state.view=view;
    },
    onCleanup:()=>{if(activeGesture===gesture)activeGesture=null;onTeardown?.();if(gesture.canceled){render();drainPending();}}
  });
  const cancel=gesture.cancel.bind(gesture);gesture.cancel=()=>{gesture.canceled=true;cancel();};
  activeGesture=gesture;return gesture.signal;
}
function endGesture(cancel=false){const gesture=activeGesture;if(!gesture)return;cancel?gesture.cancel():gesture.finish();}
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
function bumpZ(c, el) { c.z = ++state.zmax; if (el) el.style.zIndex = c.z; }
function startCardDrag(e, c, el) {
  if (e.button !== 0 || criticalDepth || retryActions.size) return;
  e.stopPropagation();
  closeMenu(); hideUrlPop();
  const before=snapshotUI();
  bumpZ(c, el);
  const multi = (e.shiftKey || e.ctrlKey || e.metaKey);
  if (multi) toggleSel(c.cardId);
  else if (!selection.has(c.cardId)) selectOnly(c.cardId);
  const movingMany = selection.size > 1 && selection.has(c.cardId);
  if(multi&&!selection.has(c.cardId))return;
  const group = movingMany ? state.cards.filter((k) => selection.has(k.cardId)) : [c];
  const noteStarts=state.stickies.filter(n=>selection.has(n.id)).map(n=>({n,x:n.x,y:n.y}));
  const starts = group.map((k) => ({ k, x: k.x, y: k.y }));
  const start = toWorld(e.clientX, e.clientY);
  const downX = e.clientX, downY = e.clientY; let moved = false;
  el.classList.add("dragging");
  const signal = beginGesture(el, e.pointerId, () => { el.classList.remove("dragging"); clearZones(); hidePreview(); },before);

  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - downX, ev.clientY - downY) > 4) { moved = true; hideUrlPop(); }
    const w = toWorld(ev.clientX, ev.clientY);
    const dx = w.x - start.x, dy = w.y - start.y;
    for (const s of starts) {
      s.k.x = s.x + dx; s.k.y = s.y + dy;
      const ke = cardsEl.querySelector(`[data-id="${s.k.cardId}"]`);
      if (ke) { ke.style.left = s.k.x + "px"; ke.style.top = s.k.y + "px"; }
    }
    for(const o of noteStarts){o.n.x=o.x+dx;o.n.y=o.y+dy;const node=stickiesEl.querySelector(`[data-id="${o.n.id}"]`);if(node){node.style.left=o.n.x+'px';node.style.top=o.n.y+'px';}}
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
    scheduleGroups();
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
        if (overTrash(ev.clientX, ev.clientY)) removeEntities(group.map(k=>k.cardId),noteStarts.map(o=>o.n.id)).catch(saveError);
        else if (overHand(ev.clientX, ev.clientY)) { group.forEach((k) => { k.placed = false; k.group = null; persist(k); }); pruneGroups(); commitUI(before,"Send to hand").catch(saveError); render(); }
        else { if (!movingMany) finalizeGroup(c); group.forEach((k) => persist(k)); commitUI(before,"Move").catch(saveError); render(); }
      } else { persist(c); } // a plain click saves the raised z-order without a move undo
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
  const before=snapshotUI();
  const orig = membersOf(g.id).map((c) => ({ c, x: c.x, y: c.y }));
  const notes = stickiesNearGroup(g.id).map((s) => ({ s, x: s.x, y: s.y }));
  const signal = beginGesture(tableEl, e.pointerId, () => { tableEl.style.cursor = ""; },before);
  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY); const dx = w.x - start.x, dy = w.y - start.y;
    for (const o of orig) {
      o.c.x = o.x + dx; o.c.y = o.y + dy;
      const el = cardsEl.querySelector(`[data-id="${o.c.cardId}"]`);
      if (el) { el.style.left = o.c.x + "px"; el.style.top = o.c.y + "px"; }
    }
    for (const o of notes) {
      o.s.x = o.x + dx; o.s.y = o.y + dy;
      const el = stickiesEl.querySelector(`[data-id="${o.s.id}"]`);
      if (el) { el.style.left = o.s.x + "px"; el.style.top = o.s.y + "px"; }
    }
    scheduleGroups();
  };
  const finish = () => { endGesture(); try { orig.forEach((o) => persist(o.c)); notes.forEach((o) => saveSticky(o.s)); commitUI(before,"Move group").catch(saveError); render(); } finally { drainPending(); } };
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
    if (hoverEv.target.closest(".card") || hoverEv.target.closest(".sticky") || hoverEv.target.closest(".group-label")) { setNear(null); return; }
    const g = nearestGroupOutline(toWorld(hoverEv.clientX, hoverEv.clientY));
    setNear(g ? g.id : null);
  });
});

// ---------------- hand dragging ----------------
// A press alone must NOT move the card (so a click just rests, and a double-click can open) — the
// floater is only spawned once the pointer travels past a small threshold, i.e. a genuine drag.
function startHandDrag(e, c, el, captureEl=el) {
  if (e.button !== 0 || criticalDepth || retryActions.size) return;
  const before=snapshotUI();
  const downX = e.clientX, downY = e.clientY;
  let floater = null, moved = false;
  // capture up front so even a fast flick lands its first move (capture doesn't change click/dblclick target)
  const signal = beginGesture(captureEl, e.pointerId, () => {
    handDock?.endGesture();clearZones(); hidePreview();
    if (floater) floater.remove();
    el.style.visibility = "";
  },before);
  const begin = () => {
    moved = true; hideUrlPop(); handDock?.clearHover();
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
      else { c.placed = true; finalizeGroup(c); persist(c); commitUI(before,"Place card").catch(saveError); render(); }
    } finally { drainPending(); }
  };
  captureEl.addEventListener("pointermove", move, { signal });
  captureEl.addEventListener("pointerup", finish, { signal });
  captureEl.addEventListener("pointercancel", finish, { signal });
}

// ---------------- drop zones ----------------
function overTrash(x, y) { const r = trashEl.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
// The hand's real footprint (centered, sized to the resting cards) — you must aim INTO it, not just
// graze the bottom edge. Width comes from the live hand count (not getBoundingClientRect) so the
// ghost preview, which transiently widens #hand, can't feed back into the hit-test and cause flicker.
function handDropRect(){return handEl.getBoundingClientRect();}
function overHand(x, y) { const r = handDropRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
function hotZones(x, y) { const t = overTrash(x, y); trashEl.classList.toggle("hot", t); handEl.classList.toggle("receiving", !t && overHand(x, y)); }
function clearZones() { trashEl.classList.remove("hot"); handEl.classList.remove("receiving"); hideHandPreview(); }

// ---------------- commands ----------------
async function openCard(id,destination='current') { try{await flush();await send({type:CT.MSG.OPEN,cardId:id,destination});}catch(e){saveError(e);} }
const layoutRecord=c=>({cardId:c.cardId,x:c.x,y:c.y,rot:c.rot,group:c.group,note:c.note,z:c.z,placed:c.placed});
function snapshotUI(){
  return [
    ...state.cards.map(c=>({store:'layout',key:c.cardId,value:(c.placed||model.rows.layout.has(c.cardId)||dirty.has(c.cardId))?layoutRecord(c):undefined,preview:layoutRecord(c),pendingFields:pendingWrites.get('layout:'+c.cardId)?.fields,pendingCreate:pendingWrites.get('layout:'+c.cardId)?.create,pendingBase:model.rows.layout.get(c.cardId)})),
    ...state.groups.map(g=>({store:'groups',key:g.id,value:{...g},pendingFields:pendingWrites.get('groups:'+g.id)?.fields,pendingCreate:pendingWrites.get('groups:'+g.id)?.create,pendingBase:model.rows.groups.get(g.id)})),
    ...state.stickies.map(n=>({store:'notes',key:n.id,value:{...n},pendingFields:pendingWrites.get('notes:'+n.id)?.fields,pendingCreate:pendingWrites.get('notes:'+n.id)?.create,pendingBase:model.rows.notes.get(n.id)}))
  ].map(r=>structuredClone(r));
}
function diffUI(before){
  const after=snapshotUI(),old=new Map(before.map(r=>[r.store+':'+r.key,r]));
  const next=new Map(after.map(r=>[r.store+':'+r.key,r]));const ops=[];
  for(const tag of new Set([...old.keys(),...next.keys()])){
    const a=old.get(tag),b=next.get(tag);if(JSON.stringify(a?.value)===JSON.stringify(b?.value))continue;
    const r=b||a;ops.push(b?.value===undefined?{type:'delete',store:r.store,key:r.key}:{type:'put',store:r.store,value:r.value});
  }
  return ops;
}
const undoStack=[],retryActions=new Map();
async function commitUI(before,label='Move',deleteCards=[]){
  if(retryActions.size)throw new Error('Retry the unsaved action before making another change');
  const operations=diffUI(before),commandId=CT.uuid(),epoch=model.epoch,held=new Map();
  for(const op of operations){const key=op.key??op.value?.cardId??op.value?.id,tag=op.store+':'+key;if(pendingWrites.has(tag))held.set(tag,pendingWrites.get(tag));pendingWrites.delete(tag);if(op.store==='layout')dirty.delete(key);}
  if(!operations.length&&!deleteCards.length)return;
  const perform=()=>withInteraction(async()=>{
    try{
      const result=await boardCommand('editBoard',{operations,before,label,deleteCards,commandId,epoch});
      retryActions.delete(commandId);
      for(const [tag,value]of held){const current=pendingWrites.get(tag);if(current===value){pendingWrites.delete(tag);if(value.store==='layout')dirty.delete(value.key);}else if(current?.blockedBy===commandId)pendingWrites.set(tag,{...current,blockedBy:undefined});}
      if(!undoStack.some(e=>e.token===result.token))undoStack.push({token:result.token,label});
      if(undoStack.length>50)undoStack.shift();
      for(const [,r]of held)if(!editing.has(r.key)&&!pendingWrites.has(r.store+':'+r.key))model.drafts.delete(r.key);
      showToast(label+(result.conflicts?.length?' (newer text kept)':''),true);
      await loadAll();render();
    }catch(e){
      for(const [tag,value]of held)if(!pendingWrites.has(tag)){const blocked={...value,blockedBy:commandId};held.set(tag,blocked);pendingWrites.set(tag,blocked);if(value.store==='layout')dirty.add(value.key);}
      retryActions.set(commandId,perform);throw e;
    }
  });
  return perform();
}
function removeCards(ids){return removeEntities(ids,[]).catch(saveError);}
async function removeEntities(cardIds,noteIds){
  hideUrlPop();
  return withInteraction(async()=>{
    await flush();const before=snapshotUI(),ids=new Set([...cardIds,...noteIds]);
    state.cards=state.cards.filter(c=>!ids.has(c.cardId));state.stickies=state.stickies.filter(n=>!ids.has(n.id));
    for(const id of ids){selection.delete(id);cardIndex.delete(id);model.drafts.delete(id);}
    await pruneGroups();
    try{await commitUI(before,`Deleted ${ids.size} item${ids.size===1?'':'s'}`,cardIds);}catch(e){saveError(e);}
  });
}
async function undo(){
  if(retryActions.size){showToast('Retry the unsaved action before undoing earlier work',false);return;}
  const entry=undoStack.at(-1);if(!entry)return;
  await withInteraction(async()=>{
    try{await flush();await boardCommand('undo',{token:entry.token});undoStack.pop();hideToast();await loadAll();render();}
    catch(e){showToast(e.message,false);}
  });
}

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
  const ids = selection.size ? [...selection].filter((id) => card(id)) : (c ? [c.cardId] : []);   // card actions ignore any stickies in the selection
  const items = [];
  if (c) {
    items.push(["Open", () => openCard(c.cardId)]);
    items.push(["Open in new window",()=>openCard(c.cardId,"newWindow")]);
    items.push(["Copy URL", () => navigator.clipboard && navigator.clipboard.writeText(c.url)]);
    items.push(["Send to hand", () => { const before=snapshotUI(); ids.forEach((id) => { const k = card(id); if (k) { k.placed = false; k.group = null; persist(k); } }); pruneGroups(); commitUI(before,"Send to hand").catch(saveError); render(); }]);
    items.push(["sep"]);
    items.push([`Close ${ids.length > 1 ? ids.length + " cards" : "card"}`, () => removeCards(ids), true]);
  } else {
    const w = toWorld(x, y);
    items.push(["Add sticky note", () => addSticky(w.x, w.y, true)]);
    items.push(["Fit all", fit]);
    items.push(["Settings", openSettings]);
  }
  showMenu(x, y, items);
}
function openStickyMenu(x, y, s) {
  showMenu(x, y, [["Edit text", () => startStickyEdit(s)], ["sep"], ["Delete note", () => deleteSticky(s), true]]);
}
function showMenu(x, y, items) {
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
  if (e.button !== 0 || e.target.closest(".card") || e.target.closest(".sticky") || e.target.closest(".group-label")) return;
  const gNear = nearestGroupOutline(toWorld(e.clientX, e.clientY));
  if (gNear) { startGroupDrag(e, gNear); return; }     // press on/near an outline grabs the group
  clearSel();
  if(criticalDepth)return;
  tableEl.classList.add('panning');
  const signal=beginGesture(tableEl,e.pointerId,()=>tableEl.classList.remove('panning'));
  const sx=e.clientX,sy=e.clientY,ox=state.view.x,oy=state.view.y;
  tableEl.addEventListener('pointermove',ev=>{state.view.x=ox+ev.clientX-sx;state.view.y=oy+ev.clientY-sy;applyView();},{signal});
  tableEl.addEventListener('pointerup',()=>{endGesture();saveView();drainPending();},{signal});
});
tableEl.addEventListener("contextmenu", (e) => { if (e.target.closest(".card") || e.target.closest(".sticky")) return; e.preventDefault(); openMenu(e.clientX, e.clientY, null); });
tableEl.addEventListener("wheel", (e) => {
  e.preventDefault(); hideUrlPop();
  if(activeGesture)return;
  const z = Math.max(0.2, Math.min(3, state.view.zoom * Math.exp(-e.deltaY * 0.0015)));
  const w = toWorld(e.clientX, e.clientY);
  state.view.x = e.clientX - w.x * z; state.view.y = e.clientY - w.y * z; state.view.zoom = z;
  applyView(); saveView();
}, { passive: false });

function fit() {
  const bb=fitBounds(state.cards.filter(c=>c.placed),state.stickies,{cardWidth:CARD_W,cardHeight:CARD_H,stickySize:stickySize()});if(!bb)return;
  const pad=80,top=$('bar').getBoundingClientRect().bottom+20,bottom=HAND_ZONE_H,vw=innerWidth,vh=Math.max(100,innerHeight-top-bottom);
  const z=Math.max(0.2,Math.min(1.5,Math.min(vw/(bb.maxX-bb.minX+pad*2),vh/(bb.maxY-bb.minY+pad*2))));
  state.view.zoom=z;state.view.x=(vw-(bb.minX+bb.maxX)*z)/2;state.view.y=top+(vh-(bb.minY+bb.maxY)*z)/2;
  applyView(); saveView();
}

// ---------------- keyboard ----------------
window.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if (e.key === "/" && !typing) { e.preventDefault(); searchEl.focus(); return; }
  if (typing) { if (e.key === "Escape") e.target.blur(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && selection.size) { e.preventDefault(); deleteSelection(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
  else if (e.key.toLowerCase() === "f") fit();
  else if (e.key === "Enter" && selection.size === 1) { const id = [...selection][0]; const s = sticky(id); s ? startStickyEdit(s) : openCard(id); }
  else if (e.key === "Escape") { clearSel(); closeMenu(); }
});

// ---------------- search ----------------
let searchT = null;
searchEl.addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(() => { filter = searchEl.value.trim(); renderCards(); renderGroups(); renderHand(); }, 120); });

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
// Build the preview through the real card builder so it always matches actual cards. Sample data only.
function buildPreviewCard() {
  let favicon = ""; try { favicon = X.runtime.getURL("icons/icon-48.png"); } catch (e) {}
  const el = buildCard({
    cardId: "preview", url: "https://example.com/your/page", title: "cardtable — your tabs as cards",
    favicon, state: "live", note: "drag me onto the felt", shotUrl: null, x: 0, y: 0, rot: 0, z: 1,
  }, false);
  el.id = "s-preview-card";
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
  // Fixed "zoom" into the table (not a function of cw) so a wider card reads as wider, with text
  // holding its apparent size — matching the real canvas. Sized so the widest slider value still
  // fits the preview frame; the stage flex-centres it.
  const cwMax = +$("s-cardw").max || cw;
  card.style.transform = `scale(${Math.min(1, 200 / cwMax)})`;
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
  const stickySize = +$("s-stickysize").value || CT.DEFAULTS.stickySize;
  const stickyFontSize = +$("s-stickyfontsize").value || CT.DEFAULTS.stickyFontSize;
  const stickyEl = $("s-preview-sticky");
  if (stickyEl) {
    stickyEl.style.background = $("s-stickycolor").value || CT.DEFAULTS.stickyColor;
    stickyEl.style.fontFamily = $("s-stickyfont").value || CT.DEFAULTS.stickyFont;
    stickyEl.style.fontSize = stickyFontSize + "px";
  }
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  set("s-cardw-val", cw + "px"); set("s-size-val", size + "px");
  set("s-notesize-val", noteSize + "px"); set("s-groupsize-val", groupSize + "px");
  set("s-stickysize-val", stickySize + "px"); set("s-stickyfontsize-val", stickyFontSize + "px");
  set("s-quality-val", (+$("s-quality").value).toFixed(2));
}
function wireSettings() {
  for (const id of ["s-theme", "s-felt", "s-cardw", "s-font", "s-size", "s-titlelines",
    "s-notefont", "s-notesize", "s-groupfont", "s-groupsize",
    "s-stickycolor", "s-stickysize", "s-stickyfont", "s-stickyfontsize", "s-quality"]) {
    $(id).addEventListener("input", updatePreview);
  }
}
function openSettings() {
  buildFontOptions($("s-font")); buildFontOptions($("s-notefont")); buildFontOptions($("s-groupfont")); buildFontOptions($("s-stickyfont"));
  $("s-theme").value = S.theme; $("s-felt").value = S.feltColor; $("s-cardw").value = S.cardWidth;
  setFontValue($("s-font"), S.labelFont || CT.DEFAULTS.labelFont);
  setFontValue($("s-notefont"), S.noteFont || CT.DEFAULTS.noteFont);
  setFontValue($("s-groupfont"), S.groupFont || CT.DEFAULTS.groupFont);
  setFontValue($("s-stickyfont"), S.stickyFont || CT.DEFAULTS.stickyFont);
  $("s-titlelines").value = S.titleLines || 1; $("s-size").value = S.labelSize || 18;
  $("s-notesize").value = S.noteSize || CT.DEFAULTS.noteSize; $("s-groupsize").value = S.groupSize || CT.DEFAULTS.groupSize;
  $("s-stickycolor").value = S.stickyColor || CT.DEFAULTS.stickyColor;
  $("s-stickysize").value = S.stickySize || CT.DEFAULTS.stickySize;
  $("s-stickyfontsize").value = S.stickyFontSize || CT.DEFAULTS.stickyFontSize;
  $("s-quality").value = S.shotQuality;
  $("s-hand").checked = S.handOnNewTab; $("s-keep-hand").checked = !!S.keepHandCardsOnTabClose; $("s-solo").checked = S.soloGroups; $("s-reduce").checked = S.reducedMotion;
  $("s-favicons").checked = S.showFavicons !== false;
  $("s-newtab").checked = !!S.newTabOpensCanvas;
  $("s-pin").checked = S.pinCanvasTab !== false;
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
  try {
  S.theme = $("s-theme").value; S.feltColor = $("s-felt").value || CT.DEFAULTS.feltColor;
  S.cardWidth = +$("s-cardw").value; S.labelFont = $("s-font").value || CT.DEFAULTS.labelFont;
  S.shotQuality = +$("s-quality").value;
  S.titleLines = Math.max(1, Math.min(5, +$("s-titlelines").value || 1));
  S.labelSize = Math.max(11, Math.min(34, +$("s-size").value || 18));
  S.noteFont = $("s-notefont").value || CT.DEFAULTS.noteFont;
  S.noteSize = Math.max(9, Math.min(22, +$("s-notesize").value || CT.DEFAULTS.noteSize));
  S.groupFont = $("s-groupfont").value || CT.DEFAULTS.groupFont;
  S.groupSize = Math.max(14, Math.min(48, +$("s-groupsize").value || CT.DEFAULTS.groupSize));
  S.stickyColor = $("s-stickycolor").value || CT.DEFAULTS.stickyColor;
  S.stickySize = Math.max(120, Math.min(320, +$("s-stickysize").value || CT.DEFAULTS.stickySize));
  S.stickyFont = $("s-stickyfont").value || CT.DEFAULTS.stickyFont;
  S.stickyFontSize = Math.max(11, Math.min(34, +$("s-stickyfontsize").value || CT.DEFAULTS.stickyFontSize));
  S.handOnNewTab = $("s-hand").checked; S.keepHandCardsOnTabClose = $("s-keep-hand").checked; S.soloGroups = $("s-solo").checked; S.reducedMotion = $("s-reduce").checked;
  S.showFavicons = $("s-favicons").checked;
  S.newTabOpensCanvas = $("s-newtab").checked;
  S.pinCanvasTab = $("s-pin").checked;
  await saveSettings(); applyTheme(); ensureGroups(); closeSettings(); render();
  } catch(e) { showToast("Settings not saved: "+e.message,false); }
});

// import / export: one validated background transaction; never clear stores from the page.
async function boardCommand(name, input) {
  const r = await send({type:CT.MSG.COMMAND,name,input});
  if (!r?.ok) throw new Error(r?.error?.message || 'Board command failed');
  return r;
}
$("s-export").addEventListener("click", async () => {
  try {
    if(retryActions.size)throw new Error('Retry the unsaved action before exporting');
    await flush();
    const data = await boardCommand('exportBoard'); data.settings=S; data.view=state.view;
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='cardtable-board.json'; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  } catch(e) { showToast(e.message,false); }
});
$("s-import").addEventListener("click",()=>$("s-file").click());
$("s-file").addEventListener("change",async e=>{
  const file=e.target.files[0]; if(!file)return;
  try {
    if(file.size>25*1024*1024)throw new Error('Board file exceeds 25 MiB');
    const board=JSON.parse(await file.text()),mode=$("s-import-mode").value;
    await withInteraction(async()=>{
      await flush();
      const result=await boardCommand('importBoard',{mode,board});
      if(mode==='replace') {
        undoStack.length=0;retryActions.clear();pendingWrites.clear();dirty.clear();model.drafts.clear();$('toast-retry').hidden=true;
        if(result.settings) { S=CT.normalizeSettings(result.settings); await saveSettings(); }
        if(result.view) { state.view=result.view; await X.storage.local.set({view:state.view}); }
      }
      await loadAll(); applyTheme(); render(); closeSettings();
      showToast(`${mode==='replace'?'Board replaced':'Board merged'}: ${result.added} added, ${result.skipped} kept`,false);
    });
  }catch(err){showToast('Import failed: '+err.message,false);}
  e.target.value='';
});

// ---------------- toolbar + global ----------------
$("btn-fit").addEventListener("click", fit);
$("btn-note").addEventListener("click", () => { const w = toWorld(innerWidth / 2, innerHeight / 2); addSticky(w.x, w.y, true); });
$("toast-undo").addEventListener("click", undo);
$("toast-retry").addEventListener("click",async()=>{try{for(const action of [...retryActions.values()])await action();await flush();$('toast-retry').hidden=true;}catch(e){saveError(e);}});
window.addEventListener("click", (e) => { if (!e.target.closest("#menu")) closeMenu(); });
// Capture phase (runs before card/group drag handlers): commit an open note/group-name edit
// the instant you press elsewhere, and clear any stray text selection.
document.addEventListener("pointerdown", (e) => {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !a.contains(e.target)) a.blur();   // fires blur → saves before any re-render
  if (!e.target.closest('input, textarea')) {
    const sel = window.getSelection(); if (sel && !sel.isCollapsed) sel.removeAllRanges();
  }
}, true);
window.addEventListener("resize", positionLabels);
window.addEventListener("pagehide",()=>{flush().catch(saveError);});
window.addEventListener("beforeunload", () => { for(const cache of [shotUrls,iconUrls])for(const u of cache.values())URL.revokeObjectURL(u); });

// ---------------- reactivity ----------------
let reloadT = null;
function scheduleReload() {
  clearTimeout(reloadT);
  if(isInteracting()){pendingReload=true;return;}
  reloadT=setTimeout(async()=>{
    if(isInteracting()){pendingReload=true;return;}
    try{await loadAll();if(!isInteracting())render();else pendingReload=true;}catch(e){saveError(e);}
  },250);
}
X.runtime.onMessage.addListener(msg=>{
  if(msg?.type!==CT.MSG.CHANGED)return;
  if(isInteracting()){pendingReload=true;return;}
  if(!msg.change||!model.apply(msg.change)){scheduleReload();return;}
  syncModel().then(()=>{
    if(isInteracting()){pendingReload=true;return;}render();
    for(const row of msg.change.upserts?.shots||[])loadShot(row.cardId).then(()=>{if(!activeGesture){renderCards();renderHand();}});
  }).catch(saveError);
});
// Settings can change in another canvas tab (or be imported elsewhere) — keep this tab's live copy,
// theme, and groups in sync. background.js has its own storage.onChanged; this is the page's.
X.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.settings) return;
  S = CT.normalizeSettings(ch.settings.newValue);
  applyTheme();        // immediate visual sync (theme / font / size / width)
  scheduleReload();    // membership-affecting changes (soloGroups) reconcile from fresh DB state, not stale in-memory groups
});
// Failsafe: a drag can't outlive the canvas tab being hidden (opening a card switches tabs). If a
// pointerup/pointercancel is ever missed, the gesture would otherwise stay open. Route the tab-hide
// through the same single teardown door (endGesture); on return, pull in anything that changed.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (activeGesture) { endGesture(true); render(); drainPending(); } }
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
  handDock=createHand({root:handEl,buildCard,presentationKey:()=>S.showFavicons,reducedMotion:()=>!!S.reducedMotion,canInteract:()=>!criticalDepth&&!retryActions.size,
    onPointerDown:startHandDrag,onActivate:openCard,onHover:(c,node)=>{if(c&&node)scheduleUrlPop(node,c.url);else hideUrlPop();}});
  wireSettings();
  await loadSettings();
  await loadAll();
  render();
  refreshPermUI();
})();
