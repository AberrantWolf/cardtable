// One schema and commit-aware IndexedDB adapter for the page and both backgrounds.
(function (g) {
  let connection = null;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      const r = indexedDB.open(CT.DB, CT.DBV);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const name of ['tabs', 'shots', 'layout', 'groups', 'notes', 'meta']) {
          if (db.objectStoreNames.contains(name)) continue;
          const s = db.createObjectStore(name, { keyPath: name === 'meta' ? 'key' : ['groups', 'notes'].includes(name) ? 'id' : 'cardId' });
          if (name === 'tabs') { s.createIndex('tabId', 'tabId'); s.createIndex('url', 'url'); }
        }
      };
      r.onerror = () => { connection = null; reject(r.error); };
      r.onblocked = () => console.warn('[cardtable] Close other canvas pages to finish the storage upgrade.');
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); connection = null; };
        db.onclose = () => { connection = null; };
        resolve(db);
      };
    });
    return connection;
  }
  async function transaction(names, mode, enqueue) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const stores = Object.fromEntries(names.map(n => [n, tx.objectStore(n)]));
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('Storage transaction aborted'));
      tx.onerror = () => {}; // abort is the terminal failure; never resolve a request early
      try {
        const value = enqueue(stores, tx, v => { result = v; });
        if (value && typeof value.then === 'function') throw new Error('Transaction callbacks must enqueue synchronously');
      } catch (e) { failure = e; tx.abort(); }
    });
  }
  const read = (name, method, key) => transaction([name], 'readonly', (s, tx, result) => {
    const req = key === undefined ? s[name][method]() : s[name][method](key);
    req.onsuccess = () => result(req.result);
  });
  async function snapshot() {
    const names = Object.keys(CT.STORES);
    return transaction(names, 'readonly', (s, tx, result) => {
      const board = {}; result(board);
      for (const name of names) {
        const request=name==='meta'?s.meta.get('revision'):s[name].getAll();
        request.onsuccess=e=>{board[name]=name==='meta'?(e.target.result?[e.target.result]:[]):e.target.result;
          if(name==='meta')s.meta.get('boardEpoch').onsuccess=ev=>{if(ev.target.result)board.meta.push(ev.target.result);};
        };
      }
    });
  }
  g.CTStore = { open, transaction, snapshot, get: (s, k) => read(s, 'get', k), all: s => read(s, 'getAll') };
})(globalThis);
