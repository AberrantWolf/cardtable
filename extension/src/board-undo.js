// Undo data lives in IndexedDB so service-worker suspension cannot invalidate a visible token.
(function(g){
  const keyOf=o=>o.type==='put'?(o.value.cardId??o.value.id):o.key;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const size=v=>v instanceof Blob?v.size:!v||typeof v!=='object'?JSON.stringify(v)?.length||0:Object.values(v).reduce((n,x)=>n+size(x),0);
  async function edit({operations,before=[],label='Edit',commandId}){
    if(commandId){const saved=await CTStore.get('meta','undo:'+commandId);if(saved)return {token:commandId,label,conflicts:saved.conflicts||[]};}
    const inverses=[],expected=[],seen=new Set(),resolved=[],conflicts=[];
    for(const op of operations){
      const key=keyOf(op),tag=op.store+':'+key;
      if(seen.has(tag))throw new Error('Duplicate mutation key');seen.add(tag);
      const supplied=before.find(r=>r.store===op.store&&r.key===key);
      const old=await CTStore.get(op.store,key);
      if(old===undefined&&supplied?.value!==undefined&&!supplied.pendingCreate)throw new Error('This item was deleted in another canvas');
      const existed=old!==undefined||!!(supplied?.pendingCreate&&Object.keys(supplied.pendingFields||{}).length);
      let actual=op,baseline=old,fields;
      if(supplied&&['layout','groups','notes'].includes(op.store)){
        baseline={...old};
        for(const [field,value]of Object.entries(supplied.pendingFields||{})){
          if(same(old?.[field],supplied.pendingBase?.[field])||same(old?.[field],value))baseline[field]=value;
          else conflicts.push({store:op.store,key,field});
        }
        if(op.type==='put'){
          const start=supplied.value||supplied.preview||{},changes=Object.fromEntries(Object.entries(op.value).filter(([k,v])=>!same(v,start[k])));
          const field=['groups','notes'].includes(op.store)?'id':'cardId';
          actual={...op,value:{...baseline,...changes,[field]:key}};
          if(existed)fields=Object.keys(changes).filter(k=>k!==field);
        }
      }
      resolved.push(actual);
      let value=baseline;
      if(op.store==='tabs'&&value)value={...value,tabId:null,state:'cold'};
      inverses.push(!existed?{type:'delete',store:op.store,key}:fields?{type:'patch',store:op.store,key,value:Object.fromEntries(fields.map(k=>[k,baseline[k]]))}:{type:'put',store:op.store,value});
      expected.push({store:op.store,key,value:actual.type==='put'?actual.value:undefined,fields});
    }
    const history=[...((await CTStore.get('meta','undo-index'))?.value||[])];
    const token=commandId||CT.uuid(),entry={key:'undo:'+token,created:Date.now(),before:inverses,expected,label,conflicts};entry.bytes=size(entry);
    let total=entry.bytes;for(const h of history)total+=h.bytes||0;
    const cleanup=[];
    while(history.length&&(history.length>=50||total>32*1024*1024)){const h=history.shift();total-=h.bytes||0;cleanup.push({type:'delete',store:'meta',key:h.key});}
    if(entry.bytes>32*1024*1024)throw new Error('This operation exceeds the 32 MiB undo limit');
    history.push({key:entry.key,created:entry.created,bytes:entry.bytes});
    await CTCommands.commit([...resolved,...cleanup,{type:'put',store:'meta',value:entry},{type:'put',store:'meta',value:{key:'undo-index',value:history}}]);
    return {token,label,conflicts};
  }
  async function undo(token){
    const entry=await CTStore.get('meta','undo:'+token),receipts=(await CTStore.get('meta','undo-done'))?.value||[];
    if(!entry){if(receipts.includes(token))return {alreadyUndone:true};throw new Error('Undo expired');}
    for(const e of entry.expected){const current=await CTStore.get(e.store,e.key);if(e.fields?(!current||e.fields.some(k=>!same(current[k],e.value[k]))):!same(current,e.value))throw new Error('This item changed since the action; undo would overwrite newer work');}
    const history=((await CTStore.get('meta','undo-index'))?.value||[]).filter(e=>e.key!==entry.key);
    await CTCommands.commit([...entry.before,{type:'delete',store:'meta',key:entry.key},{type:'put',store:'meta',value:{key:'undo-index',value:history}},{type:'put',store:'meta',value:{key:'undo-done',value:[...receipts,token].slice(-50)}}]);return {label:entry.label};
  }
  g.CTUndo={edit,undo};
})(globalThis);
