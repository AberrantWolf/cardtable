const {test}=require('node:test');const assert=require('node:assert/strict');
const load=()=>import('../extension/src/board-model.js');
test('incoming metadata preserves note/sticky drafts and indexed membership',async()=>{
 const {BoardModel}=await load();const m=new BoardModel();m.replace({tabs:[{cardId:'a',title:'old'}],layout:[{cardId:'a',group:'g',placed:true,note:'saved'}],notes:[{id:'n',text:'saved'}],groups:[{id:'g'}],shots:[],meta:[{key:'revision',value:1}]});
 m.draft('a',{note:'typing'});m.draft('n',{text:'typing note'});
 assert.equal(m.apply({revision:2,upserts:{tabs:[{cardId:'a',title:'new'}]},deletes:{}}),true);
 assert.equal(m.entity('a').note,'typing');assert.equal(m.entity('n').text,'typing note');assert.equal(m.members.get('g').has('a'),true);
});
test('revision gaps request recovery and stale snapshots do not replace newer state',async()=>{
 const {BoardModel}=await load();const m=new BoardModel();m.replace({tabs:[],meta:[{key:'revision',value:5}]});
 assert.equal(m.apply({revision:7,upserts:{tabs:[{cardId:'x'}]},deletes:{}}),false);assert.equal(m.rows.tabs.size,0);
 assert.equal(m.replace({tabs:[{cardId:'old'}],meta:[{key:'revision',value:4}]}),false);assert.equal(m.rows.tabs.size,0);
});
