// db.js — page-side IndexedDB accessor. Same schema as background.js. The page reads all
// stores and OWNS writes to layout/groups/notes; tabs/shots are written by the background.
let _db = null;
function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(CT.DB, CT.DBV);
    r.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(CT.STORES.tabs)) {
        const s = db.createObjectStore(CT.STORES.tabs, { keyPath: "cardId" });
        s.createIndex("tabId", "tabId", { unique: false });
        s.createIndex("url", "url", { unique: false });
      }
      if (!db.objectStoreNames.contains(CT.STORES.shots)) db.createObjectStore(CT.STORES.shots, { keyPath: "cardId" });
      if (!db.objectStoreNames.contains(CT.STORES.layout)) db.createObjectStore(CT.STORES.layout, { keyPath: "cardId" });
      if (!db.objectStoreNames.contains(CT.STORES.groups)) db.createObjectStore(CT.STORES.groups, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CT.STORES.notes)) db.createObjectStore(CT.STORES.notes, { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function db() { if (!_db) _db = await open(); return _db; }
function p(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
async function store(name, mode) { return (await db()).transaction(name, mode).objectStore(name); }

const DBP = {
  all: async (name) => p((await store(name, "readonly")).getAll()),
  get: async (name, k) => p((await store(name, "readonly")).get(k)),
  put: async (name, v) => p((await store(name, "readwrite")).put(v)),
  del: async (name, k) => p((await store(name, "readwrite")).delete(k)),
  clear: async (name) => p((await store(name, "readwrite")).clear()),
};
export default DBP;
