const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./helpers/runtime.cjs');
const { fakeBrowser } = require('./helpers/browser.cjs');
const fs = require('node:fs'), vm = require('node:vm');
async function setup(tabs, cards, bindings) {
  const b = fakeBrowser(tabs); if (bindings) b.session.bindings = bindings;
  const r = runtime({ browser: b.browser }, ['shared.js','storage.js','commands.js','board-format.js','board-undo.js','capture.js']);
  await r.CTCommands.commit(cards.map(value => ({ store: 'tabs', type: 'put', value })));
  vm.runInContext(fs.readFileSync('extension/src/background.js', 'utf8'), r);
  await r.CTBackground.ready;
  return { ...b, ...r };
}
const c = (cardId, url, tabId = null) => ({ cardId, url, tabId, title: cardId, state: tabId == null ? 'cold' : 'live' });
test('restart does not trust reused tab ID', async () => {
  const r = await setup([{ id: 1, url: 'https://b.test/' }], [c('a', 'https://a.test/', 1)]);
  assert.equal((await r.CTStore.get('tabs', 'a')).tabId, null);
  assert.equal((await r.CTStore.all('tabs')).length, 2);
});
test('concurrent cold opens and onCreated create exactly one binding', async () => {
  const r = await setup([], [c('a', 'https://a.test/')]);
  await Promise.all([r.CTCommands.run('openCard', { cardId: 'a' }), r.CTCommands.run('openCard', { cardId: 'a' })]);
  await r.CTCommands.idle();
  assert.equal(r.effects.filter(e => e[0] === 'create').length, 1);
  assert.equal((await r.CTStore.all('tabs')).length, 1);
});
test('worker restart preserves same-session binding after navigation', async () => {
  const r = await setup([{ id: 1, url: 'https://b.test/' }], [c('a', 'https://a.test/', 1)], { 1: 'a' });
  assert.equal((await r.CTStore.get('tabs', 'a')).url, 'https://b.test/');
  assert.equal((await r.CTStore.all('tabs')).length, 1);
});
test('duplicate URLs and fragment routes remain distinct', async () => {
  const url = 'https://a.test/#';
  const r = await setup([{ id: 1, url: url+'b' }, { id: 2, url: url+'a' }, { id: 3, url: url+'a' }], [c('a',url+'a'), c('b',url+'b'), c('a2',url+'a')]);
  assert.equal((await r.CTStore.get('tabs','b')).tabId,1);
  assert.equal((await r.CTStore.get('tabs','a')).tabId,2);
  assert.equal((await r.CTStore.get('tabs','a2')).tabId,3);
});
test('swapped restart IDs retain both bindings after a subsequent update', async () => {
  const r=await setup([{id:1,url:'https://b.test/'},{id:2,url:'https://a.test/'}],[c('a','https://a.test/',1),c('b','https://b.test/',2)]);
  await r.browser.tabs.onUpdated.fire(1,{title:'B'},await r.browser.tabs.get(1)); await r.CTCommands.idle();
  assert.equal((await r.CTStore.all('tabs')).length,2);
  assert.equal(r.session.bindings[1],'b'); assert.equal(r.session.bindings[2],'a');
});
test('URL fallback cannot steal a later tab session binding', async()=>{
 const r=await setup([{id:1,url:'https://a.test/'},{id:2,url:'https://a.test/'}],[c('a','https://a.test/',2),c('b','https://a.test/')],{2:'a'});
 assert.equal((await r.CTStore.get('tabs','a')).tabId,2); assert.equal((await r.CTStore.get('tabs','b')).tabId,1);
});
test('failed reopen binding compensates created tab before retry', async()=>{
 const r=await setup([],[c('a','https://a.test/')]);
 const commit=r.CTCommands.commit;let fail=true;
 r.CTCommands.commit=ops=>{if(fail){fail=false;return Promise.reject(new Error('write aborted'));}return commit(ops);};
 await assert.rejects(r.CTCommands.run('openCard',{cardId:'a'})); await r.CTCommands.idle();
 await r.CTCommands.run('openCard',{cardId:'a'}); await r.CTCommands.idle();
 assert.equal(r.tabs.size,1);assert.equal((await r.CTStore.all('tabs')).length,1);
});
test('empty merge through runtime message preserves same-URL session bindings',async()=>{
 const r=await setup([{id:1,url:'https://a.test/'},{id:2,url:'https://a.test/'}],[c('a','https://a.test/',2),c('b','https://a.test/',1)],{1:'b',2:'a'});
 const result=await new Promise(resolve=>r.browser.runtime.onMessage.fire({type:r.CT.MSG.COMMAND,name:'importBoard',input:{mode:'merge',board:{v:1,tabs:[],layout:[],groups:[]}}},{url:r.browser.runtime.getURL('newtab.html')},resolve));
 assert.equal(result.ok,true);assert.equal(r.session.bindings[1],'b');assert.equal(r.session.bindings[2],'a');
});
test('partial multi-delete failure reconciles already closed tabs',async()=>{
 const r=await setup([{id:1,url:'https://a.test/'},{id:2,url:'https://b.test/'}],[c('a','https://a.test/',1),c('b','https://b.test/',2)],{1:'a',2:'b'});
 const remove=r.browser.tabs.remove;r.browser.tabs.remove=async id=>{if(id===2)throw Error('browser refused');return remove(id);};
 await assert.rejects(r.CTCommands.run('editBoard',{operations:[],deleteCards:['a','b']}));await r.CTCommands.idle();assert.equal((await r.CTStore.get('tabs','a')).state,'cold');assert.equal((await r.CTStore.get('tabs','b')).tabId,2);
});
test('HTTP to untrackable navigation preserves original URL for reopening',async()=>{
 const r=await setup([{id:1,url:'https://a.test/'}],[c('a','https://a.test/',1)],{1:'a'});r.tabs.get(1).url='about:blank';await r.browser.tabs.onUpdated.fire(1,{url:'about:blank'},await r.browser.tabs.get(1));await r.CTCommands.idle();assert.equal((await r.CTStore.get('tabs','a')).state,'cold');await r.CTCommands.run('openCard',{cardId:'a'});assert.equal((await r.CTStore.get('tabs','a')).url,'https://a.test/');
});
test('stale board generation refuses deletion before closing replacement tabs',async()=>{
 const r=await setup([{id:1,url:'https://a.test/'}],[c('a','https://a.test/',1)],{1:'a'});await r.CTCommands.commit([{type:'put',store:'meta',value:{key:'boardEpoch',value:1}}]);await assert.rejects(r.CTCommands.run('editBoard',{operations:[],deleteCards:['a'],epoch:0}));assert.equal(r.tabs.has(1),true);
});
test('Firefox initial about:blank does not overwrite a reopening card or duplicate it',async()=>{
 const r=await setup([],[c('a','https://a.test/')]);const create=r.browser.tabs.create;
 r.browser.tabs.create=async opts=>{const t=await create(opts);Object.assign(r.tabs.get(t.id),{url:'about:blank',status:'loading'});return {...t,url:'about:blank',status:'loading'};};
 await r.CTCommands.run('openCard',{cardId:'a'});await r.CTCommands.idle();const first=await r.CTStore.get('tabs','a');assert.equal(first.url,'https://a.test/');
 await r.browser.tabs.onUpdated.fire(first.tabId,{status:'loading'},await r.browser.tabs.get(first.tabId));await r.CTCommands.idle();await r.CTCommands.run('openCard',{cardId:'a'});assert.equal(r.tabs.size,1);
 Object.assign(r.tabs.get(first.tabId),{url:'https://a.test/',status:'complete',active:false});await r.browser.tabs.onUpdated.fire(first.tabId,{url:'https://a.test/',status:'complete'},await r.browser.tabs.get(first.tabId));await r.CTCommands.idle();assert.equal((await r.CTStore.all('tabs')).length,1);assert.equal((await r.CTStore.get('tabs','a')).tabId,first.tabId);
});
test('reconciliation preserves a same-session opening binding while Firefox is blank',async()=>{
 const r=await setup([{id:1,url:'about:blank',status:'loading'}],[{...c('a','https://a.test/',1),opening:true}],{1:'a'});assert.equal((await r.CTStore.get('tabs','a')).tabId,1);Object.assign(r.tabs.get(1),{url:'https://a.test/',status:'complete'});await r.browser.tabs.onUpdated.fire(1,{url:'https://a.test/'},await r.browser.tabs.get(1));await r.CTCommands.idle();assert.equal((await r.CTStore.all('tabs')).length,1);
});
