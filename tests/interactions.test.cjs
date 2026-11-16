const{test}=require('node:test');const assert=require('node:assert/strict');
test('gesture cancellation finalizes once and removes all listeners',async()=>{
 const{GestureSession}=await import('../extension/src/interactions.js');const el=new EventTarget();el.setPointerCapture=()=>{};el.releasePointerCapture=()=>{};let cancel=0,cleanup=0,moves=0;
 const s=new GestureSession(el,1,{onCancel:()=>cancel++,onCleanup:()=>cleanup++});el.addEventListener('pointermove',()=>moves++,{signal:s.signal});el.dispatchEvent(new Event('lostpointercapture'));s.cancel();el.dispatchEvent(new Event('pointermove'));
 assert.equal(cancel,1);assert.equal(cleanup,1);assert.equal(moves,0);
});
test('successful finish never runs rollback and mixed movement includes both kinds',async()=>{
 const{GestureSession,movementSnapshot}=await import('../extension/src/interactions.js');let canceled=0;const el=new EventTarget();el.setPointerCapture=()=>{};el.releasePointerCapture=()=>{};
 const s=new GestureSession(el,1,{onCancel:()=>canceled++});s.finish();s.cancel();assert.equal(canceled,0);
 const cards=[{cardId:'a',x:1,y:2}],notes=[{id:'n',x:3,y:4}];const movers=movementSnapshot(cards,notes,new Set(['a','n']));assert.equal(movers.length,2);assert.equal(movers[1].kind,'note');
});
