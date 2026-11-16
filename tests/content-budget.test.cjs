const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');const{runtime}=require('./helpers/runtime.cjs');
test('a static visible page requests at most six captures over five minutes',async()=>{
 let now=100000;const timers=[],messages=[];const r=runtime({Date:class extends Date{static now(){return now;}},location:{href:'https://a.test/'},document:{visibilityState:'visible',title:'Static',head:null,readyState:'complete',querySelector:()=>null,addEventListener(){}},window:{addEventListener(){},scrollTo(){},scrollY:0},browser:{runtime:{sendMessage:async m=>{messages.push(m);return{y:0};}}},setTimeout(fn,delay){timers.push({fn,due:now+delay});},setInterval(fn,period){timers.push({fn,due:now+period,period});}},['shared.js']);
 vm.runInContext(fs.readFileSync('extension/src/content.js','utf8'),r);
 const end=now+300000;while(true){timers.sort((a,b)=>a.due-b.due);const t=timers.shift();if(!t||t.due>end)break;now=t.due;t.fn();if(t.period)timers.push({...t,due:now+t.period});}
 assert.ok(messages.filter(m=>m.type===r.CT.MSG.CAPTURE).length<=6);
});
