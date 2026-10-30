'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const slot='00000000-0000-4000-8000-000000000001';

function device(gateway){
  const calls=[],timers=new Map(),listeners=new Map();let timerId=0,uuidId=0;
  const document={hidden:false,addEventListener:(name,run)=>listeners.set(name,run)};
  const context=vm.createContext({document,AbortController,uuid:()=>slot.slice(0,-12)+String(++uuidId).padStart(12,'0'),BridgeI18n:{t:text=>text},
    setTimeout:run=>{timers.set(++timerId,run);return timerId;},clearTimeout:id=>timers.delete(id)});
  for(const file of ['side-chat','workbench'])vm.runInContext(fs.readFileSync('web/features/workspace/'+file+'.js','utf8'),context);
  vm.runInContext(`const Panel=SideChatPanel;
    SideChatPanel=class {
      constructor(workbench,session,tab){
        const panel=Object.create(Panel.prototype);
        Object.assign(panel,{workbench,session,tab,creationId:uuid(),status:{},caption:{},apply(state){this.state=state;},controls(){},
          references:{close(){}},dispose(){this.disposed=true;}});
        panel.load();return panel;
      }
    };`,context);
  const Workbench=vm.runInContext('Workbench',context),wb=Object.create(Workbench.prototype);
  Object.assign(wb,{sessions:new Map(),fileQuotes:{open(){},close(){}},rememberScroll(){},paint(){},
    stopThumbnails(){},endDrag(){},chat:{classList:{remove(){}}},panel:{replaceChildren(){}},tabs:{replaceChildren(){}},
    onUnauthorized(){wb.unauthorized=true;},
    node:()=>({}),request:(url,body,signal)=>{calls.push({url,body,signal});return gateway(url,body,signal);}});
  const flush=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
  const tick=async()=>{const [id,run]=timers.entries().next().value;timers.delete(id);await run();await flush();};
  return {wb,calls,document,flush,timers,listeners,tick};
}

test('a fresh tablet opening the parent discovers phone side chats without opening a side panel',async()=>{
  const slots=[{slot:'',id:'phone-default'},{slot,id:'phone-second'}];
  const tablet=device(async url=>{
    const selected=new URL(url,'https://fixture').searchParams.get('slot')||'';
    return {id:slots.find(row=>row.slot===selected)?.id,connected:true,slots,turns:[{text:'Phone discussion'}]};
  });
  tablet.wb.open('parent','local');await tablet.flush();
  assert.deepEqual(Array.from(tablet.wb.current.files,tab=>tab.slot),['',slot]);
  assert.deepEqual(Array.from(tablet.wb.current.files,tab=>tab.sideChat.state.id),['phone-default','phone-second']);
  assert.equal(tablet.wb.current.active,'chat');
  assert.ok(tablet.calls.length>0);assert.ok(tablet.calls.every(call=>call.body===undefined));
});

test('manually opening a side panel can already discover the same gateway chats on another device',async()=>{
  const tablet=device(async()=>({id:'phone-default',connected:true,slots:[{slot:'',id:'phone-default'},{slot,id:'phone-second'}]}));
  tablet.wb.open('parent','local');
  tablet.wb.createSideChat(tablet.wb.current);await tablet.flush();
  assert.deepEqual(Array.from(tablet.wb.current.files,tab=>tab.slot),['',slot]);
});

test('关闭 Codex 标签仅释放本机视图，后台发现不重新打开，显式打开仍读取原会话',async()=>{
  const tablet=device(async()=>({id:'saved-child',connected:true,slots:[{slot:'',id:'saved-child'}]}));
  tablet.wb.open('parent','local');await tablet.flush();
  await tablet.wb.close('sidechat');
  assert.equal(tablet.wb.current.files.length,0);
  await tablet.wb.refreshSideChats();assert.equal(tablet.wb.current.files.length,0);
  tablet.wb.createSideChat(tablet.wb.current);await tablet.flush();
  assert.equal(tablet.wb.current.files[0].sideChat.state.id,'saved-child');
  assert.ok(tablet.calls.every(call=>call.body===undefined));
});

