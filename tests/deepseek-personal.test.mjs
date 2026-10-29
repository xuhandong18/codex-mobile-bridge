import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {apply} from '../bridge/clients/deepseek/host.mjs';

async function fixture(t){
  await mkdir('.tmp',{recursive:true});const folder=await mkdtemp(resolve('.tmp','dsh-personal-')),endpoint=join(folder,'endpoint.json'),configPath=join(folder,'connection.json');
  await writeFile(configPath,JSON.stringify({token:'isolated-fixture-token',endpoint}));
  const rows=[],events=new Map(),calls=[],disposers=[],handlers=new Map(),workspaces=[];
  const add=(id,cwd=folder,parentSessionId)=>{const row={sessionId:id,cwd,parentSessionId,running:false,updatedAt:Date.now(),projections:{values:{title:'新会话',modelSelection:{next:{provider:'fixture',model:'chat',reasoningEffort:'high'}}}}};rows.push(row);events.set(id,[]);return row;};
  const append=(id,type,data)=>{const list=events.get(id);list.push({event:{seq:list.length+1,type,data}});};
  const workspace=(path,title)=>{const w={id:randomUUID(),path,title,sessionIds:[],setTitle:async name=>{calls.push(['project-title',w.id,name]);w.title=name;},insertSessionBefore:async(id,before)=>{assert.ok(w.sessionIds.includes(id));w.sessionIds=w.sessionIds.filter(s=>s!==id);const at=before===undefined?w.sessionIds.length:w.sessionIds.indexOf(before);assert.ok(at>=0);w.sessionIds.splice(at,0,id);}};workspaces.push(w);return w;};
  const ctx={sessionController:{
    list:async()=>({items:rows}),projections:async({sessionId})=>({asOfSeq:events.get(sessionId).length}),
    page:async({address})=>({records:events.get(address.sessionId),hasMore:false}),
    modelCatalog:async()=>({groups:[{id:'fixture',models:[{id:'chat',name:'Fixture',reasoning:{efforts:[{id:'high'},{id:'low'}],defaultEffort:'low'}}]}]}),
    create:async value=>{calls.push(['create',value]);if(rows.some(r=>r.sessionId===value.sessionId))return {sessionId:value.sessionId};const row=add(value.sessionId,value.cwd);workspaces.find(w=>w.path===row.cwd)?.sessionIds.unshift(row.sessionId);return {sessionId:row.sessionId};},
    fork:async value=>{calls.push(['fork',value]);const parent=rows.find(r=>r.sessionId===value.sessionId),child=add('fork-'+randomUUID(),parent.cwd,parent.sessionId);child.projections.values.title=parent.projections.values.title;events.set(child.sessionId,[...events.get(parent.sessionId)]);return {sessionId:child.sessionId};},
    rename:async value=>{calls.push(['rename',value]);rows.find(r=>r.sessionId===value.sessionId).projections.values.title=value.title;handlers.get('session/event')?.({id:value.sessionId},{type:'session/title',data:{title:value.title,source:{kind:'user'}}});},
    prompt:async value=>{calls.push(['prompt',value]);append(value.sessionId,'user/message',{content:value.content});return {accepted:true};},
    cancel:async value=>{calls.push(['cancel',value]);rows.find(r=>r.sessionId===value.sessionId).running=false;},
    selectModel:async value=>{calls.push(['model',value]);rows.find(r=>r.sessionId===value.sessionId).projections.values.modelSelection.next=value;return {selected:value};}
  },workspaceRegistry:{list:()=>workspaces,archivedSessionIds:[],pinnedSessionIds:[],
    create:async(path,title)=>workspace(path,title),delete:async id=>{workspaces.splice(workspaces.findIndex(w=>w.id===id),1);},
    insertBefore:async(id,before)=>{const index=workspaces.findIndex(w=>w.id===id),[w]=workspaces.splice(index,1);workspaces.splice(before===undefined?workspaces.length:workspaces.findIndex(w=>w.id===before),0,w);},
    pinSession:async id=>ctx.workspaceRegistry.pinnedSessionIds.push(id),unpinSession:async id=>{ctx.workspaceRegistry.pinnedSessionIds=ctx.workspaceRegistry.pinnedSessionIds.filter(s=>s!==id);},
    archiveSession:async(id,options)=>{calls.push(['archive',id,options]);ctx.workspaceRegistry.archivedSessionIds.push(id);},unarchiveSession:async id=>{ctx.workspaceRegistry.archivedSessionIds=ctx.workspaceRegistry.archivedSessionIds.filter(s=>s!==id);}
  },sessionSkillCatalog:{list:async()=>({skills:Array.from({length:221},(_,i)=>({name:'skill-'+i,description:'fixture'}))})},
    permissionPresets:{catalog:()=>({defaultPreset:'ask',options:[{value:'ask'},{value:'full-access'}]}),set:(session,mode)=>calls.push(['permission',session,mode])},
    agents:{list:()=>[],get:id=>({session:{id}})},on:(name,fn)=>handlers.set(name,fn),effect:setup=>disposers.push(setup()),get:()=>undefined};
  let port;
  const start=async()=>{await apply(ctx,{configPath});port=JSON.parse(await readFile(endpoint,'utf8')).port;};await start();
  const request=async(action,sid,body={})=>{const res=await fetch(`http://127.0.0.1:${port}/mobile`,{method:'POST',headers:{Authorization:'Bearer isolated-fixture-token'},body:JSON.stringify({action,sid,body})});const value=await res.json();return {code:res.status,...value};};
  t.after(async()=>{for(const dispose of disposers.reverse())await dispose();await rm(folder,{recursive:true,force:true});});
  return {ctx,folder,add,append,rows,events,calls,handlers,workspace,request,restart:async()=>{await disposers.pop()();await start();}};
}

