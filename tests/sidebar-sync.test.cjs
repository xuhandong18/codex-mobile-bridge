const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('web/shell/app.js','utf8');
const render=source.slice(source.indexOf('function sidebarEntry('),source.indexOf('async function loadList('));
class Element{
  constructor(tag,cls='',text=''){this.tag=tag;this.className=cls;this.textContent=text;this.children=[];this.dataset={};this.scrollTop=0;}
  get parentElement(){return this.parent;}
  matches(selector){
    if(selector==='summary[data-project-key]')return this.tag==='summary'&&this.dataset.projectKey!==undefined;
    if(selector==='.sidebar-section > summary')return this.tag==='summary'&&this.parent?.matches('.sidebar-section');
    return selector.startsWith('.')?this.className.split(' ').includes(selector.slice(1)):this.tag===selector;
  }
  closest(selector){for(let node=this;node;node=node.parent)if(node.matches(selector))return node;return null;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector.split(',').some(part=>child.matches(part.trim()))?[child]:[]),...child.querySelectorAll(selector)]);}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  prepend(...nodes){for(const node of nodes)node.parent=this;this.children.unshift(...nodes);}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(name,value){this[name]=value;}
  remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
}
function fixture(mode='codex'){
  const saved=new Map();
  const nodes={sessions:new Element('div'),'list-mode':{value:mode},search:{value:''},archived:{checked:false}};
  const selected=[];
  const context={$:id=>nodes[id],el:(...args)=>new Element(...args),localStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},t:x=>x,BridgeI18n:{locale:()=> 'zh'},
    currentId:null,currentHost:'local',availableSources:[],listSource:'all',listRenderStamp:'',listComplete:true,listReadFinished:true,listHasMore:false,listLoading:0,listFilterKey:'fixture',projectChatPages:new Map(),
    renderActivity(){},scheduleActivityRefresh(){},projectThreadOrder:{sort:(key,ids)=>ids},sessionAccess:x=>x||{source:'desktop'},sourceLabel:()=>'',dateText:()=>'',openChat:async()=>{},toast(){},openNewChat:p=>selected.push(p),
    sidebarData:{sections:[{id:'custom',name:'Daily',itemKeys:['codex:project:p'],hostSectionIds:{local:'native'}}],projects:[{key:'local|p',name:'Project',host:'local',cwd:'/work'},{key:'local|empty',name:'Empty',host:'local',cwd:'/empty'}]},
    listRows:[{id:'thread',host:'local',projectKey:'local|p',projectName:'Project',title:'Chat',recency:1},{id:'direct',host:'local',projectKey:'local|p',projectName:'Project',thread_section_id:'native',title:'Direct',recency:2}]};
  vm.createContext(context);vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8'),context);context.projectPins=vm.runInContext('new SidebarProjectPins(localStorage,"project-pins:")',context);context.sidebarPlacements=vm.runInContext('new SidebarPlacements(localStorage,"fixture:")',context);context.sectionProjectOrder=vm.runInContext('new SidebarItemOrder(localStorage,"project-order:")',context);vm.runInContext(render,context);context.renderList();return {context,nodes,selected};
}
test('native sections contain projects, empty projects and directly assigned threads',()=>{
  const {nodes,selected}=fixture();
  const section=nodes.sessions.children.find(n=>n.dataset.section==='custom');
  const project=section.children.find(n=>n.className==='project-group');
  assert.ok(project.children.some(n=>n.dataset.id==='thread'));
  assert.ok(section.children.some(n=>n.dataset.id==='direct'));
  const projects=nodes.sessions.children.find(n=>n.dataset.section==='projects');
  assert.ok(projects.children.some(n=>n.className==='project-group'&&n.children[0].children[0].textContent.startsWith('Empty')));
  const button=project.children[0].children[1];let prevented=false;
  button.onclick({preventDefault(){prevented=true;},stopPropagation(){}});
  assert.equal(prevented,true);assert.equal(selected[0].key,'local|p');
});

