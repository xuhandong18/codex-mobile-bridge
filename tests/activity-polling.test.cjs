'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ActivityPolling,ActivityChanges}=require('../web/features/chat/activity.js');
const streamId='a'.repeat(32),row={id:'chat',host:'local',connected:true,status:'active',activityRealtime:true,activityStreamId:streamId};

test('已确认实时来源且通知正常时三十秒补查一次，来源与主机独立',()=>{
  let now=0;const polling=new ActivityPolling({now:()=>now});
  const changes={canConfirm:(host,id,stream)=>host==='local'&&id==='chat'&&stream===streamId};
  polling.observe([row]);now=5000;assert.equal(polling.due(row,changes),false);
  now=29999;assert.equal(polling.due(row,changes),false);now=30000;assert.equal(polling.due(row,changes),true);
  polling.observe([row]);assert.equal(polling.due({...row,host:'ssh'},changes),true);
  assert.equal(polling.due(row,{canConfirm:()=>false}),true,'通知失联立即恢复普通补查');
});

test('原生补读、未知、侧边未确认和旧网关不能延长补查，失败与身份清理撤销凭据',()=>{
  const polling=new ActivityPolling(),changes={canConfirm:()=>true};
  for(const update of [{activityRealtime:false},{activityRealtime:undefined},{connected:false},{status:'unknown'},{activityError:'timeout'},{activityStreamId:null}]){
    polling.observe([{...row,...update}]);assert.equal(polling.due(row,changes),true);
  }
  polling.observe([row]);polling.fail(['local|chat']);assert.equal(polling.due(row,changes),true);
  polling.observe([row]);polling.clear();assert.equal(polling.due(row,changes),true);
});

test('通知健康凭据必须属于当前范围及游标流，过期和网络错误后失效',async t=>{
  let now=0,resolve,reject;const pauses=[];
  const changes=new ActivityChanges({now:()=>now,request:()=>new Promise((yes,no)=>{resolve=yes;reject=no;}),onChange(){},pause:(ms,signal)=>new Promise(done=>{pauses.push(done);signal.addEventListener('abort',done,{once:true});})});
  t.after(()=>changes.stop());changes.setScope({local:['chat']});
  assert.equal(changes.canConfirm('local','chat',streamId),false);
  resolve({streamId,cursor:0,reset:true,hosts:{}});await new Promise(setImmediate);
  assert.equal(changes.canConfirm('local','chat',streamId),true);
  assert.equal(changes.canConfirm('ssh','chat',streamId),false);
  assert.equal(changes.canConfirm('local','chat','b'.repeat(32)),false);
  now=20000;assert.equal(changes.canConfirm('local','chat',streamId),false);
  now=1000;pauses.shift()();await new Promise(setImmediate);reject(Error('offline'));await new Promise(setImmediate);
  assert.equal(changes.canConfirm('local','chat',streamId),false);
});
