const{test}=require('node:test');const assert=require('node:assert/strict');
test('moving one card invalidates only its groups and labels reuse geometry',async()=>{
 const{GroupGeometry}=await import('../extension/src/geometry.js');const cache=new GroupGeometry();let a=[{x:0,y:0,w:100,h:200}],b=[{x:500,y:0,w:100,h:200}];
 const first=cache.get('a',a,50,1);cache.get('b',b,50,2);assert.equal(cache.builds,2);assert.equal(cache.get('a',a,50,1),first);
 a=[{...a[0],x:10}];cache.get('a',a,50,1);cache.get('b',b,50,2);assert.equal(cache.builds,3);
 cache.get('a',[{...a[0],w:230}],50,1);assert.equal(cache.builds,4);cache.prune(new Set(['a']));assert.equal(cache.size,1);
});
