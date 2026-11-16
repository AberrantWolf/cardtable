// Background mutation ordering. Browser effects and encoding run outside IDB transactions.
(function (g) {
  let tail = Promise.resolve();
  const listeners = new Set(), handlers = new Map();
  function enqueue(fn) { const run = tail.then(fn); tail = run.catch(() => {}); return run; }
  async function commit(operations) {
    if (!operations.length) return null;
    const names = [...new Set(['meta', ...operations.map(o => o.store)])];
    const change = await CTStore.transaction(names, 'readwrite', (s, tx, result) => {
      const c = { revision: 0, epoch:0, upserts: {}, deletes: {}, reset: false };
      const epoch=s.meta.get('boardEpoch');epoch.onsuccess=()=>{c.epoch=operations.find(o=>o.store==='meta'&&o.value?.key==='boardEpoch')?.value.value??epoch.result?.value??0;};
      const revision = s.meta.get('revision');
      revision.onsuccess = () => { c.revision = (revision.result?.value || 0) + 1; s.meta.put({ key: 'revision', value: c.revision }); };
      const record = (name, value) => { if(name !== 'meta') (c.upserts[name] ||= []).push(name === 'shots' ? { cardId: value.cardId } : value); };
      for (const op of operations) {
        if (!s[op.store] || (op.store === 'meta' && (op.key || op.value?.key) === 'revision')) throw new Error('Invalid store');
        if (op.type === 'put') { s[op.store].put(op.value); record(op.store, op.value); }
        else if (op.type === 'patch') {
          const request=s[op.store].get(op.key);
          request.onsuccess=()=>{
            if(!request.result&&!op.create){tx.abort();return;}
            const field=['groups','notes'].includes(op.store)?'id':'cardId',value={...request.result,...op.value,[field]:op.key};
            s[op.store].put(value);record(op.store,value);
          };
        }
        else if (op.type === 'delete') { s[op.store].delete(op.key); if(op.store !== 'meta') (c.deletes[op.store] ||= []).push(op.key); }
        else if (op.type === 'clear') { s[op.store].clear(); c.reset = true; }
        else throw new Error('Invalid mutation');
      }
      result(c);
    });
    for (const fn of listeners) { try { fn(change); } catch (e) { console.error('[cardtable] change notification', e); } }
    return change;
  }
  g.CTCommands = {
    enqueue, commit, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    register(name, fn) { handlers.set(name, fn); },
    invoke(name, input) { const fn = handlers.get(name); if (!fn) throw new Error('Unknown command'); return fn(input); },
    run(name, input) { return enqueue(async () => { const fn = handlers.get(name); if (!fn) throw new Error('Unknown command'); return fn(input); }); },
    idle: () => tail,
  };
})(globalThis);
