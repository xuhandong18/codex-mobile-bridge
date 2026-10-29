'use strict';
// 在隔离 VM 中运行实际排序、缓存和读取入口，不启动浏览器或网关。
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {SessionActivity}=require('../web/features/chat/activity.js');
const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
const BASE=1800000000000;
const copy=value=>JSON.parse(JSON.stringify(value));
const row=(id,recency,host='local')=>({id,host,title:id,projectKey:host+'|project',projectName:'项目',recency});
const activityRow=(id,recency,extra={})=>({id,host:'local',connected:true,status:'active',parentStatus:'active',turnId:id+'-turn',turnStatus:'inProgress',recency,...extra});

function section(start,end){
  const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
  assert.ok(first>=0&&last>first,'测试入口仍存在：'+start);
  return source.slice(first,last);
}

function fixture(){
  const saved=new Map(),calls=[];
  const storage={
    get length(){return saved.size;},key:index=>[...saved.keys()][index]??null,
    getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,String(value)),removeItem:key=>saved.delete(key),
  };
  const activity=new SessionActivity({storage:{getItem:()=>null,setItem(){}}});
  let now=BASE+12000,activityRows=[],serverRows=[];
  const nodes={
    search:{value:''},archived:{checked:false},app:{hidden:false,classList:{contains:()=>false}},
    sessions:{clientWidth:240,clientHeight:300,scrollTop:0,
      getBoundingClientRect:()=>({top:0,left:0,right:240,bottom:300}),
      querySelectorAll:()=>context.listRows.map(value=>({dataset:{id:value.id,host:value.host},
        closest:()=>null,getClientRects:()=>[{}],getBoundingClientRect:()=>({top:10,bottom:40,left:0,right:240})})),
    },
  };
  const context=vm.createContext({
    Date:class extends Date{static now(){return now;}},AbortController,
    setTimeout:()=>1,clearTimeout(){},setInterval(){},document:{hidden:false},window:{innerWidth:1000,innerHeight:800},
    $:id=>nodes[id],t:value=>value,chatKey:(id,host)=>host+'|'+id,
    listRows:[],listIdentity:'a'.repeat(64),listFilterKey:'',listQuery:'',listSource:'all',listArchived:false,
    listOffset:0,listHasMore:false,listGeneration:0,listLoading:0,listComplete:false,listReadFinished:false,
    listHostIds:[],availableSources:[],sidebarData:{sections:[],projects:[]},projectChatPages:new Map(),
    currentId:null,currentHost:'local',state:null,activityBusy:false,activityRequests:new Set(),activityInFlight:new Set(),
    sessionStorage:storage,sessionActivity:activity,clientNavigation:{provider:'codex',acknowledgeList(){}},
    listSync:{acknowledgeSuccess(){}},projectPins:{entries:()=>[]},sidebarPreferences:{receive:async()=>{}},
    isProjectPinned:()=>false,isPlaceholderChatTitle:()=>false,mergeCreatedChats:rows=>rows,
    renderList(){},renderSourceFilter:()=>true,renderHostErrors(){},renderActivity(){},visibleChat:()=>null,
    api:async(url,body)=>{
      calls.push({url,body});
      if(url==='/api/activity')return {sessions:copy(activityRows)};
      assert.ok(url.startsWith('/api/sessions?'),'仅允许合成只读接口：'+url);
      const host=new URL(url,'https://fixture.invalid').searchParams.get('host');
      return {sessions:copy(serverRows.filter(value=>value.host===host)),complete:true,
        remoteHosts:host==='local'?[...new Set(serverRows.map(value=>value.host))].filter(value=>value!=='local'):[],
        availableSources:['desktop'],unavailableHosts:[]};
    },
  });
  for(const code of [
    section('const recentInteractions=','let activityBusy='),
    section('function listAuthIdentity(',"$('list-mode').value="),
    section('async function loadList(','function loadMoreSessions('),
    section('async function refreshActivity(',"window.addEventListener('focus'"),
  ])vm.runInContext(code,context,{filename:'web/shell/app.js'});
  return {
    context,saved,activity,calls,nodes,run:code=>vm.runInContext(code,context),
    at:value=>{now=value;},rows:values=>{context.listRows=copy(values);},
    recency:(id,host='local')=>context.listRows.find(value=>value.id===id&&value.host===host)?.recency,
    async poll(values){activityRows=copy(values);await context.refreshActivity();},
    async load(values){
      serverRows=copy(values);
      // 列表刷新末尾的活动轮询没有可见条目，保持两个读取入口的测试各自独立。
      nodes.sessions.clientHeight=0;
      try{return await context.loadList(true);}finally{nodes.sessions.clientHeight=300;}
    },
  };
}

test('同一登录身份也不能恢复含旧工具时间的 codex-list-v1 缓存',()=>{
  const ui=fixture(),filter=JSON.stringify(['',false,'all']);
  ui.saved.set('codex-list-v1:'+'a'.repeat(64)+':'+filter,JSON.stringify({
    rows:[row('旧工具时间',BASE+9000)],sources:['desktop'],hosts:[],offset:1,hasMore:false,
  }));
  assert.equal(ui.run('restoreListSnapshot()'),false,'旧排序语义的缓存必须失效');
  assert.equal(ui.saved.size,0,'旧快照应实际清理');
  assert.equal(ui.context.listRows.length,0);
});