test('历史标签通过存档身份读取，不与同槽位的新聊天合并',async()=>{
  const tablet=device(async url=>({id:new URL(url,'https://fixture').searchParams.get('archiveId')||'live-child',slots:[]}));
  tablet.wb.open('parent','local');await tablet.flush();
  const archived=tablet.wb.createSideChat(tablet.wb.current,'',slot);await tablet.flush();
  assert.equal(archived.id,'sidearchive:'+slot);assert.equal(archived.sideChat.state.id,slot);
  assert.ok(tablet.calls.every(call=>call.body===undefined));
});

test('a phone side chat in an independent slot restores without creating an empty default tab',async()=>{
  const tablet=device(async url=>({id:new URL(url,'https://fixture').searchParams.has('slot')?'phone-side':null,
    slots:[{slot,id:'phone-side'}],turns:[{text:'Shared discussion'}]}));
  tablet.wb.open('parent','local');await tablet.flush();
  assert.equal(tablet.wb.current.files.length,1);assert.equal(tablet.wb.current.files[0].slot,slot);
  assert.equal(tablet.wb.current.files[0].sideChat.state.id,'phone-side');
  assert.equal(tablet.wb.current.files[0].sideChat.state.turns[0].text,'Shared discussion');
});

test('another device can add side chats while the tablet stays in the main chat without losing drafts',async()=>{
  let slots=[{slot:'',id:'first'}];
  const tablet=device(async()=>({id:'first',slots}));
  tablet.wb.open('parent','local');await tablet.flush();
  const first=tablet.wb.current.files[0];first.sideChat.input={value:'Tablet draft'};
  slots=[...slots,{slot,id:'second'}];await tablet.tick();
  assert.equal(tablet.wb.current.files.length,2);assert.equal(tablet.wb.current.files[0],first);
  assert.equal(first.sideChat.input.value,'Tablet draft');assert.equal(tablet.wb.current.active,'chat');
  assert.ok(tablet.calls.every(call=>call.body===undefined));
});

test('side discovery observes caller capabilities and skips other providers and remote hosts',async()=>{
  for(const target of ['unsupported','claude','deepseek','remote']){
    const tablet=device(async()=>{throw Error('Unexpected read');});
    if(['claude','deepseek'].includes(target))tablet.wb.provider=target;
    tablet.wb.open('parent',target==='remote'?'ssh:server':'local');
    if(target==='unsupported')tablet.wb.current.access={canUseSideChat:false};
    await tablet.flush();assert.equal(tablet.calls.length,0);assert.equal(tablet.timers.size,0);
  }
});

test('overlapping discovery reads join and late replies cannot restore tabs after changing chats',async()=>{
  let finish;
  const tablet=device(url=>url.includes('/old/')?new Promise(resolve=>finish=resolve):Promise.resolve({slots:[]}));
  tablet.wb.open('old','local');await tablet.flush();const old=tablet.wb.current;
  await tablet.wb.refreshSideChats();assert.equal(tablet.calls.length,1);
  tablet.wb.open('new','local');await tablet.flush();
  assert.equal(tablet.calls[0].signal.aborted,true);
  finish({slots:[{slot,id:'stale'}]});await tablet.flush();
  assert.equal(tablet.wb.current.id,'new');assert.equal(tablet.wb.current.files.length,0);assert.equal(old.files.length,0);
  assert.equal(tablet.timers.size,1);
});

test('reset aborts discovery and late replies cannot populate a new login using the same chat key',async()=>{
  let finish,first=true;
  const tablet=device(()=>first?(first=false,new Promise(resolve=>finish=resolve)):Promise.resolve({slots:[]}));
  tablet.wb.open('parent','local');await tablet.flush();const previous=tablet.wb.current;
  tablet.wb.reset();tablet.wb.open('parent','local');await tablet.flush();
  finish({slots:[{slot,id:'old-login'}]});await tablet.flush();
  assert.equal(tablet.calls[0].signal.aborted,true);assert.notEqual(tablet.wb.current,previous);
  assert.equal(tablet.wb.current.files.length,0);assert.equal(previous.files.length,0);assert.equal(tablet.timers.size,1);
});

