const {test}=require('node:test');const assert=require('node:assert/strict');
const {runtime}=require('./helpers/runtime.cjs');const {fakeBrowser}=require('./helpers/browser.cjs');
function setup(encode=async()=>new Blob(['image'])) {
 const b=fakeBrowser([{id:1,windowId:1,active:true,url:'https://a.test/'}]);const r=runtime({},['shared.js','capture.js']);
 let current={cardId:'a',tabId:1,url:'https://a.test/',generation:0,scrollY:10},writes=[];
 const cap=r.CTCapture.create({browser:b.browser,encode,prepare:async()=>current&&({...current}),commit:async(token,blob)=>{if(current&&current.tabId===token.tabId&&current.url===token.url&&current.generation===token.generation)writes.push({blob,scrollY:current.scrollY});},settings:()=>({}),report:()=>{}});
 return {...b,cap,writes,setCurrent:c=>{current=c;},getCurrent:()=>current};
}
test('delete during encoding cannot resurrect a card; navigation drops capture',async()=>{
 let release;const r=setup(()=>new Promise(resolve=>release=resolve));const p=r.cap.capture(await r.browser.tabs.get(1));
 while(!release)await new Promise(setImmediate);r.setCurrent(null);release(new Blob(['late']));await p;assert.equal(r.writes.length,0);
 const q=setup(async()=>{q.tabs.get(1).url='https://other.test/';return new Blob(['wrong']);});await q.cap.capture(await q.browser.tabs.get(1));assert.equal(q.writes.length,0);
});
test('capture preserves newer scroll and rejects active-tab switches',async()=>{
 const r=setup(async()=>{r.getCurrent().scrollY=90;return new Blob(['image']);});await r.cap.capture(await r.browser.tabs.get(1));assert.equal(r.writes[0].scrollY,90);
 const q=setup(async()=>{q.tabs.get(1).active=false;return new Blob(['wrong']);});await q.cap.capture(await q.browser.tabs.get(1));assert.equal(q.writes.length,0);
});
test('concurrent capture requests coalesce and closed tabs release scheduling',async()=>{
 let count=0;const r=setup(async()=>{count++;await new Promise(setImmediate);return new Blob(['image']);});
 await Promise.all(Array.from({length:10},()=>r.cap.capture({id:1,windowId:1,url:'https://a.test/'})));assert.equal(count,1);
 r.cap.request({id:1,windowId:1,url:'https://a.test/'});r.cap.cancel(1);assert.equal(r.cap.pendingCount(),0);
});
test('new active tab capture waits for previous window encoding instead of disappearing',async()=>{
 let release,count=0;const r=setup(()=>++count===1?new Promise(resolve=>release=resolve):Promise.resolve(new Blob(['B'])));
 const a=r.cap.capture(await r.browser.tabs.get(1));while(!release)await new Promise(setImmediate);
 r.tabs.get(1).active=false;r.tabs.set(2,{id:2,windowId:1,active:true,url:'https://b.test/'});r.setCurrent({cardId:'b',tabId:2,url:'https://b.test/',generation:0});
 const b=r.cap.capture(await r.browser.tabs.get(2));release(new Blob(['A']));await Promise.all([a,b]);assert.equal(count,2);assert.equal(r.writes.length,1);
});
