'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {SessionActivity}=require('../web/features/chat/activity.js');
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
const row=(changes={})=>({id:'chat',host:'local',connected:true,status:'idle',turnId:'one',turnStatus:'completed',...changes});
const unavailable=(changes={})=>row({connected:false,status:'unknown',activityError:'timeout',turnId:null,turnStatus:null,...changes});
function fixture(options={}){let now=0;const activity=new SessionActivity({storage:storage(),now:()=>now,...options});return {activity,at:value=>now=value};}

for(const [name,changes,label] of [
  ['空闲',{},null],
  ['运行中',{status:'active',turnStatus:'inProgress'},'上次确认运行中，正在重新确认'],
  ['子代理运行中',{status:'active',parentStatus:'idle',runningSubagents:1},'上次确认子代理运行中，正在重新确认']
])test(name+'在短暂失败时保留显示，持续三十秒后才变灰',()=>{
  const {activity,at}=fixture(),known=row(changes),key='local|chat';
  activity.update([known]);activity.update([unavailable()]);
  assert.equal(activity.rows[key].offline,true,'显示缓冲不能把连接状态改为成功');
  const buffered=()=>label?{kind:'running',label,stale:true}:null;
  assert.deepEqual(activity.indicator(key),buffered());
  at(29000);activity.update([unavailable()]);
  assert.deepEqual(activity.indicator(key),buffered(),'再次失败不能重置缓冲期');
  at(30000);
  assert.deepEqual(activity.indicator(key),{kind:'unknown',label:'读取运行状态超时'});
  activity.update([known]);assert.equal(activity.rows[key].offline,false);
  assert.equal(activity.indicator(key)?.kind,label?'running':undefined);
  at(40000);activity.update([unavailable()]);at(69999);
  assert.deepEqual(activity.indicator(key),buffered(),'恢复后再次失败应开启新的缓冲期');
  at(70000);assert.equal(activity.indicator(key)?.kind,'unknown');
});

test('首次未知和缺少有效状态的响应不享有显示缓冲',()=>{
  const {activity}=fixture();activity.update([unavailable()]);
  assert.equal(activity.indicator('local|chat')?.kind,'unknown');
  activity.update([row({status:undefined})]);activity.update([unavailable()]);
  assert.equal(activity.indicator('local|chat')?.kind,'unknown');
});

test('空闲与未加载桌面聊天恢复后立即消除灰点，不制造未读',()=>{
  const {activity,at}=fixture();
  const known=row({connected:false,activityConnected:true,status:'notLoaded'});
  activity.update([known]);activity.update([unavailable()]);
  assert.equal(activity.indicator('local|chat'),null);
  at(30000);assert.equal(activity.indicator('local|chat')?.kind,'unknown');
  activity.update([known]);assert.equal(activity.indicator('local|chat'),null);
});

test('主机、应用及主侧聊天的失败计时相互隔离，移除侧边后清除其基线',()=>{
  const {activity,at}=fixture(),parent=row(),side={id:'side',connected:true,status:'active',turnId:'s',turnStatus:'inProgress'};
  activity.update([{...parent,sideChats:[side]},row({host:'remote'}),row({host:'claude'})]);
  activity.update([unavailable()]);
  assert.equal(activity.ownIndicator('local|chat'),null);
  assert.equal(activity.ownIndicator('local|chat/side/side')?.label,'运行中');
  at(20000);activity.update([unavailable({host:'remote'}),unavailable({host:'claude'})]);
  activity.updateSideChat(parent,{...side,connected:false,status:'unknown'});
  at(30000);assert.equal(activity.ownIndicator('local|chat')?.kind,'unknown');
  assert.equal(activity.ownIndicator('remote|chat'),null);assert.equal(activity.ownIndicator('claude|chat'),null);
  assert.equal(activity.ownIndicator('local|chat/side/side')?.stale,true);
  activity.update([{...parent,sideChats:[]}]);
  activity.updateSideChat(parent,{...side,connected:false,status:'unknown'});
  assert.equal(activity.ownIndicator('local|chat/side/side')?.kind,'unknown','移除后重现的未知侧边不能复用旧基线');
});

