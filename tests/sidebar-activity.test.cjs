'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {SessionActivity,ActivityPolling}=require('../web/features/chat/activity.js');

function fixture({adaptive=false}={}){
  const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
  const calls=[],nodes=[],timers=new Map(),root={clientWidth:240,clientHeight:300,getBoundingClientRect:()=>({top:0,left:0,right:240,bottom:300}),querySelectorAll:()=>nodes};
  const rows=[{id:'visible',host:'local'},{id:'below',host:'local'},{id:'collapsed',host:'ssh'},{id:'not-rendered',host:'ssh'}];
  const node=(row,top,rendered=true)=>({dataset:row,closest:()=>null,getClientRects:()=>rendered?[{}]:[],getBoundingClientRect:()=>({top,bottom:top+30,left:0,right:240})});
  nodes.push(node(rows[0],10),node(rows[1],400),node(rows[2],60,false));
  let now=0;const activity=new SessionActivity({storage:{getItem:()=>null,setItem(){}},now:()=>now});
  let periodic;const context=vm.createContext({AbortController,setInterval:fn=>periodic=fn,activityBusy:false,activityRequests:new Set(),activityInFlight:new Set(),listRows:rows,document:{hidden:false},window:{innerWidth:1000,innerHeight:800},
    clientNavigation:{provider:'codex'},$:id=>id==='sessions'?root:{hidden:false},sessionActivity:activity,visibleChat:()=>null,
    setTimeout:(fn,delay=0)=>{const id={delay,at:now+delay};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    chatKey:(id,host)=>host+'|'+id,renderActivity(){},syncRecencies(){},bumpRecency(){},api:async(url,body)=>{calls.push({url,body});return {sessions:[]};}});
  const start=source.indexOf('async function refreshActivity(');
  if(adaptive){context.ActivityPolling=class extends ActivityPolling{constructor(){super({now:()=>now});}};context.ActivityChanges=class{setScope(){}canConfirm(){return context.healthy;} };context.healthy=true;}
  vm.runInContext(source.slice(start,source.indexOf("window.addEventListener('focus'",start)),context);
  const next=async()=>{const id=[...timers.keys()].sort((a,b)=>a.at-b.at)[0];assert.ok(id,'An automatic refresh must be scheduled');const fn=timers.get(id);timers.delete(id);now=id.at;await fn();return id.delay;};
  return {context,calls,nodes,root,rows,timers,activity,next,at:value=>now=value,periodic:()=>periodic(),refresh:()=>vm.runInContext('refreshActivity()',context),schedule:()=>vm.runInContext('scheduleActivityRefresh()',context)};
}

test('sidebar automatically polls only chats currently visible in its viewport',async()=>{
  const ui=fixture();await ui.refresh();
  assert.equal(ui.calls.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[0].body)),{hosts:{local:['visible']}});
});

test('实际定时入口减少可靠实时聊天的补读，通知断开时下个五秒周期恢复',async()=>{
  const ui=fixture({adaptive:true});
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[{...ui.rows[0],connected:true,status:'active',activityRealtime:true,activityStreamId:'a'.repeat(32)}]};};
  await ui.refresh();assert.equal(ui.calls.length,1);
  ui.at(5000);await ui.periodic();ui.at(10000);await ui.periodic();assert.equal(ui.calls.length,1);
  ui.at(30000);await ui.periodic();assert.equal(ui.calls.length,2);
  ui.context.healthy=false;ui.at(35000);await ui.periodic();assert.equal(ui.calls.length,3);
  ui.context.healthy=true;vm.runInContext("queueActivityChanges({local:['visible']})",ui.context);await ui.next();
  assert.equal(ui.calls.length,4,'通知到达时不等三十秒，立即定向读取');
});

test('较早的活动响应不能把消息流已确认结束的聊天重新变绿',async()=>{
  const ui=fixture(),key='local|visible',running={...ui.rows[0],connected:true,status:'active',turnId:'one',turnStatus:'inProgress'};
  ui.context.visibleChat=()=>key;
  ui.activity.update([running],key);
  let release;
  ui.context.api=async()=>{await new Promise(resolve=>release=resolve);return {sessions:[running]};};
  const reading=ui.refresh();
  ui.activity.update([{...running,status:'idle',turnStatus:'completed'}],key);
  assert.equal(ui.activity.indicator(key),null);
  release();await reading;
  assert.equal(ui.activity.indicator(key),null,'旧活动响应不得复活运行圆点');
});

