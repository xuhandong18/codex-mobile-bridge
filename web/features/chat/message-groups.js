'use strict';

// Presentation only: grouping never changes message keys, history or turn state.
class ChatMessageGroups {
  constructor(container,node=(tag,classes='',text='')=>{
    const element=document.createElement(tag);element.className=classes;element.textContent=text;return element;
  }){this.container=container;this.node=node;this.groups=new Map();this.firstGroups=new Map();}
  static kind(message){
    if(message.isUserContext||message.kind==='reasoning'||message.role==='reasoning')return null;
    if(message.role==='assistant')return message.phase==='commentary'?'progress':null;
    return ['user','error'].includes(message.role)?null:'process';
  }
  static place(container,nodes){
    if(container.children.length===nodes.length&&nodes.every((node,index)=>container.children[index]===node))return;
    let position=container.firstChild;
    for(const node of nodes){if(node===position)position=position.nextSibling;else container.insertBefore(node,position);}
    const keep=new Set(nodes);for(const child of [...container.children])if(!keep.has(child))child.remove();
  }
  get(key){return this.groups.get(key)?.node||this.firstGroups.get(key);}
  render(entries,{showProcess=true}={}){
    const assignments=[],turns=new Map();let fallback=0;
    for(const entry of entries){
      const message=entry.message;
      if(message.role==='user'&&!message.isUserContext&&message.kind!=='threadMessage')fallback++;
      const turn=entry.turnId??'legacy:'+fallback,kind=ChatMessageGroups.kind(message);
      const state=turns.get(turn)||{};
      if(entry.turnStatus)state.status=entry.turnStatus;
      turns.set(turn,state);assignments.push({...entry,turn,kind});
    }
    // A different kind, turn, or standalone row ends the current segment.
    const segments=[];let current=null;
    for(const entry of assignments){
      entry.node.dataset.key=entry.key;
      if(!entry.kind){segments.push({node:entry.node});current=null;continue;}
      if(!current||current.kind!==entry.kind||current.turn!==entry.turn){
        current={kind:entry.kind,turn:entry.turn,entries:[]};segments.push(current);
      }
      current.entries.push(entry);
    }
    // Overlapping row keys retain expansion when older rows extend a segment.
    const priorGroups=new Map();
    for(const [id,group] of this.groups)for(const key of group.keys)priorGroups.set(JSON.stringify([group.turn,group.kind,key]),id);
    const roots=[],used=new Set();this.firstGroups.clear();
    for(const segment of segments){
      if(segment.node){roots.push(segment.node);continue;}
      const {kind,turn,entries:rows}=segment,baseKey='group:'+kind+':'+turn;
      const previous=rows.map(row=>priorGroups.get(JSON.stringify([turn,kind,row.key]))).find(id=>id&&!used.has(id));
      const groupKey=previous||baseKey+':'+rows[0].key;
      let group=this.groups.get(groupKey);
      const state=turns.get(turn),completed=state.status==='completed';
      const outcome=completed?'completed':['interrupted','failed','cancelled','stopped'].includes(state.status)?state.status:'running';
      if(!group){
        const root=this.node('details','chat-message-group chat-'+kind+'-group');root.dataset.key=groupKey;
        const label=kind==='progress'?'文字进度':'执行过程',summary=this.node('summary','chat-group-summary',typeof BridgeI18n==='undefined'?label:BridgeI18n.t(label));
        summary.dataset.i18n=label;
        const body=this.node('div','chat-group-body');root.append(summary,body);
        group={node:root,body,outcome};this.groups.set(groupKey,group);
        root.open=kind==='progress'&&!completed;
      }else if(kind==='progress'&&group.outcome!==outcome)group.node.open=!completed;
      Object.assign(group,{kind,turn,outcome,keys:new Set(rows.map(row=>row.key))});
      used.add(groupKey);roots.push(group.node);if(!this.firstGroups.has(baseKey))this.firstGroups.set(baseKey,group.node);
      const nodes=rows.map(row=>row.node);ChatMessageGroups.place(group.body,nodes);
      group.node.hidden=kind==='process'&&!showProcess||nodes.every(node=>node.hidden);
    }
    for(const [key,group] of this.groups){
      if(!used.has(key)){group.node.remove();this.groups.delete(key);}
    }
    ChatMessageGroups.place(this.container,roots);
  }
}