test('unopened parent lists summarize waiting native agents and side forks without transcripts',async t=>{
  const f=await fixture(t),r=f.request;f.add('parent');f.add('agent',f.folder,'parent');
  const child=await r('side-write','parent',{operation:'create',id:randomUUID()});
  const ask=sid=>f.handlers.get('user-questions/request')({agent:{id:sid},questions:[{id:'q',question:'PRIVATE QUESTION',options:[]}],signal:new AbortController().signal},()=>new Promise(()=>{}));
  const native=ask('agent'),side=ask(child.id);
  await new Promise(resolve=>setTimeout(resolve,0));
  const listed=(await r('list')).sessions.find(row=>row.id==='parent');
  assert.equal(listed.waitingForUser,false);assert.equal(listed.waitingSubagents,1);
  assert.equal(listed.sideChats[0].waitingForUser,true);
  assert.ok(!JSON.stringify(listed.sideChats).includes('PRIVATE QUESTION'));
  const nativeRequest=(await r('detail','agent')).session.requests[0];
  const sideRequest=(await r('side-read','parent')).requests[0];
  await r('respond','agent',{requestId:nativeRequest.id,answers:{q:{answers:['yes']}}});await native;
  assert.equal((await r('list')).sessions.find(row=>row.id==='parent').waitingSubagents,0);
  await r('respond',child.id,{requestId:sideRequest.id,answers:{q:{answers:['yes']}}});await side;
  assert.equal((await r('list')).sessions.find(row=>row.id==='parent').sideChats[0].waitingForUser,false);
});

