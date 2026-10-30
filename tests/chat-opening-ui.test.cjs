'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
const opening=source.slice(source.indexOf('async function openChat('),source.indexOf('let notificationState=',source.indexOf('async function openChat(')));

function fixture({source='desktop',canReconnect=true}={}){
  const events=[],nodes=new Map(),access={source,canReconnect,canChangeModel:true};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',classList:{add(){}},close(){},replaceChildren(){}});return nodes.get(id);};
  let finishReading;
  const ctx={$,events,currentId:null,currentHost:'local',state:null,chatTimeline:null,catalogStarted:false,modelCatalogGeneration:0,modelRequest:0,notificationRequest:0,applyingNewChat:null,
    listRows:[{id:'a',host:'local',access}],submittedRequestIds:new Set(),
    messageActions:{dialog:{close(){}}},workbench:{open(){},current:{}},saveDraft(){},
    sessionAccess:value=>value||access,currentAccess:()=>access,chatKey:(id='a',host='local')=>host+'|'+id,
    contextUsageControl:{update(){}},workModes:{open(){}},attachments:{open(){}},fastModeControl:{reset(){}},
    composerDrafts:{get(){return '';},set(){}},sessionStorage:{getItem(){},removeItem(){}},
    history:{replaceState(){}},document:{querySelectorAll:()=>[]},window:{},t:text=>text,
    renderNotificationState(){},sessionActivity:{read(){}},renderActivity(){},renderState(){},renderMarkdown(){},
    startCatalog(){events.push('catalog');},sessionUrl:(id,action,host)=>host+'/'+id+'/'+action,
    api:async(url,body,signal)=>{events.push('reconnect');ctx.reconnect={url,body,signal};return {connected:true};},
    loadNotificationState(){events.push('notifications');},toast(){},
    ChatTimeline:class{
      constructor(){this.abort=new AbortController();}
      start(){events.push('history');return new Promise(resolve=>finishReading=resolve);}
      dispose(){this.abort.abort();}
    }};
  vm.createContext(ctx);vm.runInContext(opening,ctx);
  return {ctx,events,finish:()=>finishReading()};
}

test('opening reserves requests for owner connection and history before model discovery',async()=>{
  const f=fixture(),pending=f.ctx.openChat('a');
  assert.ok(f.events.includes('reconnect'));
  assert.ok(!f.events.includes('catalog'),'自动连接期间不应预读模型目录并抢占请求名额');
  assert.ok(f.events.includes('history'),'历史读取应与连接并行');
  assert.equal(f.ctx.reconnect.body.activate,true);
  assert.equal(f.ctx.reconnect.signal,f.ctx.chatTimeline.abort.signal);
  f.finish();await pending;
});

test('opening CLI history never starts an automatic runtime connection',async()=>{
  const f=fixture({source:'cli'}),pending=f.ctx.openChat('a');
  assert.ok(!f.events.includes('reconnect'));
  f.finish();await pending;
});