test('native project chats keep recent order before pagination despite older desktop positions',()=>{
  const {context,nodes}=fixture();
  context.listRows=Array.from({length:9},(_,i)=>({id:'chat-'+i,host:'local',projectKey:'local|p',projectName:'Project',title:'Chat '+i,recency:100-i,section_position:8-i}));
  context.sidebarData.threadOrders={p:{threadIds:context.listRows.map(row=>row.id).reverse()}};
  context.renderList();
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),['chat-0','chat-1','chat-2','chat-3','chat-4']);
  vm.runInContext(source.slice(source.indexOf('function projectChatRows('),source.indexOf('function sidebarEntry(')),context);
  assert.deepEqual(Array.from(context.projectChatRows(context.listRows[0])),context.listRows.map(row=>row.id));
  context.listRows[8].recency=200;context.listRows.sort((a,b)=>b.recency-a.recency);context.renderList();
  assert.deepEqual(ids(),['chat-8','chat-0','chat-1','chat-2','chat-3']);
});

test('native direct section and pinned chats keep recent order while projects retain their positions',()=>{
  const {context,nodes}=fixture();
  context.sidebarData.sections[0].itemKeys=['codex:thread:old','codex:project:p','codex:thread:new'];
  context.sidebarData.pinnedThreadIds=['pinned-old','pinned-new'];
  context.listRows=[
    {id:'new',recency:4,thread_section_id:'native',section_position:3},
    {id:'pinned-new',recency:3,section_position:3},
    {id:'old',recency:2,thread_section_id:'native',section_position:0},
    {id:'pinned-old',recency:1,section_position:0},
  ].map(row=>({...row,host:'local',projectKey:'local|p',projectName:'Project',title:row.id}));
  context.renderList();
  const section=id=>nodes.sessions.children.find(node=>node.dataset.section===id);
  assert.deepEqual(section('custom').children.slice(1).map(node=>node.dataset.id||node.dataset.projectKey),['new','local|p','old']);
  assert.deepEqual(section('pinned').children.slice(1).map(node=>node.dataset.id),['pinned-new','pinned-old']);
});

for(const mode of ['codex','project'])test('project pins have independent recent order and do not consume ordinary pagination in '+mode+' mode',()=>{
  const {context,nodes}=fixture(mode);
  context.listRows=Array.from({length:20},(_,i)=>({id:'chat-'+i,host:'local',projectKey:'local|p',projectName:'Project',title:'Chat '+i,recency:100-i}));
  const original=JSON.stringify(context.listRows);
  context.projectPins.toggle('local|p','chat-19');context.projectPins.toggle('local|p','chat-18');context.listRenderStamp='';context.renderList();
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),['chat-18','chat-19','chat-0','chat-1','chat-2','chat-3','chat-4']);
  assert.equal(JSON.stringify(context.listRows),original,'Pinning only changes display preferences');
  vm.runInContext(source.slice(source.indexOf('function projectChatRows('),source.indexOf('function sidebarEntry(')),context);
  assert.equal(context.projectChatRows(context.listRows[19]).length,0,'Pins cannot be moved into the ordinary order');
  context.listRows[19].recency=200;context.listRows.sort((a,b)=>b.recency-a.recency);context.renderList();
  assert.deepEqual(ids().slice(0,2),['chat-19','chat-18']);
  context.shiftProjectChat(context.listRows.find(row=>row.id==='chat-19'),1);
  assert.deepEqual(ids().slice(0,2),['chat-19','chat-18']);
  context.toggleProjectPin(context.listRows.find(row=>row.id==='chat-18'));
  assert.deepEqual(ids(),['chat-19','chat-0','chat-1','chat-2','chat-3','chat-4']);
  const stale={...context.listRows[0],projectKey:'local|moved'};
  assert.throws(()=>context.toggleProjectPin(stale),/侧栏条目已变化/);
});

for(const mode of ['codex','project'])test('explicit local chat moves still persist over recent defaults in '+mode+' mode',()=>{
  const {context,nodes}=fixture(mode);
  context.projectThreadOrder=vm.runInContext('new SidebarItemOrder(localStorage,"chat-order:")',context);
  context.listRows=[3,2,1].map(recency=>({id:'chat-'+recency,host:'local',projectKey:'local|p',projectName:'Project',title:'Chat '+recency,recency}));
  context.sidebarData.threadOrders={p:{threadIds:['chat-1','chat-2','chat-3']}};
  context.renderList();
  vm.runInContext(source.slice(source.indexOf('function projectChatRows('),source.indexOf('function sidebarEntry(')),context);
  context.shiftProjectChat(context.listRows[0],1);
  const ids=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p').children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),['chat-2','chat-3','chat-1']);
  context.projectThreadOrder=vm.runInContext('new SidebarItemOrder(localStorage,"chat-order:")',context);context.listRenderStamp='';context.renderList();
  assert.deepEqual(ids(),['chat-2','chat-3','chat-1']);
});