test('explicit AI rename summarizes conversation without prompting or creating a native agent',async t=>{
  const f=await fixture(t),row=f.add('title');row.projections.values.title='用户原先的标题';
  f.append('title','user/message',{content:[{type:'text',text:'首先修复登录'}]});
  f.append('title','assistant/message',{message:{content:[{type:'text',text:'登录已修复'},{type:'thinking',thinking:'PRIVATE REASONING'}]}});
  f.append('title','user/message',{message:{content:[{type:'text',text:'现在增加聊天重命名'}]}});
  f.append('title','tool/result',{content:'PRIVATE TOOL OUTPUT'});
  let release;const paused=new Promise(resolve=>release=resolve),requests=[];
  f.ctx.llm={prepareCall:async options=>({config:options,stream:async function*(request){requests.push(request);await paused;yield {type:'text-delta',text:'完善聊天标题管理'};yield {type:'finish',reason:{kind:'stop'}};}})};
  assert.equal((await f.request('title-status','title')).status,'ready');assert.equal(requests.length,0);
  const id=randomUUID();assert.equal((await f.request('manage','title',{operation:'ai-rename',id})).status,'queued');
  const merged=randomUUID();await f.request('manage','title',{operation:'ai-rename',id});await f.request('manage','title',{operation:'ai-rename',id:merged});
  release();let status;
  for(let n=0;n<100;n++){status=await f.request('title-status','title');if(status.status==='complete')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(status.status,'complete');assert.equal(status.title,'完善聊天标题管理');assert.equal(requests.length,1);
  assert.equal((await f.request('manage','title',{operation:'ai-rename',id:merged})).status,'complete');assert.equal(requests.length,1,'coalesced requests stay deduplicated after completion');
  await f.restart();assert.equal((await f.request('manage','title',{operation:'ai-rename',id:merged})).status,'complete');assert.equal(requests.length,1,'coalesced requests survive host restart');
  const text=JSON.stringify(requests[0].messages);assert.match(text,/首先修复登录/);assert.match(text,/现在增加聊天重命名/);assert.match(text,/登录已修复/);assert.doesNotMatch(text,/PRIVATE TOOL OUTPUT|PRIVATE REASONING/);
  assert.deepEqual(requests[0].tools,[]);assert.equal(requests[0].provider,'fixture');assert.equal(requests[0].model,'chat');
  assert.deepEqual(f.calls.map(call=>call[0]),['rename']);
  assert.equal((await f.request('title-status','title',{requestId:randomUUID()})).status,'unknown','a missing request cannot reuse a previous success');
  const saved=await readFile(join(f.folder,'personal-state.json'),'utf8');assert.doesNotMatch(saved,/现在增加聊天重命名/);
});

test('explicit AI rename preserves a manual same-name choice and never replays an unknown request',async t=>{
  const f=await fixture(t),row=f.add('protected');f.append('protected','user/message',{content:[{type:'text',text:'需要精炼的主题'}]});
  let release,started;const paused=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve);let count=0;
  f.ctx.llm={prepareCall:async options=>{count++;started();return {config:options,stream:async function*(){await paused;yield {type:'text-delta',text:'迟到的标题'};yield {type:'finish',reason:{kind:'stop'}};}};}};
  await f.request('manage','protected',{operation:'ai-rename',id:randomUUID()});await ready;
  await f.request('manage','protected',{operation:'rename',title:row.projections.values.title});release();
  assert.equal((await f.request('title-status','protected')).status,'manual');assert.equal(f.calls.filter(c=>c[0]==='rename').length,1);
  const id=randomUUID();f.ctx.llm.prepareCall=async()=>{count++;throw Error('unknown provider request');};
  await f.request('manage','protected',{operation:'ai-rename',id});
  for(let n=0;n<100;n++){if((await f.request('title-status','protected')).status==='unknown')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal((await f.request('title-status','protected')).status,'unknown');
  await f.request('manage','protected',{operation:'ai-rename',id});await f.restart();await f.request('manage','protected',{operation:'ai-rename',id});
  assert.equal(count,2);assert.equal(f.calls.filter(c=>c[0]==='rename').length,1);
});

test('a failed title ledger save does not poison the shared title queue',async t=>{
  const f=await fixture(t);f.add('save-failure');f.append('save-failure','user/message',{content:[{type:'text',text:'需要摘要的会话'}]});
  let count=0;f.ctx.llm={prepareCall:async options=>({config:options,stream:async function*(){count++;yield {type:'text-delta',text:'生成的主题'+count};yield {type:'finish',reason:{kind:'stop'}};}})};
  const rename=f.ctx.sessionController.rename,blocked=join(f.folder,'personal-state.json.tmp');let failOnce=true;
  f.ctx.sessionController.rename=async request=>{await rename(request);if(failOnce){failOnce=false;await mkdir(blocked);}};
  await f.request('manage','save-failure',{operation:'ai-rename',id:randomUUID()});
  for(let n=0;n<100;n++){if(f.calls.some(call=>call[0]==='rename'))break;await new Promise(resolve=>setTimeout(resolve,10));}
  await new Promise(resolve=>setTimeout(resolve,30));await rm(blocked,{recursive:true});
  assert.equal((await f.request('manage','save-failure',{operation:'ai-rename',id:randomUUID()})).status,'queued');
  for(let n=0;n<100;n++){if((await f.request('title-status','save-failure')).status==='complete')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(count,2);assert.equal((await f.request('title-status','save-failure')).title,'生成的主题2');
});

test('reading completion clears only that native desktop dot and cannot consume a later turn',async t=>{
  const f=await fixture(t),row=f.add('read-me');f.add('other');
  f.append('read-me','turn/start',{turn:1});f.append('read-me','turn/end',{turn:1,reason:{kind:'completed'}});
  const {runInNewContext}=await import('node:vm');let plugin,listener,frame;const subscribers=new Set(),disposers=[];
  runInNewContext(await readFile(new URL('../bridge/clients/deepseek/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load:entry=>{plugin=entry.factory(()=>{throw Error('No native dependencies should be required');});}}}});
  const ui={running:new Map(),completionUnread:new Set(['read-me','other']),publishStatus:()=>{for(const fn of subscribers)fn();},sessionStatus:{subscribe:fn=>{subscribers.add(fn);return ()=>subscribers.delete(fn);}}};
  const client={uiSession:ui,sessions:{list:{getSnapshot:()=>({byId:{'read-me':row}}),subscribe:fn=>{subscribers.add(fn);return ()=>subscribers.delete(fn);}}},remote:{$on:(name,fn)=>{assert.equal(name,'codex-mobile/read-state');listener=fn;return ()=>listener=null;}},effect:setup=>disposers.push(setup())};
  plugin.apply(client);t.after(()=>disposers.forEach(dispose=>dispose()));
  const services={clientModules:{clientPath:()=>'/fixture/client.js'},typertGateway:{broadcastRemoteEvent:value=>{frame=value;listener(value.args[0]);}}};f.ctx.get=name=>services[name];
  await f.request('detail','read-me');await f.request('list');assert.equal(ui.completionUnread.has('read-me'),true);
  const request={id:randomUUID(),turnId:'1',turnStatus:'completed'};
  assert.equal((await f.request('read-state','read-me',request)).status,'accepted');
  assert.equal(frame.resources.session(frame.args[0]),'read-me');assert.equal(ui.completionUnread.has('read-me'),false);assert.equal(ui.completionUnread.has('other'),true);assert.equal(f.calls.length,0);
  const delayed=frame.args[0];row.updatedAt++;f.append('read-me','turn/start',{turn:2});f.append('read-me','turn/end',{turn:2,reason:{kind:'completed'}});ui.completionUnread.add('read-me');
  assert.equal((await f.request('read-state','read-me',request)).status,'stale');listener(delayed);ui.publishStatus();assert.equal(ui.completionUnread.has('read-me'),true);
  row.running=true;assert.equal((await f.request('read-state','read-me',{...request,turnId:'2'})).status,'stale');
  row.running=false;assert.equal((await f.request('read-state','read-me',{...request,turnId:'2'})).status,'accepted');assert.equal(ui.completionUnread.has('read-me'),false);
  delete services.clientModules;assert.equal((await f.request('read-state','read-me',{...request,turnId:'2'})).status,'unsupported');
});

test('work modes use native plan and goal services without changing the original session or passive reads',async t=>{
  const f=await fixture(t),row=f.add('modes'),v=row.projections.values,agents=new Map();
  v.plan={active:false,pending:false};v.goal=null;
  const plan={get:()=>({active:v.plan.active}),set:(agent,active)=>{assert.equal(agent,agents.get('modes'));f.calls.push(['plan',active]);v.plan.active=active;}};
  const goals={get:()=>v.goal,create:(agent,{objective})=>{assert.equal(agent,agents.get('modes'));f.calls.push(['goal',objective]);return v.goal={id:'native-goal',revision:1,objective,phase:'active',createdAt:100,roundsStarted:0,maxGoalRounds:256,activation:'armed'};},pause:(agent,ref)=>{assert.deepEqual(ref,{id:v.goal.id,revision:v.goal.revision});v.goal={...v.goal,revision:2,phase:'paused'};return v.goal;}};
  for(const name of ['resume','edit','clear'])goals[name]=(agent,ref,fields)=>{assert.equal(agent,agents.get('modes'));assert.deepEqual(ref,{id:v.goal.id,revision:v.goal.revision});v.goal=name==='clear'?null:{...v.goal,...fields,revision:v.goal.revision+1,...name==='resume'?{phase:'active',activation:'armed'}:{}};return v.goal;};
  agents.set('modes',{session:{id:'modes'},ctx:{get:name=>({planMode:plan,goals}[name])}});f.ctx.agents.get=id=>agents.get(id);
  let detail=await f.request('detail','modes');assert.equal(detail.capabilities.workModes,true);assert.equal(detail.capabilities.goal,true);assert.equal(detail.session.collaborationMode,'default');assert.equal(f.calls.length,0);
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'先规划',workMode:'plan'})).status,'accepted');assert.equal(f.calls.at(-2)[0],'plan');assert.equal(f.calls.at(-1)[0],'prompt');
  detail=await f.request('detail','modes');assert.equal(detail.session.collaborationMode,'plan');
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'直接执行',workMode:'default'})).status,'accepted');assert.equal(v.plan.active,false);
  const prompts=f.calls.filter(c=>c[0]==='prompt').length;
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'完成改造',workMode:'goal'})).status,'accepted');assert.equal(v.goal.objective,'完成改造');assert.equal(f.calls.filter(c=>c[0]==='prompt').length,prompts,'native goal driver owns execution');
  detail=await f.request('detail','modes');assert.equal(detail.session.goal.status,'active');assert.equal(detail.session.goal.goalId,'native-goal');
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'另一个目标',workMode:'goal'})).code,400);
  assert.equal((await f.request('settings','modes',{goalAction:'paused',expected:{goalId:'native-goal',revision:0}})).code,400);
  assert.equal((await f.request('settings','modes',{goalAction:'paused',expected:{goalId:'native-goal',revision:1}})).status,'accepted');assert.equal(v.goal.phase,'paused');
  assert.equal((await f.request('settings','modes',{goalAction:'edit',objective:'改进目标',expected:{goalId:'native-goal',revision:2}})).status,'accepted');assert.equal(v.goal.objective,'改进目标');
  assert.equal((await f.request('settings','modes',{goalAction:'active',expected:{goalId:'native-goal',revision:3}})).status,'accepted');assert.equal(v.goal.phase,'active');
  v.goal.activation='disarmed';assert.equal((await f.request('settings','modes',{goalAction:'active',expected:{goalId:'native-goal',revision:4}})).status,'accepted');assert.equal(v.goal.activation,'armed');
  assert.equal((await f.request('settings','modes',{goalAction:'clear',expected:{goalId:'native-goal',revision:5}})).status,'accepted');assert.equal(v.goal,null);
  const before=f.calls.length;row.running=true;
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'排队',mode:'queue',workMode:'plan'})).code,400);
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'补充',mode:'steer',workMode:'plan'})).code,400);
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'非法',workMode:'invented'})).code,400);assert.equal(f.calls.length,before);
  agents.clear();delete v.plan;delete v.goal;
  detail=await f.request('detail','modes');assert.equal(detail.capabilities.workModes,false);assert.equal(detail.capabilities.goal,false);
  assert.equal((await f.request('send','modes',{id:randomUUID(),text:'旧版本',workMode:'plan'})).code,400);
});

