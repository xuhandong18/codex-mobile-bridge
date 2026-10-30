'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {SessionActivity}=require('../web/features/chat/activity.js');
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
const status=(id,host,state,turn='one',result=state==='active'?'inProgress':'completed')=>({id,host,connected:true,status:state,turnId:turn,turnStatus:result});

test('reading a completed chat propagates its host and observed turn to the desktop',()=>{
 const reads=[],activity=new SessionActivity({storage:storage(),onRead:(key,row)=>reads.push([key,row.turnId,row.turnStatus])});
 activity.update([status('a','local','active')]);
 activity.update([status('a','local','idle')]);
 activity.read('local|a',{explicit:true});
 assert.equal(activity.indicator('local|a'),null);
 assert.deepEqual(reads,[['local|a','one','completed']]);
});

test('visible completion syncs once per turn; background, unknown and manual unread never sync',()=>{
 const reads=[],activity=new SessionActivity({storage:storage(),onRead:(key,row)=>{reads.push([key,row.turnId]);throw Error('lost acknowledgement');}});
 activity.update([status('a','deepseek','active')],'deepseek|a');assert.equal(reads.length,0);
 activity.update([status('a','deepseek','idle')]);assert.equal(reads.length,0);
 activity.update([status('a','deepseek','idle')],'deepseek|a',{sync:false});assert.equal(reads.length,0);
 activity.update([status('a','deepseek','idle')],'deepseek|a');
 activity.read('deepseek|a');activity.update([status('a','deepseek','idle')],'deepseek|a');
 assert.deepEqual(reads,[['deepseek|a','one']]);
 activity.update([status('a','deepseek','idle','two')],'deepseek|a');assert.equal(reads.length,2);
 activity.markUnread('deepseek|a');activity.update([status('a','deepseek','idle','three')],'deepseek|a');assert.equal(reads.length,2);
 activity.update([{...status('a','deepseek','idle','three'),connected:false}],'deepseek|a');activity.read('deepseek|a',{explicit:true});assert.equal(reads.length,2);
 activity.update([status('a','deepseek','idle','three')],'deepseek|a');assert.equal(reads.length,3);
});

test('manual unread persists through polling and passive reads until explicitly opened',()=>{
 const saved=storage(),activity=new SessionActivity({storage:saved});
 activity.markUnread('local|a');
 assert.equal(activity.indicator('local|a').label,'未读');
 activity.update([status('a','local','idle')],'local|a');activity.read('local|a');
 assert.equal(activity.indicator('local|a').label,'未读');
 activity.update([{id:'a',host:'local',connected:false,status:'unknown'}],'local|a');
 const restored=new SessionActivity({storage:saved});
 assert.equal(restored.indicator('local|a').label,'未读');
 assert.equal(restored.indicator('remote|a'),null);
 restored.read('local|a',{explicit:true});
 assert.equal(restored.rows['local|a'].manualUnread,false);
 restored.update([status('a','local','idle')],'local|a');
 assert.equal(restored.indicator('local|a'),null);
});

test('sidebar context menu marks the selected host-qualified chat unread without opening it',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
 const start=source.indexOf("new ChatContextMenu($('sessions'),target=>{");
 const end=source.indexOf("},{label:'侧栏操作'});",start);
 let menu,marked,renders=0;
 const row={id:'a',host:'ssh',access:{}},button={dataset:{id:'a',host:'ssh'},closest:()=>null};
 const ctx=vm.createContext({sidebarManagement:null,ChatContextMenu:class{constructor(root,items){menu=items;}},$:()=>({}),listRows:[row],
  window:{BridgeClipboard:{}},chatKey:(id,host)=>host+'|'+id,sessionActivity:{markUnread:key=>marked=key},renderActivity:()=>renders++,
  sidebarPlacementActions:()=>[],sidebarEntry:()=>({}),sessionAccess:()=>({source:'cli'})});
 vm.runInContext(source.slice(start,end)+"},{label:'侧栏操作'});",ctx);
 const items=menu({closest:selector=>selector==='.session'?button:null});
 items.find(item=>item.label==='标记为未读').run();
 assert.equal(marked,'ssh|a');assert.equal(renders,1);
});