test('较早活动请求失败不能把消息流新确认的状态标记为离线',async()=>{
  const ui=fixture();let reject;
  ui.context.api=()=>new Promise((resolve,fail)=>reject=fail);
  const reading=ui.refresh();
  ui.activity.update([{...ui.rows[0],connected:true,status:'idle'}]);
  reject(Error('旧请求超时'));await reading;
  assert.equal(ui.activity.rows['local|visible'].offline,false);
});

test('增量通知只读取改变的可见聊天，屏外变化不会触发读取',async()=>{
  const ui=fixture();
  vm.runInContext("queueActivityChanges({local:['visible','below']})",ui.context);
  await ui.next();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.map(call=>call.body))),[{hosts:{local:['visible']}}]);
});

test('查询中到达的通知使旧响应失效，并在空位释放后补读一次',async()=>{
  const ui=fixture(),key='local|visible';let release;
  ui.activity.update([{...ui.rows[0],connected:true,status:'idle'}]);
  ui.context.api=async()=>{await new Promise(resolve=>release=resolve);return {sessions:[{...ui.rows[0],connected:true,status:'active'}]};};
  const reading=ui.refresh();
  vm.runInContext("queueActivityChanges({local:['visible']})",ui.context);await ui.next();
  release();await reading;
  assert.equal(ui.activity.indicator(key),null,'通知后旧请求不能复活旧状态');
  let calls=0;ui.context.api=async()=>{calls++;return {sessions:[{...ui.rows[0],connected:true,status:'idle'}]};};
  await ui.next();assert.equal(calls,1);assert.equal(ui.timers.size,0);
});

test('不同主机的可见聊天独立返回，不等待同批慢主机',async()=>{
  const ui=fixture();let release;
  ui.nodes[2].getClientRects=()=>[{}];
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});if(body.hosts.ssh)await new Promise(resolve=>release=resolve);return {sessions:Object.entries(body.hosts).flatMap(([host,ids])=>ids.map(id=>({id,host,connected:true,status:'active'})))};};
  const reading=ui.refresh();await new Promise(resolve=>setImmediate(resolve));
  try{
    assert.equal(ui.activity.indicator('local|visible')?.kind,'running','本机结果应先显示');
    assert.equal(ui.calls.length,2);
    assert.ok(ui.calls.every(call=>Object.keys(call.body.hosts).length===1));
  }finally{release?.();await reading;}
});

test('活动响应的排序时间批量应用，整批只触发一次状态绘制',async()=>{
  const ui=fixture(),source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');let renders=0;
  ui.context.recentInteractions=new Map();ui.context.renderList=()=>renders++;
  ui.context.renderActivity=()=>renders++;
  vm.runInContext(source.slice(source.indexOf('function syncRecency('),source.indexOf('let activityBusy')),ui.context);
  ui.context.api=async()=>({sessions:ui.rows.map((row,i)=>({...row,connected:true,status:'idle',recency:i+100}))});
  await ui.refresh();
  assert.equal(renders,1,'每个排序字段更新不能分别触发列表绘制');
  assert.deepEqual(ui.rows.map(row=>row.recency),[103,102,101,100]);
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

test('layout events coalesce without queueing another read for the same in-flight chats',async()=>{
  const ui=fixture();let release;ui.context.api=async(url,body)=>{ui.calls.push({url,body});await new Promise(resolve=>release=resolve);return {sessions:[]};};
  const reading=ui.refresh();ui.schedule();ui.schedule();assert.equal(ui.timers.size,2);
  await ui.next();assert.equal(ui.calls.length,1);
  release();await reading;assert.equal(ui.timers.size,0);assert.equal(ui.calls.length,1);
});

test('newly visible chats start their read while an older periodic request is still waiting',async()=>{
  const ui=fixture();let release;
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});if(body.hosts.local?.includes('visible'))await new Promise(resolve=>release=resolve);return {sessions:[]};};
  const reading=ui.refresh();
  try{
    ui.nodes[1].getBoundingClientRect=()=>({top:20,bottom:50,left:0,right:240});
    ui.schedule();await ui.next();
    assert.equal(ui.calls.length,2,'A newly expanded project must not wait for the old request deadline or the next five-second tick');
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[1].body)),{hosts:{local:['below']}});
    assert.equal(ui.context.activityBusy,true,'Completing the new read cannot release the older in-flight read');
    await ui.periodic();assert.equal(ui.calls.length,3,'Periodic updates can refresh completed chats without waiting for another chat');
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[2].body)),{hosts:{local:['below']}});
  }finally{release();await reading;}
});