test('cold mode changes resume only the explicitly addressed native session',async t=>{
  const f=await fixture(t),row=f.add('cold'),agents=new Map();row.projections.values.plan={active:false,pending:false};
  f.ctx.agents.get=id=>agents.get(id);const create=f.ctx.sessionController.create;
  const plan={get:()=>({active:row.projections.values.plan.active}),set:(agent,active)=>{assert.equal(agent,agents.get('cold'));row.projections.values.plan.active=active;}};
  f.ctx.sessionController.create=async request=>{const result=await create(request);agents.set(request.sessionId,{session:{id:request.sessionId},ctx:{get:name=>name==='planMode'?plan:undefined}});return result;};
  assert.equal((await f.request('detail','cold')).capabilities.workModes,true);assert.equal(agents.size,0);assert.equal(f.calls.length,0);
  assert.equal((await f.request('send','cold',{id:randomUUID(),text:'先规划',workMode:'plan'})).status,'accepted');
  assert.deepEqual(f.calls[0],['create',{sessionId:'cold',cwd:row.cwd}]);assert.equal(f.rows.length,1);assert.equal(row.projections.values.modelSelection.next.provider,'fixture');
});

test('native projects, manual order, shared sections, pins, archive and projectless creation survive reconnect',async t=>{
  const f=await fixture(t),{request:r}=f;const first=f.add('one'),second=f.add('two');const a=f.workspace(f.folder,'甲'),other=join(f.folder,'other');await mkdir(other);const b=f.workspace(other,'乙');a.sessionIds=['one','two'];
  assert.equal((await r('list')).sessions.length,2);assert.equal(f.calls.length,0,'passive reads must not create or activate anything');
  assert.equal((await r('manage',null,{id:randomUUID(),operation:'project-order',projectKey:other,beforeKey:f.folder})).code,200);
  assert.deepEqual((await r('projects')).projects.map(p=>p.name),['乙','甲']);
  await r('manage','two',{operation:'thread-order',projectKey:f.folder,beforeId:'one'});assert.deepEqual(a.sessionIds,['two','one']);
  const section=randomUUID();await r('manage',null,{id:section,operation:'section-create',title:'规划'});
  await r('manage',null,{operation:'place',projectKey:f.folder,sectionId:section});await r('manage','one',{operation:'place',sectionId:'pinned'});
  let list=await r('list');assert.equal(list.sidebar.placements['project:'+f.folder],section);assert.equal(list.sessions.find(s=>s.id==='one').pinned,true);
  await r('manage','two',{operation:'rename',title:'新名字'});assert.equal((await r('detail','two')).session.title,'新名字');
  await r('manage','two',{operation:'archive',confirmed:true});assert.equal((await r('list')).sessions.find(s=>s.id==='two').archived,true);
  await r('manage','two',{operation:'unarchive'});assert.equal((await r('list')).sessions.find(s=>s.id==='two').archived,false);
  const created=await r('create',null,{id:randomUUID(),projectKey:'',title:''});assert.equal(created.status,'ready');assert.ok(f.rows.find(s=>s.sessionId===created.result.id).cwd.includes('projectless'));
  await f.restart();list=await r('list');assert.equal(list.sidebar.sections[0].title,'规划');assert.equal(list.sessions.find(s=>s.id===created.result.id).projectless,true);
  assert.equal((await r('projects')).projects.length,2,'projectless working directories never become project records');
  await r('manage',null,{operation:'section-delete',sectionId:section});assert.equal((await r('list')).sidebar.placements['project:'+f.folder],undefined);
  assert.equal((await r('manage',null,{operation:'project-create',cwd:'relative',title:'拒绝'})).code,400);
  assert.equal((await r('manage','one',{operation:'rename',title:'bad\nname'})).code,400);
  assert.equal((await r('manage',null,{operation:'place',projectKey:f.folder,sectionId:'absent'})).code,400);
  const third=join(f.folder,'third');await mkdir(third);const before=f.rows.length;
  assert.equal((await r('manage',null,{operation:'project-create',cwd:third,title:'第三项目'})).status,'accepted');assert.equal(f.rows.length,before,'creating a project never starts a chat');
  assert.equal((await r('manage',null,{operation:'project-create',cwd:third,title:'重复'})).code,400);
  await r('manage',null,{operation:'project-rename',projectKey:third,title:'已改名'});assert.equal((await r('projects')).projects.find(p=>p.key===third).name,'已改名');
  await r('manage',null,{operation:'project-delete',projectKey:third,confirmed:true});assert.ok(!(await r('projects')).projects.some(p=>p.key===third));assert.equal((await stat(third)).isDirectory(),true);
  const configured=await r('create',null,{id:randomUUID(),projectKey:f.folder,model:'fixture/chat',effort:'low',permissionMode:'full-access'});assert.equal(configured.status,'ready');assert.deepEqual(f.calls.at(-1),['permission',{id:configured.result.id},'full-access']);
});

