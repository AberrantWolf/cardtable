const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./helpers/runtime.cjs');
test('transaction rejects on abort after request success', async () => {
  const { CTStore } = runtime();
  await assert.rejects(CTStore.transaction(['tabs'], 'readwrite', (s, tx) => {
    const req = s.tabs.put({ cardId: 'a' }); req.onsuccess = () => tx.abort();
  }));
  assert.equal(await CTStore.get('tabs', 'a'), undefined);
});
test('command failure does not publish and queue recovers', async () => {
  const { CTCommands, CTStore } = runtime();
  const changes = []; CTCommands.subscribe(c => changes.push(c));
  await assert.rejects(CTCommands.commit([{ store: 'tabs', type: 'put', value: {} }]));
  assert.equal(changes.length, 0);
  await CTCommands.commit([{ store: 'tabs', type: 'put', value: { cardId: 'ok' } }]);
  assert.equal(changes.length, 1); assert.equal(changes[0].revision, 1);
  assert.equal((await CTStore.get('tabs', 'ok')).cardId, 'ok');
});
test('v1 migration preserves every store and screenshot blob', async () => {
  const r = runtime({}, ['shared.js']);
  await new Promise((resolve, reject) => {
    const req = r.indexedDB.open(r.CT.DB, 1);
    req.onupgradeneeded = () => {
      for (const [name, key] of Object.entries({ tabs: 'cardId', shots: 'cardId', layout: 'cardId', groups: 'id', notes: 'id' })) {
        const s = req.result.createObjectStore(name, { keyPath: key });
        if (name === 'tabs') { s.createIndex('tabId', 'tabId'); s.createIndex('url', 'url'); }
        s.put({ [key]: 'a', ...(name === 'shots' ? { blob: new Blob(['image']) } : {}) });
      }
    };
    req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(req.error);
  });
  const fs = require('node:fs'), vm = require('node:vm');
  vm.runInContext(fs.readFileSync('extension/src/storage.js', 'utf8'), r);
  for (const name of ['tabs', 'layout', 'groups', 'notes']) assert.equal((await r.CTStore.all(name)).length, 1);
  assert.equal(await (await r.CTStore.get('shots', 'a')).blob.text(), 'image');
  assert.ok((await r.CTStore.open()).objectStoreNames.contains('meta'));
});
test('concurrent field patches preserve independent note and position edits',async()=>{
 const{CTCommands,CTStore}=runtime();await CTCommands.commit([{type:'put',store:'layout',value:{cardId:'a',x:0,note:'old'}}]);
 await Promise.all([CTCommands.commit([{type:'patch',store:'layout',key:'a',value:{note:'new'}}]),CTCommands.commit([{type:'patch',store:'layout',key:'a',value:{x:100}}])]);const row=await CTStore.get('layout','a');assert.equal(row.x,100);assert.equal(row.note,'new');
});
