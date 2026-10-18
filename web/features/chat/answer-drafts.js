'use strict';

// Draft metadata is independent of native approval/respond operations.
class AnswerDrafts {
  static entries=new Map();
  static prefix='answer-drafts:v1:';
  static bind(form,{scope,request}){
    const groups=[...form.querySelectorAll('[data-answer-key]')];
    if(!groups.length)return;
    scope=JSON.stringify(scope);
    const key=this.prefix+(window.BridgeRelayBase||location.origin)+'|'+scope;
    let entry=this.entries.get(key);
    if(!entry){
      let fields=Object.create(null);try{Object.assign(fields,JSON.parse(localStorage.getItem(key)||'{}'));}catch{}
      const pending=new Set(Object.keys(fields).filter(field=>fields[field].dirty&&!fields[field].sent));
      entry={key,scope,fields,forms:new Set(),request,loaded:false,reading:false,saving:false,pending};
      if(Object.values(fields).some(row=>row.dirty&&row.sent))entry.error='答案暂未同步，当前输入已保存在本机。';
      this.entries.set(key,entry);
    }
    entry.request=request;entry.forms.add(form);
    const status=document.createElement('p');status.className='muted';status.dataset.draftStatus='loading';status.setAttribute('role','status');form.append(status);
    for(const group of groups){
      this.restore(group,entry.fields[group.dataset.answerKey]);
      const edit=()=>{
        const field=group.dataset.answerKey,previous=entry.fields[field];
        entry.fields[field]={value:this.value(group),version:previous?.version||0,dirty:true,sent:false};
        entry.pending.add(field);entry.error='';this.persist(entry);this.paint(entry);
        clearTimeout(entry.timer);entry.timer=setTimeout(()=>this.flush(entry),150);
      };
      group.addEventListener('input',edit);group.addEventListener('change',edit);
    }
    this.paint(entry);this.read(entry);
    if(!this.timer)this.timer=setInterval(()=>{
      if(document.hidden)return;
      for(const item of this.entries.values()){
        item.forms=new Set([...item.forms].filter(node=>node.isConnected));
        if(item.forms.size)this.read(item);
      }
    },1500);
  }
  static value(group){return [...group.querySelectorAll('input,select,textarea')].map(input=>({value:input.value,checked:!!input.checked}));}
  static restore(group,record){
    if(!record?.value)return;
    const inputs=[...group.querySelectorAll('input,select,textarea')];
    if(inputs.length!==record.value.length)return;
    if(JSON.stringify(this.value(group))===JSON.stringify(record.value))return;
    inputs.forEach((input,i)=>{input.value=record.value[i].value;if(['radio','checkbox'].includes(input.type))input.checked=record.value[i].checked;});
    group.dispatchEvent(new Event('draftrestore'));
  }
  static persist(entry){if(!entry.closed)try{localStorage.setItem(entry.key,JSON.stringify(entry.fields));}catch{}}
  static paint(entry){
    const dirty=Object.values(entry.fields).some(row=>row.dirty);
    const error=entry.error||(entry.loaded&&dirty&&!entry.saving&&!entry.pending.size?'答案暂未同步，当前输入已保存在本机。':'');
    const text=error||(!entry.loaded?'正在恢复答案…':dirty?'正在保存答案…':'答案已保存');
    for(const form of entry.forms){
      const status=form.querySelector('[data-draft-status]');if(!status)continue;
      status.textContent=window.BridgeI18n?.t(text)||text;
      status.dataset.draftStatus=error?'error':!entry.loaded?'loading':dirty?'saving':'saved';
    }
  }
  static async read(entry){
    if(entry.closed||entry.reading||entry.saving)return;
    entry.reading=true;
    const writeEpoch=entry.writeEpoch||0;
    try{
      const result=await entry.request('/api/answer-drafts?scope='+encodeURIComponent(entry.scope));
      if(entry.closed||entry.saving||(entry.writeEpoch||0)!==writeEpoch)return;
      for(const [field,remote] of Object.entries(result.fields)){
        const local=entry.fields[field];
        if(local?.dirty){
          // An uncertain save is confirmed by reading; never replay it.
          if(!entry.pending.has(field)&&JSON.stringify(local.value)===JSON.stringify(remote.value))entry.fields[field]=remote;
          else if(!entry.pending.has(field))local.version=remote.version;
          continue;
        }
        if(!local||remote.version>=local.version){
          entry.fields[field]=remote;
          for(const form of entry.forms)for(const group of form.querySelectorAll('[data-answer-key]')){
            if(group.dataset.answerKey===field)this.restore(group,remote);
          }
        }
      }
      for(const [field,local] of Object.entries(entry.fields)){
        if(!Object.hasOwn(result.fields,field)&&!entry.pending.has(field)){
          local.version=0;local.dirty=true;local.sent=true;
        }
      }
      entry.loaded=true;
      if(!Object.values(entry.fields).some(row=>row.dirty))entry.error='';
      this.persist(entry);
    }catch{entry.error='答案暂未同步，当前输入已保存在本机。';}
    finally{entry.reading=false;this.paint(entry);}
    if(entry.loaded&&entry.pending.size)this.flush(entry);
  }
  static async flush(entry){
    if(entry.closed||entry.saving)return;
    if(!entry.loaded){this.read(entry);return;}
    entry.saving=true;
    entry.writeEpoch=(entry.writeEpoch||0)+1;
    try{
      while(!entry.closed&&entry.pending.size){
        const field=entry.pending.values().next().value,record=entry.fields[field];entry.pending.delete(field);
        record.sent=true;this.persist(entry);
        try{
          const saved=await entry.request('/api/answer-drafts',{scope:entry.scope,field,value:record.value,version:record.version});
          const latest=entry.fields[field];
          if(latest===record)entry.fields[field]=saved;
          else latest.version=saved.version;
          this.persist(entry);
        }catch(error){
          entry.pending.delete(field);
          entry.error=error.status===409?'其他设备已修改此答案，当前输入已保留。请核对后重新编辑。':'答案暂未同步，当前输入已保存在本机。';
          break;
        }
      }
    }finally{entry.saving=false;this.paint(entry);}
    if(entry.error)this.read(entry);
  }
  static clear(){
    clearInterval(this.timer);this.timer=null;
    for(const entry of this.entries.values()){entry.closed=true;entry.pending.clear();clearTimeout(entry.timer);}
    this.entries.clear();
    try{for(let i=localStorage.length-1;i>=0;i--){const key=localStorage.key(i);if(key?.startsWith(this.prefix))localStorage.removeItem(key);}}catch{}
  }
}
document.addEventListener('bridge-logged-out',()=>AnswerDrafts.clear());
document.addEventListener('bridge-auth-lost',()=>AnswerDrafts.clear());
window.addEventListener('pagehide',()=>{for(const entry of AnswerDrafts.entries.values())AnswerDrafts.flush(entry);});
