'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {SessionActivity}=require('../web/features/chat/activity.js');

function fixture(){
  const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
  const calls=[],nodes=[],timers=new Map(),root={clientWidth:240,clientHeight:300,getBoundingClientRect:()=>({top:0,left:0,right:240,bottom:300}),querySelectorAll:()=>nodes};
  const rows=[{id:'visible',host:'local'},{id:'below',host:'local'},{id:'collapsed',host:'ssh'},{id:'not-rendered',host:'ssh'}];
  const node=(row,top,rendered=true)=>({dataset:row,closest:()=>null,getClientRects:()=>rendered?[{}]:[],getBoundingClientRect:()=>({top,bottom:top+30,left:0,right:240})});
  nodes.push(node(rows[0],10),node(rows[1],400),node(rows[2],60,false));
  const activity=new SessionActivity({storage:{getItem:()=>null,setItem(){}}});let now=0;
  const context=vm.createContext({activityBusy:false,listRows:rows,document:{hidden:false},window:{innerWidth:1000,innerHeight:800},
    clientNavigation:{provider:'codex'},$:id=>id==='sessions'?root:{hidden:false},sessionActivity:activity,visibleChat:()=>null,
    setTimeout:(fn,delay=0)=>{const id={delay,at:now+delay};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    chatKey:(id,host)=>host+'|'+id,renderActivity(){},bumpRecency(){},api:async(url,body)=>{calls.push({url,body});return {sessions:[]};}});
  vm.runInContext(source.slice(source.indexOf('async function refreshActivity('),source.indexOf('setInterval(refreshActivity')),context);
  const next=async()=>{const id=[...timers.keys()].sort((a,b)=>a.at-b.at)[0];assert.ok(id,'An automatic refresh must be scheduled');const fn=timers.get(id);timers.delete(id);now=id.at;await fn();return id.delay;};
  return {context,calls,nodes,root,rows,timers,activity,next,refresh:()=>vm.runInContext('refreshActivity()',context),schedule:()=>vm.runInContext('scheduleActivityRefresh()',context)};
}

test('sidebar automatically polls only chats currently visible in its viewport',async()=>{
  const ui=fixture();await ui.refresh();
  assert.equal(ui.calls.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].body)),{hosts:{local:['visible']}});
});

test('scrolling changes the automatically observed chats without opening a chat',async()=>{
  const ui=fixture();await ui.refresh();
  ui.nodes[0].getBoundingClientRect=()=>({top:-50,bottom:-20,left:0,right:240});
  ui.nodes[1].getBoundingClientRect=()=>({top:20,bottom:50,left:0,right:240});
  await ui.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1).body)),{hosts:{local:['below']}});
});

test('hidden navigation and other clients do not poll Codex chats',async()=>{
  const ui=fixture();ui.root.clientHeight=0;await ui.refresh();assert.equal(ui.calls.length,0);
  ui.root.clientHeight=300;ui.context.clientNavigation.provider='claude';await ui.refresh();assert.equal(ui.calls.length,0);
});

test('a navigation panel outside the window does not observe its clipped chats',async()=>{
  const ui=fixture();ui.root.getBoundingClientRect=()=>({top:0,left:-240,right:0,bottom:300});
  await ui.refresh();assert.equal(ui.calls.length,0);
});

test('closed details are excluded even when a browser reports their child rectangles',async()=>{
  const ui=fixture();ui.nodes[2].getClientRects=()=>[{}];ui.nodes[2].closest=()=>({open:false});
  await ui.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].body)),{hosts:{local:['visible']}});
});

test('layout events coalesce and a changed viewport is refreshed after an in-flight read',async()=>{
  const ui=fixture();let release;ui.context.api=async(url,body)=>{ui.calls.push({url,body});await new Promise(resolve=>release=resolve);return {sessions:[]};};
  const reading=ui.refresh();ui.schedule();ui.schedule();assert.equal(ui.timers.size,1);
  await [...ui.timers.values()][0]();ui.timers.clear();assert.equal(ui.calls.length,1);
  ui.nodes[0].getBoundingClientRect=()=>({top:-50,bottom:-20,left:0,right:240});
  ui.nodes[1].getBoundingClientRect=()=>({top:20,bottom:50,left:0,right:240});
  release();await reading;assert.equal(ui.timers.size,1);
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[]};};
  await [...ui.timers.values()][0]();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1).body)),{hosts:{local:['below']}});
});

test('a gray activity dot automatically retrieves the completed background read before the five-second poll',async()=>{
  const ui=fixture();let ready=false;
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[{...ui.rows[0],connected:false,activityConnected:ready,status:ready?'notLoaded':'unknown',turnId:'last',turnStatus:'completed'}]};};
  await ui.refresh();assert.equal(ui.activity.indicator('local|visible')?.kind,'unknown');
  assert.equal(ui.timers.size,1,'Unknown status must schedule a follow-up without waiting for the periodic poll');
  ready=true;assert.ok(await ui.next()<=250,'The initial follow-up must run within 250 ms');
  assert.equal(ui.calls.length,2);assert.equal(ui.activity.indicator('local|visible'),null);
  assert.equal(ui.timers.size,0,'A confirmed status stops the fast follow-ups');
});

