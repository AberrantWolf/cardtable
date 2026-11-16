import {hitHand,layoutHand,HAND_PITCH,HAND_PADDING} from './hand-layout.js';

export function createHand({root,buildCard,reducedMotion,onPointerDown,onActivate,canInteract=()=>true,onHover=()=>{},presentationKey=()=>''}){
  const scroll=document.createElement('div'),track=document.createElement('div'),visuals=document.createElement('div'),surface=document.createElement('div');
  scroll.className='hand-scroll';track.className='hand-track';visuals.className='hand-visuals';surface.className='hand-surface';scroll.append(track);root.replaceChildren(scroll,visuals,surface);
  root.tabIndex=0;root.setAttribute('role','listbox');root.setAttribute('aria-label','Unplaced tab cards. Arrow keys navigate; Enter opens.');
  let cards=[],focus=null,selected=null,pointer=null,frozen=false,frame=null,scrolling=false,scrollTimer=null,lastDown=null,previousDown=null,touchFocus=null,downPoint=null;
  const nodes=new Map();
  function paint(){
    frame=null;const width=root.clientWidth;
    track.style.width=Math.max(width,HAND_PADDING*2+cards.length*HAND_PITCH)+'px';
    const rows=layoutHand({count:cards.length,focusCoordinate:scrolling?null:focus,scrollLeft:scroll.scrollLeft,viewportWidth:width,reducedMotion:reducedMotion()});
    const wanted=new Set(rows.map(r=>cards[r.index].cardId));
    for(const[id,node]of nodes)if(!wanted.has(id)){node.remove();nodes.delete(id);}
    for(const row of rows){
      const c=cards[row.index];let node=nodes.get(c.cardId);
      // Hand cards have no editors or capture handlers; refresh only when their content changes.
      const signature=[c.title,c.shotUrl,c.faviconUrl,c.favicon,reducedMotion(),presentationKey()].join('|');
      if(!node||node._content!==signature){const fresh=buildCard(c,true);fresh._content=signature;if(node)node.replaceWith(fresh);else visuals.append(fresh);node=fresh;nodes.set(c.cardId,node);}
      node.id='hand-'+c.cardId;node.setAttribute('role','option');node.setAttribute('aria-label',c.title);node.setAttribute('aria-selected',String(row.selected));
      node.style.left=(row.x-79)+'px';node.style.setProperty('--card-w','158px');node.style.transform=`translateY(${row.selected?-12:0}px) scale(${row.width/158})`;node.style.zIndex=row.z;node.classList.toggle('hand-focused',row.selected);
      node.style.visibility=frozen&&selected===c.cardId?'hidden':'';
    }
    if(selected&&nodes.has(selected))root.setAttribute('aria-activedescendant','hand-'+selected);else root.removeAttribute('aria-activedescendant');
  }
  function schedule(){if(frame===null)frame=requestAnimationFrame(paint);}
  function aim(event){
    pointer={x:event.clientX,y:event.clientY};if(downPoint&&Math.hypot(event.clientX-downPoint.x,event.clientY-downPoint.y)>5){surface.dataset.touchActivate='';lastDown=null;}if(frozen||scrolling)return;
    const bounds=root.getBoundingClientRect(),index=hitHand({clientX:event.clientX,trackLeft:bounds.left,scrollLeft:scroll.scrollLeft,count:cards.length});
    focus=index===null?null:Math.max(0,Math.min(cards.length-1,(event.clientX-bounds.left+scroll.scrollLeft-HAND_PADDING)/HAND_PITCH-0.5));
    const next=index===null?null:cards[index].cardId;
    if(next!==selected){selected=next;onHover(next===null?null:cards[index],nodes.get(next));}schedule();
  }
  surface.addEventListener('pointermove',aim);
  surface.addEventListener('pointerleave',()=>{if(!frozen){pointer=null;focus=null;selected=null;onHover(null);schedule();}});
  surface.addEventListener('pointerdown',event=>{
    if(event.button!==0||!canInteract())return;aim(event);if(!selected)return;
    downPoint={x:event.clientX,y:event.clientY};root.focus({preventScroll:true});previousDown=lastDown;lastDown=selected;
    const c=cards.find(c=>c.cardId===selected),node=nodes.get(selected);if(!node)return;
    if(event.pointerType==='touch'){
      if(touchFocus===selected)surface.dataset.touchActivate=selected;else surface.dataset.touchActivate='';touchFocus=selected;
    }
    frozen=true;onPointerDown(event,c,node,surface);schedule();
  });
  surface.addEventListener('dblclick',()=>{if(lastDown&&lastDown===previousDown)onActivate(lastDown);});
  surface.addEventListener('pointerup',()=>{if(surface.dataset.touchActivate){const id=surface.dataset.touchActivate;surface.dataset.touchActivate='';onActivate(id);}});
  root.addEventListener('wheel',event=>{event.preventDefault();event.stopPropagation();scroll.scrollLeft+=event.deltaX||event.deltaY;},{passive:false});
  scroll.addEventListener('scroll',()=>{
    scrolling=true;clearTimeout(scrollTimer);schedule();scrollTimer=setTimeout(()=>{scrolling=false;if(pointer&&!frozen)aim({clientX:pointer.x,clientY:pointer.y});else schedule();},120);
  });
  root.addEventListener('keydown',event=>{
    const keys=['ArrowLeft','ArrowRight','Home','End','Enter','Escape'];if(!keys.includes(event.key))return;event.preventDefault();event.stopPropagation();
    pointer=null;if(!cards.length)return;let index=Math.max(0,cards.findIndex(c=>c.cardId===selected));
    if(event.key==='Enter'){onActivate(cards[index].cardId);return;}
    if(event.key==='Escape'){focus=null;selected=null;root.blur();schedule();return;}
    index=event.key==='Home'?0:event.key==='End'?cards.length-1:Math.max(0,Math.min(cards.length-1,index+(event.key==='ArrowRight'?1:-1)));
    focus=index;selected=cards[index].cardId;const x=HAND_PADDING+(index+0.5)*HAND_PITCH;
    if(x-scroll.scrollLeft<115)scroll.scrollLeft=x-115;else if(x-scroll.scrollLeft>root.clientWidth-115)scroll.scrollLeft=x-root.clientWidth+115;
    schedule();
  });
  const resize=new ResizeObserver(schedule);resize.observe(root);
  return {
    setCards(next){cards=next;root.style.width=`min(calc(100vw - 200px), ${Math.max(280,Math.min(1140,HAND_PADDING*2+cards.length*HAND_PITCH))}px)`;if(selected&&!cards.some(c=>c.cardId===selected)){selected=null;focus=null;}else if(selected&&!pointer)focus=cards.findIndex(c=>c.cardId===selected);schedule();},
    endGesture(){frozen=false;downPoint=null;surface.dataset.touchActivate='';schedule();},
    clearHover(){onHover(null);},
    destroy(){resize.disconnect();clearTimeout(scrollTimer);if(frame!==null)cancelAnimationFrame(frame);},
  };
}
