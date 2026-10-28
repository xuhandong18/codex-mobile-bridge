'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {SessionActivity}=require('../web/features/chat/activity.js');
const source=fs.readFileSync(require.resolve('../web/shell/app.js'),'utf8');

test('侧边已读只由当前前台面板触发，并将服务端交互时间用于父聊天排序',()=>{
 const updates=[],bumps=[],mainReads=[],app={hidden:false,classList:{contains:()=>true}},context=vm.createContext({workbench:{},document:{hidden:false},clientNavigation:{provider:'codex'},currentId:'parent',currentHost:'local',
  $:()=>app,sessionActivity:{updateSideChat:(...args)=>updates.push(args)},bumpRecency:(...args)=>bumps.push(args),renderActivity(){},readVisibleChat:()=>mainReads.push(true)});
 const start=source.indexOf('workbench.onSideChatActivity='),end=source.indexOf('workbench.canQuoteMain=',start);
 vm.runInContext(source.slice(start,end),context);
 const session={id:'parent',host:'local',provider:'codex'},view={id:'side',recency:123};
 context.workbench.current=session;context.workbench.onViewChange();assert.equal(mainReads.length,1);
 context.workbench.current={...session,id:'other'};context.workbench.onViewChange();assert.equal(mainReads.length,1,'切换途中不能将旧主聊天标为已读');
 context.workbench.current={...session,host:'remote'};context.workbench.onViewChange();assert.equal(mainReads.length,1,'同 ID 的不同主机不能互相标为已读');
 context.workbench.onSideChatActivity(session,view,true);
 assert.equal(updates.at(-1)[2],true);assert.deepEqual(bumps.at(-1),['parent','local',123]);
 context.workbench.onSideChatActivity(session,view,false);assert.equal(updates.at(-1)[2],false);
 context.document.hidden=true;context.workbench.onSideChatActivity(session,view,true);assert.equal(updates.at(-1)[2],false);
 context.document.hidden=false;context.currentId='other';context.workbench.onSideChatActivity(session,view,true);assert.equal(updates.at(-1)[2],false);
 const count=updates.length;context.workbench.onSideChatActivity({...session,provider:'deepseek'},view,true);
 context.workbench.onSideChatActivity(session,{...view,expired:true},true);assert.equal(updates.length,count);
});

test('Codex rendered terminal metadata clears the matching desktop badge even without sidebar polling',async()=>{
 const calls=[],values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},app={classList:{contains:()=>true}};
 const context=vm.createContext({SessionActivity:class extends SessionActivity{constructor(options){super({...options,storage});}},currentId:'chat',currentHost:'ssh:work',clientNavigation:{provider:'codex'},document:{hidden:false},workbench:{isFileVisible:false},$:()=>app,
  chatKey:()=>context.currentHost+'|'+context.currentId,sessionUrl:(id,action,host)=>`/api/sessions/${id}/${action}?host=${encodeURIComponent(host)}`,uuid:()=>String(calls.length+1),api:async(url,body)=>{calls.push({url,body});return {status:'accepted'};},toast:assert.fail,renderActivity(){}});
 const start=source.indexOf('const sessionActivity=new SessionActivity('),end=source.indexOf('const recentInteractions=',start);
 vm.runInContext(source.slice(start,end),context);
 vm.runInContext(source.match(/^function visibleChat\(\).*$/m)[0],context);
 vm.runInContext(source.slice(source.indexOf('function readVisibleChat('),source.indexOf('function renderActivity(')),context);
 const render=view=>{context.view=view;vm.runInContext('readVisibleChat(view)',context);};
 render({connected:true,status:'active',turnId:'one',turnStatus:'inProgress'});assert.equal(calls.length,0);
 render({connected:true,status:'idle',turnId:'one',turnStatus:'completed'});await Promise.resolve();assert.equal(calls.length,1);
 assert.equal(calls[0].url,'/api/sessions/chat/read-state?host=ssh%3Awork');assert.equal(calls[0].body.turnId,'one');
 render({connected:true,status:'idle',turnId:'one',turnStatus:'completed'});assert.equal(calls.length,1);
 context.clientNavigation.provider='deepseek';render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,1);
 context.clientNavigation.provider='codex';context.document.hidden=true;render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,1);
 context.document.hidden=false;context.workbench.isFileVisible=true;render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,1);
 context.workbench.isFileVisible=false;render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,2);
});
