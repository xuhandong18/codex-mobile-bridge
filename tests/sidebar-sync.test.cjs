const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('web/shell/app.js','utf8');
const render=source.slice(source.indexOf('function sidebarEntry('),source.indexOf('async function loadList('));
class Element{
  constructor(tag,cls='',text=''){this.tag=tag;this.className=cls;this.textContent=text;this.children=[];this.dataset={};this.scrollTop=0;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
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
    renderActivity(){},projectThreadOrder:{sort:(key,ids)=>ids},sessionAccess:x=>x||{source:'desktop'},sourceLabel:()=>'',dateText:()=>'',openChat:async()=>{},toast(){},openNewChat:p=>selected.push(p),
    sidebarData:{sections:[{id:'custom',name:'Daily',itemKeys:['codex:project:p'],hostSectionIds:{local:'native'}}],projects:[{key:'local|p',name:'Project',host:'local',cwd:'/work'},{key:'local|empty',name:'Empty',host:'local',cwd:'/empty'}]},
    listRows:[{id:'thread',host:'local',projectKey:'local|p',projectName:'Project',title:'Chat',recency:1},{id:'direct',host:'local',projectKey:'local|p',projectName:'Project',thread_section_id:'native',title:'Direct',recency:2}]};
  vm.createContext(context);vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8'),context);context.sidebarPlacements=vm.runInContext('new SidebarPlacements(localStorage,"fixture:")',context);context.sectionProjectOrder=vm.runInContext('new SidebarItemOrder(localStorage,"project-order:")',context);vm.runInContext(render,context);context.renderList();return {context,nodes,selected};
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
