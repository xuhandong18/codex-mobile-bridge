'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/shell/app.js','utf8'),adapter=app.slice(app.indexOf('async function loadComposerReferences('),app.indexOf('\nconst composerReferences='));
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(handler){
  const calls=[],saved=new Map(),ctx=vm.createContext({BridgeI18n:{t:text=>text},t:text=>text,
    chatKey:(id,host)=>host+'|'+id,sessionUrl:(id,action,host)=>'/api/sessions/'+id+'/'+action+'?host='+encodeURIComponent(host),
    api:async(url,body,signal)=>{calls.push({url,body,signal});assert.equal(body,undefined,'Reference sources must only issue reads');return handler(url);}});
  vm.runInContext(fs.readFileSync('web/features/chat/reference-picker.js','utf8'),ctx);
  vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8')+'\nthis.sidebarPlacements=new SidebarPlacements(storage);',Object.assign(ctx,{storage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)}}));
  vm.runInContext(adapter,ctx);return {ctx,calls};
}

test('file references query the chosen remote host and request recursive search only when needed',async()=>{
  const ui=fixture(()=>({root:'/srv/project',entries:[{name:'needle.js',path:'src/needle.js',kind:'file'}],nextOffset:null,truncated:true}));
  const target={id:'remote-chat',host:'ssh:chosen'},signal=new AbortController().signal;
  const result=await ui.ctx.loadComposerReferences('files',{target,query:'needle',offset:200,path:'',hidden:true,signal});
  const url=new URL(ui.calls[0].url,'http://fixture');
  assert.equal(url.searchParams.get('host'),'ssh:chosen');assert.equal(url.searchParams.get('recursive'),'true');
  assert.equal(url.searchParams.get('hidden'),'true');assert.equal(url.searchParams.get('offset'),'200');assert.equal(ui.calls[0].signal,signal);
  assert.equal(result.items[0].value,'/srv/project/src/needle.js');assert.match(result.notice,/搜索结果/);
  await ui.ctx.loadComposerReferences('files',{target,query:'',offset:0,path:'src',hidden:false});
  assert.equal(new URL(ui.calls[1].url,'http://fixture').searchParams.get('recursive'),'false');
});

test('session references preserve project sections, direct chats, pins, independent chats and local overrides',async()=>{
  const metadata={sections:[{id:'work',name:'Work',itemKeys:['codex:project:p'],hostSectionIds:{local:'native'}},{id:'other',name:'Other'}],
    projects:[{key:'local|p',host:'local',name:'Project'},{key:'ssh|q',host:'ssh',name:'Remote'}],sectionOrder:['pinned','custom:work','projects','threads']};
  const rows=[{id:'one',host:'local',title:'One',projectKey:'local|p'},
    {id:'direct',host:'local',title:'Direct',projectKey:'local|p',thread_section_id:'native'},
    {id:'pin',host:'local',title:'Pin',projectKey:'local|p',is_pinned:true},
    {id:'loose',host:'local',title:'Loose',projectKey:'local|independent'},
    {id:'remote',host:'ssh',hostLabel:'Remote host',title:'Remote',projectKey:'ssh|q'}];
  const ui=fixture(url=>url.startsWith('/api/projects')?metadata:{sessions:rows});
  const options={target:{id:'current',host:'local'},query:'',offset:0};
  let result=await ui.ctx.loadComposerReferences('sessions',options);
  const groups=id=>plain(result.items.find(item=>item.id.endsWith('|'+id)).groups.map(group=>group.id));
  assert.deepEqual(groups('one'),['section:work','project:local|p']);assert.deepEqual(groups('direct'),['section:work']);
  assert.deepEqual(groups('pin'),['pinned']);assert.deepEqual(groups('loose'),['threads']);assert.deepEqual(groups('remote'),['projects','project:ssh|q']);
  assert.equal(result.items.find(item=>item.id==='ssh|remote').value,'codex://threads/remote');
  ui.ctx.sidebarPlacements.set({kind:'thread',id:'one',host:'local'},'section:other',['work','other']);
  result=await ui.ctx.loadComposerReferences('sessions',{...options,query:'One'});assert.deepEqual(groups('one'),['section:other']);
  assert.equal(ui.calls.filter(call=>call.url.startsWith('/api/projects')).length,1,'Metadata can be reused for the same picker target');
});

test('skills insert only the name while catalog errors and partial caches stay visible',async()=>{
  const ui=fixture(()=>({skills:[{id:'skill',name:'code-review',displayName:'Review',path:'/skills/code-review/SKILL.md'}],total:300,errors:['Unavailable source'],cache:{state:'stale'}}));
  const result=await ui.ctx.loadComposerReferences('skills',{target:{id:'one',host:'remote'},query:'review',offset:0,refresh:true});
  assert.equal(result.items[0].value,'$code-review');assert.equal(result.nextOffset,1);assert.equal(result.error,'Unavailable source');assert.ok(result.notice);
  const url=new URL(ui.calls[0].url,'http://fixture');assert.equal(url.searchParams.get('host'),'remote');assert.equal(url.searchParams.get('refresh'),'true');
});
