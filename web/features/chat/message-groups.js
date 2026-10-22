'use strict';

// Presentation only: grouping never changes message keys, history or turn state.
class ChatMessageGroups {
  constructor(container,node=(tag,classes='',text='')=>{
    const element=document.createElement(tag);element.className=classes;element.textContent=text;return element;
  }){this.container=container;this.node=node;this.groups=new Map();this.firstGroups=new Map();}
  static kind(message){
    if(message.isUserContext)return null;
    if(message.kind==='reasoning'||message.role==='reasoning')return 'process';
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
  static decorateTime(node,message,make=(tag,classes='',text='')=>{
    const element=document.createElement(tag);element.className=classes;element.textContent=text;return element;
  }){
    const value=message.timestamp;
    const numeric=typeof value==='number'||typeof value==='string'&&/^\d+(\.\d+)?$/.test(value);
    const date=new Date(numeric?(Number(value)<1e11?Number(value)*1000:Number(value)):typeof value==='string'?value:NaN);
    if(!Number.isFinite(date.getTime())||date.getTime()<=0)return;
    const text=['user','assistant','error'].includes(message.role);
    let parent=text?node.querySelector('.message-actions'):node.querySelector('summary');
    if(!parent&&text){parent=make('div','message-actions');node.append(parent);}
    if(!parent)return;
    let time=parent.querySelector('.message-time');
    if(!time){time=make('time','message-time');parent.append(time);}
    const pad=value=>String(value).padStart(2,'0');
    const clock=pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds());
    time.dateTime=date.toISOString();time.textContent=pad(date.getMonth()+1)+'-'+pad(date.getDate())+' '+clock;
    time.title=date.getFullYear()+'-'+time.textContent;
    // Actions may arrive later than the message body; the timestamp stays last.
    parent.append(time);
  }
  progressSummary(summary){
    // The first rendered message is the summary itself: no duplicate preview.
    summary.onclick=event=>{
      if(event.target.closest?.('a,button,input,select,textarea,[role="button"]'))return;
      const selection=window.getSelection();if(selection&&!selection.isCollapsed){event.preventDefault();return;}
      if(event.detail===0)return; // Keep native keyboard activation.
      const body=summary.querySelector('.message-body'),first=body?.firstElementChild||body||summary;
      const rect=first.getBoundingClientRect(),style=getComputedStyle(first);
      const line=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.8;
      if(event.clientY>rect.top+line)event.preventDefault();
    };
  }
  render(entries,{showProcess=true}={}){
    const assignments=[],turns=new Map();let fallback=0;
    for(const entry of entries){
      const message=entry.message;
      ChatMessageGroups.decorateTime(entry.node,message,this.node);
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
        const label='执行过程',summary=this.node('summary','chat-group-summary'+(kind==='progress'?' chat-progress-summary':''),kind==='progress'?'':typeof BridgeI18n==='undefined'?label:BridgeI18n.t(label));
        if(kind==='progress')this.progressSummary(summary);else summary.dataset.i18n=label;
        const body=this.node('div','chat-group-body');root.append(summary,body);
        group={node:root,summary,body,outcome};this.groups.set(groupKey,group);
        root.open=kind==='progress'&&!completed;
      }else if(kind==='progress'&&group.outcome!==outcome)group.node.open=!completed;
      Object.assign(group,{kind,turn,outcome,keys:new Set(rows.map(row=>row.key))});
      used.add(groupKey);roots.push(group.node);if(!this.firstGroups.has(baseKey))this.firstGroups.set(baseKey,group.node);
      const nodes=rows.map(row=>row.node);
      if(kind==='progress')ChatMessageGroups.place(group.summary,nodes.slice(0,1));
      ChatMessageGroups.place(group.body,kind==='progress'?nodes.slice(1):nodes);
      group.node.hidden=kind==='process'&&!showProcess||nodes.every(node=>node.hidden);
    }
    for(const [key,group] of this.groups){
      if(!used.has(key)){group.node.remove();this.groups.delete(key);}
    }
    ChatMessageGroups.place(this.container,roots);
  }
}