test('仍有实时侧边运行时，汇总绿点使用新确认的状态说明',()=>{
  const {activity}=fixture(),parent=row({status:'active',turnStatus:'inProgress'});
  activity.update([{...parent,sideChats:[{id:'side',connected:true,status:'active'}]}]);
  activity.update([unavailable()]);
  assert.equal(activity.ownIndicator('local|chat')?.stale,true);
  assert.deepEqual(activity.indicator('local|chat'),{kind:'running',label:'运行中'});
});

for(const kind of ['awaiting','completed','ended'])test(kind+'提示在缓冲与到期后都保留原有优先级',()=>{
  const {activity,at}=fixture();
  activity.update([row({status:'active',turnStatus:'inProgress'})]);
  activity.update([row({waitingForUser:kind==='awaiting',turnStatus:kind==='ended'?'failed':'completed'})]);
  assert.equal(activity.indicator('local|chat')?.kind,kind);
  activity.update([unavailable()]);at(30000);
  assert.equal(activity.indicator('local|chat')?.kind,kind);
});

test('缓冲期间吸收共享已读记录，并继续阻止基于离线状态的已读同步',()=>{
  const reads=[],{activity,at}=fixture({onRead:(...args)=>reads.push(args)});
  activity.update([row({status:'active',turnStatus:'inProgress'})]);activity.update([row()]);
  activity.update([unavailable({readCompletions:['one:completed']})]);
  assert.equal(activity.indicator('local|chat'),null);
  activity.read('local|chat',{explicit:true});assert.equal(reads.length,0);
  at(30000);assert.equal(activity.indicator('local|chat')?.kind,'unknown');
});

test('重载、清空和移除聊天不会从持久化缓存恢复成功基线或失败计时',()=>{
  const saved=storage(),{activity}=fixture({storage:saved});
  activity.update([row({status:'active',turnStatus:'inProgress'})]);activity.update([unavailable()]);
  const restored=new SessionActivity({storage:saved,now:()=>0});
  assert.equal(restored.indicator('local|chat')?.kind,'unknown');
  assert.equal(saved.getItem('bridge-session-activity').includes('failedAt'),false);
  activity.forget('local|chat');activity.update([unavailable()]);
  assert.equal(activity.indicator('local|chat')?.kind,'unknown');
  activity.update([row()]);activity.clear();activity.update([unavailable()]);
  assert.equal(activity.indicator('local|chat')?.kind,'unknown');
});

test('Codex 聊天头部说明旧运行状态，缓冲到期后说明不可用',()=>{
  const {activity,at}=fixture(),view=row({status:'active',turnStatus:'inProgress'});
  const source=fs.readFileSync(require.resolve('../web/shell/app.js'),'utf8');
  const context=vm.createContext({sessionActivity:activity,chatKey:()=> 'local|chat',t:value=>value,view});
  vm.runInContext(source.slice(source.indexOf('function chatStatusText('),source.indexOf('function isPlaceholderChatTitle(')),context);
  activity.update([view]);activity.update([unavailable()]);
  assert.equal(vm.runInContext('chatStatusText(view,{})',context),'上次确认运行中，正在重新确认');
  at(30000);assert.equal(vm.runInContext('chatStatusText(view,{})',context),'读取运行状态超时');
  activity.update([view]);assert.equal(vm.runInContext('chatStatusText(view,{})',context),'运行中');
});

test('旧运行状态的主聊天和子代理说明均有英文翻译',()=>{
  const i18n=require('../web/shared/i18n.js');
  try{
    i18n.setLanguage('en');
    assert.equal(i18n.t('上次确认运行中，正在重新确认'),'Last confirmed running; checking again');
    assert.equal(i18n.t('上次确认子代理运行中，正在重新确认'),'Subagents last confirmed running; checking again');
  }finally{i18n.setLanguage('zh');}
});