test('each project displays five chats then ten more per click without expanding another project',async()=>{
  const {context,nodes}=fixture('project');
  context.listRows=Array.from({length:27},(_,i)=>({id:'chat-'+i,host:'local',title:'Chat '+i,projectKey:'local|p',projectName:'Project',recency:100-i}));
  context.listRows.push(...context.listRows.slice(0,9).map(row=>({...row,id:'other-'+row.id,projectKey:'local|other'})));
  const group=key=>nodes.sessions.children.find(node=>node.dataset.projectKey===key);
  const count=key=>group(key).children.filter(node=>node.dataset.id).length;
  const more=key=>group(key).children.find(node=>node.className==='plain project-load-more');
  context.renderList();assert.equal(count('local|p'),5);assert.equal(count('local|other'),5);
  for(const expected of [15,25,27]){
    await more('local|p').onclick();assert.equal(count('local|p'),expected);assert.equal(count('local|other'),5);
    context.listRows[0].title+='!';context.renderList();assert.equal(count('local|p'),expected);
  }
  assert.equal(more('local|p'),undefined);
});

test('project pagination continues past global pages containing only other projects and retries failures',async()=>{
  const {context,nodes}=fixture('project');context.listRows=context.listRows.slice(0,1);context.listHasMore=true;
  let reads=0;
  context.loadList=async()=>{
    if(++reads===1)throw Error('offline');
    if(reads===2)context.listRows.push({...context.listRows[0],id:'other',projectKey:'local|other'});
    else{context.listRows.push(...Array.from({length:19},(_,i)=>({...context.listRows[0],id:'chat-'+i})));context.listHasMore=false;}
    return true;
  };
  const group=()=>nodes.sessions.children.find(node=>node.dataset.projectKey==='local|p');
  const more=()=>group().children.find(node=>node.className==='plain project-load-more');
  context.renderList();await more().onclick();assert.equal(context.projectPage('local|p').limit,5);assert.equal(more().disabled,false);
  await more().onclick();assert.equal(reads,3);assert.equal(group().children.filter(node=>node.dataset.id).length,15);
});

test('switching a list filter while a project page loads discards the old expansion',async()=>{
  const {context}=fixture('project');context.listHasMore=true;
  let finish;context.loadList=()=>new Promise(resolve=>finish=resolve);
  const loading=context.loadProjectChats('local|p');
  context.projectChatPages.clear();context.listFilterKey='different';context.listHasMore=false;
  finish(true);await loading;assert.equal(context.projectPage('local|p').limit,5);
});

test('locally collapsed native sections stay closed when conversation metadata refreshes',()=>{
  const {context,nodes}=fixture();
  const section=nodes.sessions.children.find(n=>n.dataset.section==='projects');
  section.open=false;section.ontoggle?.();
  context.sidebarData.collapsedSections={projects:false};
  context.listRows[0].title='Updated';context.renderList();
  assert.equal(nodes.sessions.children.find(n=>n.dataset.section==='projects').open,false);
});

test('a detached project cannot overwrite the remembered open state with a delayed toggle',()=>{
  const {context,nodes}=fixture('project'),old=nodes.sessions.children[0];
  old.open=false;old.ontoggle();context.listRows[0].title='Updated';context.renderList();
  const current=nodes.sessions.children[0];current.open=true;current.ontoggle();
  old.isConnected=false;old.ontoggle();
  context.listRows[0].title='Again';context.renderList();assert.equal(nodes.sessions.children[0].open,true);
});

function bindSidebarMenu({context}){
  vm.runInContext(fs.readFileSync('web/features/chat/sidebar-management.js','utf8'),context);
  context.sidebarManagement=new context.SidebarManagementUI({snapshot:()=>context.sidebarData});
  context.ChatContextMenu=class{constructor(_root,items){context.menuItems=items;}};
  vm.runInContext(source.slice(source.indexOf("new ChatContextMenu($('sessions'),"),source.indexOf('\nfunction currentSidebarEntry(')),context);
}

