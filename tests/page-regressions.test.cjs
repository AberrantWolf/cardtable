const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');const source=()=>fs.readFileSync('extension/src/app.js','utf8');
test('removing the layout during undo resets reused card placement',async()=>{
 const text=source(),c={cardId:'a',placed:true,x:100,y:200,note:'old',z:1};
 const g={indexMembership(){},model:{rows:{tabs:new Map([['a',{cardId:'a',url:'https://a.test/'}]]),layout:new Map(),groups:new Map(),notes:new Map(),shots:new Map()},drafts:new Map()},state:{cards:[c],stickies:[],zmax:2},cardIndex:new Map(),pendingWrites:new Map(),dirty:new Set(),shotUrls:new Map(),iconUrls:new Map(),selection:new Set(),S:{handOnNewTab:true},rotFor:()=>0,URL};
 g.card=id=>g.cardIndex.get(id);vm.createContext(g);vm.runInContext(text.slice(text.indexOf('async function syncModel()'),text.indexOf('// ---------------- view')),g);await g.syncModel();assert.equal(c.placed,false);assert.equal(c.note,'');assert.equal(c.x,0);
});
test('failed canvas command retains pending layout and note for retry',async()=>{
 const text=source(),value={store:'layout',key:'a',value:{cardId:'a',note:'unsaved',x:5}},pendingWrites=new Map([['layout:a',value]]),dirty=new Set(['a']);
 const g={model:{epoch:0},DBP:{mutate:async()=>{}},pendingWrites,dirty,retryActions:new Map(),CT:{uuid:()=> 'request'},snapshotUI:()=>[],withInteraction:fn=>fn(),diffUI:()=>[{type:'put',store:'layout',value:value.value}],boardCommand:async()=>{throw Error('quota');},loadAll:async()=>{},render(){},undoStack:[],showToast(){},saveError(){}};
 vm.createContext(g);vm.runInContext(text.slice(text.indexOf('async function commitUI('),text.indexOf('function removeCards(')),g);await assert.rejects(g.commitUI([], 'Move'));assert.equal(pendingWrites.size,1);assert.equal(dirty.has('a'),true);
});
test('snapshot clearing shots invalidates images for a surviving imported card ID',async()=>{
 const text=source(),c={cardId:'a',shotUrl:'blob:old',faviconUrl:'blob:icon'},revoked=[];
 const g={indexMembership(){},model:{rows:{tabs:new Map([['a',{cardId:'a',url:'https://b.test/'}]]),layout:new Map(),groups:new Map(),notes:new Map(),shots:new Map()},drafts:new Map()},state:{cards:[c],stickies:[],zmax:2},cardIndex:new Map(),pendingWrites:new Map(),dirty:new Set(),shotUrls:new Map([['a','blob:old']]),iconUrls:new Map([['a','blob:icon']]),selection:new Set(),S:{handOnNewTab:true},rotFor:()=>0,URL:{revokeObjectURL:u=>revoked.push(u)}};
 g.card=id=>g.cardIndex.get(id);vm.createContext(g);vm.runInContext(text.slice(text.indexOf('async function syncModel()'),text.indexOf('// ---------------- view')),g);await g.syncModel();assert.equal(c.shotUrl,null);assert.equal(c.faviconUrl,'');assert.equal(revoked.length,2);
});
test('successful replacement clears failed commands and unsaved state from the old board',async()=>{
 const text=source();let change;const retryActions=new Map([['old',()=>{throw Error('stale');}]]);
 const g={$:id=>id==='s-file'?{addEventListener:(type,fn)=>change=fn}:{value:'replace'},retryActions,dirty:new Set(['a']),pendingWrites:new Map(),undoStack:[{}],model:{drafts:new Map()},shotUrls:new Map(),iconUrls:new Map(),withInteraction:fn=>fn(),flush:async()=>{},boardCommand:async()=>({added:1,skipped:0}),loadAll:async()=>{},applyTheme(){},render(){},closeSettings(){},showToast(){},S:{},state:{},X:{storage:{local:{set:async()=>{}}}}};
 vm.createContext(g);vm.runInContext(text.slice(text.indexOf('$("s-file").addEventListener'),text.indexOf('// ---------------- toolbar + global')),g);await change({target:{files:[{size:2,text:async()=>'{}'}],value:'file'}});assert.equal(retryActions.size,0);
});
test('first placement does not save unchanged preview defaults before its undo snapshot',async()=>{
 const text=source(),value={cardId:'a',x:100,y:200,rot:0,note:'',group:null,placed:true,z:2},before=[{store:'layout',key:'a',value:undefined,preview:{...value,x:0,y:0,placed:false,z:1}}];let preliminary=0;
 const g={model:{epoch:0,drafts:new Map()},editing:new Set(),DBP:{mutate:async()=>preliminary++},pendingWrites:new Map([['layout:a',{store:'layout',key:'a',value,fields:value,create:true}]]),dirty:new Set(['a']),retryActions:new Map(),CT:{uuid:()=> 'request'},snapshotUI:()=>[],withInteraction:fn=>fn(),diffUI:()=>[{type:'put',store:'layout',value}],boardCommand:async()=>({token:'t'}),loadAll:async()=>{},render(){},undoStack:[],showToast(){}};
 vm.createContext(g);vm.runInContext(text.slice(text.indexOf('async function commitUI('),text.indexOf('function removeCards(')),g);await g.commitUI(before,'Place');assert.equal(preliminary,0);
});
test('automatic flush does not bypass a failed undoable command awaiting retry',async()=>{
 const text=source();let writes=0;const g={clearTimeout(){},flushT:null,activeGesture:null,flushing:Promise.resolve(),pendingWrites:new Map([['layout:a',{store:'layout',key:'a',value:{cardId:'a',x:20},fields:{x:20},blockedBy:'failed'}]]),DBP:{mutate:async()=>writes++},model:{epoch:0,drafts:new Map()},editing:new Set(),dirty:new Set(),retryActions:new Map(),$:()=>({hidden:false})};
 vm.createContext(g);vm.runInContext(text.slice(text.indexOf('async function flush()'),text.indexOf('function saveError(')),g);await g.flush();assert.equal(writes,0);
});
test('rapid text edit reverted before debounce does not save stale patch text',()=>{
 const text=source(),g={model:{rows:{layout:new Map([['a',{cardId:'a',note:''}]])}},pendingWrites:new Map(),clearTimeout(){},setTimeout(){},flushT:null};vm.createContext(g);vm.runInContext(text.slice(text.indexOf('function queueWrite('),text.indexOf('function persist(')),g);
 g.queueWrite('layout','a',{cardId:'a',note:'a'});g.queueWrite('layout','a',{cardId:'a',note:''});assert.notEqual(g.pendingWrites.get('layout:a')?.fields.note,'a');
});
test('old editor callback cannot overwrite a replacement epoch',()=>{
 const text=source(),c={cardId:'a',note:'replacement'},model={epoch:1,drafts:new Map(),draft(){}};let saved=0;
 const g={model,editing:new Set(),normalizePlainText:s=>s,noteDisplay:()=>({}),wireCardNote(){},persist(){saved++;},pendingWrites:new Map()};vm.createContext(g);vm.runInContext(text.slice(text.indexOf('function commitCardNote('),text.indexOf('// ---------------- sticky notes')),g);
 g.commitCardNote(c,{value:'old draft',closest:()=>null,replaceWith(){}},0);assert.equal(c.note,'replacement');assert.equal(saved,0);
});
test('retry after a lost edit response cannot replay stale pending note fields',async()=>{
 const text=source();let note='original',calls=0;const record={cardId:'a',x:200,note:'A'},before=[{store:'layout',key:'a',value:{cardId:'a',x:0,note:'A'},pendingFields:{note:'A'},pendingBase:{cardId:'a',x:0,note:'original'}}];
 const g={model:{epoch:0,drafts:new Map()},editing:new Set(),DBP:{mutate:async()=>{note='A';}},pendingWrites:new Map([['layout:a',{store:'layout',key:'a',value:record,fields:{x:200,note:'A'}}]]),dirty:new Set(['a']),retryActions:new Map(),CT:{uuid:()=> 'request'},withInteraction:fn=>fn(),diffUI:()=>[{type:'put',store:'layout',value:record}],boardCommand:async()=>{if(++calls===1){note='A';throw Error('response lost');}return{token:'t'};},loadAll:async()=>{},render(){},undoStack:[],showToast(){}};
 vm.createContext(g);vm.runInContext(text.slice(text.indexOf('async function commitUI('),text.indexOf('function removeCards(')),g);await assert.rejects(g.commitUI(before,'Move'));note='B';await g.retryActions.get('request')();assert.equal(note,'B');
});