test('fast follow-ups only read the still-unknown visible chats',async()=>{
  const ui=fixture();ui.nodes[1].getBoundingClientRect=()=>({top:50,bottom:80,left:0,right:240});
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:Object.entries(body.hosts).flatMap(([host,ids])=>ids.map(id=>({id,host,connected:id!=='visible',status:id==='visible'?'unknown':'idle'})))};};
  await ui.refresh();await ui.next();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1).body)),{hosts:{local:['visible']}});
  ui.nodes[0].getBoundingClientRect=()=>({top:-50,bottom:-20,left:0,right:240});
  const before=ui.calls.length;await ui.next();assert.equal(ui.calls.length,before,'A retry cannot keep reading a chat that scrolled out of view');
});

test('persistent unknown status backs off and leaves normal periodic recovery available',async()=>{
  const ui=fixture();let ready=false;
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[{...ui.rows[0],connected:ready,status:ready?'idle':'unknown'}]};};
  await ui.refresh();assert.equal(ui.timers.size,1);
  let elapsed=0;while(ui.timers.size&&ui.calls.length<15)elapsed+=await ui.next();
  assert.ok(ui.calls.length>1&&ui.calls.length<=12,'An unavailable owner must not cause endless rapid requests');
  assert.equal(ui.timers.size,0);assert.ok(elapsed<10000);
  const before=ui.calls.length;await ui.refresh();assert.equal(ui.calls.length,before+1);assert.equal(ui.timers.size,0,'The next normal poll does not restart the exhausted burst');
  ready=true;await ui.refresh();ready=false;await ui.refresh();assert.equal(ui.timers.size,1,'A new loss after recovery gets its own prompt retry');
});

test('hiding navigation or switching clients cancels pending fast activity reads',async()=>{
  for(const hide of [ui=>ui.root.clientHeight=0,ui=>ui.context.document.hidden=true,ui=>ui.context.clientNavigation.provider='claude']){
    const ui=fixture();ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[{...ui.rows[0],connected:false,status:'unknown'}]};};
    await ui.refresh();hide(ui);await ui.next();assert.equal(ui.calls.length,1);assert.equal(ui.timers.size,0);
  }
});

test('a normal refresh supersedes the pending retry without concurrent requests',async()=>{
  const ui=fixture();ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[{...ui.rows[0],connected:false,status:'unknown'}]};};
  await ui.refresh();assert.equal(ui.timers.size,1);
  let release;ui.context.api=async(url,body)=>{ui.calls.push({url,body});await new Promise(resolve=>release=resolve);return {sessions:[{...ui.rows[0],connected:true,status:'idle'}]};};
  const reading=ui.refresh();assert.equal(ui.timers.size,0,'Starting a normal read removes the old retry timer');
  ui.schedule();await ui.next();assert.equal(ui.calls.length,2);release();await reading;
  assert.equal(ui.timers.size,1);ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[]};};await ui.next();assert.equal(ui.calls.length,3);
});

test('newly rendered gray dots trigger a read while existing gray dots do not restart it',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');let dot=null,scheduled=0;
  const button={dataset:{id:'chat',host:'local'},querySelector:selector=>selector==='.session-indicator'?dot:{prepend:value=>dot=value}};
  const context=vm.createContext({activityBusy:false,state:null,currentId:null,chatKey:(id,host)=>host+'|'+id,t:value=>value,
    $:()=>({querySelectorAll:()=>[button]}),sessionActivity:{indicator:()=>({kind:'unknown',label:'运行状态暂不可用'})},scheduleActivityRefresh:()=>scheduled++,
    el:(tag,cls)=>({classList:{contains:value=>cls.split(' ').includes(value)},setAttribute(){},remove(){dot=null;}})});
  vm.runInContext(source.slice(source.indexOf('function renderActivity(){'),source.indexOf('async function refreshActivity(')),context);
  vm.runInContext('renderActivity()',context);assert.equal(scheduled,1);
  vm.runInContext('renderActivity()',context);assert.equal(scheduled,1);
  dot=null;context.activityBusy=true;vm.runInContext('renderActivity()',context);assert.equal(scheduled,1,'An in-flight read already handles the new gray status');
});

test('a failed fast HTTP read falls back to normal polling',async()=>{
  const ui=fixture();ui.context.api=async()=>({sessions:[{...ui.rows[0],connected:true,status:'unknown'}]});
  await ui.refresh();assert.equal(ui.timers.size,1);
  ui.context.api=async()=>{throw Error('fixture unavailable');};await ui.next();assert.equal(ui.timers.size,0);
  assert.equal(ui.context.activityBusy,false);assert.equal(ui.activity.indicator('local|visible')?.kind,'unknown');
});