for(const mode of ['codex','project'])test('project menu restores recent chats hidden by a saved manual order in '+mode+' mode',()=>{
  const f=fixture(mode),{context,nodes}=f;
  context.projectThreadOrder=vm.runInContext('new SidebarItemOrder(localStorage,"chat-order:")',context);
  context.listRows=Array.from({length:9},(_,i)=>({id:'chat-'+i,host:'local',projectKey:'local|p',projectName:'Project',title:'Chat '+i,recency:100-i}));
  const originalIds=context.listRows.map(row=>row.id);
  context.projectThreadOrder.move('local|p',originalIds,'chat-8','chat-0');
  context.projectThreadOrder.move('ssh|other',['a','b'],'b','a');
  context.projectPins.toggle('local|p','chat-7');
  context.listRows[6].recency=200;context.listRows.sort((a,b)=>b.recency-a.recency);
  context.renderList();bindSidebarMenu(f);
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.ok(!ids().includes('chat-6'),'The latest chat is initially hidden behind load more');
  const restore=context.menuItems(group().children[0]).find(item=>item.label==='聊天按最近交互排序');
  assert.ok(restore,'The project menu offers a way back to recent ordering');
  restore.run();
  assert.deepEqual(ids(),['chat-7','chat-6','chat-0','chat-1','chat-2','chat-3']);
  context.projectThreadOrder=vm.runInContext('new SidebarItemOrder(localStorage,"chat-order:")',context);
  context.listRenderStamp='';context.renderList();
  assert.deepEqual(ids(),['chat-7','chat-6','chat-0','chat-1','chat-2','chat-3']);
  assert.deepEqual(Array.from(context.projectThreadOrder.sort('ssh|other',['a','b'])),['b','a']);
});

for(const mode of ['codex','project'])test('native project management retains sibling ordering in '+mode+' mode',()=>{
  const f=fixture(mode),{context,nodes}=f;
  context.sidebarData.projects=context.sidebarData.projects.filter(project=>project.key!=='local|empty');
  context.sidebarData.projects.push({key:'local|b',host:'local',name:'B'},{key:'ssh|r',host:'ssh',name:'Remote'});
  context.sidebarData.sections[0].itemKeys.push('codex:project:b','codex:project:r');
  context.renderList();bindSidebarMenu(f);
  const group=key=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key);
  const menu=key=>context.menuItems(group(key).children[0]);
  const keys=()=>group('local|p').parent.children.filter(node=>node.dataset.projectKey).map(node=>node.dataset.projectKey);
  const first=menu('local|p');
  for(const label of ['修改名称','移动到分区…','删除项目','上移','下移'])assert.ok(first.some(row=>row.label===label),'Missing '+label);
  assert.equal(first.find(row=>row.label==='上移').disabled,true);
  first.find(row=>row.label==='下移').run();
  const scope=mode==='codex'?'custom':'projects';
  assert.deepEqual(Array.from(context.sectionProjectOrder.sort(scope,['local|p','local|b','ssh|r'])),['local|b','local|p','ssh|r']);
  const ordered=keys();assert.ok(ordered.indexOf('local|b')<ordered.indexOf('local|p'));
  const remote=menu('ssh|r');assert.equal(remote.find(row=>row.label==='修改名称').disabled,true);
  assert.equal(remote.find(row=>row.label==='上移').disabled,false);assert.equal(remote.find(row=>row.label==='下移').disabled,true);
  remote.find(row=>row.label==='上移').run();
  context.listRows[0].title='Refreshed';context.renderList();
  assert.deepEqual(Array.from(context.sectionProjectOrder.sort(scope,['local|p','local|b','ssh|r'])),['local|b','ssh|r','local|p']);
  assert.deepEqual(Array.from(context.menuItems(group('local|p').children[0].children[1])),[],'The project create button does not open a menu');
});

for(const mode of ['codex','project','recent'])test('collapse all persists immediately across list refreshes in '+mode+' mode',()=>{
  const {context,nodes}=fixture(mode),row=JSON.stringify(context.listRows),pages=context.projectChatPages;
  context.collapseSidebarGroups();
  const groups=()=>nodes.sessions.querySelectorAll('.sidebar-section, .project-group');
  assert.ok(groups().every(group=>!group.open));
  context.listRenderStamp='';context.renderList();
  assert.ok(groups().every(group=>!group.open),'A refresh before the toggle event must retain collapsed state');
  if(mode!=='recent'){
    const project=groups().find(group=>group.dataset.projectKey==='local|p');
    project.open=true;project.ontoggle();context.listRenderStamp='';context.renderList();
    assert.equal(groups().find(group=>group.dataset.projectKey==='local|p').open,true,'An individual project can be reopened');
  }
  assert.equal(JSON.stringify(context.listRows),row);assert.equal(context.projectChatPages,pages);
});
test('recent mode preserves the flat list and project mode offers creation',()=>{
  const recent=fixture('recent');assert.equal(recent.nodes.sessions.children.length,2);
  assert.ok(recent.nodes.sessions.children.every(n=>n.className.startsWith('session')));
  const grouped=fixture('project');assert.equal(grouped.nodes.sessions.children.length,2);
  assert.equal(grouped.nodes.sessions.children[0].children[0].children[1].className,'plain project-create');
});

