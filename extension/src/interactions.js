// One terminal path for pointer capture, cancellation, and listener cleanup.
export class GestureSession {
  constructor(element,pointerId,{onCancel=()=>{},onCleanup=()=>{}}={}){
    this.element=element;this.pointerId=pointerId;this.onCancel=onCancel;this.onCleanup=onCleanup;this.closed=false;
    this.controller=new AbortController();this.signal=this.controller.signal;
    element.addEventListener('lostpointercapture',()=>this.cancel(),{signal:this.signal});
    element.addEventListener('pointercancel',()=>this.cancel(),{signal:this.signal,capture:true});
    try{element.setPointerCapture(pointerId);}catch{/* cancellation still cleans listeners */}
  }
  close(cancel){
    if(this.closed)return;this.closed=true;
    this.controller.abort();
    try{if(cancel)this.onCancel();}finally{try{this.onCleanup();}finally{try{this.element.releasePointerCapture(this.pointerId);}catch{}}}
  }
  finish(){this.close(false);}
  cancel(){this.close(true);}
}
export function movementSnapshot(cards,notes,selection){
  return [...cards.filter(c=>selection.has(c.cardId)).map(value=>({kind:'card',id:value.cardId,value,x:value.x,y:value.y})),...notes.filter(n=>selection.has(n.id)).map(value=>({kind:'note',id:value.id,value,x:value.x,y:value.y}))];
}