test('当前版本的列表缓存仍可往返保存和恢复',()=>{
  const ui=fixture();ui.rows([row('已校准',BASE+1000)]);
  ui.run('saveListSnapshot(currentListFilter())');ui.rows([]);
  assert.equal(ui.run('restoreListSnapshot()'),true);
  assert.equal(ui.recency('已校准'),BASE+1000);
});

for(const corrected of [BASE+1000,0])test('活动响应可把旧排序时间下调到权威值 '+corrected,async()=>{
  const ui=fixture();ui.rows([row('旧聊天',BASE+1000),row('其他聊天',BASE+5000)]);
  await ui.poll([activityRow('旧聊天',BASE+9000)]);
  assert.equal(ui.recency('旧聊天'),BASE+9000);
  await ui.poll([activityRow('旧聊天',corrected)]);
  assert.equal(ui.recency('旧聊天'),corrected,'服务端纠正后的时间必须替换旧工具时间');
  assert.equal(ui.context.listRows[0].id,'其他聊天','下调时间后也必须重新排序');
  assert.equal(ui.calls.length,2);
});

test('列表刷新不能用 recentInteractions 的旧工具时间盖过服务端校正',async()=>{
  const ui=fixture();ui.rows([row('旧聊天',BASE+1000),row('其他聊天',BASE+5000)]);
  await ui.poll([activityRow('旧聊天',BASE+9000)]);
  assert.equal(await ui.load([row('旧聊天',BASE+1000),row('其他聊天',BASE+5000)]),true);
  assert.equal(ui.recency('旧聊天'),BASE+1000);
  assert.equal(ui.context.listRows[0].id,'其他聊天');
  assert.equal(ui.context.listComplete,true);
});

test('校正到相同时间时沿用服务端标识顺序，刷新不会跳回',async()=>{
  const ui=fixture();ui.rows([row('a',BASE+9000),row('z',BASE+5000)]);
  await ui.poll([activityRow('a',BASE+5000)]);
  assert.equal(ui.context.listRows[0].id,'z');
  await ui.load([row('z',BASE+5000),row('a',BASE+5000)]);
  assert.equal(ui.context.listRows[0].id,'z');
});

for(const origin of ['活动轮询','列表刷新'])test(origin+'校正旧值时保留本机已确认用户操作的覆盖',async()=>{
  const ui=fixture();ui.rows([row('本机聊天',BASE+1000)]);
  // 旧工具时间可能比随后确认的用户操作还大，不能继续将二者混存取 max。
  await ui.poll([activityRow('本机聊天',BASE+30000)]);
  ui.at(BASE+12000);ui.run("bumpRecency('本机聊天','local')");
  if(origin==='活动轮询')await ui.poll([activityRow('本机聊天',BASE+1000)]);
  else await ui.load([row('本机聊天',BASE+1000)]);
  assert.equal(ui.recency('本机聊天'),BASE+12000,'只保留真实已确认操作，丢弃旧工具时间');
  if(origin==='活动轮询')await ui.poll([activityRow('本机聊天',BASE+16000)]);
  else await ui.load([row('本机聊天',BASE+16000)]);
  assert.equal(ui.recency('本机聊天'),BASE+16000,'之后的新发言仍可推动排序');
});

test('本机确认操作的覆盖按主机和聊天隔离',async()=>{
  const ui=fixture();ui.rows([row('相同标识',BASE+1000),row('相同标识',BASE+1000,'ssh-fixture')]);
  ui.at(BASE+12000);ui.run("bumpRecency('相同标识','local')");
  await ui.load([row('相同标识',BASE+1000),row('相同标识',BASE+2000,'ssh-fixture')]);
  assert.equal(ui.recency('相同标识'),BASE+12000);
  assert.equal(ui.recency('相同标识','ssh-fixture'),BASE+2000);
});

test('响应未提供排序值时不凭读取时间生成新交互',async()=>{
  const ui=fixture();ui.rows([row('聊天',BASE+1000)]);ui.at(BASE+50000);
  const value=activityRow('聊天',BASE+1000);delete value.recency;
  await ui.poll([value]);
  assert.equal(ui.recency('聊天'),BASE+1000);
});

test('排序时间不变时主侧聊天的绿点和蓝点仍按原规则变化',async()=>{
  const ui=fixture();ui.rows([row('父聊天',BASE+1000)]);
  const side={id:'侧边聊天',connected:true,status:'active',turnId:'side-turn',turnStatus:'inProgress'};
  const active=activityRow('父聊天',BASE+1000,{sideChats:[side]});
  await ui.poll([active]);
  assert.equal(ui.activity.indicator('local|父聊天')?.kind,'running');
  const completed={...active,status:'active',parentStatus:'idle',turnStatus:'completed'};
  ui.at(BASE+50000);await ui.poll([completed]);
  assert.equal(ui.activity.indicator('local|父聊天')?.kind,'completed','主聊天完成时蓝点优先于侧边绿点');
  ui.activity.read('local|父聊天',{sync:false});
  assert.equal(ui.activity.indicator('local|父聊天')?.kind,'running');
  const doneSide={...side,status:'idle',turnStatus:'completed'};
  await ui.poll([{...completed,status:'idle',sideChats:[doneSide]}]);
  assert.equal(ui.activity.indicator('local|父聊天')?.kind,'completed');
  ui.activity.updateSideChat({id:'父聊天',host:'local'},doneSide,true);
  assert.equal(ui.activity.indicator('local|父聊天'),null);
  assert.equal(ui.recency('父聊天'),BASE+1000,'运行与完成提示的变化不能冒充新发言');
});
