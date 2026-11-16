function event() { const listeners = []; return { addListener(fn) { listeners.push(fn); }, fire(...args) { return Promise.all(listeners.map(fn => fn(...args))); } }; }
function fakeBrowser(initial = [], initialSettings = {}) {
  const tabs = new Map(initial.map(t => [t.id, { windowId: 1, active: false, ...t }]));
  const session = {}, local = { settings: initialSettings }, sent = [], effects = [];
  let nextId = 100, nextWindow = 10;
  const area = data => ({ async get(keys) { if (keys == null) return structuredClone(data); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(data[k])])); }, async set(v) { Object.assign(data, structuredClone(v)); }, async remove(k) { delete data[k]; } });
  const b = {
    storage: { local: area(local), session: area(session), onChanged: event() },
    runtime: { getURL: p => 'chrome-extension://test/' + p, async sendMessage(m) { sent.push(m); }, onInstalled: event(), onStartup: event(), onMessage: event() },
    tabs: {
      onCreated: event(), onUpdated: event(), onActivated: event(), onRemoved: event(), onReplaced: event(),
      async query(q = {}) { return [...tabs.values()].filter(t => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)); },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return structuredClone(tabs.get(id)); },
      async create(opts) { const t = { id: nextId++, windowId: 1, ...opts }; tabs.set(t.id, t); b.tabs.onCreated.fire(structuredClone(t)); effects.push(['create', t.id]); return structuredClone(t); },
      async update(id, opts) { const t = tabs.get(id); if (!t) throw new Error('No tab'); Object.assign(t, opts); effects.push(['update', id, opts]); return structuredClone(t); },
      async remove(id) { tabs.delete(id); b.tabs.onRemoved.fire(id); effects.push(['remove', id]); },
      async captureVisibleTab() { return 'data:image/jpeg;base64,aW1hZ2U='; },
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event(), async update() {}, async create(opts) { const id = nextWindow++; let t; if (opts.tabId) { t = tabs.get(opts.tabId); t.windowId = id; } else { t = await b.tabs.create({ url: opts.url, active: true }); tabs.get(t.id).windowId = id; } return { id, tabs: [{ ...t, windowId: id }] }; } },
    commands: { onCommand: event() }, action: { onClicked: event() }, permissions: { onAdded: event() },
  };
  return { browser: b, tabs, session, local, sent, effects };
}
module.exports = { fakeBrowser, event };
