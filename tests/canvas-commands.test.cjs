const{test}=require('node:test');const assert=require('node:assert/strict');
const {runtime}=require('./helpers/runtime.cjs');const{fakeBrowser}=require('./helpers/browser.cjs');const fs=require('node:fs'),vm=require('node:vm');
test('fit includes only notes, outlying notes and rotated cards',async()=>{
 const{fitBounds}=await import('../extension/src/geometry.js');assert.equal(fitBounds([],[],{cardWidth:230,cardHeight:245,stickySize:180}),null);
 const b=fitBounds([],[{x:1000,y:500,rot:0}],{cardWidth:230,cardHeight:245,stickySize:180});assert.equal(b.maxX,1180);assert.equal(b.minY,500);
 const r=fitBounds([{x:0,y:0,rot:90}],[],{cardWidth:100,cardHeight:200,stickySize:180});assert.equal(Math.round(r.minX),-50);
});
test('new window moves a live tab and cold reopen creates only one card',async()=>{
 const b=fakeBrowser([{id:1,url:'https://a.test/'}]);const r=runtime({browser:b.browser},['shared.js','storage.js','commands.js','board-format.js','board-undo.js','capture.js']);vm.runInContext(fs.readFileSync('extension/src/background.js','utf8'),r);await r.CTBackground.ready;
 const c=(await r.CTStore.all('tabs'))[0];await r.CTCommands.run('openCard',{cardId:c.cardId,destination:'newWindow'});assert.equal(b.effects.filter(e=>e[0]==='create').length,0);assert.equal((await r.CTStore.get('tabs',c.cardId)).windowId,10);
 await r.CTCommands.commit([{type:'put',store:'tabs',value:{cardId:'cold',url:'https://b.test/',tabId:null,state:'cold'}}]);await r.CTCommands.run('openCard',{cardId:'cold',destination:'newWindow'});await r.CTCommands.idle();assert.equal((await r.CTStore.all('tabs')).length,2);
});