test('multiple native side forks retain context, isolate sends, sync names, resolve skills, and archive on explicit end',async t=>{
  const f=await fixture(t),{request:r}=f,parent=f.add('parent');parent.projections.values.title='原主题';f.add('unrelated');f.append('parent','user/message',{content:[{type:'text',text:'existing context'}]});
  assert.deepEqual((await r('side-read','parent')).slots,[]);assert.equal(f.calls.length,0);
  const slot1=randomUUID(),slot2=randomUUID(),one=await r('side-write','parent',{operation:'create',slot:slot1,id:randomUUID(),title:'方案甲'}),two=await r('side-write','parent',{operation:'create',slot:slot2,id:randomUUID()});
  assert.equal(one.cwd,parent.cwd);assert.notEqual(one.id,two.id);assert.equal(f.calls.filter(c=>c[0]==='prompt').length,0);assert.deepEqual(f.calls.find(c=>c[0]==='fork')[1],{sessionId:'parent',allowMigration:false});
  assert.equal((await r('side-read','parent')).slots.length,2);assert.equal((await r('list')).sessions.length,2,'side forks stay out of the main chat list');
  await r('side-write','parent',{operation:'send',slot:slot1,childId:one.id,submissionId:randomUUID(),text:'仅发给甲',mode:'send'});assert.equal(f.calls.at(-1)[1].sessionId,one.id);
  const view=await r('side-read','parent',{slot:slot1});assert.equal(view.title,'方案甲');assert.equal(view.submissions.length,1);assert.equal(view.records.at(-1).event.data.content[0].text,'仅发给甲');
  assert.equal((await r('side-read','parent',{slot:slot1,operation:'skills',childId:one.id,offset:200})).skills.length,21);
  await r('side-write','parent',{operation:'rename',slot:slot1,childId:one.id,title:'已更名'});await f.restart();assert.equal((await r('side-read','parent',{slot:slot1})).title,'已更名');
  assert.equal((await r('side-write','unrelated',{operation:'stop',slot:slot1,childId:one.id})).code,400);
  assert.equal((await r('side-read','parent',{operation:'catalog',slot:slot1,childId:two.id})).code,400);
  await r('side-write','parent',{operation:'close',slot:slot1,childId:one.id});assert.equal((await r('side-read','parent')).slots.length,1);assert.ok(f.ctx.workspaceRegistry.archivedSessionIds.includes(one.id));
  assert.equal((await r('side-write','parent',{operation:'create',slot:slot1,id:randomUUID()})).code,400,'closed slots cannot silently create a replacement on retry');
});