test('discovery retries connection failures, pauses in the background and refreshes on return',async()=>{
  let offline=true;
  const tablet=device(async()=>{if(offline)throw Error('Offline');return {id:'recovered',slots:[{slot:'',id:'recovered'}]};});
  tablet.wb.open('parent','local');await tablet.flush();assert.equal(tablet.wb.current.files.length,0);assert.equal(tablet.timers.size,1);
  offline=false;await tablet.tick();const tab=tablet.wb.current.files[0];tab.sideChat.input={value:'Kept draft'};
  offline=true;await tablet.tick();assert.equal(tablet.wb.current.files[0],tab);assert.equal(tab.sideChat.input.value,'Kept draft');
  const reads=tablet.calls.length;tablet.document.hidden=true;await tablet.wb.refreshSideChats();
  assert.equal(tablet.calls.length,reads);assert.equal(tablet.timers.size,0);
  tablet.document.hidden=false;offline=false;await tablet.wb.refreshSideChats();await tablet.flush();
  assert.equal(tablet.calls.length,reads+1);assert.equal(tablet.wb.current.files[0],tab);
});

test('expired discovery authentication follows the shared logout handler',async()=>{
  const tablet=device(async()=>{throw Object.assign(Error('Login required'),{status:401});});
  tablet.wb.open('parent','local');await tablet.flush();assert.equal(tablet.wb.unauthorized,true);
});

test('the new-tab side-chat entry creates a ready chat and preserves the disconnected chat draft',async()=>{
  const tablet=device(async(url,body)=>body?.action==='create'?{id:'new-child',connected:true}:
    {id:'old-child',connected:false,slots:[{slot:'',id:'old-child'}]});
  tablet.wb.open('parent','local');await tablet.flush();
  const session=tablet.wb.current,old=session.files[0];old.sideChat.input={value:'Preserved draft'};
  tablet.wb.select=id=>session.active=id;
  tablet.wb.sideChat('',true);await tablet.flush();
  assert.equal(session.files.length,2);assert.notEqual(session.active,old.id);
  const created=session.files[1];assert.ok(created.slot);assert.equal(old.sideChat.input.value,'Preserved draft');
  assert.equal(created.sideChat.state.id,'new-child');assert.equal(created.sideChat.state.connected,true);
  assert.equal(tablet.calls.filter(call=>call.body?.action==='create').length,1);
  assert.ok(tablet.calls.every(call=>call.body===undefined||call.body.action==='create'),'creating a chat does not send a message');
});

test('a late initial read cannot replace the chat created from the new-tab entry',async()=>{
  let finishRead;
  const tablet=device(async(url,body)=>body?.action==='create'?{id:'created-child',connected:true}:
    new URL(url,'https://fixture').searchParams.has('slot')?new Promise(resolve=>finishRead=resolve):{id:null,slots:[]});
  tablet.wb.open('parent','local');await tablet.flush();tablet.wb.select=id=>tablet.wb.current.active=id;
  tablet.wb.sideChat('',true);await tablet.flush();const panel=tablet.wb.current.files[0].sideChat;
  assert.equal(panel.state?.id,'created-child');
  finishRead({id:null,connected:false,slots:[]});await tablet.flush();
  assert.equal(panel.state.id,'created-child');assert.equal(tablet.calls.filter(call=>call.body).length,1);
});

test('creation failure is not replayed by reads and an explicit retry keeps the creation id',async()=>{
  let fail=true;
  const tablet=device(async(url,body)=>{
    if(body?.action==='create'){if(fail)throw Error('Creation unavailable');return {id:'retried-child',connected:true};}
    return {id:null,slots:[]};
  });
  tablet.wb.open('parent','local');await tablet.flush();tablet.wb.select=id=>tablet.wb.current.active=id;
  tablet.wb.sideChat('',true);await tablet.flush();const panel=tablet.wb.current.files[0].sideChat;
  assert.equal(panel.status.textContent,'Creation unavailable');assert.equal(panel.busy,false);
  await panel.load();await tablet.tick();assert.equal(tablet.calls.filter(call=>call.body).length,1);
  fail=false;await panel.create();const writes=tablet.calls.filter(call=>call.body);
  assert.equal(writes.length,2);assert.equal(writes[0].body.creationId,writes[1].body.creationId);
  assert.equal(panel.state.id,'retried-child');
});

