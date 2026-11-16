// Firefox event-page smoke test via web-ext's temporary-addon installer.
const{firefox}=require('playwright');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),http=require('node:http');const{pathToFileURL}=require('node:url');
(async()=>{
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'cardtable-firefox-')),uuid='12345678-1234-4234-8234-123456789abc',addonId='cardtable@trashtools.net';let context,remote;
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><title>Firefox fixture</title><body>Disposable browser test</body></html>');});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/fixture`;
 try{
  context=await firefox.launchPersistentContext(profile,{headless:true,...(process.env.CARDTABLE_FIREFOX?{executablePath:process.env.CARDTABLE_FIREFOX}:{}),args:['--start-debugger-server',String(port)],firefoxUserPrefs:{'devtools.debugger.remote-enabled':true,'devtools.debugger.prompt-connection':false,'devtools.debugger.force-local':true,'extensions.webextensions.uuids':JSON.stringify({[addonId]:uuid})},viewport:{width:1440,height:1000}});
  const{connectWithMaxRetries}=await import(pathToFileURL(path.join(path.dirname(require.resolve('web-ext')),'lib/firefox/remote.js')).href);remote=await connectWithMaxRetries({port,maxRetries:100});await remote.installTemporaryAddon(path.resolve('extension/dist/firefox'),false);assert.equal((await remote.getInstalledAddon(addonId)).backgroundScriptStatus,'RUNNING');
  // Playwright cannot attach to Firefox extension principals. Navigate through its
  // browser, then use Firefox's native debugger actors to inspect the real page.
  const page=await context.newPage();
  await page.goto('moz-extension://'+uuid+'/newtab.html',{waitUntil:'commit',timeout:3000}).catch(()=>{});
  const tabs=await remote.client.request('listTabs'),tab=tabs.tabs.find(t=>t.url==='moz-extension://'+uuid+'/newtab.html');assert.ok(tab);assert.equal(tab.title,'cardtable');
  const client=remote.client,handle=client._handleMessage.bind(client);let targetResolve;
  const targetReady=new Promise(resolve=>targetResolve=resolve);
  client._handleMessage=data=>{
    if(data.type==='target-available-form'){targetResolve(data.target);return;}
    if(data.type==='evaluationResult'){client.emit('evaluation-result',data);return;}
    if(data.type==='target-destroyed-form')return;
    handle(data);
  };
  const watcher=await client.request({to:tab.actor,type:'getWatcher',isServerTargetSwitchingEnabled:true});
  await client.request({to:watcher.actor,type:'watchTargets',targetType:'frame'});
  const target=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Firefox debugger target unavailable')),10000);targetReady.then(value=>{clearTimeout(timer);resolve(value);},reject);});
  async function evaluate(text){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{client.off('evaluation-result',listener);reject(Error('Firefox debugger evaluation timed out'));},10000);
      const listener=data=>{if(data.from!==target.consoleActor)return;clearTimeout(timer);client.off('evaluation-result',listener);if(data.exceptionMessage)reject(Error(data.exceptionMessage));else resolve(data.result);};
      client.on('evaluation-result',listener);client.request({to:target.consoleActor,type:'evaluateJSAsync',text}).catch(e=>{clearTimeout(timer);client.off('evaluation-result',listener);reject(e);});
    });
  }
  async function execute(code){
    await evaluate(`globalThis.__ffSmoke=undefined;(async()=>{${code}})().then(value=>{globalThis.__ffSmoke={value}},e=>{globalThis.__ffSmoke={error:e.stack||String(e)}})`);
    for(let i=0;i<100;i++){
      const result=await evaluate('JSON.stringify(globalThis.__ffSmoke)');
      if(typeof result==='string'){const parsed=JSON.parse(result);if(parsed.error)throw Error(parsed.error);return parsed.value;}
      await new Promise(r=>setTimeout(r,50));
    }
    throw Error('Firefox evaluation timed out');
  }
  const ready=await execute("return {surface:!!document.querySelector('.hand-surface'),version:(await CTStore.open()).version};");assert.equal(ready.surface,true);assert.equal(ready.version,2);console.log('PASS Firefox native canvas initialization and v2 IndexedDB');
  const imported=await execute(`const result=await browser.runtime.sendMessage({type:CT.MSG.COMMAND,name:'importBoard',input:{mode:'replace',board:{v:1,tabs:[{cardId:'a',url:${JSON.stringify(url+'?a')},title:'Firefox A'},{cardId:'b',url:${JSON.stringify(url+'?b')},title:'Firefox B'}],layout:[{cardId:'a',x:200,y:200,placed:true}],groups:[],notes:[{id:'n',x:600,y:200,text:'Firefox note'}]}}});await new Promise(r=>setTimeout(r,350));return {ok:result.ok,cards:document.querySelectorAll('#cards>.card').length,hand:document.querySelectorAll('#hand .card').length,sticky:document.querySelector('.sticky-text').textContent};`);
  assert.equal(imported.ok,true);assert.equal(imported.cards,1);assert.equal(imported.hand,1);assert.equal(imported.sticky,'Firefox note');console.log('PASS Firefox atomic import and hand/sticky rendering');
  const edited=await execute("document.querySelector('#cards .note').click();const input=document.querySelector('.note-input');input.value='Firefox persistent note';input.dispatchEvent(new Event('input',{bubbles:true}));input.blur();await new Promise(r=>setTimeout(r,350));return (await CTStore.get('layout','a')).note;");assert.equal(edited,'Firefox persistent note');console.log('PASS Firefox editor and committed note persistence');
  const moved=await execute("const el=document.querySelector('#cards>.card'),r=el.getBoundingClientRect();for(const [type,dx,dy]of [['pointerdown',0,0],['pointermove',200,60],['pointerup',200,60]])el.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:1,clientX:r.x+50+dx,clientY:r.y+50+dy}));await new Promise(r=>setTimeout(r,400));const moved=(await CTStore.get('layout','a')).x;window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));await new Promise(r=>setTimeout(r,350));return {moved,restored:(await CTStore.get('layout','a')).x};");assert.ok(moved.moved>300);assert.equal(moved.restored,200);console.log('PASS Firefox pointer movement and undo');
  const deletion=await execute("await CTStore.transaction(['shots'],'readwrite',s=>s.shots.put({cardId:'a',blob:new Blob(['Firefox image'])}));document.querySelector('#cards>.card .close').click();await new Promise(r=>setTimeout(r,350));const gone=!await CTStore.get('tabs','a');window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));await new Promise(r=>setTimeout(r,350));return {gone,image:await(await CTStore.get('shots','a')).blob.text()};");assert.equal(deletion.gone,true);assert.equal(deletion.image,'Firefox image');console.log('PASS Firefox delete undo preserves Blob screenshot data');
  const tracking=await execute(`const t=await browser.tabs.create({url:${JSON.stringify(url)},active:true});await new Promise(r=>setTimeout(r,350));const c=(await CTStore.all('tabs')).find(c=>c.tabId===t.id);if(!c)throw Error('Missing tracked card');await browser.runtime.sendMessage({type:CT.MSG.MUTATE,operations:[{type:'put',store:'layout',value:{cardId:c.cardId,x:900,y:200,placed:true}}]});await browser.tabs.remove(t.id);await new Promise(r=>setTimeout(r,300));const cold=(await CTStore.get('tabs',c.cardId)).state;const response=await browser.runtime.sendMessage({type:CT.MSG.OPEN,cardId:c.cardId});await new Promise(r=>setTimeout(r,500));return {cold,response,record:await CTStore.get('tabs',c.cardId),openTabs:await browser.tabs.query({}),live:(await CTStore.get('tabs',c.cardId)).tabId!=null};`);assert.equal(tracking.cold,'cold');assert.equal(tracking.live,true,JSON.stringify(tracking));console.log('PASS Firefox actual browser tab tracking, close and reopen');
  const singleton=await execute("await browser.runtime.sendMessage({type:CT.MSG.FOCUS_CANVAS});await browser.runtime.sendMessage({type:CT.MSG.FOCUS_CANVAS});return (await browser.tabs.query({})).filter(t=>t.url===browser.runtime.getURL('newtab.html')).length;");assert.equal(singleton,1);console.log('PASS Firefox singleton canvas');
 }finally{remote?.disconnect();await context?.close();await new Promise(r=>server.close(r));await fs.rm(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
