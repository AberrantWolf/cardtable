// Committed records are indexed separately from unsaved editor drafts.
export class BoardModel {
  constructor() {
    this.rows=Object.fromEntries(['tabs','layout','groups','notes','shots'].map(n=>[n,new Map()]));
    this.revision=-1;this.epoch=0;this.drafts=new Map();this.members=new Map();
  }
  indexMembers(){this.members.clear();for(const l of this.rows.layout.values())if(l.placed&&l.group){if(!this.members.has(l.group))this.members.set(l.group,new Set());this.members.get(l.group).add(l.cardId);}}
  replace(snapshot){
    const revision=snapshot.meta?.find(r=>r.key==='revision')?.value||0;
    if(revision<this.revision)return false;
    const epoch=snapshot.meta?.find(r=>r.key==='boardEpoch')?.value||0;if(epoch!==this.epoch)this.drafts.clear();this.epoch=epoch;
    for(const n of Object.keys(this.rows))this.rows[n]=new Map((snapshot[n]||[]).map(r=>[r.cardId??r.id,r]));
    this.revision=revision;this.indexMembers();return true;
  }
  apply(change){
    if(change.revision<=this.revision)return true;
    if((change.epoch??this.epoch)!==this.epoch||change.reset||change.revision!==this.revision+1)return false;
    for(const [n,rows]of Object.entries(change.upserts||{}))if(this.rows[n])for(const r of rows)this.rows[n].set(r.cardId??r.id,r);
    for(const [n,ids]of Object.entries(change.deletes||{}))if(this.rows[n])for(const id of ids)this.rows[n].delete(id);
    this.revision=change.revision;if(change.upserts?.layout||change.deletes?.layout)this.indexMembers();return true;
  }
  draft(id,fields){this.drafts.set(id,{...this.drafts.get(id),...fields});}
  entity(id){return {...this.rows.tabs.get(id),...this.rows.layout.get(id),...this.rows.notes.get(id),...this.drafts.get(id)};}
}
