'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {SessionActivity}=require('../web/features/chat/activity.js');
const source=fs.readFileSync(require.resolve('../web/shell/app.js'),'utf8');

test('Codex rendered terminal metadata clears the matching desktop badge even without sidebar polling',async()=>{
 const calls=[],values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},app={classList:{contains:()=>true}};
 const context=vm.createContext({SessionActivity:class extends SessionActivity{constructor(options){super({...options,storage});}},currentId:'chat',currentHost:'ssh:work',clientNavigation:{provider:'codex'},document:{hidden:false},workbench:{isFileVisible:false},$:()=>app,
  chatKey:()=>context.currentHost+'|'+context.currentId,sessionUrl:(id,action,host)=>`/api/sessions/${id}/${action}?host=${encodeURIComponent(host)}`,uuid:()=>String(calls.length+1),api:async(url,body)=>{calls.push({url,body});return {status:'accepted'};},toast:assert.fail,renderActivity(){}});
 const start=source.indexOf('const sessionActivity=new SessionActivity('),end=source.indexOf('const recentInteractions=',start);
 vm.runInContext(source.slice(start,end),context);
 vm.runInContext(source.match(/^function visibleChat\(\).*$/m)[0],context);
 const readStart=source.indexOf('  if(visibleChat()){'),readEnd=source.indexOf("  $('execution-host')",readStart);
 const render=view=>{context.view=view;vm.runInContext(source.slice(readStart,readEnd),context);};
 render({connected:true,status:'active',turnId:'one',turnStatus:'inProgress'});assert.equal(calls.length,0);
 render({connected:true,status:'idle',turnId:'one',turnStatus:'completed'});await Promise.resolve();assert.equal(calls.length,1);
 assert.equal(calls[0].url,'/api/sessions/chat/read-state?host=ssh%3Awork');assert.equal(calls[0].body.turnId,'one');
 render({connected:true,status:'idle',turnId:'one',turnStatus:'completed'});assert.equal(calls.length,1);
 context.clientNavigation.provider='deepseek';render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,1);
 context.clientNavigation.provider='codex';context.document.hidden=true;render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,1);
 context.document.hidden=false;context.workbench.isFileVisible=true;render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,1);
 context.workbench.isFileVisible=false;render({connected:true,status:'idle',turnId:'two',turnStatus:'completed'});assert.equal(calls.length,2);
});
