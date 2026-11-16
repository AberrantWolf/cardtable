// Pure validation for untrusted board files. Also registers atomic board commands in background.
(function (g) {
  const fail = message => { throw new Error('Invalid board: ' + message); };
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const text = (v, name, max = 100000) => typeof v === 'string' && v.length <= max ? v : fail(name);
  const id = v => { text(v, 'ID', 200); if (!v || !/^[\w.-]+$/.test(v)) fail('ID characters'); return v; };
  const num = (v, name, min = -1e8, max = 1e8) => Number.isFinite(v) && v >= min && v <= max ? v : fail(name);
  const ranges = { cardWidth:[120,500], titleLines:[1,5], labelSize:[11,34], noteSize:[9,22], groupSize:[14,48], stickySize:[120,320], stickyFontSize:[11,34], shotQuality:[0.3,0.95], shotMaxWidth:[120,1920] };
  function validateSettings(saved) {
    if (!object(saved)) fail('settings');
    const out = CT.normalizeSettings();
    for (const [k,v] of Object.entries(saved)) {
      if (!Object.hasOwn(CT.DEFAULTS,k)) continue;
      if (typeof v !== typeof CT.DEFAULTS[k]) fail('setting ' + k);
      if (typeof v === 'number') { const [a,b]=ranges[k] || [0,1e8]; num(v,k,a,b); }
      if (typeof v === 'string') text(v,k,1000);
      out[k]=v;
    }
    if (!['slate','paper'].includes(out.theme)) fail('theme');
    for (const k of ['feltColor','stickyColor']) if (!/^#[a-f\d]{6}$/i.test(out[k])) fail(k);
    return out;
  }
  function validate(data) {
    if (!object(data) || data.v !== 1) fail('expected a version 1 cardtable export');
    const out = { v:1 };
    for (const n of ['tabs','layout','groups','notes']) {
      const rows = n === 'notes' && data[n] === undefined ? [] : data[n];
      if (!Array.isArray(rows) || rows.length > 10000) fail(n);
      const seen=new Set();
      out[n]=rows.map(r=>{
        if (!object(r)) fail(n+' record'); const key = n==='groups'||n==='notes' ? 'id' : 'cardId';
        const keyValue=id(r[key]); if(seen.has(keyValue)) fail('duplicate '+key); seen.add(keyValue);
        if(n==='tabs') {
          const url=text(r.url,'URL',16000); if(!CT.isTrackable(url)) fail('HTTP(S) URL'); try { new URL(url); } catch { fail('URL'); }
          return {cardId:keyValue,url,title:text(r.title??url,'title'),favicon:'',tabId:null,state:'cold',scrollY:num(r.scrollY??0,'scroll',0),createdAt:num(r.createdAt??Date.now(),'createdAt',0,1e15),lastSeen:num(r.lastSeen??0,'lastSeen',0,1e15)};
        }
        if(n==='groups') return {id:keyValue,name:text(r.name??'','group name'),seed:num(r.seed??0,'seed',0,2**32)};
        const common={ [key]:keyValue,x:num(r.x,'x'),y:num(r.y,'y'),rot:num(r.rot??0,'rotation',-360,360),z:num(r.z??1,'z',0,1e12) };
        if(n==='notes') return {...common,text:text(r.text??'','note')};
        if(r.placed!==undefined && typeof r.placed!=='boolean') fail('placed');
        return {...common,note:text(r.note??'','card note'),placed:r.placed===true,group:r.group==null?null:id(r.group)};
      });
    }
    const tabs=new Set(out.tabs.map(r=>r.cardId)),groups=new Set(out.groups.map(r=>r.id));
    for(const l of out.layout) if(!tabs.has(l.cardId)||(l.group&&!groups.has(l.group))) fail('layout reference');
    for(const n of out.notes) if(tabs.has(n.id)) fail('note/card ID collision');
    if(data.settings!==undefined) out.settings=validateSettings(data.settings);
    if(data.view!==undefined) { if(!object(data.view)) fail('view'); out.view={x:num(data.view.x,'view x'),y:num(data.view.y,'view y'),zoom:num(data.view.zoom,'zoom',0.2,3)}; }
    return out;
  }
  g.CTBoardFormat={validate,validateSettings};
  if (!g.CTCommands) return;
  CTCommands.register('importBoard',async ({mode,board})=>{
    if(!['merge','replace'].includes(mode)) fail('import mode');
    const valid=validate(board), existing=await CTStore.snapshot(), ops=[];
    const collisions=Object.fromEntries(['tabs','layout','groups','notes'].map(n=>[n,new Set(existing[n].map(r=>r.cardId??r.id))]));
    if(mode==='replace'){
      ops.push({type:'put',store:'meta',value:{key:'boardEpoch',value:((await CTStore.get('meta','boardEpoch'))?.value||0)+1}});
      for(const row of (await CTStore.get('meta','undo-index'))?.value||[])ops.push({type:'delete',store:'meta',key:row.key});
      for(const key of ['undo-index','undo-done'])ops.push({type:'delete',store:'meta',key});
    }
    if(mode==='replace') for(const store of ['tabs','shots','layout','groups','notes']) ops.push({type:'clear',store});
    let added=0,skipped=0;
    for(const store of ['tabs','layout','groups','notes']) for(const value of valid[store]) {
      const key=value.cardId??value.id;
      const skip=mode==='merge'&&(collisions[store].has(key)||(store==='layout'&&(collisions.tabs.has(key)||collisions.notes.has(key)))||(store==='notes'&&collisions.tabs.has(key))||(store==='tabs'&&collisions.notes.has(key)));
      if(skip) { if(store==='tabs') skipped++; continue; }
      ops.push({type:'put',store,value}); if(store==='tabs') added++;
    }
    await CTCommands.commit(ops);
    return {added,skipped,settings:mode==='replace'?valid.settings:undefined,view:mode==='replace'?valid.view:undefined};
  });
  CTCommands.register('exportBoard',async ()=>{
    const b=await CTStore.snapshot();
    return {v:1,exportedAt:new Date().toISOString(),tabs:b.tabs.map(t=>({...t,tabId:null,state:'cold'})),layout:b.layout,groups:b.groups,notes:b.notes};
  });
})(globalThis);
