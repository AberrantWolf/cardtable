// Logical hit cells never depend on magnified visual rectangles.
export const HAND_PITCH=82,HAND_PADDING=115;
export function hitHand({clientX,trackLeft,scrollLeft,pitch=HAND_PITCH,count}){
  if(!count)return null;
  return Math.max(0,Math.min(count-1,Math.floor((clientX-trackLeft+scrollLeft-HAND_PADDING)/pitch)));
}
export function layoutHand({count,focusCoordinate=null,scrollLeft,viewportWidth,reducedMotion=false}){
  if(!count)return [];
  const focused=focusCoordinate!==null,focus=focused?Math.max(0,Math.min(count-1,focusCoordinate)):0;
  const selected=Math.round(focus),size=reducedMotion?158:230,maxWidth=Math.min(size,Math.max(80,viewportWidth-16));
  const center=i=>HAND_PADDING+(i+0.5)*HAND_PITCH-scrollLeft+(focused&&!reducedMotion?74*Math.tanh((i-focus)/1.5):0);
  const anchor=center(selected),shift=focused?Math.max(maxWidth/2,Math.min(viewportWidth-maxWidth/2,anchor))-anchor:0;
  const first=Math.max(0,Math.floor((scrollLeft-HAND_PADDING-shift)/HAND_PITCH)-3),last=Math.min(count-1,Math.ceil((scrollLeft+viewportWidth-HAND_PADDING-shift)/HAND_PITCH)+3),out=[];
  for(let i=first;i<=last;i++){
    const d=Math.abs(i-focus),width=focused&&!reducedMotion?(i===selected?maxWidth:Math.min(maxWidth,158+72*Math.exp(-d*d/3))):Math.min(158,maxWidth);
    out.push({index:i,x:center(i)+shift,width,z:focused?10000-Math.round(d*100):i,selected:focused&&i===selected});
  }
  return out;
}
