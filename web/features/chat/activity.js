'use strict';
class SessionActivity {
  constructor({storage=localStorage,key='bridge-session-activity',onRead=null,now=()=>globalThis.performance?.now()??Date.now()}={}){this.storage=storage;this.key=key;this.onRead=onRead;this.now=now;this.readTokens=new Map();this.refreshes=new Map();this.observationEpoch=0;this.observationVersion=0;this.observations=new Map();this.sideObservations=new Map();try{this.rows=JSON.parse(storage.getItem(key)||'{}');}catch{this.rows={};}}
  // Capture before an asynchronous read. These versions are page-local and
  // fence late responses against newer stream observations and identity resets.
  beginRead(){return {epoch:this.observationEpoch,version:++this.observationVersion};}
  isCurrentRead(observation){return observation.epoch===this.observationEpoch;}
  invalidate(keys){
    const observation=this.beginRead();
    for(const key of keys){
      this.observations.set(key,observation.version);this.sideObservations.set(key,observation.version);
      for(const child of this.rows[key]?.sideKeys||[])this.observations.set(child,observation.version);
    }
  }
  id(row){return row.host+'|'+row.id;}
  save(){try{this.storage.setItem(this.key,JSON.stringify(this.rows));}catch{}}
  waitingSnapshot(row,previous){
    // The gateway's last confirmed wait is shared across devices, even when
    // the current read is unavailable. It never establishes a live baseline.
    const result=row.sharedWaiting?this.waitingSnapshot({...row.sharedWaiting,activityConnected:true},previous):{};
    previous={...previous,...result};
    const fresh=!Number.isFinite(previous?.waitingObservedAt)||Number.isFinite(row.waitingObservedAt)&&row.waitingObservedAt>=previous.waitingObservedAt;
    const own=typeof row.waitingForUser==='boolean'?row.waitingForUser:row.waitingForUser===undefined&&row.connected&&Array.isArray(row.requests)?row.requests.length>0:null;
    if(fresh&&own!==null&&(row.connected||row.activityConnected)){result.waitingForUser=own;if(Number.isFinite(row.waitingObservedAt))result.waitingObservedAt=row.waitingObservedAt;}
    const subtreeFresh=!Number.isFinite(previous?.waitingSubagentsObservedAt)||Number.isFinite(row.waitingSubagentsObservedAt)&&row.waitingSubagentsObservedAt>=previous.waitingSubagentsObservedAt;
    if(subtreeFresh&&Number.isInteger(row.waitingSubagents)&&row.waitingSubagents>=0&&(row.waitingSubagents>0||row.subagentsKnown!==false)){result.waitingSubagents=row.waitingSubagents;if(Number.isFinite(row.waitingSubagentsObservedAt))result.waitingSubagentsObservedAt=row.waitingSubagentsObservedAt;}
    return result;
  }
  update(rows,visible=null,{sync=true,save=true,observation=this.beginRead()}={}){
    if(!this.isCurrentRead(observation))return;
    for(const row of rows){
      const key=this.id(row),parentStatus=row.parentStatus??row.status;
      let previous=this.rows[key];
      const fresh=observation.version>=(this.observations.get(key)||0);
      if(!fresh&&!previous)continue;
      if(Array.isArray(row.readCompletions)&&row.readCompletions.length){
        previous={...previous};
        for(const token of row.readCompletions)if(!previous.readCompletions?.includes(token))this.rememberRead(previous,token);
        if(previous.readCompletions?.includes(previous.pending))previous.pending=null;
        this.rows[key]=previous;
      }
      if(fresh){
        this.observations.set(key,observation.version);
        const waiting=this.waitingSnapshot(row,previous);
        // A different device may have observed the run. Gateway completion
        // evidence is independent of this device's historical baseline.
        if(row.completionToken&&row.completionToken!==previous?.completionToken){
          previous={...previous,completionToken:row.completionToken};
          if(!previous.readCompletions?.includes(row.completionToken))previous.pending=row.completionToken;
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
      }
      // Main-chat stream snapshots omit sideChats. Only a complete activity
      // response may remove children; reading the main chat never reads them.
      if(Array.isArray(row.sideChats)&&observation.version>=(this.sideObservations.get(key)||0)&&(!Number.isFinite(this.rows[key].sideChatsObservedAt)||Number.isFinite(row.sideChatsObservedAt)&&row.sideChatsObservedAt>=this.rows[key].sideChatsObservedAt)){
        this.sideObservations.set(key,observation.version);
        const old=this.rows[key].sideKeys||[],next=[];
        for(const child of row.sideChats)next.push(this.updateSideChat(row,child,false,{save:false,observation}));
        for(const child of old)if(!next.includes(child))this.forget(child);
        this.rows[key].sideKeys=next;
        if(Number.isFinite(row.sideChatsObservedAt))this.rows[key].sideChatsObservedAt=Math.max(row.sideChatsObservedAt,this.rows[key].sideChatsObservedAt||0);
      }
    }
    if(save)this.save();
  }
  updateSideChat(parent,row,visible=false,{save=true,observation=this.beginRead()}={}){
    const turn=row.turns?.at(-1);
    const key=this.id(parent),child={...row,turnId:row.turnId??turn?.turnId??turn?.id,turnStatus:row.turnStatus??turn?.status,host:parent.host,id:parent.id+'/side/'+row.id},childKey=this.id(child);
    if(!this.isCurrentRead(observation)||observation.version<(this.observations.get(childKey)||0)||!this.rows[key]&&observation.version<(this.observations.get(key)||0))return childKey;
    this.sideObservations.set(key,Math.max(observation.version,this.sideObservations.get(key)||0));
    this.rows[key]??={};
    if(Number.isFinite(row.waitingObservedAt))this.rows[key].sideChatsObservedAt=Math.max(row.waitingObservedAt,this.rows[key].sideChatsObservedAt||0);
    this.rows[key].sideKeys=[...new Set([...(this.rows[key].sideKeys||[]),childKey])];
    this.update([child],visible?childKey:null,{sync:visible,save,observation});
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
    return ['completed','awaiting','ended','running','unknown'].map(kind=>indicators.find(row=>row.kind===kind&&!row.stale)||indicators.find(row=>row.kind===kind)).find(Boolean)||null;
  }
  ownIndicator(key){
    const row=this.rows[key];if(!row)return null;
    if(row.manualUnread)return {kind:'completed',label:'未读'};
    const pendingStatus=row.pending?.split(':').at(-1);
    if(pendingStatus==='completed')return {kind:'completed',label:'已完成，未查看'};
    if(row.waitingForUser||row.waitingSubagents>0)return {kind:'awaiting',label:'等待你回复或处理'};
    if(row.pending)return {kind:'ended',label:pendingStatus==='failed'?'运行失败，未查看':'已停止，未查看'};
    if(row.offline){
      const failedAt=this.refreshes.get(key)?.failedAt;
      if(!Number.isFinite(failedAt)||this.now()-failedAt>=30000)return {kind:'unknown',label:row.offlineReason==='timeout'?'读取运行状态超时':'运行状态暂不可用'};
      return row.status==='active'?{kind:'running',label:row.runningSubagents?'上次确认子代理运行中，正在重新确认':'上次确认运行中，正在重新确认',stale:true}:null;
    }
    if(row.status==='active')return {kind:'running',label:row.runningSubagents?'子代理运行中':'运行中'};
    return null;
  }
  forget(key){delete this.rows[key];this.readTokens.delete(key);this.refreshes.delete(key);this.observations.set(key,++this.observationVersion);this.sideObservations.delete(key);}
  clear(){this.rows={};this.readTokens.clear();this.refreshes.clear();this.observations.clear();this.sideObservations.clear();this.observationEpoch++;this.storage.removeItem(this.key);}
}

class ActivityChanges {
  constructor({request,onChange,pause=null,now=()=>globalThis.performance?.now()??Date.now()}){
    Object.assign(this,{request,onChange,now});this.scope={};this.scopeStamp='';this.unsupported=false;this.healthy=false;
    this.pause=pause||((ms,signal)=>new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
    }));
  }
  setScope(hosts){
    const scope=Object.fromEntries(Object.entries(hosts).filter(([,ids])=>ids.length).sort(([a],[b])=>a.localeCompare(b)).slice(0,20).map(([host,ids])=>[host,[...new Set(ids)].slice(0,500).sort()]));
    const stamp=JSON.stringify(scope);if(stamp!==this.scopeStamp)this.healthy=false;
    this.scope=scope;this.scopeStamp=stamp;
    if(!Object.keys(scope).length){this.stop();return;}
    // Keep one long poll when scrolling changes the scope. After it returns,
    // replay its cursor with the new scope instead of abandoning server waiters.
    if(this.task||this.unsupported)return;
    const task={};this.task=task;task.promise=this.run(task);
  }
  canConfirm(host,id,streamId){return this.healthy&&!!this.task&&!this.unsupported&&this.streamId===streamId&&this.now()-this.confirmedAt<20000&&this.scope[host]?.includes(id)===true;}
  stop(){this.healthy=false;const task=this.task;this.task=null;task?.controller?.abort();}
  reset(){this.stop();this.scope={};this.scopeStamp='';this.streamId=null;this.cursor=null;this.unsupported=false;}
  async run(task){
    let retry=1000;
    try{
      while(this.task===task){
        const controller=task.controller=new AbortController(),stamp=this.scopeStamp,scope=this.scope,started=Date.now();
        const timeout=setTimeout(()=>controller.abort(),20000);
        try{
          const value=await this.request('/api/activity/changes',{hosts:scope,...(this.streamId?{streamId:this.streamId,after:this.cursor}:{})},controller.signal);
          if(this.task!==task)return;
          if(!value||!Number.isSafeInteger(value.cursor)||value.cursor<0||!/^[0-9a-f]{32}$/.test(value.streamId)||typeof value.reset!=='boolean'||!value.hosts||typeof value.hosts!=='object'||Array.isArray(value.hosts)||Object.values(value.hosts).some(ids=>!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))){this.unsupported=true;return;}
          if(value.closed){this.healthy=false;return;}
          if(stamp!==this.scopeStamp)continue;
          this.streamId=value.streamId;this.cursor=value.cursor;retry=1000;
          this.healthy=true;this.confirmedAt=this.now();
          if(value.reset)this.onChange(scope,true);
          else if(!value.reset&&Object.keys(value.hosts).length)this.onChange(value.hosts,false);
          clearTimeout(timeout);
          // An immediate empty response from a proxy must not become a hot loop.
          await this.pause(!value.reset&&!Object.keys(value.hosts).length&&Date.now()-started<1000?1000:150,controller.signal);
        }catch(error){
          if(this.task!==task)return;
          this.healthy=false;
          if([404,405,501].includes(error.status)){this.unsupported=true;return;}
          if(error.status===401)return;
          clearTimeout(timeout);
          const retryController=task.controller=new AbortController();
          await this.pause(retry,retryController.signal);retry=Math.min(15000,retry*2);
        }finally{clearTimeout(timeout);}
      }
    }finally{if(this.task===task){this.task=null;this.healthy=false;}}
  }
}

class ActivityPolling {
  constructor({now=()=>globalThis.performance?.now()??Date.now()}={}){this.now=now;this.confirmed=new Map();}
  observe(rows){
    for(const row of rows){
      const key=row.host+'|'+row.id;this.confirmed.delete(key);
      if(row.connected&&row.status!=='unknown'&&!row.activityError&&row.activityRealtime===true&&/^[0-9a-f]{32}$/.test(row.activityStreamId))this.confirmed.set(key,{at:this.now(),streamId:row.activityStreamId});
    }
    while(this.confirmed.size>4000)this.confirmed.delete(this.confirmed.keys().next().value);
  }
  due(row,changes){const known=this.confirmed.get(row.host+'|'+row.id);return !known||this.now()-known.at>=30000||!changes?.canConfirm(row.host,row.id,known.streamId);}
  fail(keys){for(const key of keys)this.confirmed.delete(key);}
  clear(){this.confirmed.clear();}
}
if(typeof module!=='undefined')module.exports={SessionActivity,ActivityChanges,ActivityPolling};
