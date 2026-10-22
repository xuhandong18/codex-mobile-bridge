'use strict';

// Presentation only: grouping never changes message keys, history or turn state.
class ChatMessageGroups {
  constructor(container,node=(tag,classes='',text='')=>{
    const element=document.createElement(tag);element.className=classes;element.textContent=text;return element;
  }){this.container=container;this.node=node;this.groups=new Map();}
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
  get(key){return this.groups.get(key)?.node;}
  render(entries,{showProcess=true}={}){
    const assignments=[],turns=new Map();let fallback=0;
    for(const entry of entries){
      const message=entry.message;
      if(message.role==='user'&&!message.isUserContext&&message.kind!=='threadMessage')fallback++;
      const turn=entry.turnId??'legacy:'+fallback,kind=ChatMessageGroups.kind(message);
      const state=turns.get(turn)||{finished:false};
      if(['completed','interrupted','failed','cancelled','stopped'].includes(entry.turnStatus)
        ||message.role==='assistant'&&message.phase==='final_answer')state.finished=true;
      turns.set(turn,state);assignments.push({...entry,turn,kind});
    }
    const roots=[],used=new Set(),children=new Map();
    for(const {key,node,turn,kind} of assignments){
      node.dataset.key=key;
      if(!kind){roots.push(node);continue;}
      const groupKey='group:'+kind+':'+turn;
      let group=this.groups.get(groupKey);
      const finished=turns.get(turn).finished;
      if(!group){
        const root=this.node('details','chat-message-group chat-'+kind+'-group');root.dataset.key=groupKey;
        const label=kind==='progress'?'文字进度':'执行过程',summary=this.node('summary','chat-group-summary',typeof BridgeI18n==='undefined'?label:BridgeI18n.t(label));
        summary.dataset.i18n=label;
        const body=this.node('div','chat-group-body');root.append(summary,body);
        group={node:root,body,finished};this.groups.set(groupKey,group);
        root.open=kind==='progress'&&!finished;
      }else if(kind==='progress'&&group.finished!==finished)group.node.open=!finished;
      group.finished=finished;
      if(!used.has(groupKey)){used.add(groupKey);roots.push(group.node);children.set(groupKey,[]);}
      children.get(groupKey).push(node);
    }
    for(const [key,group] of this.groups){
      if(!used.has(key)){group.node.remove();this.groups.delete(key);continue;}
      const nodes=children.get(key);ChatMessageGroups.place(group.body,nodes);
      group.node.hidden=key.startsWith('group:process:')&&!showProcess||nodes.every(node=>node.hidden);
    }
    ChatMessageGroups.place(this.container,roots);
  }
}