test('rapid viewport changes bound concurrent requests and use the next free slot',async()=>{
  const ui=fixture(),releases=[],reading=[];
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});await new Promise(resolve=>releases.push(resolve));return {sessions:[]};};
  try{
    for(let i=0;i<5;i++){
      const row={id:'project-'+i,host:'local'};ui.rows.push(row);ui.nodes[0].dataset=row;
      const task=ui.refresh();if(i<4)reading.push(task);else await task;
    }
    assert.equal(ui.calls.length,4,'Fast scrolling must not create unbounded concurrent reads');
    releases[0]();await reading[0];
    const scheduled=ui.next();await Promise.resolve();
    assert.equal(ui.calls.length,5);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[4].body)),{hosts:{local:['project-4']}});
    for(const release of releases)release();await scheduled;
  }finally{for(const release of releases)release();await Promise.all(reading);}
  assert.equal(ui.context.activityBusy,false);
});

test('one blocking activity request returns the desktop result without follow-up reads',async()=>{
  const ui=fixture();let release;
  ui.activity.update([{...ui.rows[0],connected:false,status:'unknown'}]);
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});await new Promise(resolve=>release=resolve);return {sessions:[{...ui.rows[0],connected:false,activityConnected:true,status:'notLoaded',turnId:'last',turnStatus:'completed'}]};};
  const reading=ui.refresh();assert.equal(ui.context.activityBusy,true);assert.equal(ui.calls.length,1);
  assert.equal(ui.activity.indicator('local|visible')?.kind,'unknown');
  assert.deepEqual([...ui.timers.keys()].map(timer=>timer.delay),[10000],'Only a network timeout is scheduled while waiting');
  release();await reading;
  assert.equal(ui.activity.indicator('local|visible'),null);assert.equal(ui.calls.length,1);assert.equal(ui.timers.size,0);
});

test('an unknown or timed-out response stays gray without starting rapid polling',async()=>{
  const ui=fixture();ui.context.api=async(url,body)=>{ui.calls.push({url,body});return {sessions:[{...ui.rows[0],connected:false,status:'unknown',activityError:'timeout'}],timedOut:true};};
  await ui.refresh();assert.equal(ui.activity.indicator('local|visible')?.label,'读取运行状态超时');
  assert.equal(ui.calls.length,1);assert.equal(ui.timers.size,0);
});

test('periodic updates skip in-flight blocking reads instead of queueing an immediate retry',async()=>{
  const ui=fixture();let release;
  ui.context.api=async(url,body)=>{ui.calls.push({url,body});await new Promise(resolve=>release=resolve);return {sessions:[{...ui.rows[0],connected:false,status:'unknown'}]};};
  const reading=ui.refresh();ui.periodic();ui.periodic();assert.equal(ui.calls.length,1);
  release();await reading;assert.equal(ui.timers.size,0,'A periodic tick cannot turn a timeout into a rapid retry');
});

test('a hung network request is aborted and releases the activity request lock',async()=>{
  const ui=fixture();ui.context.api=async(url,body,signal)=>{ui.calls.push({url,body});await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('fixture timeout')),{once:true}));};
  const reading=ui.refresh();assert.equal(await ui.next(),10000);await reading;
  assert.equal(ui.context.activityBusy,false);assert.equal(ui.timers.size,0);assert.equal(ui.calls.length,1);
  assert.equal(ui.activity.indicator('local|visible')?.label,'读取运行状态超时');
  ui.context.api=async()=>({sessions:[]});await ui.refresh();assert.equal(ui.context.activityBusy,false);
});

test('newly rendered gray dots trigger a read while existing gray dots do not restart it',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');let dot=null,scheduled=0;
  const button={dataset:{id:'chat',host:'local'},querySelector:selector=>selector==='.session-indicator'?dot:{prepend:value=>dot=value}};
  let periodic;const context=vm.createContext({AbortController,setInterval:fn=>periodic=fn,activityBusy:false,activityInFlight:new Set(),state:null,currentId:null,chatKey:(id,host)=>host+'|'+id,t:value=>value,
    $:()=>({querySelectorAll:()=>[button]}),sessionActivity:{indicator:()=>({kind:'unknown',label:'运行状态暂不可用'})},scheduleActivityRefresh:()=>scheduled++,
    el:(tag,cls)=>({classList:{contains:value=>cls.split(' ').includes(value)},setAttribute(){},remove(){dot=null;}})});
  vm.runInContext(source.slice(source.indexOf('function renderActivity('),source.indexOf('async function refreshActivity(')),context);
  vm.runInContext('renderActivity()',context);assert.equal(scheduled,1);
  vm.runInContext('renderActivity()',context);assert.equal(scheduled,1);
  dot=null;context.activityBusy=true;context.activityInFlight.add('local|chat');vm.runInContext('renderActivity()',context);assert.equal(scheduled,1,'An in-flight read already handles the new gray status');
  dot=null;context.activityInFlight.clear();vm.runInContext('renderActivity()',context);assert.equal(scheduled,2,'An unrelated in-flight request cannot suppress a newly visible gray chat');
});