test('a native project with no chats remains visible in project mode and can be searched by name',()=>{
  const {context,nodes}=fixture('project');context.listRows=[];nodes.search.value='Empty';context.renderList();
  assert.equal(nodes.sessions.children.length,1);
  assert.equal(nodes.sessions.children[0].dataset.projectKey,'local|empty');
  nodes.search.value='Project';context.renderList();
  assert.equal(nodes.sessions.children[0].dataset.projectKey,'local|p');
});
test('section rename is rendered on the next metadata refresh',()=>{
  const {context,nodes}=fixture();context.sidebarData.sections[0].name='Renamed';context.renderList();
  assert.equal(nodes.sessions.children.find(n=>n.dataset.section==='custom').children[0].textContent,'Renamed');
});

test('a project can move from its native custom section to pinned and back to ordinary projects',()=>{
  const {context,nodes}=fixture(),item=context.sidebarEntry('project',context.sidebarData.projects[0]);
  context.sidebarPlacements.set(item,'pinned',['custom'],item.native);context.listRenderStamp='';context.renderList();
  const section=id=>nodes.sessions.children.find(node=>node.dataset.section===id);
  assert.ok(section('pinned').children.some(node=>node.dataset.projectKey==='local|p'));
  assert.equal(section('custom').children.filter(node=>node.dataset.projectKey==='local|p').length,0);
  context.sidebarPlacements.set(item,'home',['custom'],item.native);context.listRenderStamp='';context.renderList();
  assert.ok(section('projects').children.some(node=>node.dataset.projectKey==='local|p'));
});

test('chat section and pin overrides survive native metadata refresh without changing the source record',()=>{
  const {context,nodes}=fixture(),row=context.listRows[1],item=context.sidebarEntry('thread',row),original=JSON.stringify(row);
  context.sidebarPlacements.set(item,'pinned',['custom'],item.native);context.listRenderStamp='';context.renderList();
  let pinned=nodes.sessions.children.find(node=>node.dataset.section==='pinned');assert.ok(pinned.children.some(node=>node.dataset.id==='direct'));
  context.sidebarData={...context.sidebarData};context.renderList();
  pinned=nodes.sessions.children.find(node=>node.dataset.section==='pinned');assert.ok(pinned.children.some(node=>node.dataset.id==='direct'));
  context.sidebarPlacements.set(item,'home',['custom'],item.native);context.listRenderStamp='';context.renderList();
  const custom=nodes.sessions.children.find(node=>node.dataset.section==='custom'),project=custom.children.find(node=>node.dataset.projectKey==='local|p');
  assert.ok(project.children.some(node=>node.dataset.id==='direct'));assert.equal(JSON.stringify(row),original);
});


test('project create dialog selects the clicked project and blocks a removed project',async()=>{
  const nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,open:false,children:[],
    append(option){this.children.push(option);if(!this.value)this.value=option.value;},
    replaceChildren(){this.children=[];this.value='';},showModal(){this.open=true;}});return nodes.get(id);};
  const projects=[{key:'local|a',name:'A',host:'local',cwd:'/a',type:'desktop'},{key:'local|b',name:'B',host:'local',cwd:'/b',type:'desktop'}];
  const context={$,t:x=>x,creatingChat:false,newChatSettings:{load(){}},newChatProjects:[],listRows:[],currentId:null,currentHost:'local',api:async()=>({projects}),
    Option:class{constructor(text,value){this.textContent=text;this.value=value;}}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function openNewChat('),source.indexOf("$('new-chat-dialog').addEventListener('cancel'")),context);
  await context.openNewChat(projects[1]);
  assert.equal($('new-chat-project').value,'local|b');assert.equal($('new-chat-path').textContent,'/b');
  assert.equal($('new-chat-type').value,'desktop');assert.equal($('new-chat-submit').disabled,false);
  $('new-chat-dialog').open=false;
  await context.openNewChat({key:'local|removed',host:'local',cwd:'/removed',type:'desktop'});
  assert.equal($('new-chat-submit').disabled,true);assert.equal($('new-chat-error').textContent,'请选择现有项目');
});
