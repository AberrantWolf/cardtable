// Page reads use the shared schema. Writes are routed to the background command owner.
const X = globalThis.browser || globalThis.chrome;
async function mutate(operations, epoch) {
  const r = await X.runtime.sendMessage({ type: CT.MSG.MUTATE, operations, epoch });
  if (!r || !r.ok) throw new Error(r?.error?.message || 'Could not save board');
  return r;
}
const DBP = {
  all: CTStore.all, get: CTStore.get, snapshot: CTStore.snapshot, mutate,
  put: (store, value) => mutate([{ type: 'put', store, value }]),
  del: (store, key) => mutate([{ type: 'delete', store, key }]),
  clear: store => mutate([{ type: 'clear', store }]),
};
export default DBP;