test('concurrent host-qualified runs become unread completion badges and persist until viewed',()=>{
 const saved=storage(),a=new SessionActivity({storage:saved});
 a.update([status('a','local','active'),status('a','remote','active')]);
 assert.equal(a.indicator('local|a').kind,'running');
 a.update([status('a','local','idle'),status('a','remote','active')]);
 assert.equal(a.indicator('local|a').kind,'completed');assert.equal(a.indicator('remote|a').kind,'running');
 const restored=new SessionActivity({storage:saved});assert.equal(restored.indicator('local|a').kind,'completed');
 restored.read('local|a');restored.update([status('a','local','idle')]);assert.equal(restored.indicator('local|a'),null);
 restored.update([status('a','local','idle','two')]);assert.equal(restored.indicator('local|a').kind,'completed');
});
test('initial history does not flood unread; brief offline retains the last run and stopped/failed are not successes',()=>{
 const a=new SessionActivity({storage:storage()});
 a.update([status('a','local','idle')]);assert.equal(a.indicator('local|a'),null);
 a.update([status('a','local','active','two')]);a.update([{id:'a',host:'local',connected:false,status:'unknown'}]);assert.equal(a.indicator('local|a').stale,true);
 a.update([status('a','local','idle','two','failed')]);assert.equal(a.indicator('local|a').kind,'ended');
 a.update([status('a','local','idle','three','interrupted')],'local|a');assert.equal(a.indicator('local|a'),null);
});
test('temporarily missing turn history does not resurrect a read completion',()=>{
 const a=new SessionActivity({storage:storage()});a.update([status('a','local','idle')]);
 a.update([{id:'a',host:'local',connected:true,status:'idle',turnId:null,turnStatus:null}]);
 a.update([status('a','local','idle')]);assert.equal(a.indicator('local|a'),null);
});

test('verified unloaded desktop metadata clears unknown without claiming a running or writable chat',()=>{
 const activity=new SessionActivity({storage:storage()});
 activity.update([{id:'cold',host:'local',connected:false,activityConnected:false,status:'unknown'}]);
 assert.equal(activity.indicator('local|cold').kind,'unknown');
 activity.update([{id:'cold',host:'local',connected:false,activityConnected:true,status:'notLoaded',turnId:'last',turnStatus:'completed'}]);
 assert.equal(activity.indicator('local|cold'),null);
 assert.equal(activity.rows['local|cold'].offline,false);
 assert.equal(activity.rows['local|cold'].status,'notLoaded');
});

test('a parent completion stays running while descendants work and finishes only after the subtree settles',()=>{
 const a=new SessionActivity({storage:storage()});
 const row={...status('a','local','idle'),parentStatus:'idle',status:'active',runningSubagents:2,subagentsKnown:true,activityConnected:true};
 a.update([row]);assert.deepEqual(a.indicator('local|a'),{kind:'running',label:'子代理运行中'});
 a.read('local|a');a.update([{...row,runningSubagents:1}]);assert.equal(a.indicator('local|a').kind,'running');
 a.update([{...row,status:'unknown',subagentsKnown:false,runningSubagents:0}]);assert.equal(a.indicator('local|a').label,'上次确认子代理运行中，正在重新确认');
 a.update([{...row,status:'idle',runningSubagents:0}]);assert.equal(a.indicator('local|a').kind,'completed');
 a.read('local|a');a.update([{...row,status:'idle',runningSubagents:0}]);assert.equal(a.indicator('local|a'),null);
});

