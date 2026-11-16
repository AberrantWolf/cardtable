// Capture scheduling/validation is independent of persistence and browser event wiring.
(function(g){
  async function encode(dataUrl, maxWidth, quality) {
    const bitmap=await createImageBitmap(await(await fetch(dataUrl)).blob());
    try {
      const scale=Math.min(1,maxWidth/bitmap.width), canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      return await canvas.convertToBlob({type:'image/jpeg',quality});
    } finally { bitmap.close?.(); }
  }
  function create({browser:X,prepare,commit,settings,encode:resize=encode,report=console.warn}) {
    const last=new Map(),timers=new Map(),windows=new Map(),runningTabs=new Map(),epochs=new Map(),errors=new Set();
    function cancel(id){clearTimeout(timers.get(id));timers.delete(id);last.delete(id);epochs.set(id,(epochs.get(id)||0)+1);if(epochs.size>1000)epochs.delete(epochs.keys().next().value);}
    async function active(tab){try{const t=(await X.tabs.query({active:true,windowId:tab.windowId}))[0];return t?.id===tab.id&&t.url===tab.url?t:null;}catch{return null;}}
    async function capture(tab){
      if(!tab||!CT.isTrackable(tab.url))return;
      if(windows.has(tab.windowId)){const current=windows.get(tab.windowId);return runningTabs.get(tab.windowId)===tab.id?current:current.then(()=>capture(tab));}
      const run=(async()=>{
        const epoch=epochs.get(tab.id)||0;
        try {
          if(Date.now()-(last.get(tab.id)||0)<5000||!await active(tab))return;
          const token=await prepare(tab);if(!token)return;
          last.set(tab.id,Date.now());
          const s=settings(),data=await X.tabs.captureVisibleTab(tab.windowId,{format:'jpeg',quality:Math.round((s.shotQuality||0.7)*100)});
          if(!await active(tab))return;
          const blob=await resize(data,s.shotMaxWidth||480,s.shotQuality||0.7);
          if((epochs.get(tab.id)||0)!==epoch||!await active(tab))return;
          await commit(token,blob);
        }catch(e){const key=e.message||String(e);if(!errors.has(key)){if(errors.size>=50)errors.delete(errors.values().next().value);errors.add(key);report(e);}}
      })();
      windows.set(tab.windowId,run);runningTabs.set(tab.windowId,tab.id);
      try{return await run;}finally{windows.delete(tab.windowId);runningTabs.delete(tab.windowId);}
    }
    function request(tab){
      if(!tab||!CT.isTrackable(tab.url))return;
      clearTimeout(timers.get(tab.id));
      timers.set(tab.id,setTimeout(()=>{timers.delete(tab.id);capture(tab);},Math.max(400,5000-(Date.now()-(last.get(tab.id)||0)))));
    }
    return {capture,request,cancel,pendingCount:()=>timers.size};
  }
  g.CTCapture={create};
})(globalThis);
