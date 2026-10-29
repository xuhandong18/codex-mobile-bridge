'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SessionActivity}=require('../web/features/chat/activity.js');
const fixture=()=>new SessionActivity({storage:{getItem:()=>null,setItem(){},removeItem(){}}});
const row=(changes={})=>({id:'main',host:'local',connected:true,status:'active',turnId:'turn',turnStatus:'inProgress',...changes});

test('正式待处理请求优先显示红色，阅读不能清除，解除后恢复蓝绿',()=>{
  const activity=fixture();
  activity.update([row({waitingForUser:true})]);
  assert.deepEqual(activity.indicator('local|main'),{kind:'awaiting',label:'等待你回复或处理'});
  activity.read('local|main');
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.update([row({waitingForUser:false})]);
  assert.equal(activity.indicator('local|main').kind,'running');
  activity.update([row({status:'idle',turnStatus:'completed',waitingForUser:true})]);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.update([row({status:'idle',turnStatus:'completed',waitingForUser:false})]);
  assert.equal(activity.indicator('local|main').kind,'completed');
});

test('主侧和派生聊天独立等待，缺失状态及断线不清除已确认的红色',()=>{
  const activity=fixture(),side={id:'side',connected:true,status:'active',turnId:'s',turnStatus:'inProgress',waitingForUser:true};
  activity.update([row({sideChats:[side],waitingForUser:true,waitingSubagents:1})]);
  activity.update([row({waitingForUser:false,waitingSubagents:0})],'local|main');
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.updateSideChat(row(),{...side,status:'unknown',connected:false,waitingForUser:null},true);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.updateSideChat(row(),{...side,waitingForUser:false});
  assert.equal(activity.indicator('local|main').kind,'running');
  activity.update([row({waitingSubagents:2})]);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
});

test('普通正文、工具和失败不制造等待状态',()=>{
  const activity=fixture();
  activity.update([row({text:'是否继续？',requests:undefined})]);
  assert.equal(activity.indicator('local|main').kind,'running');
  activity.update([row({status:'idle',turnStatus:'failed'})]);
  assert.equal(activity.indicator('local|main').kind,'ended');
});

test('旧回包不能清除新请求，明确的新状态才能解除红色',()=>{
  const activity=fixture();
  activity.update([row({waitingForUser:true,waitingObservedAt:200})]);
  activity.update([row({waitingForUser:false,waitingObservedAt:100})]);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.update([row({requests:[]})]);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.update([row({waitingForUser:false,waitingObservedAt:300})]);
  assert.equal(activity.indicator('local|main').kind,'running');
});

test('旧侧边列表不能删除刚收到等待请求的侧边聊天',()=>{
  const activity=fixture();
  activity.update([row({sideChats:[],sideChatsObservedAt:100})]);
  activity.updateSideChat(row(),{id:'new-side',connected:true,status:'active',waitingForUser:true,waitingObservedAt:200});
  activity.update([row({sideChats:[],sideChatsObservedAt:100})]);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.update([row({sideChats:[],sideChatsObservedAt:300})]);
  assert.equal(activity.indicator('local|main').kind,'running');
});

test('派生任务的等待观察独立于主聊天连接和观察时间',()=>{
  const activity=fixture();
  activity.update([row({waitingForUser:false,waitingObservedAt:300})]);
  activity.update([row({connected:false,status:'unknown',waitingForUser:null,waitingSubagents:1,waitingSubagentsObservedAt:400})]);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.update([row({waitingSubagents:0,waitingSubagentsObservedAt:200})]);
  assert.equal(activity.indicator('local|main').kind,'awaiting');
  activity.update([row({waitingSubagents:0,waitingSubagentsObservedAt:500})]);
  assert.equal(activity.indicator('local|main').kind,'running');
});