test('a failed HTTP read releases the lock without automatic resubmission',async()=>{
  const ui=fixture();ui.context.api=async(url,body)=>{ui.calls.push({url,body});throw Error('fixture unavailable');};
  ui.activity.update([{...ui.rows[0],connected:true,status:'active'}]);
  await ui.refresh();assert.equal(ui.context.activityBusy,false);assert.equal(ui.timers.size,0);assert.equal(ui.calls.length,1);
  assert.equal(ui.activity.rows['local|visible'].offline,true);
  assert.equal(ui.activity.indicator('local|visible')?.label,'上次确认运行中，正在重新确认');
  ui.at(29000);await ui.periodic();assert.equal(ui.activity.indicator('local|visible')?.stale,true);
  ui.at(30000);await ui.periodic();assert.equal(ui.activity.indicator('local|visible')?.kind,'unknown');
  assert.equal(ui.timers.size,0,'Grace and expiry cannot schedule rapid retries');
});

test('分区只读检查屏幕内已展开项目的隐藏聊天，排除折叠、屏外项目和其他视图',async()=>{
  const ui=fixture(),groups=[],pages=new Map(),mode={value:'codex'};
  ui.context.$=id=>id==='sessions'?ui.root:id==='list-mode'?mode:{hidden:false};
  ui.root.querySelectorAll=selector=>selector==='.session'?ui.nodes:groups;
  ui.context.projectRows=key=>ui.rows.filter(row=>row.projectKey===key);
  ui.context.projectPage=key=>{if(!pages.has(key))pages.set(key,{});return pages.get(key);};
  const group=(key,{open=true,top=0,collapsed=false}={})=>({dataset:{projectKey:key},open,closest:()=>collapsed?{}:null,getClientRects:()=>[{}],getBoundingClientRect:()=>({top,bottom:top+50,left:0,right:240})});
  groups.push(group('visible'),group('closed',{open:false}),group('outside',{top:400}),group('parent-closed',{collapsed:true}));
  ui.rows.push(...['visible','closed','outside','parent-closed'].map(projectKey=>({id:'hidden-'+projectKey,host:'local',projectKey})));
  await ui.refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.map(call=>call.body))),[{hosts:{local:['visible']}},{hosts:{local:['hidden-visible']},background:true}]);
  mode.value='project';await ui.refresh();assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[2].body)),{hosts:{local:['visible']}});
  mode.value='codex';groups[0].open=false;await ui.refresh();assert.deepEqual(JSON.parse(JSON.stringify(ui.calls[3].body)),{hosts:{local:['visible']}});
});

test('隐藏扫描只占一个名额，可见结果和滚动后的新聊天不等待扫描',async()=>{
  const ui=fixture(),page={};let release;
  ui.rows.push(...Array.from({length:100},(_,i)=>({id:'hidden-'+i,host:'local'})));
  const group={dataset:{projectKey:'p'},open:true,closest:()=>null,getClientRects:()=>[{}],getBoundingClientRect:()=>({top:10,bottom:60,left:0,right:240})};
  ui.context.$=id=>id==='sessions'?ui.root:id==='list-mode'?{value:'codex'}:{hidden:false};
  ui.root.querySelectorAll=selector=>selector==='.session'?ui.nodes:[group];
  ui.context.projectRows=()=>ui.rows;ui.context.projectPage=()=>page;
  ui.context.api=async(url,body)=>{
    ui.calls.push({url,body});if(body.background)await new Promise(resolve=>release=resolve);
    return {sessions:Object.entries(body.hosts).flatMap(([host,ids])=>ids.map(id=>({id,host,connected:true,status:'active'})))};
  };
  const reading=ui.refresh();await new Promise(resolve=>setImmediate(resolve));
  try{
    assert.equal(ui.activity.indicator('local|visible')?.kind,'running');
    assert.equal(ui.calls.filter(call=>call.body.background).length,1);
    assert.ok(!ui.calls[1].body.hosts.local.includes('visible'));
    ui.nodes[1].getBoundingClientRect=()=>({top:20,bottom:50,left:0,right:240});
    // A chat already being scanned joins that passive read; use a newly loaded
    // row here to verify an unrelated foreground read retains a free slot.
    ui.rows.push({id:'new-visible',host:'local'});ui.nodes[1].dataset=ui.rows.at(-1);
    await ui.refresh();
    assert.equal(ui.activity.indicator('local|new-visible')?.kind,'running');
    assert.equal(ui.calls.filter(call=>call.body.background).length,1);
    assert.ok(ui.context.activityRequests.size<=4);
  }finally{release();await reading;}
});

