// Capacity-only recovery. See dsh-client-auto-continue for the host-owned engine pattern.
// No startup scans, silent-turn recovery, autonomous loop, or replay of uncertain sends.
import {randomUUID} from 'node:crypto';
export function capacityFailure(reason){
  if(reason?.kind!=='error')return false;
  const e=reason.error;return !!e&&(['serverOverloaded','server_overloaded','model_overloaded'].includes(e.code)||e.message==='Selected model is at capacity. Please try a different model.');
}
export function createRecovery({personal,save,inspect,send,serialize,clock=Date.now,schedule=setTimeout,unschedule=clearTimeout}){
  personal.recovery??={enabled:true,records:{}};const state=personal.recovery,timers=new Map(),started=new Map(),deferredEnds=new Map();let disposed=false;
  for(const record of Object.values(state.records))if(['waiting','sending','awaiting'].includes(record.status))record.status=record.status==='sending'?'unknown':'cancelled';
  const finish=(sid,record,status='cancelled')=>{unschedule(timers.get(sid));timers.delete(sid);if(record)record.status=status;};
  const intervene=async sid=>{finish(sid,state.records[sid]);started.delete(sid);deferredEnds.delete(sid);await save();};
  async function attempt(sid,record){
    if(disposed||!state.enabled||state.records[sid]!==record||record.status!=='waiting')return;
    let now;try{now=await inspect(sid);}catch{finish(sid,record);await save();return;}
    if(disposed||!state.enabled||state.records[sid]!==record||record.status!=='waiting')return;
    if(!now||now.running||now.queued||now.waiting||now.side||now.goalDriving||now.external||now.turn!==record.turn){finish(sid,record);await save();return;}
    const id=randomUUID();record.attempts.push({id,time:clock()});record.status='sending';await save();
    if(disposed||!state.enabled||state.records[sid]!==record||record.status!=='sending')return;
    try{const result=await send(sid,id);if(record.status==='sending')record.status=result?.accepted===true?'awaiting':'unknown';}
    catch{if(record.status==='sending')record.status='unknown';}await save();
    const ending=deferredEnds.get(sid);deferredEnds.delete(sid);
    if(ending&&record.status==='awaiting')observe(sid,ending);
  }
  function observe(sid,event){
    if(disposed)return;
    const data=event.data||{},record=state.records[sid];
    if(event.type.startsWith('goal/')||event.type==='model/selection'){finish(sid,record);save().catch(()=>{});return;}
    if(event.type==='turn/start'){started.set(sid,data.turn);if(['sending','awaiting'].includes(record?.status))record.activeTurn=data.turn;return;}
    if(event.type==='user/message'){
      const source=(data.message||data).source;
      if(source?.kind==='user'&&!record?.attempts.some(a=>a.id===source.rpcId)){finish(sid,record);save().catch(()=>{});}return;
    }
    if(event.type!=='turn/end'||started.get(sid)!==data.turn)return;
    // Native execution can settle before prompt acceptance arrives. Reconcile
    // that ending only after the exact persisted attempt has a known receipt.
    if(record?.status==='sending'){deferredEnds.set(sid,event);return;}
    started.delete(sid);
    if(!capacityFailure(data.reason)||!state.enabled){finish(sid,record);save().catch(()=>{});return;}
    if(record&&['unknown','exhausted'].includes(record.status))return;
    const chain=record?.status==='awaiting'&&record.activeTurn===data.turn?record:{attempts:[],status:'new'};
    chain.turn=data.turn;chain.activeTurn=null;state.records[sid]=chain;
    if(chain.attempts.length>=3){finish(sid,chain,'exhausted');save().catch(()=>{});return;}
    chain.status='waiting';const wait=chain.attempts.length?Math.max(0,chain.attempts.at(-1).time+600000-clock()):0;
    // Persist the schedule before admitting the automatic mutation.
    save().then(()=>{if(disposed||chain.status!=='waiting')return;timers.set(sid,schedule(()=>{timers.delete(sid);return serialize(()=>attempt(sid,chain)).catch(()=>{});},wait));}).catch(()=>{chain.status='unknown';});
  }
  return {observe,intervene,settings:()=>({enabled:state.enabled}),set:async enabled=>{if(typeof enabled!=='boolean')throw Error('自动继续开关无效');state.enabled=enabled;if(!enabled)for(const [sid,r]of Object.entries(state.records))finish(sid,r);await save();},dispose:()=>{disposed=true;for(const t of timers.values())unschedule(t);timers.clear();}};
}