test('verified running subagents remain visible when the parent owner is disconnected',()=>{
 const a=new SessionActivity({storage:storage()});
 a.update([{...status('a','local','active'),connected:false,activityConnected:true,runningSubagents:1}]);
 assert.equal(a.indicator('local|a').kind,'running');
 a.update([{...status('a','local','idle'),status:'unknown',subagentsKnown:false}]);
 assert.equal(a.indicator('local|a').stale,true);
});
function fixture(){
 let count=0,thumbCalls=[],upload=async(key,id,file)=>({id,name:file.name,size:file.size,image:null});
 const calls=[],saved=storage(),events=new Map();
 const node=tag=>({tag,children:[],dataset:{},append(...values){this.children.push(...values);},replaceChildren(){this.children=[];},setAttribute(){},addEventListener(type,handler){(events.get(type)||events.set(type,new Set()).get(type)).add(handler);}});
 const root=node('div'),button=node('button'),input=node('input'),paste=node('textarea'),drop=node('form');
 const ctx=vm.createContext({document:{createElement:node},sessionStorage:saved,root,button,input,paste,drop,uuid:()=>String(++count),BridgeI18n:{t:v=>v},preview:(key,id)=>key+'/preview/'+id,thumbnail:async(key,id,f)=>{thumbCalls.push([key,id,f.name]);return {id,thumb:'image/webp',thumbWidth:6,thumbHeight:6};},upload:(...args)=>{calls.push(args);return upload(...args);}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/features/chat/attachments.js'),'utf8'),ctx);
 const panel=vm.runInContext('new ChatAttachments({root,button,input,upload,paste,drop,preview,thumbnail})',ctx);panel.open('local|one');
 return {panel,calls,saved,root,button,input,events,thumbCalls,setUpload:f=>upload=f};
}
const tick=()=>new Promise(setImmediate),file=(name,size=12)=>({name,size});
test('multi-select uploads independently and switching chats preserves host-scoped drafts',async()=>{
 const ui=fixture();ui.panel.add([file('a.txt'),file('photo.png')]);await tick();
 assert.equal(ui.calls.length,2);assert.equal(ui.panel.ready(),true);assert.equal(ui.panel.ids().length,2);
 ui.panel.open('remote|one');assert.equal(ui.panel.ids().length,0);ui.panel.add([file('remote.txt')]);await tick();
 ui.panel.open('local|one');assert.equal(ui.panel.rows[0].name,'a.txt');assert.equal(ui.panel.rows[1].name,'photo.png');
 assert.equal(ui.calls[2][0],'remote|one');
});
test('failed uploads block send and retry keeps the same attachment id',async()=>{
 const ui=fixture();ui.setUpload(()=>{throw Error('offline');});ui.panel.add([file('a.txt')]);await tick();
 assert.equal(ui.panel.ready(),false);assert.equal(ui.panel.rows[0].status,'failed');
 ui.setUpload(async(key,id,file)=>({id,name:file.name,size:file.size}));
 const card=ui.root.children[0];card.children.find(n=>n.tag==='button'&&n.textContent==='重试').onclick();await tick();
 assert.equal(ui.calls[0][1],ui.calls[1][1]);assert.equal(ui.panel.ready(),true);
});
test('removing a pending upload or logging out prevents delayed results restoring the draft',async()=>{
 const ui=fixture();let finish;ui.setUpload(()=>new Promise(r=>finish=r));ui.panel.add([file('a.txt')]);
 const id=ui.panel.ids()[0];ui.root.children[0].children.at(-1).onclick();finish({id,name:'a.txt',size:12});await tick();assert.equal(ui.panel.rows.length,0);
 ui.panel.add([file('b.txt')]);ui.panel.reset();finish({id:'2',name:'b.txt',size:12});await tick();assert.equal(ui.panel.rows.length,0);
 assert.equal(ui.saved.getItem('attachments:local|one'),'[]');
});
test('limits reject the selection before upload, and send lock prevents changing attachments',async()=>{
 const ui=fixture();ui.panel.add([file('large',21*1024*1024)]);assert.equal(ui.calls.length,0);
 ui.panel.add(Array.from({length:11},(_,i)=>file(String(i))));assert.equal(ui.calls.length,0);
 ui.panel.add([file('ok')]);await tick();ui.panel.setLocked(true);ui.panel.add([file('other')]);assert.equal(ui.calls.length,1);assert.equal(ui.button.disabled,true);
 ui.panel.clear('local|one',ui.panel.ids());assert.equal(ui.panel.rows.length,0);
});

test('pasted and dropped images upload, preview through authenticated endpoint, and are removable',async()=>{
 const ui=fixture();
 ui.setUpload(async(key,id,f)=>({id,name:f.name,size:f.size,image:'image/png'}));
 const paste={clipboardData:{files:[file('pasted.png')]},preventDefault(){this.prevented=true}};
 ui.events.get('paste').forEach(handler=>handler(paste));
 await tick();
 assert.equal(paste.prevented,true);assert.equal(ui.calls.length,1);assert.equal(ui.thumbCalls.length,1);
 let card=ui.root.children[0];assert.equal(card.children.find(n=>n.tag==='img').src,'local|one/preview/'+ui.panel.ids()[0]);
 const drop={dataTransfer:{files:[file('dropped.png')]},preventDefault(){this.prevented=true}};
 ui.events.get('drop').forEach(handler=>handler(drop));await tick();
 assert.equal(drop.prevented,true);assert.equal(ui.calls.length,2);assert.equal(ui.panel.ids().length,2);
 const remove=ui.root.children[0].children.at(-1);remove.onclick();
 assert.equal(ui.panel.ids().length,1);assert.equal(ui.root.children[0].children.some(n=>n.tag==='img'),true);
});

test('asynchronous historical baseline is not a new completion, observed running still is',()=>{
 const a=new SessionActivity({storage:storage()});
 a.update([{id:'a',host:'claude',connected:true,status:'idle'}]);
 a.update([status('a','claude','idle','old')]);assert.equal(a.indicator('claude|a'),null);
 a.update([status('a','claude','active','old')]);a.update([status('a','claude','idle','new')]);assert.equal(a.indicator('claude|a').kind,'completed');
 a.update([{id:'a',host:'claude',connected:false,status:'idle'}]);assert.equal(a.indicator('claude|a').kind,'completed','已确认的未读完成不会因断线消失');
});
