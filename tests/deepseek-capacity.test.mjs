import test from 'node:test';import assert from 'node:assert/strict';
import {createRecovery,capacityFailure} from '../bridge/clients/deepseek/recovery.mjs';
const failure={kind:'error',error:{code:'serverOverloaded',message:'model at capacity'}};
function fixture(){
  let time=1000000,next=0;const timers=new Map(),personal={},sent=[],saved=[];let current={turn:1,running:false},sendError=false,duringSend,inspectGate;
  const options={personal,save:async()=>saved.push(JSON.parse(JSON.stringify(personal))),inspect:async()=>{await inspectGate;return current;},send:async(sid,id)=>{sent.push({sid,id});duringSend?.(sid,id);if(sendError)throw Error('unknown acceptance');return {accepted:true};},serialize:fn=>fn(),clock:()=>time,schedule:(fn,delay)=>{const id=++next;timers.set(id,{fn,at:time+delay});return id;},unschedule:id=>timers.delete(id)};
  let recovery=createRecovery(options);
  const turn=async(n,reason=failure)=>{current.turn=n;recovery.observe('main',{type:'turn/start',data:{turn:n}});recovery.observe('main',{type:'turn/end',data:{turn:n,reason}});await Promise.resolve();await Promise.resolve();};
  const tick=async ms=>{time+=ms;for(const [id,t]of [...timers])if(t.at<=time){timers.delete(id);await t.fn();}await Promise.resolve();};
  return {personal,sent,saved,current,timers,turn,tick,get recovery(){return recovery;},restart:()=>{recovery.dispose();recovery=createRecovery(options);},failSend:()=>{sendError=true;},duringSend:fn=>{duringSend=fn;},blockInspect:promise=>{inspectGate=promise;}};
}
test('capacity classifier excludes authentication, quota, context limits and arbitrary 503 errors',()=>{
  assert.equal(capacityFailure(failure),true);for(const code of ['401','rate_limit','quota_exceeded','context_length_exceeded','UNKNOWN'])assert.equal(capacityFailure({kind:'error',error:{code,message:'some error',status:503}}),false);assert.equal(capacityFailure({kind:'max-tokens'}),false);
});
test('new failure continues immediately, repeats after ten minutes, and stops after three attempts',async()=>{
  const f=fixture();f.recovery.observe('main',{type:'turn/end',data:{turn:0,reason:failure}});await f.tick(0);assert.equal(f.sent.length,0);
  await f.turn(1);await f.tick(0);assert.equal(f.sent.length,1);assert.equal(f.saved.some(x=>x.recovery.records.main?.status==='sending'),true);
  for(let n=2;n<=3;n++){await f.turn(n);await f.tick(599999);assert.equal(f.sent.length,n-1);await f.tick(1);assert.equal(f.sent.length,n);}
  await f.turn(4);await f.tick(999999);assert.equal(f.sent.length,3);assert.equal(f.personal.recovery.records.main.status,'exhausted');assert.equal(new Set(f.sent.map(s=>s.id)).size,3);
});
test('manual intervention, native goals, other recovery engines and side sessions cancel scheduled sends',async()=>{
  for(const field of ['side','goalDriving','external','queued','running']){const f=fixture();await f.turn(1);f.current[field]=true;await f.tick(0);assert.equal(f.sent.length,0,field);assert.equal(f.personal.recovery.records.main.status,'cancelled');}
  const f=fixture();await f.turn(1);await f.recovery.intervene('main');await f.tick(0);assert.equal(f.sent.length,0);
  await f.turn(2);await f.recovery.set(false);await f.tick(0);assert.equal(f.sent.length,0);
});
test('unknown acceptance and restart never replay a prior recovery request',async()=>{
  const f=fixture();await f.turn(1);f.failSend();await f.tick(0);assert.equal(f.sent.length,1);assert.equal(f.personal.recovery.records.main.status,'unknown');await f.turn(2);await f.tick(999999);assert.equal(f.sent.length,1);f.restart();await f.tick(999999);assert.equal(f.sent.length,1);
  const queued=fixture();await queued.turn(1);queued.restart();await queued.tick(999999);assert.equal(queued.sent.length,0);assert.equal(queued.personal.recovery.records.main.status,'cancelled');
});
test('a native ending before its prompt receipt preserves the same fault budget',async()=>{
  const f=fixture();f.duringSend((sid,id)=>{const turn=++f.current.turn;f.recovery.observe(sid,{type:'turn/start',data:{turn}});f.recovery.observe(sid,{type:'user/message',data:{source:{kind:'user',rpcId:id}}});f.recovery.observe(sid,{type:'turn/end',data:{turn,reason:failure}});});
  await f.turn(1);await f.tick(0);assert.equal(f.sent.length,1);assert.equal(f.personal.recovery.records.main.attempts.length,1);
  await f.tick(600000);await f.tick(600000);await f.tick(600000);assert.equal(f.sent.length,3);assert.equal(f.personal.recovery.records.main.status,'exhausted');
});
test('manual intervention during asynchronous inspection cancels the not-yet-sent attempt',async()=>{
  const f=fixture();let release;f.blockInspect(new Promise(resolve=>release=resolve));await f.turn(1);const firing=f.tick(0);await Promise.resolve();await f.recovery.intervene('main');release();await firing;assert.equal(f.sent.length,0);assert.equal(f.personal.recovery.records.main.status,'cancelled');
});
