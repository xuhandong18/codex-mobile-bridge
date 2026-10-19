'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

function fixture(){
  const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
  const calls=[],nodes=[],timers=new Map(),root={clientWidth:240,clientHeight:300,getBoundingClientRect:()=>({top:0,left:0,right:240,bottom:300}),querySelectorAll:()=>nodes};
  const rows=[{id:'visible',host:'local'},{id:'below',host:'local'},{id:'collapsed',host:'ssh'},{id:'not-rendered',host:'ssh'}];
  const node=(row,top,rendered=true)=>({dataset:row,closest:()=>null,getClientRects:()=>rendered?[{}]:[],getBoundingClientRect:()=>({top,bottom:top+30,left:0,right:240})});
  nodes.push(node(rows[0],10),node(rows[1],400),node(rows[2],60,false));
  const context=vm.createContext({activityBusy:false,listRows:rows,document:{hidden:false},window:{innerWidth:1000,innerHeight:800},
    clientNavigation:{provider:'codex'},$:id=>id==='sessions'?root:{hidden:false},sessionActivity:{update(){}},visibleChat:()=>null,
    setTimeout:fn=>{const id={};timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    chatKey:(id,host)=>host+'|'+id,renderActivity(){},bumpRecency(){},api:async(url,body)=>{calls.push({url,body});return {sessions:[]};}});
  vm.runInContext(source.slice(source.indexOf('async function refreshActivity(){'),source.indexOf('setInterval(refreshActivity')),context);
  return {context,calls,nodes,root,rows,timers,refresh:()=>vm.runInContext('refreshActivity()',context),schedule:()=>vm.runInContext('scheduleActivityRefresh()',context)};
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