test('nested child activity and read-only subagent history never activate another session',async t=>{
  const f=await fixture(t),{request:r}=f;f.add('parent');f.add('child',f.folder,'parent');f.add('grandchild',f.folder,'child').running=true;f.add('foreign');
  let row=(await r('list')).sessions.find(s=>s.id==='parent');assert.equal(row.status,'active');assert.equal(row.childActive,1);assert.equal((await r('detail','parent')).session.status,'active');
  const agents=await r('subagents','parent');assert.deepEqual(agents.agents.map(a=>a.id),['child','grandchild']);
  f.append('grandchild','assistant/message',{content:[{type:'text',text:'child result'}]});assert.equal((await r('subagents','parent',{childId:'grandchild'})).records[0].event.data.content[0].text,'child result');
  assert.equal((await r('subagents','parent',{childId:'foreign'})).code,400);delete f.rows.find(s=>s.sessionId==='grandchild').running;row=(await r('list')).sessions[0];assert.equal(row.status,'unknown');assert.equal(f.calls.length,0);
});

test('side controls use native child models, permissions, pending queue identities and historical metadata',async t=>{
  const f=await fixture(t),{request:r}=f;f.add('parent');
  const child=await r('side-write','parent',{operation:'create',id:randomUUID()}),body={childId:child.id};
  await r('side-write','parent',{...body,operation:'settings',model:'fixture/chat',effort:'low'});assert.equal(f.calls.at(-1)[1].sessionId,child.id);assert.equal(f.calls.at(-1)[1].reasoningEffort,'low');
  await r('side-write','parent',{...body,operation:'permissions',preset:'full-access'});assert.deepEqual(f.calls.at(-1),['permission',{id:child.id},'full-access']);
  const row=f.rows.find(row=>row.sessionId===child.id),submission=randomUUID();row.running=true;
  assert.equal((await r('side-write','parent',{...body,operation:'send',text:'queued',submissionId:submission,mode:'queue'})).status,'queued');
  row.projections.values.inbox={'next-turn':[{id:'native-queue-item',source:{rpcId:submission}}]};
  f.ctx.sessionController.updateQueue=async params=>{f.calls.push(['queue',params]);row.projections.values.inbox['next-turn']=[];return {accepted:true};};
  await r('side-write','parent',{...body,operation:'cancel-queued',submissionId:submission});assert.deepEqual(f.calls.at(-1),['queue',{sessionId:child.id,itemId:'native-queue-item',action:{kind:'remove'}}]);
  assert.equal((await r('side-read','parent')).submissions[0].status,'cancelled');
  assert.equal((await r('side-write','parent',{...body,operation:'cancel-queued',submissionId:submission})).code,400);
  f.append(child.id,'request/header',{header:{config:{provider:'fixture',model:'old-model',reasoningEffort:'high',apiKey:'must-stay-native'}}});f.append(child.id,'assistant/message',{content:[{type:'text',text:'historical answer'}]});
  const detail=await r('detail',child.id);assert.equal(detail.records.at(-1).presentation.model,'old-model');assert.equal(detail.records.at(-1).presentation.effort,'high');assert.ok(!JSON.stringify(detail).includes('must-stay-native'));assert.equal(detail.session.model,'fixture/chat');
});

