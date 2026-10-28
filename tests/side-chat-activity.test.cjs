'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SessionActivity}=require('../web/features/chat/activity.js');
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};};
const main=(status='idle',turnId='main',turnStatus='completed')=>({id:'parent',host:'local',connected:true,status,parentStatus:status,turnId,turnStatus});
const side=(id,status='active',turnId=id,turnStatus=status==='active'?'inProgress':'completed')=>({id,connected:true,status,turnId,turnStatus});

test('主聊天已完成时，仍在工作的侧边聊天显示绿色；任一完成优先显示蓝色',()=>{
  const activity=new SessionActivity({storage:storage()});
  activity.update([{...main(),sideChats:[side('one'),side('two')]}]);
  assert.equal(activity.indicator('local|parent')?.kind,'running');
  activity.update([{...main(),sideChats:[side('one','idle'),side('two')]}]);
  assert.equal(activity.indicator('local|parent')?.kind,'completed');
  activity.read('local|parent',{explicit:true,sync:false});
  assert.equal(activity.indicator('local|parent')?.kind,'completed','只看主聊天不清除侧边聊天未读');
  activity.updateSideChat(main(),side('one','idle'),true);
  assert.equal(activity.indicator('local|parent')?.kind,'running');
  activity.update([{...main(),sideChats:[side('one','idle'),side('two','idle')]}]);
  assert.equal(activity.indicator('local|parent')?.kind,'completed');
  activity.updateSideChat(main(),side('two','idle'),true);
  assert.equal(activity.indicator('local|parent'),null);
});

test('主聊天完成不被侧边运行盖住，阅读后恢复绿色；侧边读取不清除主聊天蓝点',()=>{
  const activity=new SessionActivity({storage:storage()});
  activity.update([{...main('active','main','inProgress'),sideChats:[side('one')]}]);
  activity.update([{...main(),status:'active',sideChats:[side('one')]}]);
  assert.equal(activity.indicator('local|parent')?.kind,'completed');
  activity.updateSideChat(main(),side('one'),true);
  assert.equal(activity.indicator('local|parent')?.kind,'completed');
  activity.read('local|parent',{sync:false});
  assert.equal(activity.indicator('local|parent')?.kind,'running');
  activity.update([{...main(),status:'active',sideChats:[side('one')]}],'local|parent',{sync:false});
  assert.equal(activity.indicator('local|parent')?.kind,'running','相同父轮次不能重新冒蓝点');
});

test('未读完成持久保留，后续运行及仅含主聊天的快照不丢失侧边状态',()=>{
  const saved=storage(),activity=new SessionActivity({storage:saved});
  activity.update([{...main('active','main','inProgress'),sideChats:[side('one')]}]);
  activity.update([{...main('active','main','inProgress'),sideChats:[side('one','idle')]}]);
  activity.update([main('active','main','inProgress')],'local|parent',{sync:false});
  const restored=new SessionActivity({storage:saved});
  assert.equal(restored.indicator('local|parent')?.kind,'completed');
  restored.updateSideChat(main(),side('one','active','next','inProgress'));
  assert.equal(restored.indicator('local|parent')?.kind,'completed');
  restored.updateSideChat(main(),side('one','active','next','inProgress'),true);
  assert.equal(restored.indicator('local|parent')?.kind,'running');
});

test('首次侧边历史不制造未读，关闭与不同主机的侧边状态互不干扰',()=>{
  const activity=new SessionActivity({storage:storage()});
  activity.update([{...main(),sideChats:[side('one','idle')]},{...main(),host:'remote',sideChats:[side('one')]}]);
  assert.equal(activity.indicator('local|parent'),null);
  assert.equal(activity.indicator('remote|parent')?.kind,'running');
  activity.update([{...main(),sideChats:[]}]);
  assert.equal(activity.indicator('local|parent'),null);
  assert.equal(activity.indicator('remote|parent')?.kind,'running');
});

test('真实侧边详情只有 turns 内的轮次，阅读后下一次摘要不会重新变蓝',()=>{
  const activity=new SessionActivity({storage:storage()});
  activity.update([{...main(),sideChats:[side('one')]}]);
  activity.updateSideChat(main(),{id:'one',connected:true,status:'idle',turns:[{id:'one',status:'completed',messages:[]}]},true);
  activity.update([{...main(),sideChats:[side('one','idle')]}]);
  assert.equal(activity.indicator('local|parent'),null);
});

test('已确认完成未读遇到锁占用或断线仍优先于其他聊天的绿点，刷新后保留',()=>{
  const saved=storage(),activity=new SessionActivity({storage:saved});
  activity.update([{...main('active','main','inProgress'),sideChats:[side('one')]}]);
  activity.update([{...main('active','main','inProgress'),sideChats:[side('one','idle')]}]);
  activity.update([{...main('active','main','inProgress'),sideChats:[{id:'one',connected:false,status:'unknown'}]}]);
  assert.equal(activity.indicator('local|parent')?.kind,'completed');
  assert.equal(new SessionActivity({storage:saved}).indicator('local|parent')?.kind,'completed');
});

test('旧运行摘要晚到不能让同轮已读结果再次变蓝，下一轮完成仍提示',()=>{
  const saved=storage();let activity=new SessionActivity({storage:saved});
  activity.update([{...main(),sideChats:[side('one')]}]);
  activity.updateSideChat(main(),side('one','idle'),true);
  activity=new SessionActivity({storage:saved});
  activity.update([{...main(),sideChats:[side('one')]}]);
  activity.update([{...main(),sideChats:[side('one','idle')]}]);
  assert.equal(activity.indicator('local|parent'),null);
  activity.update([{...main(),sideChats:[side('one','active','next','inProgress')]}]);
  activity.update([{...main(),sideChats:[side('one','idle','next','completed')]}]);
  assert.equal(activity.indicator('local|parent')?.kind,'completed');
});

test('读完下一轮后上一轮完成摘要晚到，也不会复活旧的蓝点',()=>{
  const saved=storage();let activity=new SessionActivity({storage:saved});
  for(const turn of ['first','second']){
    activity.updateSideChat(main(),side('one','active',turn,'inProgress'));
    activity.updateSideChat(main(),side('one','idle',turn,'completed'),true);
  }
  activity=new SessionActivity({storage:saved});
  activity.update([{...main(),sideChats:[side('one','idle','first','completed')]}]);
  assert.equal(activity.indicator('local|parent'),null);
  activity.update([{...main(),sideChats:[side('one','idle','second','completed')]}]);
  assert.equal(activity.indicator('local|parent'),null);
});