test('超过六十四个可见聊天分成独立有界批次，不遗漏尾部',async()=>{
  const ui=fixture();ui.nodes.length=0;ui.rows.length=0;
  for(let i=0;i<70;i++){
    const row={id:'visible-'+i,host:'local'};ui.rows.push(row);
    ui.nodes.push({dataset:row,closest:()=>null,getClientRects:()=>[{}],getBoundingClientRect:()=>({top:10,bottom:20,left:0,right:240})});
  }
  await ui.refresh();
  assert.deepEqual(ui.calls.map(call=>call.body.hosts.local.length),[64,6]);
  assert.equal(new Set(ui.calls.flatMap(call=>call.body.hosts.local)).size,70);
});

test('超过四个主机时，空位只补读未服务的可见聊天，不重复轮询已完成批次',async()=>{
  const ui=fixture();ui.nodes.length=0;ui.rows.length=0;
  for(let i=0;i<5;i++){
    const row={id:'chat',host:'host-'+i};ui.rows.push(row);
    ui.nodes.push({dataset:row,closest:()=>null,getClientRects:()=>[{}],getBoundingClientRect:()=>({top:10,bottom:20,left:0,right:240})});
  }
  await ui.refresh();assert.equal(ui.calls.length,4);
  await ui.next();assert.equal(ui.calls.length,5);
  assert.deepEqual(Object.keys(ui.calls.at(-1).body.hosts),['host-4']);
  assert.equal(ui.timers.size,0,'补完后等待正常轮询，不形成短间隔刷新循环');
});

test('分区隐藏聊天分批轮换并为多个可见项目保留份额，在途聊天不重复查询',async()=>{
  const ui=fixture(),pages=new Map(),groups=['a','b'].map(projectKey=>({dataset:{projectKey},open:true,closest:()=>null,getClientRects:()=>[{}],getBoundingClientRect:()=>({top:10,bottom:40,left:0,right:240})}));
  ui.nodes.length=0;
  ui.context.$=id=>id==='sessions'?ui.root:id==='list-mode'?{value:'codex'}:{hidden:false};
  ui.root.querySelectorAll=selector=>selector==='.session'?[]:groups;
  ui.rows.push(...['a','b'].flatMap(projectKey=>Array.from({length:100},(_,i)=>({id:projectKey+i,host:'local',projectKey}))));
  ui.context.projectRows=key=>ui.rows.filter(row=>row.projectKey===key);
  ui.context.projectPage=key=>{if(!pages.has(key))pages.set(key,{});return pages.get(key);};
  ui.context.activityInFlight.add('local|a0');
  for(let i=0;i<4;i++)await ui.refresh();
  const all=new Set(ui.calls.flatMap(call=>call.body.hosts.local));
  assert.equal(all.size,199,'除正在查询的聊天外，两项目的全部候选都得到检查');
  assert.ok(!all.has('a0'));
  for(const call of ui.calls){assert.equal(call.body.hosts.local.length,64);for(const prefix of ['a','b'])assert.equal(call.body.hosts.local.filter(id=>id.startsWith(prefix)).length,32);}
});

test('分区状态更新通过列表重绘同步可见聊天，绘制圆点时不递归重绘',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');let renders=0;
  const context=vm.createContext({$:id=>id==='list-mode'?{value:'codex'}:{querySelectorAll:()=>[]},renderList:()=>renders++,state:null,currentId:null});
  vm.runInContext(source.slice(source.indexOf('function renderActivity('),source.indexOf('async function refreshActivity(')),context);
  context.renderActivity();assert.equal(renders,1);
  context.renderActivity(false);assert.equal(renders,1);
});
