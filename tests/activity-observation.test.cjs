'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SessionActivity}=require('../web/features/chat/activity.js');
const row=(changes={})=>({id:'chat',host:'local',connected:true,status:'active',turnId:'one',turnStatus:'inProgress',...changes});
const fixture=()=>new SessionActivity({storage:{getItem:()=>null,setItem(){},removeItem(){}}});

test('请求版本按聊天隔离，旧成功和旧失败都不能覆盖更新的运行状态',()=>{
  const activity=fixture(),old=activity.beginRead();
  activity.update([row({status:'idle',turnStatus:'completed'})],'local|chat');
  activity.update([row(),row({host:'ssh'})],null,{observation:old});
  assert.equal(activity.indicator('local|chat'),null);
  assert.equal(activity.indicator('ssh|chat')?.kind,'running');
  activity.update([row({connected:false,status:'unknown'})],null,{observation:old});
  assert.equal(activity.rows['local|chat'].offline,false);
  activity.update([row()],null,{observation:activity.beginRead()});
  assert.equal(activity.indicator('local|chat')?.kind,'running','后续新轮次仍能正常显示运行');
});

test('晚到旧响应不复活旧完成标记，但可合并其他设备的已读记录',()=>{
  const activity=fixture();activity.update([row()]);
  const old=activity.beginRead();
  activity.update([row({status:'idle',turnStatus:'completed'})],'local|chat');
  activity.update([row({status:'idle',completionToken:'older:completed',readCompletions:['shared:completed']})],null,{observation:old});
  assert.equal(activity.indicator('local|chat'),null);
  assert.ok(activity.rows['local|chat'].readCompletions.includes('shared:completed'));
});

test('侧边独立的新状态不被较早的父聊天活动列表覆盖或删除',()=>{
  const activity=fixture(),parent=row({status:'idle'}),side=row({id:'side'});
  activity.update([{...parent,sideChats:[side]}]);
  const old=activity.beginRead();
  activity.updateSideChat(parent,{...side,status:'idle',turnStatus:'completed'},true);
  activity.update([{...parent,sideChats:[side]}],null,{observation:old});
  assert.equal(activity.ownIndicator('local|chat/side/side'),null);
  activity.update([{...parent,sideChats:[]}],null,{observation:old});
  assert.ok(activity.rows['local|chat/side/side']);
});

test('身份清理和移除聊天使在途观察失效，观察版本不写入存储',()=>{
  const activity=fixture(),old=activity.beginRead();activity.clear();
  activity.update([row()],null,{observation:old});
  assert.deepEqual(activity.rows,{});
  const removed=activity.beginRead();activity.forget('local|chat');
  activity.update([row()],null,{observation:removed});
  assert.equal(activity.rows['local|chat'],undefined);
  activity.updateSideChat(row(),row({id:'side'}),false,{observation:removed});
  assert.equal(activity.rows['local|chat'],undefined,'旧侧边结果也不能重新创建已移除的父聊天');
  activity.update([row()]);
  assert.equal(activity.indicator('local|chat')?.kind,'running');
  assert.equal(JSON.stringify(activity.rows).includes('observation'),false);
});