test('background summaries use the same Harness model without tools or parent messages; manual names win',async t=>{
  const f=await fixture(t),{request:r}=f;f.add('parent');const requests=[];let release;
  f.ctx.llm={prepareCall:async(route,signal)=>{assert.deepEqual(route,{provider:'fixture',model:'chat',maxTokens:80});return {config:route,stream:async function*(options){requests.push(options);if(release===null)await new Promise(resolve=>release=resolve);signal.throwIfAborted();yield {type:'text-delta',text:'修复多设备侧边聊天同步'};yield {type:'finish',reason:{kind:'stop'}};}};}};
  const child=await r('side-write','parent',{operation:'create',slot:'',id:randomUUID()});
  await r('side-write','parent',{operation:'send',slot:'',childId:child.id,submissionId:randomUUID(),text:'修复同步问题'});
  for(let i=0;i<100&&(await r('side-read','parent')).title!=='修复多设备侧边聊天同步';i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await r('side-read','parent')).title,'修复多设备侧边聊天同步');assert.equal(requests.length,1);assert.deepEqual(requests[0].tools,[]);assert.equal(requests[0].purpose,'session-title');assert.equal(requests[0].messages.length,1);assert.equal(f.events.get('parent').length,0);
  await r('side-write','parent',{operation:'send',slot:'',childId:child.id,submissionId:randomUUID(),text:'继续'});assert.equal(requests.length,1);
  const named=f.add('named-main');named.projections.values.title='人工主标题';await r('send',named.sessionId,{id:randomUUID(),text:'首条文字'});assert.equal(requests.length,1,'a named native chat is never summarized over a manual title');
  f.add('second');release=null;const sid=await r('side-write','second',{operation:'create',id:randomUUID()});await r('side-write','second',{operation:'send',childId:sid.id,submissionId:randomUUID(),text:'另一个问题'});
  for(let i=0;i<100&&release===null;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(typeof release,'function');
  await r('side-write','second',{operation:'rename',childId:sid.id,title:'人工名称'});release();await new Promise(resolve=>setTimeout(resolve,20));assert.equal((await r('side-read','second')).title,'人工名称');
});
