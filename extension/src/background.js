// Classic background: Chromium MV3 worker / Firefox event page. No browser-side bundler.
if (typeof CT === 'undefined') importScripts('shared.js');
if (typeof CTStore === 'undefined') importScripts('storage.js', 'commands.js', 'board-format.js', 'board-undo.js', 'capture.js');
const X = globalThis.browser || globalThis.chrome;
const idbGet = CTStore.get, idbAll = CTStore.all;
const put = (store, value) => ({ type: 'put', store, value });
const del = (store, key) => ({ type: 'delete', store, key });
let settings = { ...CT.DEFAULTS }, bindings = {};
const isCanvas = url => typeof url === 'string' && url.startsWith(X.runtime.getURL('newtab.html'));
const tracked = tab => tab && CT.isTrackable(tab.url) && !isCanvas(tab.url);
const report = e => console.error('[cardtable]', e);
const queueEvent = fn => CTCommands.enqueue(fn).catch(report);
CTCommands.subscribe(change => { X.runtime.sendMessage({ type: CT.MSG.CHANGED, change }).catch(() => {}); });
async function loadSettings() {
  const { settings: saved } = await X.storage.local.get('settings');
  settings = CT.normalizeSettings(saved);
  if (saved && Object.keys(saved).some(k => !Object.hasOwn(CT.DEFAULTS, k))) await X.storage.local.set({ settings });
}
async function saveBindings() { await X.storage.session.set({ bindings }); }
async function cardByTab(id) {
  const c = bindings[id] ? await idbGet('tabs', bindings[id]) : null;
  return c?.tabId === id ? c : null;
}
function newCard(t) {
  return { cardId: CT.uuid(), url: t.url, title: t.title || t.url, favicon: t.favIconUrl || '', tabId: t.id, windowId: t.windowId, state: 'live', createdAt: Date.now(), lastSeen: Date.now(), scrollY: 0 };
}
function bind(c, t) {
  if (c.tabId != null && c.tabId !== t.id && bindings[c.tabId] === c.cardId) delete bindings[c.tabId];
  bindings[t.id] = c.cardId;
  return { ...c, tabId: t.id, windowId: t.windowId, url: t.url, title: t.title || c.title, favicon: t.favIconUrl || c.favicon, state: 'live', lastSeen: Date.now() };
}
async function reconcile() {
  const all=await X.tabs.query({}),cards=await idbAll('tabs'),old=bindings;
  const byId=new Map(cards.map(c=>[c.cardId,c])),byUrl=new Map();
  for(const c of cards){const key=CT.normUrl(c.url);if(!byUrl.has(key))byUrl.set(key,[]);byUrl.get(key).push(c);}
  const pending=t=>byId.get(old[t.id])?.opening&&(!t.url||t.url==='about:blank');
  const open=all.filter(t=>tracked(t)||pending(t));bindings={};
  const used=new Set(),ops=[],reserved=new Set(open.map(t=>old[t.id]).filter(id=>byId.has(id)));
  for(const t of open){
    let c=byId.get(old[t.id]);if(c&&used.has(c.cardId))c=null;
    if(!c)c=byUrl.get(CT.normUrl(t.url))?.find(c=>!used.has(c.cardId)&&!reserved.has(c.cardId));
    const opening=!tracked(t);
    c={...bind(c||newCard(t),opening?{...t,url:c.url}:t),opening};used.add(c.cardId);ops.push(put('tabs',c));
  }
  for(const c of cards)if(!used.has(c.cardId)&&(c.tabId!=null||c.state!=='cold'))ops.push(put('tabs',{...c,tabId:null,state:'cold'}));
  await CTCommands.commit(ops);await saveBindings();
}
async function ensureCardForTab(tab) {
  // Resolve a fresh browser tab; delayed events must not recreate a tab that has closed.
  try { tab = await X.tabs.get(tab.id); } catch { return null; }
  if (!tracked(tab)) return null;
  let c = await cardByTab(tab.id);
  if (c) return c;
  c = bind(newCard(tab), tab);
  await CTCommands.commit([put('tabs', c)]); await saveBindings(); return c;
}
async function updateTab(tab,info={}) {
  try { tab = await X.tabs.get(tab.id); } catch { return; }
  if (!tracked(tab)) {
    const c=await cardByTab(tab.id);
    // Firefox initially exposes a newly created navigation as about:blank.
    if(c?.opening&&(!tab.url||tab.url==='about:blank')&&info.url!=='about:blank')return;
    if(c){delete bindings[tab.id];capture.cancel(tab.id);await CTCommands.commit([put('tabs',{...c,tabId:null,state:'cold'})]);await saveBindings();}
    return;
  }
  const c = await ensureCardForTab(tab); if (!c) return;
  const next = {...bind(c, tab),opening:false};
  next.generation = (c.generation || 0) + (c.url !== tab.url ? 1 : 0);
  if (c.url !== next.url || c.title !== next.title || c.favicon !== next.favicon || c.state !== next.state || c.opening) await CTCommands.commit([put('tabs', next)]);
}
async function cacheFavicon(cardId,source){
  const data=CT.localFavicon(source);if(!data)return;
  const [header,encoded]=data.split(','),mime=header.slice(5,header.indexOf(';'));
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const shot=await idbGet('shots',cardId);
  await CTCommands.commit([put('shots',{...shot,cardId,faviconBlob:new Blob([bytes],{type:mime})})]);
}
const rkey = id => 'restore:' + id;
async function openCard({ cardId, destination = 'current' }) {
  let c = await idbGet('tabs', cardId); if (!c) throw new Error('Card no longer exists');
  let tab = null, created = false;
  if (c.tabId != null && bindings[c.tabId] === c.cardId) {
    try { tab = await X.tabs.get(c.tabId);if(!tracked(tab)&&!(c.opening&&tab.status==='loading'))tab=null; } catch { /* cold reopen */ }
  }
  if (tab) {
    if (destination === 'newWindow') {
      const win = await X.windows.create({ tabId: tab.id }); tab = { ...tab, windowId: win.id };
    } else {
      await X.tabs.update(tab.id, { active: true });
      await X.windows.update(tab.windowId, { focused: true });
    }
  } else {
    created = true;
    if (destination === 'newWindow') {
      const win = await X.windows.create({ url: c.url, focused: true });
      tab = win.tabs?.[0] || (await X.tabs.query({ windowId: win.id }))[0];
    } else tab = await X.tabs.create({ url: c.url, active: true });
    if (!tab) throw new Error('Browser did not create a tab');
  }
  const before = { ...bindings }, next = {...bind(c,tracked(tab)?tab:{...tab,url:c.url}),opening:!tracked(tab)};
  try { await CTCommands.commit([put('tabs', next)]); }
  catch (e) {
    bindings = before;
    if (created) { try { await X.tabs.remove(tab.id); } catch (cleanup) { report(cleanup); } }
    throw e;
  }
  try {
    await saveBindings();
    if (created) await X.storage.session.set({ [rkey(tab.id)]: c.scrollY || 0 });
  } catch (e) { report(e); } // successful binding remains authoritative if optional session saving fails
  return { cardId, tabId: tab.id };
}
async function deleteCardRecords(cardId) {
  await CTCommands.commit([del('tabs', cardId), del('shots', cardId), del('layout', cardId)]);
}
async function deleteCard(cardId) {
  const c = await idbGet('tabs', cardId);
  if (c?.tabId != null && bindings[c.tabId] === cardId) {
    try { await X.tabs.remove(c.tabId); } catch (e) {
      try { await X.tabs.get(c.tabId); throw e; } catch (gone) { if (gone === e) throw e; }
    }
    delete bindings[c.tabId];
  }
  await deleteCardRecords(cardId); await saveBindings();
}
async function focusCanvas() {
  const existing = (await X.tabs.query({})).find(t => isCanvas(t.url));
  if (existing) {
    await X.tabs.update(existing.id, { active: true }); await X.windows.update(existing.windowId, { focused: true });
  } else await X.tabs.create({ url: X.runtime.getURL('newtab.html'), pinned: settings.pinCanvasTab !== false });
}
async function applyCanvasPin() {
  for (const t of await X.tabs.query({})) if (isCanvas(t.url) && t.pinned !== settings.pinCanvasTab) await X.tabs.update(t.id, { pinned: settings.pinCanvasTab !== false });
}
const NEWTAB_URLS = ['chrome://newtab/', 'chrome://new-tab-page/', 'edge://newtab/', 'brave://newtab/', 'about:newtab', 'about:home'];
async function routeNewTabToCanvas(tab) {
  const all = await X.tabs.query({});
  const existing = all.find(t => isCanvas(t.url) && t.id !== tab.id);
  if (existing && all.filter(t => t.windowId === tab.windowId).length > 1) {
    await focusCanvas(); await X.tabs.remove(tab.id);
  } else await X.tabs.update(tab.id, { url: X.runtime.getURL('newtab.html'), pinned: settings.pinCanvasTab !== false });
}
// Encoding does not hold the command queue. Only prepare/commit touch board state.
let captureEpoch=0;
const capture=CTCapture.create({browser:X,settings:()=>settings,report,
  prepare:tab=>CTCommands.enqueue(async()=>{
    const c=await cardByTab(tab.id);return c&&c.url===tab.url?{cardId:c.cardId,tabId:tab.id,url:c.url,generation:c.generation||0,epoch:captureEpoch}:null;
  }),
  commit:(token,blob)=>CTCommands.enqueue(async()=>{
    const c=await idbGet('tabs',token.cardId);
    if(!c||token.epoch!==captureEpoch||c.tabId!==token.tabId||c.url!==token.url||(c.generation||0)!==token.generation||bindings[c.tabId]!==c.cardId)return;
    const previous=await idbGet('shots',c.cardId);
    await CTCommands.commit([put('shots',{...previous,cardId:c.cardId,blob,ts:Date.now()})]);
  })
});
const scheduleCapture=tab=>capture.request(tab);
const captureTab=tab=>capture.capture(tab);
// Initialization occupies the queue before any event or page command can run.
const ready = CTCommands.enqueue(async () => {
  await loadSettings(); bindings = (await X.storage.session.get('bindings')).bindings || {};
  await reconcile();
});
ready.catch(report);
globalThis.CTBackground = { ready };
async function editBoard(input) {
  if(input.epoch!==undefined&&input.epoch!==((await idbGet('meta','boardEpoch'))?.value||0))throw new Error('Board was replaced; this edit is no longer valid');
  const operations=[...(input.operations||[])];
  // Only explicit deletion commands may touch tab identities or screenshot blobs.
  if(operations.some(o=>!['layout','groups','notes'].includes(o.store)||!['put','delete'].includes(o.type)))throw new Error('Invalid canvas edit');
  try {
  for(const id of input.deleteCards||[]){
    const c=await idbGet('tabs',id);if(!c)continue;
    if(c.tabId!=null&&bindings[c.tabId]===id){await X.tabs.remove(c.tabId);delete bindings[c.tabId];capture.cancel(c.tabId);}
    for(const store of ['tabs','shots','layout'])if(!operations.some(o=>o.store===store&&(o.key??o.value?.cardId)===id))operations.push(del(store,id));
  }
  return await CTUndo.edit({...input,operations});
  }
  catch(e){await reconcile();throw e;}
  finally{await saveBindings();}
}
CTCommands.register('editBoard',editBoard);
CTCommands.register('undo',({token})=>CTUndo.undo(token));
CTCommands.register('openCard', openCard);
CTCommands.register('deleteCard', ({ cardId }) => deleteCard(cardId));
CTCommands.register('focusCanvas', focusCanvas);
CTCommands.register('mutate', operations => CTCommands.commit(operations));
X.tabs.onCreated.addListener(tab => queueEvent(async () => {
  if (settings.newTabOpensCanvas && tab.active && NEWTAB_URLS.includes(tab.pendingUrl || tab.url)) return routeNewTabToCanvas(tab);
  await ensureCardForTab(tab);
}));
X.tabs.onUpdated.addListener((id, info, tab) => {
  queueEvent(() => updateTab(tab,info));
  if (info.status === 'complete' && tab.active && tracked(tab)) scheduleCapture(tab);
});
X.tabs.onActivated.addListener(({ tabId }) => { X.tabs.get(tabId).then(scheduleCapture).catch(() => {}); });
X.tabs.onRemoved.addListener(id => queueEvent(async () => {
  capture.cancel(id);
  await X.storage.session.remove(rkey(id));
  const c = await cardByTab(id); delete bindings[id];
  if (c) {
    const layout = await idbGet('layout', c.cardId);
    if (!settings.keepHandCardsOnTabClose && layout?.placed !== true) await deleteCardRecords(c.cardId);
    else await CTCommands.commit([put('tabs', { ...c, tabId: null, state: 'cold' })]);
  }
  await saveBindings();
}));
X.tabs.onReplaced?.addListener((added, removed) => queueEvent(async () => {
  const c = await cardByTab(removed); delete bindings[removed];
  if (c) { const t = await X.tabs.get(added); await CTCommands.commit([put('tabs', bind(c, t))]); await saveBindings(); }
}));
X.windows.onFocusChanged?.addListener(id => {
  if (id !== X.windows.WINDOW_ID_NONE) X.tabs.query({ active: true, windowId: id }).then(t => t[0] && scheduleCapture(t[0])).catch(report);
});
X.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) queueEvent(async () => { await loadSettings(); await applyCanvasPin(); });
});
X.runtime.onStartup?.addListener(() => queueEvent(reconcile));
X.runtime.onInstalled.addListener(() => queueEvent(reconcile));
X.commands?.onCommand.addListener(cmd => { if (cmd === 'focus-canvas') queueEvent(focusCanvas); });
X.action?.onClicked.addListener(() => queueEvent(focusCanvas));
X.permissions?.onAdded.addListener(() => { X.tabs.query({ active: true }).then(tabs => tabs.forEach(scheduleCapture)).catch(report); });
X.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.type === CT.MSG.CHANGED) return false;
  const page = isCanvas(sender.url || sender.tab?.url);
  const contentTypes = [CT.MSG.META, CT.MSG.CAPTURE, CT.MSG.SCROLL, CT.MSG.GET_SCROLL];
  if (!page && !contentTypes.includes(msg.type)) { respond({ ok: false, error: { code: 'FORBIDDEN', message: 'Canvas command only' } }); return false; }
  const run = async () => {
    switch (msg.type) {
      case CT.MSG.COMMAND: {
        if (!['importBoard','exportBoard','editBoard','undo'].includes(msg.name)) throw new Error('Unknown board command');
        if (msg.name === 'importBoard') captureEpoch++;
        const value = await CTCommands.invoke(msg.name, msg.input);
        if (msg.name === 'importBoard') { if (msg.input.mode === 'replace') bindings = {}; await reconcile(); }
        return value;
      }
      case CT.MSG.OPEN: return openCard({ cardId: msg.cardId, destination: msg.destination });
      case CT.MSG.DELETE: return deleteCard(msg.cardId);
      case CT.MSG.MUTATE: {
        if(msg.epoch!==undefined&&msg.epoch!==((await idbGet('meta','boardEpoch'))?.value||0))throw new Error('Board was replaced; reload before saving');
        if(!Array.isArray(msg.operations)||msg.operations.some(o=>!['layout','groups','notes'].includes(o.store)||!['put','patch','delete'].includes(o.type)))throw new Error('Invalid canvas mutation');
        return CTCommands.commit(msg.operations);
      }
      case CT.MSG.FOCUS_CANVAS: return focusCanvas();
      case CT.MSG.GET_ALL: return { tabs: await idbAll('tabs') };
      case CT.MSG.META: if (sender.tab) { await updateTab(sender.tab);const c=await cardByTab(sender.tab.id);if(c)await cacheFavicon(c.cardId,msg.favicon); } break;
      case CT.MSG.SCROLL: {
        const c = sender.tab && await cardByTab(sender.tab.id);
        if (c && Number.isFinite(msg.y)) await CTCommands.commit([put('tabs', { ...c, scrollY: Math.max(0, msg.y) })]); break;
      }
      case CT.MSG.GET_SCROLL: {
        if (!sender.tab) return { y: 0 };
        const key = rkey(sender.tab.id), r = await X.storage.session.get(key);
        await X.storage.session.remove(key); return { y: r[key] || 0 };
      }
      default: throw new Error('Unknown message');
    }
  };
  // Image encoding never holds the mutation queue. Its commit will be serialized separately.
  const promise = msg.type === CT.MSG.CAPTURE ? (sender.tab ? captureTab(sender.tab) : Promise.resolve()) : CTCommands.enqueue(run);
  promise.then(value => respond({ ok: true, ...(value || {}) }), e => respond({ ok: false, error: { code: 'COMMAND_FAILED', message: e.message || String(e) } }));
  return true;
});
