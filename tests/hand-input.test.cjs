const{test}=require('node:test');const assert=require('node:assert/strict');
class Element extends EventTarget{
 constructor(){super();this.children=[];this.style={setProperty(){}};this.dataset={};this.attrs={};this.classList={toggle(){}};this.clientWidth=600;this.scrollLeft=0;}
 append(...c){this.children.push(...c);}replaceChildren(...c){this.children=c;}setAttribute(k,v){this.attrs[k]=v;}removeAttribute(k){delete this.attrs[k];}remove(){}replaceWith(){}focus(){}blur(){}getBoundingClientRect(){return{left:0};}
}
const fire=(el,type,props={})=>{const e=new Event(type);Object.assign(e,{button:0,clientX:156,clientY:10,pointerType:'mouse',...props});el.dispatchEvent(e);};
test('touch drag never activates; keyboard reveal survives old pointer coordinates',async()=>{
 let frames=[];global.document={createElement:()=>new Element()};global.ResizeObserver=class{observe(){}disconnect(){}};global.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};global.cancelAnimationFrame=()=>{};
 const paint=()=>{const f=frames;frames=[];f.forEach(fn=>fn());};
 const{createHand}=await import('../extension/src/hand.js');const root=new Element(),activated=[];
 const dock=createHand({root,buildCard:()=>new Element(),reducedMotion:()=>false,onActivate:id=>activated.push(id),onPointerDown:(e,c,n,surface)=>surface.addEventListener('pointerup',()=>dock.endGesture(),{once:true})});
 dock.setCards(Array.from({length:200},(_,i)=>({cardId:'c'+i,title:'Card '+i})));paint();const[scroll,,surface]=root.children;
 fire(surface,'pointerdown',{pointerType:'touch'});fire(surface,'pointerup',{pointerType:'touch'});paint();fire(surface,'pointerdown',{pointerType:'touch'});fire(surface,'pointermove',{pointerType:'touch',clientX:350,clientY:-200});fire(surface,'pointerup',{pointerType:'touch',clientX:350,clientY:-200});paint();assert.equal(activated.length,0);
 fire(surface,'pointermove',{clientX:300});paint();fire(root,'keydown',{key:'End'});paint();assert.equal(root.attrs['aria-activedescendant'],'hand-c199');fire(scroll,'scroll');await new Promise(resolve=>setTimeout(resolve,150));paint();assert.equal(root.attrs['aria-activedescendant'],'hand-c199');dock.destroy();
});
