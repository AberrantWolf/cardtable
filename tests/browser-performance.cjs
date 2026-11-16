// Compare frame/handler latency with an optional unpacked baseline extension.
const{chromium}=require('playwright');const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))];
(async()=>{
 const targets=[...(process.env.CARDTABLE_BASELINE?[['baseline',process.env.CARDTABLE_BASELINE]]:[]),['current',path.resolve('extension/dist/chromium')]],results=[];
 for(const[label,directory]of targets){
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'cardtable-perf-'));let context;
  try{
   context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],...(process.env.CARDTABLE_CHROMIUM?{executablePath:process.env.CARDTABLE_CHROMIUM}:{}),args:[`--disable-extensions-except=${directory}`,`--load-extension=${directory}`],viewport:{width:1440,height:1000}});
   const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const origin=worker.url().replace('/background.js',''),page=await context.newPage();await page.goto(origin+'/newtab.html');await page.waitForSelector('#btn-settings');
   for(const count of [50,200,500])for(const mode of ['grouped','solo']){
    await page.evaluate(async({count,mode})=>{
     const DB=(await import('./db.js')).default;
     const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(CT.DB,CT.DBV);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
     await new Promise((resolve,reject)=>{
      const tx=db.transaction(['tabs','layout','groups','notes','shots'],'readwrite');for(const n of ['tabs','layout','groups','notes','shots'])tx.objectStore(n).clear();
      const groups=new Set();
      for(let i=0;i<count;i++){
       const cardId='bench-'+i,group='g-'+(mode==='solo'?i:Math.floor(i/10));groups.add(group);
       tx.objectStore('tabs').put({cardId,url:'https://example.invalid/'+i,title:'Benchmark '+i,tabId:null,state:'cold'});
       tx.objectStore('layout').put({cardId,x:100+i%20*290,y:160+Math.floor(i/20)*300,placed:true,group,note:'',rot:0,z:i+1});
      }
      for(const id of groups)tx.objectStore('groups').put({id,name:id,seed:1});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
     });db.close();await chrome.storage.local.set({settings:{...CT.DEFAULTS,soloGroups:mode==='solo'}});
    },{count,mode});
    await page.reload();await page.waitForFunction(n=>document.querySelectorAll('#cards>.card').length===n,count);await page.waitForTimeout(300);
    await page.evaluate(async()=>{window.__builds=0;const mod=await import('./geometry.js');if(mod.GroupGeometry){const original=mod.GroupGeometry.prototype.get;mod.GroupGeometry.prototype.get=function(...args){const before=this.builds,result=original.apply(this,args);window.__builds+=this.builds-before;return result;};}});
    const c=page.locator('#cards>.card[data-id="bench-0"]'),box=await c.boundingBox();await page.mouse.move(box.x+80,box.y+60);await page.mouse.down();
    const sample=await page.evaluate(async()=>{
     const el=document.querySelector('#cards>.card[data-id="bench-0"]'),times=[],handlers=[];let previous=performance.now();
     for(let frame=0;frame<45;frame++)await new Promise(resolve=>requestAnimationFrame(()=>{
      const now=performance.now();if(frame>4)times.push(now-previous);previous=now;
      const start=performance.now();for(let j=0;j<3;j++)el.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,buttons:1,clientX:180+(frame%10)*3+j,clientY:220+(frame%5)*2}));handlers.push(performance.now()-start);resolve();
     }));return {times,handlers,geometryBuilds:window.__builds};
    });await c.dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();
    const row={version:label,cards:count,mode,frameP50:+percentile(sample.times,.5).toFixed(2),frameP95:+percentile(sample.times,.95).toFixed(2),inputBurstP95:+percentile(sample.handlers,.95).toFixed(2),geometryBuilds:label==='current'?sample.geometryBuilds:null};results.push(row);console.log(JSON.stringify(row));
   }
  }finally{await context?.close();await fs.rm(profile,{recursive:true,force:true});}
 }
 if(process.env.CARDTABLE_PERFORMANCE_OUTPUT)await fs.writeFile(process.env.CARDTABLE_PERFORMANCE_OUTPUT,JSON.stringify(results,null,2)+'\n');
})().catch(e=>{console.error(e);process.exitCode=1;});