test('an in-flight or completed creation cannot be submitted twice for the same tab',async()=>{
  let finishCreate;
  const tablet=device(async(url,body)=>body?.action==='create'?new Promise(resolve=>finishCreate=resolve):{id:null,slots:[]});
  tablet.wb.open('parent','local');await tablet.flush();tablet.wb.select=id=>tablet.wb.current.active=id;
  tablet.wb.sideChat('',true);await tablet.flush();const panel=tablet.wb.current.files[0].sideChat;
  assert.equal(tablet.calls.filter(call=>call.body).length,1);await panel.create();
  assert.equal(tablet.calls.filter(call=>call.body).length,1);
  finishCreate({id:'created-once',connected:true});await tablet.flush();await panel.create();
  assert.equal(tablet.calls.filter(call=>call.body).length,1);
});

test('repeated side-chat creation opens independent tabs instead of selecting the first chat',async()=>{
  const tablet=device(async()=>({id:null,slots:[]}));
  tablet.wb.open('parent','local');await tablet.flush();
  tablet.wb.select=id=>tablet.wb.current.active=id;
  for(let i=0;i<3;i++)tablet.wb.sideChat();
  await tablet.flush();const tabs=tablet.wb.current.files;
  assert.equal(tabs.length,3);assert.equal(new Set(tabs.map(tab=>tab.slot)).size,3);
  assert.equal(tablet.wb.current.active,tabs[2].id);
});

test('side-chat titles sync to existing tabs while older reads cannot undo a rename',async()=>{
  const tablet=device(async()=>({id:'child',slots:[{slot,id:'child',title:'First title',titleRevision:1}]}));
  tablet.wb.open('parent','local');await tablet.flush();
  const session=tablet.wb.current,tab=session.files[0];assert.equal(tab.name,'First title');
  tablet.wb.syncSideChats(session,[{slot,id:'child',title:'保存',titleRevision:2}]);assert.equal(tab.name,'保存');
  tablet.wb.syncSideChats(session,[{slot,id:'child',title:'Stale title',titleRevision:1}]);assert.equal(tab.name,'保存');
  assert.equal(tab.customTitle,'保存');assert.equal(session.active,'chat');
});

test('background summary updates the existing side-chat tab and keeps its draft and selected tab',async()=>{
  const tablet=device(async()=>({id:'child',slots:[{slot,id:'child',title:'首条消息的简短预览',titleRevision:1,titleSource:'preview'}]}));
  tablet.wb.open('parent','local');await tablet.flush();
  const session=tablet.wb.current,tab=session.files[0];tab.sideChat.input={value:'尚未发送的草稿'};
  tablet.wb.syncSideChats(session,[{slot,id:'child',title:'修复侧边聊天同步',titleRevision:2,titleSource:'summary'}]);
  assert.equal(session.files[0],tab);assert.equal(tab.name,'修复侧边聊天同步');
  assert.equal(tab.sideChat.input.value,'尚未发送的草稿');assert.equal(session.active,'chat');
  tablet.wb.syncSideChats(session,[{slot,id:'child',title:'过期预览',titleRevision:1,titleSource:'preview'}]);
  assert.equal(tab.name,'修复侧边聊天同步');
});

test('主聊天停留期间发现旧侧边槽位消失，会刷新隐藏面板的失效状态',async()=>{
  let slots=[{slot,id:'child'}];
  const tablet=device(async()=>({id:null,slots}));tablet.wb.open('parent','local');await tablet.flush();
  const panel=tablet.wb.current.files[0].sideChat;panel.state={id:'child',connected:true};
  slots=[];await tablet.wb.refreshSideChats();
  assert.equal(panel.state.connected,false);assert.equal(tablet.wb.current.active,'chat');
  assert.ok(tablet.calls.every(call=>call.body===undefined));
});

test('旧发现请求返回时不能把刚创建或更新的侧边聊天标记失效',async()=>{
  let finish,delayed=false;
  const tablet=device(async()=>delayed?new Promise(resolve=>finish=resolve):{slots:[{slot,id:'child'}]});
  tablet.wb.open('parent','local');await tablet.flush();
  const panel=tablet.wb.current.files[0].sideChat;panel.state={id:'child',connected:true};
  delayed=true;const reading=tablet.wb.refreshSideChats();await tablet.flush();
  panel.readRevision=(panel.readRevision||0)+1;
  finish({slots:[]});await reading;assert.equal(panel.state.connected,true);
});
