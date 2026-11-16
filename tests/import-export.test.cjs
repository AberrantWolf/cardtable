const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./helpers/runtime.cjs');
const board = () => ({ v: 1, tabs: [{cardId:'a',url:'https://a.test/',title:'A'}], layout: [{cardId:'a',x:1,y:2,note:'old'}], groups: [], notes: [] });
function setup() { return runtime({}, ['shared.js','storage.js','commands.js','board-format.js']); }
test('unrelated JSON and invalid second record are rejected before mutation', async () => {
  const r = setup(); await r.CTCommands.commit([{type:'put',store:'tabs',value:{cardId:'keep'}}]);
  for (const invalid of [{}, {...board(), tabs:[...board().tabs,{}]}]) await assert.rejects(r.CTCommands.run('importBoard',{mode:'replace',board:invalid}));
  assert.equal((await r.CTStore.all('tabs'))[0].cardId,'keep');
});
test('merge preserves live bindings and current notes on collisions', async () => {
  const r=setup(); await r.CTCommands.commit([{type:'put',store:'tabs',value:{cardId:'a',tabId:7}},{type:'put',store:'layout',value:{cardId:'a',note:'current'}}]);
  const result=await r.CTCommands.run('importBoard',{mode:'merge',board:board()});
  assert.equal(result.skipped,1); assert.equal((await r.CTStore.get('tabs','a')).tabId,7);
  assert.equal((await r.CTStore.get('layout','a')).note,'current');
});
test('replacement is atomic when a write aborts and legacy missing notes is accepted', async () => {
  const r=setup(); await r.CTCommands.commit([{type:'put',store:'tabs',value:{cardId:'keep'}}]);
  const commit=r.CTCommands.commit; r.CTCommands.commit=ops=>commit([...ops,{type:'put',store:'tabs',value:{}}]);
  await assert.rejects(r.CTCommands.run('importBoard',{mode:'replace',board:board()}));
  assert.equal((await r.CTStore.all('tabs'))[0].cardId,'keep');
  r.CTCommands.commit=commit; const b=board(); delete b.notes;
  await r.CTCommands.run('importBoard',{mode:'replace',board:b}); assert.equal((await r.CTStore.all('tabs')).length,1);
});
test('invalid references, nonfinite coordinates, URLs and settings are rejected', () => {
  const r=setup();
  for (const b of [{...board(),layout:[{cardId:'missing',x:1,y:2}]},{...board(),view:{x:0,y:0,zoom:0}},{...board(),settings:{cardWidth:-1}},{...board(),tabs:[{cardId:'a',url:'javascript:alert(1)'}]}]) assert.throws(()=>r.CTBoardFormat.validate(b));
});
test('merge cross-type collisions cannot leave orphan layouts or duplicate selection IDs',async()=>{
 const r=setup();await r.CTCommands.commit([{type:'put',store:'notes',value:{id:'a',x:0,y:0,text:'keep'}}]);
 await r.CTCommands.run('importBoard',{mode:'merge',board:board()});
 const exported=await r.CTCommands.run('exportBoard');assert.doesNotThrow(()=>r.CTBoardFormat.validate(exported));assert.equal(exported.layout.length,0);
});
