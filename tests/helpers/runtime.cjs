const fs = require('node:fs');
const vm = require('node:vm');
const { IDBFactory } = require('fake-indexeddb');
function runtime(extra = {}, files = ['shared.js', 'storage.js', 'commands.js']) {
  const context = vm.createContext({ indexedDB: new IDBFactory(), structuredClone, Blob, URL, crypto, console, setTimeout, clearTimeout, ...extra });
  for (const file of files) vm.runInContext(fs.readFileSync(`${__dirname}/../../extension/src/${file}`, 'utf8'), context, { filename: file });
  return context;
}
module.exports = { runtime };
