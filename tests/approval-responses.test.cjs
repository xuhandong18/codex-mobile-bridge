'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/shell/app.js','utf8');
const start=source.indexOf('function renderApprovals('),code=source.slice(start,source.indexOf('\nfunction ',start+1));

function fixture(result){
  class Element{
    constructor(tag,cls='',text=''){this.tag=tag;this.className=cls;this.textContent=text;this.children=[];this.dataset={};this.value='';this.disabled=false;this.isConnected=true;}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=items;}
    addEventListener(){}
    querySelectorAll(tag){return this.children.flatMap(item=>[...(item.tag===tag?[item]:[]),...item.querySelectorAll(tag)]);}
  }
  const approvals=new Element('div'),notices=[],calls=[],timers=[];
  const ctx={$:()=>approvals,el:(...args)=>new Element(...args),t:x=>x,jsonPretty:JSON.stringify,
    currentId:'chat',currentHost:'local',approvalStamp:'',approvalBusy:0,submittedRequestIds:new Set(),
    window:{},setLanguageBusy(){},bumpRecency(){},toast:text=>notices.push(text),
    setTimeout:(fn,delay)=>timers.push({fn,delay}),
    sessionUrl:()=>'/respond',api:async(url,body)=>{calls.push({url,body});return result;}};
  vm.createContext(ctx);vm.runInContext(code,ctx);
  const request={id:'async:turn:question',method:'bridge/requestUserInputAsync',supported:true,
    params:{questions:[{id:'question',question:'继续吗？'}]}};
  ctx.renderApprovals([request]);
  approvals.querySelectorAll('textarea')[0].value='保留我填写的答案';
  return {ctx,approvals,notices,calls,timers,submit:async()=>{approvals.querySelectorAll('form')[0].onsubmit({preventDefault(){}});await new Promise(setImmediate);}};
}

test('an ignored async answer does not claim success or wait forever for desktop confirmation',async()=>{
  const ui=fixture({status:'ignored',duplicate:true,id:'old-submission'});await ui.submit();
  assert.equal(ui.calls.length,1);
  assert.equal(ui.notices.length,0,'未发送的回复不能提示已发送');
  assert.equal(ui.ctx.submittedRequestIds.size,0,'未发送的回复不能锁成等待确认');
  assert.equal(ui.approvals.querySelectorAll('button')[0].disabled,false);
  assert.equal(ui.approvals.querySelectorAll('textarea')[0].value,'保留我填写的答案');
  assert.ok(ui.approvals.querySelectorAll('p').some(node=>node.textContent.includes('未发送')));
});

test('an unknown async answer preserves the answer without claiming delivery or resending',async()=>{
  const ui=fixture({status:'unknown',duplicate:true,id:'uncertain-submission'});await ui.submit();
  assert.equal(ui.calls.length,1);assert.equal(ui.notices.length,0);
  assert.equal(ui.approvals.querySelectorAll('textarea')[0].value,'保留我填写的答案');
  assert.ok(ui.approvals.querySelectorAll('p').some(node=>node.textContent.includes('尚未确认')));
});

test('an accepted answer still waits for authoritative desktop state',async()=>{
  const ui=fixture({status:'accepted',id:'new-submission'});await ui.submit();
  assert.equal(ui.calls.length,1);assert.equal(ui.notices.length,1);
  assert.equal(ui.approvals.querySelectorAll('button')[0].disabled,true);
  assert.equal(ui.ctx.submittedRequestIds.size,1);
});

test('a missing desktop confirmation becomes an explicit notice and never resends',async()=>{
  const ui=fixture({status:'accepted',id:'new-submission'});await ui.submit();
  assert.equal(ui.timers[0].delay,15000);ui.timers[0].fn();
  assert.ok(ui.approvals.querySelectorAll('p').some(node=>node.textContent.includes('桌面尚未确认')));
  assert.equal(ui.approvals.querySelectorAll('button')[0].disabled,true);
  assert.equal(ui.approvals.querySelectorAll('textarea')[0].value,'保留我填写的答案');
  assert.equal(ui.calls.length,1);
});

test('confirmation timers do not alter a question after switching chats',async()=>{
  const ui=fixture({status:'accepted'});await ui.submit();ui.ctx.currentId='other';ui.timers[0].fn();
  assert.ok(!ui.approvals.querySelectorAll('p').some(node=>node.textContent.includes('桌面尚未确认')));
});

test('an RPC approval without a submission status retains its existing success behavior',async()=>{
  const ui=fixture({});await ui.submit();
  assert.equal(ui.notices.length,1);assert.equal(ui.ctx.submittedRequestIds.size,1);
});

test('a late submission response cannot mark a different chat as having submitted an answer',async()=>{
  let resolve;const ui=fixture(new Promise(done=>resolve=done));await ui.submit();
  ui.ctx.currentId='other-chat';resolve({status:'accepted'});await new Promise(setImmediate);
  assert.equal(ui.ctx.submittedRequestIds.size,0);assert.equal(ui.notices.length,0);
  assert.equal(ui.ctx.approvalBusy,0);
});

test('a confirmation timer leaves an already removed question alone',async()=>{
  const ui=fixture({status:'accepted'});await ui.submit();
  ui.approvals.children[0].isConnected=false;ui.timers[0].fn();
  assert.ok(!ui.approvals.querySelectorAll('p').some(node=>node.textContent.includes('桌面尚未确认')));
});
