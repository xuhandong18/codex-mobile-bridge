'use strict';
class SessionActivity {
  constructor({storage=localStorage,key='bridge-session-activity',onRead=null}={}){this.storage=storage;this.key=key;this.onRead=onRead;this.readTokens=new Map();try{this.rows=JSON.parse(storage.getItem(key)||'{}');}catch{this.rows={};}}
  id(row){return row.host+'|'+row.id;}
  save(){try{this.storage.setItem(this.key,JSON.stringify(this.rows));}catch{}}
  update(rows,visible=null,{sync=true,save=true}={}){
    for(const row of rows){
      const key=this.id(row),previous=this.rows[key],parentStatus=row.parentStatus??row.status;
      const running=parentStatus==='active'||row.runningSubagents>0;
      const terminal=parentStatus!=='active'&&['completed','failed','interrupted'].includes(row.turnStatus);
      if(!(row.activityConnected??row.connected)||row.status==='unknown'){
        this.rows[key]={...previous,offline:true,offlineReason:row.activityError||null};
      }else{
        const token=terminal&&row.turnId?row.turnId+':'+row.turnStatus:previous?.token||null;
        const subtreeFinished=previous?.runningSubagents>0&&!(row.runningSubagents>0);
        const wasActive=(previous?.parentStatus??previous?.status)==='active'||subtreeFinished;
        const pending=terminal&&token&&previous&&(!previous.readCompletions?.includes(token)||subtreeFinished)&&(previous.turnKnown||previous.token||wasActive)&&(token!==previous.token||previous.pending||wasActive)?token:previous?.pending||null;
        this.rows[key]={...previous,status:running?'active':parentStatus,parentStatus,runningSubagents:row.runningSubagents||0,turnId:row.turnId||previous?.turnId,turnStatus:row.turnStatus||previous?.turnStatus,turnKnown:!!row.turnStatus||previous?.turnKnown||false,token,pending:visible===key?null:pending,manualUnread:!!previous?.manualUnread,offline:false};
        if(visible===key)this.rememberRead(this.rows[key],terminal?token:previous?.pending);
        if(sync&&visible===key&&terminal&&row.turnId)this.syncRead(key);
      }
      // Main-chat stream snapshots omit sideChats. Only a complete activity
      // response may remove children; reading the main chat never reads them.
      if(Array.isArray(row.sideChats)){
        const old=this.rows[key].sideKeys||[],next=[];
        for(const child of row.sideChats)next.push(this.updateSideChat(row,child,false,{save:false}));
        for(const child of old)if(!next.includes(child))delete this.rows[child];
        this.rows[key].sideKeys=next;
      }
    }
    if(save)this.save();
  }
  updateSideChat(parent,row,visible=false,{save=true}={}){
    const turn=row.turns?.at(-1);
    const key=this.id(parent),child={...row,turnId:row.turnId??turn?.id,turnStatus:row.turnStatus??turn?.status,host:parent.host,id:parent.id+'/side/'+row.id},childKey=this.id(child);
    this.rows[key]??={};
    this.rows[key].sideKeys=[...new Set([...(this.rows[key].sideKeys||[]),childKey])];
    this.update([child],visible?childKey:null,{sync:false,save});
    return childKey;
  }
  rememberRead(row,token){if(token)row.readCompletions=[...(row.readCompletions||[]).filter(value=>value!==token),token].slice(-64);}
  markUnread(key){this.rows[key]={...this.rows[key],manualUnread:true};this.save();}
  read(key,{explicit=false,sync=true}={}){const row=this.rows[key];if(row){this.rememberRead(row,row.pending||row.token);row.pending=null;if(explicit){row.manualUnread=false;this.readTokens.delete(key);}this.save();if(sync)this.syncRead(key);}}
  syncRead(key){
    const row=this.rows[key];if(!this.onRead||!row||row.offline||row.manualUnread||(row.parentStatus??row.status)==='active'||!row.turnId||!['completed','failed','interrupted'].includes(row.turnStatus))return;
    const token=row.turnId+':'+row.turnStatus;if(this.readTokens.get(key)===token)return;
    // A lost write acknowledgement must not be replayed by polling.
    this.readTokens.set(key,token);try{Promise.resolve(this.onRead(key,{...row})).catch(()=>{});}catch{}
  }
  indicator(key){
    const indicators=[key,...(this.rows[key]?.sideKeys||[])].map(id=>this.ownIndicator(id)).filter(Boolean);
    return ['completed','ended','running','unknown'].map(kind=>indicators.find(row=>row.kind===kind)).find(Boolean)||null;
  }
  ownIndicator(key){
    const row=this.rows[key];if(!row)return null;
    if(row.manualUnread)return {kind:'completed',label:'未读'};
    if(row.pending){const status=row.pending.split(':').at(-1);return {kind:status==='completed'?'completed':'ended',label:status==='completed'?'已完成，未查看':status==='failed'?'运行失败，未查看':'已停止，未查看'};}
    if(row.offline)return {kind:'unknown',label:row.offlineReason==='timeout'?'读取运行状态超时':'运行状态暂不可用'};
    if(row.status==='active')return {kind:'running',label:row.runningSubagents?'子代理运行中':'运行中'};
    return null;
  }
  clear(){this.rows={};this.readTokens.clear();this.storage.removeItem(this.key);}
}
if(typeof module!=='undefined')module.exports={SessionActivity};
