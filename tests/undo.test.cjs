const{test}=require('node:test');const assert=require('node:assert/strict');const{runtime}=require('./helpers/runtime.cjs');
const setup=()=>runtime({},['shared.js','storage.js','commands.js','board-undo.js']);
test('move undo restores start layout, group name and affected partner',async()=>{
 const r=setup(),ops=[{store:'layout',type:'put',value:{cardId:'a',x:0,group:'g'}},{store:'layout',type:'put',value:{cardId:'b',x:10,group:'g'}},{store:'groups',type:'put',value:{id:'g',name:'Research'}}];await r.CTCommands.commit(ops);
 const result=await r.CTUndo.edit({operations:[{store:'layout',type:'put',value:{cardId:'a',x:100,group:null}},{store:'layout',type:'put',value:{cardId:'b',x:10,group:null}},{store:'groups',type:'delete',key:'g'}]});
 await r.CTUndo.undo(result.token);assert.equal((await r.CTStore.get('layout','a')).x,0);assert.equal((await r.CTStore.get('layout','b')).group,'g');assert.equal((await r.CTStore.get('groups','g')).name,'Research');
});
test('delete undo restores screenshot and cold card, including after worker state is lost',async()=>{
 const r=setup();await r.CTCommands.commit([{store:'tabs',type:'put',value:{cardId:'a',tabId:7,state:'live'}},{store:'shots',type:'put',value:{cardId:'a',blob:new Blob(['saved'])}}]);
 const {token}=await r.CTUndo.edit({operations:[{store:'tabs',type:'delete',key:'a'},{store:'shots',type:'delete',key:'a'}]});
 await r.CTUndo.undo(token);assert.equal((await r.CTStore.get('tabs','a')).tabId,null);assert.equal(await(await r.CTStore.get('shots','a')).blob.text(),'saved');
});
test('stale undo refuses to overwrite subsequent edits or imported board',async()=>{
 const r=setup();await r.CTCommands.commit([{store:'notes',type:'put',value:{id:'n',text:'first'}}]);const{token}=await r.CTUndo.edit({operations:[{store:'notes',type:'put',value:{id:'n',text:'second'}}]});await r.CTCommands.commit([{store:'notes',type:'put',value:{id:'n',text:'newer'}}]);
 await assert.rejects(r.CTUndo.undo(token));assert.equal((await r.CTStore.get('notes','n')).text,'newer');
});
test('undo history is bounded to 50 entries',async()=>{
 const r=setup();for(let i=0;i<52;i++)await r.CTUndo.edit({operations:[{store:'notes',type:'put',value:{id:'n'+i,text:'x'}}]});
 assert.equal((await r.CTStore.all('meta')).filter(x=>x.key.startsWith('undo:')).length,50);
});
test('committed undo is idempotent when its first response is lost',async()=>{
 const r=setup();const{token}=await r.CTUndo.edit({operations:[{type:'put',store:'notes',value:{id:'a',text:'x'}}]});await r.CTUndo.undo(token);await assert.doesNotReject(r.CTUndo.undo(token));assert.equal(await r.CTStore.get('notes','a'),undefined);
});
test('move and undo preserve a note saved by another canvas during the gesture',async()=>{
 const r=setup();await r.CTCommands.commit([{type:'put',store:'layout',value:{cardId:'a',x:0,note:'external'}}]);
 const{token}=await r.CTUndo.edit({operations:[{type:'put',store:'layout',value:{cardId:'a',x:200,note:'old'}}],before:[{store:'layout',key:'a',value:{cardId:'a',x:0,note:'old'}}]});assert.equal((await r.CTStore.get('layout','a')).note,'external');await r.CTUndo.undo(token);const row=await r.CTStore.get('layout','a');assert.equal(row.x,0);assert.equal(row.note,'external');
});
test('pending text is committed atomically with movement and its receipt prevents stale replay',async()=>{
 const r=setup();await r.CTCommands.commit([{type:'put',store:'layout',value:{cardId:'a',x:0,note:'original'}}]);
 const command={commandId:'once',operations:[{type:'put',store:'layout',value:{cardId:'a',x:200,note:'A'}}],before:[{store:'layout',key:'a',value:{cardId:'a',x:0,note:'A'},pendingFields:{note:'A'},pendingBase:{cardId:'a',x:0,note:'original'}}]};await r.CTUndo.edit(command);assert.equal((await r.CTStore.get('layout','a')).note,'A');await r.CTCommands.commit([{type:'patch',store:'layout',key:'a',value:{note:'B'}}]);await r.CTUndo.edit(command);assert.equal((await r.CTStore.get('layout','a')).note,'B');await r.CTUndo.undo('once');const row=await r.CTStore.get('layout','a');assert.equal(row.note,'B');assert.equal(row.x,0);
});
test('moving a newly queued note retains its original note when undone',async()=>{
 const r=setup(),note={id:'n',x:0,y:0,text:'new'};
 const{token}=await r.CTUndo.edit({operations:[{type:'put',store:'notes',value:{...note,x:100}}],before:[{store:'notes',key:'n',value:note,pendingFields:note,pendingCreate:true}]});await r.CTUndo.undo(token);assert.equal((await r.CTStore.get('notes','n')).x,0);
});
test('a stale gesture cannot resurrect an entity deleted by another canvas',async()=>{
 const r=setup();await assert.rejects(r.CTUndo.edit({operations:[{type:'put',store:'notes',value:{id:'n',x:100,y:0,text:'old'}}],before:[{store:'notes',key:'n',value:{id:'n',x:0,y:0,text:'old'}}]}));assert.equal(await r.CTStore.get('notes','n'),undefined);
});
