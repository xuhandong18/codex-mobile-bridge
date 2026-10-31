import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {editCurrent,planCurrent} from '../bridge/clients/deepseek/inline-current.mjs';
function fixture(){
  const events=[],sent=[],append=(type,data,fields={})=>{const e={seq:events.length,time:events.length,type,data,...fields};events.push(e);return e;};
  append('system/message',{content:[]});append('turn/start',{turn:1});append('user/message',{id:'old',role:'user',source:{kind:'user'},content:[{type:'text',text:'first input'}]});append('assistant/message',{message:{content:[]}});append('turn/end',{turn:1,reason:{kind:'completed'}});
  append('turn/start',{turn:2});append('user/message',{id:'latest',role:'user',source:{kind:'user'},content:[{type:'text',text:'second input'}]});append('assistant/message',{message:{content:[]}});append('turn/end',{turn:2,reason:{kind:'completed'}});
  const session={header:{},surface:{nodes:[0,2,3,6,7]},snapshotEvents:(start=0)=>events.slice(start),append};
  const agent={id:'original',session,status:'idle',inbox:{nextTurn:[],nextStep:[]},options:{provider:'fixture',model:'model'},runMaintenance:fn=>fn(new AbortController().signal),followup:message=>{sent.push(message);}};
  let committed=0,disposed=0;const ctx={agents:{get:()=>agent},sessionController:{resolveAgent:async id=>{assert.equal(id,'original');return {agent};}},llm:{resolveModelInfo:async()=>({inputModalities:['text']})},attachments:{imageLimits:null},fileUploads:{bindPrompt:()=>({commit:()=>committed++,[Symbol.dispose]:()=>disposed++})}};
  return {ctx,agent,events,sent,append,counts:()=>({committed,disposed})};
}
test('inline edit retains the append-only log and admits only the edited input once',async()=>{
  const f=fixture(),plan=await planCurrent(f.ctx,{sourceId:'original',seq:6}),requestId=randomUUID(),input={sourceId:'original',seq:6,tail:plan.tail,requestId,content:[{type:'text',text:'edited input'}]};
  assert.deepEqual(await editCurrent(f.ctx,input,new AbortController().signal),{sessionId:'original',accepted:true});
  assert.equal(f.events[6].data.content[0].text,'second input');assert.equal(f.sent.length,1);assert.equal(f.sent[0].content[0].text,'edited input');assert.equal(f.sent[0].source.rpcId,requestId);
  const marker=f.events.at(-1);assert.equal(marker.surfaceOp.op,'replace');assert.deepEqual(marker.sourceEventSeqs,[6,7]);assert.equal(marker.data.source.replacement.id,f.sent[0].id);assert.deepEqual(f.counts(),{committed:1,disposed:1});
  await assert.rejects(editCurrent(f.ctx,input,new AbortController().signal),e=>e.editCode==='currentUncertain');assert.equal(f.sent.length,1);
});
test('native maintenance rechecks idle state, exact tail and unsupported supplemental history',async()=>{
  const f=fixture();assert.deepEqual((await planCurrent(f.ctx,{sourceId:'original',seq:2})).nodes,[2,3,6,7]);
  const plan=await planCurrent(f.ctx,{sourceId:'original',seq:6});f.append('session/title',{title:'changed'});
  await assert.rejects(editCurrent(f.ctx,{sourceId:'original',seq:6,tail:plan.tail,requestId:randomUUID(),content:[{type:'text',text:'edited'}]},new AbortController().signal),e=>e.editCode==='stale');assert.equal(f.sent.length,0);
  f.agent.inbox.nextTurn.push({id:'queued'});await assert.rejects(planCurrent(f.ctx,{sourceId:'original',seq:6}),e=>e.editCode==='running');
});
test('editing an earlier main turn submits only its replacement and preserves all original log entries',async()=>{
  const f=fixture(),plan=await planCurrent(f.ctx,{sourceId:'original',seq:2});
  await editCurrent(f.ctx,{sourceId:'original',seq:2,tail:plan.tail,requestId:randomUUID(),content:[{type:'text',text:'changed first input'}]},new AbortController().signal);
  assert.deepEqual(f.sent.map(m=>m.content[0].text),['changed first input']);assert.equal(f.events[6].data.content[0].text,'second input');assert.deepEqual(f.events.at(-1).sourceEventSeqs,[2,3,6,7]);
});
