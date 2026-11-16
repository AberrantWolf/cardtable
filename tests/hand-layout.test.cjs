const{test}=require('node:test');const assert=require('node:assert/strict');
const load=()=>import('../extension/src/hand-layout.js');
test('stable logical cells ignore animated positions and map scroll offsets',async()=>{
 const{hitHand}=await load();const args={trackLeft:100,scrollLeft:0,pitch:82,count:50};
 for(let i=0;i<8;i++)assert.equal(hitHand({...args,clientX:100+115+i*82+41}),i);
 assert.equal(hitHand({...args,scrollLeft:3*82,clientX:100+115+41}),3);
 assert.equal(hitHand({...args,count:0,clientX:200}),null);
});
test('both neighbors stay ordered and viewport edges keep selected card visible',async()=>{
 const{layoutHand}=await load();for(const focusCoordinate of [0,0.49,0.51,1,4.9,199]){
 const rows=layoutHand({count:200,focusCoordinate,scrollLeft:Math.max(0,focusCoordinate*82-200),viewportWidth:600});
 for(let i=1;i<rows.length;i++)assert.ok(rows[i].x>rows[i-1].x);
 const selected=rows.find(r=>r.index===Math.max(0,Math.min(199,Math.round(focusCoordinate))));if(selected){assert.ok(selected.x-selected.width/2>=-0.01);assert.ok(selected.x+selected.width/2<=600.01);}
 }
});
test('large hands render a bounded window and reduced motion does not magnify',async()=>{
 const{layoutHand}=await load();const rows=layoutHand({count:200,focusCoordinate:100,scrollLeft:8000,viewportWidth:600,reducedMotion:true});assert.ok(rows.length<20);assert.ok(rows.every(r=>r.width===158));
});
test('hand acceptance matrix remains bounded and reachable at narrow and wide sizes',async()=>{
 const{layoutHand,hitHand,HAND_PADDING,HAND_PITCH}=await load();
 for(const count of [0,1,2,10,50,200])for(const viewportWidth of [170,320,600,1200])for(const reducedMotion of [false,true]){
  if(!count){assert.deepEqual(layoutHand({count,focusCoordinate:null,scrollLeft:0,viewportWidth,reducedMotion}),[]);continue;}
  for(const index of new Set([0,Math.floor(count/2),count-1])){
   const maxScroll=Math.max(0,HAND_PADDING*2+count*HAND_PITCH-viewportWidth),scrollLeft=Math.max(0,Math.min(maxScroll,HAND_PADDING+(index+.5)*HAND_PITCH-viewportWidth/2));
   const rows=layoutHand({count,focusCoordinate:index,scrollLeft,viewportWidth,reducedMotion}),focused=rows.find(r=>r.index===index);assert.ok(focused);assert.ok(focused.x-focused.width/2>=-0.01);assert.ok(focused.x+focused.width/2<=viewportWidth+.01);
   for(let i=1;i<rows.length;i++)assert.ok(rows[i].x>rows[i-1].x);
   const logicalX=HAND_PADDING+(index+.5)*HAND_PITCH-scrollLeft;assert.equal(hitHand({clientX:logicalX,trackLeft:0,scrollLeft,count}),index);
  }
 }
});
