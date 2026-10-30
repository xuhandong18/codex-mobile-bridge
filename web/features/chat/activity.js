'use strict';
class SessionActivity {
  constructor({storage=localStorage,key='bridge-session-activity',onRead=null,now=()=>globalThis.performance?.now()??Date.now()}={}){this.storage=storage;this.key=key;this.onRead=onRead;this.now=now;this.readTokens=new Map();this.refreshes=new Map();try{this.rows=JSON.parse(storage.getItem(key)||'{}');}catch{this.rows={};}}
  id(row){return row.host+'|'+row.id;}
  save(){try{this.storage.setItem(this.key,JSON.stringify(this.rows));}catch{}}
  waitingSnapshot(row,previous){
    const result={},fresh=!Number.isFinite(previous?.waitingObservedAt)||Number.isFinite(row.waitingObservedAt)&&row.waitingObservedAt>=previous.waitingObservedAt;
    const own=typeof row.waitingForUser==='boolean'?row.waitingForUser:row.waitingForUser===undefined&&row.connected&&Array.isArray(row.requests)?row.requests.length>0:null;
    if(fresh&&own!==null&&(row.connected||row.activityConnected)){result.waitingForUser=own;if(Number.isFinite(row.waitingObservedAt))result.waitingObservedAt=row.waitingObservedAt;}
    const subtreeFresh=!Number.isFinite(previous?.waitingSubagentsObservedAt)||Number.isFinite(row.waitingSubagentsObservedAt)&&row.waitingSubagentsObservedAt>=previous.waitingSubagentsObservedAt;
    if(subtreeFresh&&Number.isInteger(row.waitingSubagents)&&row.waitingSubagents>=0&&(row.waitingSubagents>0||row.subagentsKnown!==false)){result.waitingSubagents=row.waitingSubagents;if(Number.isFinite(row.waitingSubagentsObservedAt))result.waitingSubagentsObservedAt=row.waitingSubagentsObservedAt;}
    return result;
  }
  update(rows,visible=null,{sync=true,save=true}={}){
    for(const row of rows){
      const key=this.id(row),parentStatus=row.parentStatus??row.status;
      let previous=this.rows[key];
      const waiting=this.waitingSnapshot(row,previous);
      if(Array.isArray(row.readCompletions)&&row.readCompletions.length){
        previous={...previous};
        for(const token of row.readCompletions)if(!previous.readCompletions?.includes(token))this.rememberRead(previous,token);
        if(previous.readCompletions?.includes(previous.pending))previous.pending=null;
        this.rows[key]=previous;
      }
      const running=parentStatus==='active'||row.runningSubagents>0;
      const terminal=parentStatus!=='active'&&['completed','failed','interrupted'].includes(row.turnStatus);
      if(!(row.activityConnected??row.connected)||!row.status||row.status==='unknown'){
        const refresh=this.refreshes.get(key);
        if(refresh&&refresh.failedAt===null)refresh.failedAt=this.now();
        this.rows[key]={...previous,...waiting,offline:true,offlineReason:row.activityError||null};
      }else{
        // Display grace is page-local. Persisted badges never establish a fresh
        // baseline, and failed reads remain offline for sync/write decisions.
        this.refreshes.set(key,{failedAt:null});
        const token=terminal&&row.turnId?row.turnId+':'+row.turnStatus:previous?.token||null;
        const subtreeFinished=previous?.runningSubagents>0&&!(row.runningSubagents>0);
        const wasActive=(previous?.parentStatus??previous?.status)==='active'||subtreeFinished;
        const pending=terminal&&token&&previous&&(!previous.readCompletions?.includes(token)||subtreeFinished)&&(previous.turnKnown||previous.token||wasActive)&&(token!==previous.token||previous.pending||wasActive)?token:previous?.pending||null;
        this.rows[key]={...previous,...waiting,status:running?'active':parentStatus,parentStatus,runningSubagents:row.runningSubagents||0,turnId:row.turnId||previous?.turnId,turnStatus:row.turnStatus||previous?.turnStatus,turnKnown:!!row.turnStatus||previous?.turnKnown||false,token,pending:visible===key?null:pending,manualUnread:!!previous?.manualUnread,offline:false};
        if(visible===key)this.rememberRead(this.rows[key],terminal?token:previous?.pending);
        if(sync&&visible===key&&terminal&&row.turnId)this.syncRead(key);
      }
      // Main-chat stream snapshots omit sideChats. Only a complete activity
      // response may remove children; reading the main chat never reads them.
      if(Array.isArray(row.sideChats)&&(!Number.isFinite(this.rows[key].sideChatsObservedAt)||Number.isFinite(row.sideChatsObservedAt)&&row.sideChatsObservedAt>=this.rows[key].sideChatsObservedAt)){
        const old=this.rows[key].sideKeys||[],next=[];
        for(const child of row.sideChats)next.push(this.updateSideChat(row,child,false,{save:false}));
        for(const child of old)if(!next.includes(child))this.forget(child);
        this.rows[key].sideKeys=next;
        if(Number.isFinite(row.sideChatsObservedAt))this.rows[key].sideChatsObservedAt=Math.max(row.sideChatsObservedAt,this.rows[key].sideChatsObservedAt||0);
      }
    }
    if(save)this.save();
  }
  updateSideChat(parent,row,visible=false,{save=true}={}){
    const turn=row.turns?.at(-1);
    const key=this.id(parent),child={...row,turnId:row.turnId??turn?.id,turnStatus:row.turnStatus??turn?.status,host:parent.host,id:parent.id+'/side/'+row.id},childKey=this.id(child);
    this.rows[key]??={};
    if(Number.isFinite(row.waitingObservedAt))this.rows[key].sideChatsObservedAt=Math.max(row.waitingObservedAt,this.rows[key].sideChatsObservedAt||0);
    this.rows[key].sideKeys=[...new Set([...(this.rows[key].sideKeys||[]),childKey])];
    this.update([child],visible?childKey:null,{sync:visible,save});
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
    return ['awaiting','completed','ended','running','unknown'].map(kind=>indicators.find(row=>row.kind===kind&&!row.stale)||indicators.find(row=>row.kind===kind)).find(Boolean)||null;
  }
  ownIndicator(key){
    const row=this.rows[key];if(!row)return null;
    if(row.waitingForUser||row.waitingSubagents>0)return {kind:'awaiting',label:'等待你回复或处理'};
    if(row.manualUnread)return {kind:'completed',label:'未读'};
    if(row.pending){const status=row.pending.split(':').at(-1);return {kind:status==='completed'?'completed':'ended',label:status==='completed'?'已完成，未查看':status==='failed'?'运行失败，未查看':'已停止，未查看'};}
    if(row.offline){
      const failedAt=this.refreshes.get(key)?.failedAt;
      if(!Number.isFinite(failedAt)||this.now()-failedAt>=30000)return {kind:'unknown',label:row.offlineReason==='timeout'?'读取运行状态超时':'运行状态暂不可用'};
      return row.status==='active'?{kind:'running',label:row.runningSubagents?'上次确认子代理运行中，正在重新确认':'上次确认运行中，正在重新确认',stale:true}:null;
    }
    if(row.status==='active')return {kind:'running',label:row.runningSubagents?'子代理运行中':'运行中'};
    return null;
  }
  forget(key){delete this.rows[key];this.readTokens.delete(key);this.refreshes.delete(key);}
  clear(){this.rows={};this.readTokens.clear();this.refreshes.clear();this.storage.removeItem(this.key);}
}
if(typeof module!=='undefined')module.exports={SessionActivity};
