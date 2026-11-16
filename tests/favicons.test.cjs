const{test}=require('node:test');const assert=require('node:assert/strict');const{runtime}=require('./helpers/runtime.cjs');
test('remote and oversized icons are rejected; local raster data is accepted',()=>{
 const{CT}=runtime({},['shared.js']);assert.equal(CT.localFavicon('https://example.com/icon.png'), '');assert.equal(CT.localFavicon('data:image/svg+xml;base64,PHN2Zz4='),'');
 assert.equal(CT.localFavicon('data:image/png;base64,aW1hZ2U='),'data:image/png;base64,aW1hZ2U=');assert.equal(CT.localFavicon('data:image/png;base64,'+'a'.repeat(200000)),'');
});
