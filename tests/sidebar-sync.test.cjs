const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {SessionActivity}=require('../web/features/chat/activity.js');
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
    currentId:null,currentHost:'local',availableSources:[],listSource:'all',listRenderStamp:'',listComplete:true,listReadFinished:true,listHasMore:false,listLoading:0,listFilterKey:'fixture',projectChatPages:new Map(),createdChats:new Map(),createdChatVisibility:new Set(),
    renderActivity(){},scheduleActivityRefresh(){},chatKey:(id,host)=>host+'|'+id,sessionActivity:new SessionActivity({storage:{getItem:()=>null,setItem(){}}}),sessionAccess:x=>x||{source:'desktop'},sourceLabel:()=>'',dateText:()=>'',openChat:async()=>{},toast(){},openNewChat:p=>selected.push(p),sidebarPreferences:{change:async edit=>edit()},
    sidebarData:{sections:[{id:'custom',name:'Daily',itemKeys:['codex:project:p'],hostSectionIds:{local:'native'}}],projects:[{key:'local|p',name:'Project',host:'local',cwd:'/work'},{key:'local|empty',name:'Empty',host:'local',cwd:'/empty'}]},
    listRows:[{id:'thread',host:'local',projectKey:'local|p',projectName:'Project',title:'Chat',recency:1},{id:'direct',host:'local',projectKey:'local|p',projectName:'Project',thread_section_id:'native',title:'Direct',recency:2}]};
  context.sessionActivity.update(context.listRows.map(row=>({...row,connected:true,status:'active'})));
  context.newChatProjects=context.sidebarData.projects;
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('function rememberCreatedChat('),source.indexOf('function sidebarEntry(')),context);
  vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8'),context);context.projectPins=vm.runInContext('new SidebarProjectPins(localStorage,"project-pins:")',context);context.sidebarPlacements=vm.runInContext('new SidebarPlacements(localStorage,"fixture:")',context);context.sectionProjectOrder=vm.runInContext('new SidebarItemOrder(localStorage,"project-order:")',context);vm.runInContext(render,context);context.renderList();return {context,nodes,selected};
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

test('native project shows all marked chats in recent order despite older desktop positions',()=>{
  const {context,nodes}=fixture();
  context.listRows=Array.from({length:9},(_,i)=>({id:'chat-'+i,host:'local',projectKey:'local|p',projectName:'Project',title:'Chat '+i,recency:100-i,section_position:8-i}));
  context.sidebarData.threadOrders={p:{threadIds:context.listRows.map(row=>row.id).reverse()}};
  context.sessionActivity.update(context.listRows.map(row=>({...row,connected:true,status:'active'})));
  context.renderList();
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),context.listRows.map(row=>row.id));
  context.listRows[8].recency=200;context.listRows.sort((a,b)=>b.recency-a.recency);context.renderList();
  assert.deepEqual(ids(),context.listRows.map(row=>row.id));
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

for(const mode of ['project'])test('project pins have independent recent order and do not consume ordinary pagination in '+mode+' mode',async()=>{
  const {context,nodes}=fixture(mode);
  context.listRows=Array.from({length:20},(_,i)=>({id:'chat-'+i,host:'local',projectKey:'local|p',projectName:'Project',title:'Chat '+i,recency:100-i}));
  const original=JSON.stringify(context.listRows);
  context.projectPins.toggle('local|p','chat-19');context.projectPins.toggle('local|p','chat-18');context.listRenderStamp='';context.renderList();
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),['chat-18','chat-19','chat-0','chat-1','chat-2','chat-3','chat-4']);
  assert.equal(JSON.stringify(context.listRows),original,'Pinning only changes display preferences');
  context.listRows[19].recency=200;context.listRows.sort((a,b)=>b.recency-a.recency);context.renderList();
  assert.deepEqual(ids().slice(0,2),['chat-19','chat-18']);
  await context.toggleProjectPin(context.listRows.find(row=>row.id==='chat-18'));
  assert.deepEqual(ids(),['chat-19','chat-0','chat-1','chat-2','chat-3','chat-4']);
  const stale={...context.listRows[0],projectKey:'local|moved'};
  await assert.rejects(context.toggleProjectPin(stale),/侧栏条目已变化/);
});

for(const mode of ['project'])test('project chats ignore legacy manual order and keep pins before recent ordinary chats in '+mode+' mode',()=>{
  const {context,nodes}=fixture(mode);
  context.listRows=Array.from({length:9},(_,i)=>({id:'chat-'+i,host:'local',projectKey:'local|p',projectName:'Project',title:'Chat '+i,recency:100-i}));
  context.localStorage.setItem('legacy|project-thread-order:local|p',JSON.stringify(context.listRows.map(row=>row.id).reverse()));
  // Recreate the old reader so this test also catches the previous renderer.
  context.projectThreadOrder=vm.runInContext('new SidebarItemOrder(localStorage,"legacy|project-thread-order:")',context);
  context.projectPins.toggle('local|p','chat-7');context.projectPins.toggle('local|p','chat-8');
  context.renderList();
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),['chat-7','chat-8','chat-0','chat-1','chat-2','chat-3','chat-4']);
  assert.ok(group().children.filter(node=>node.dataset.id).every(node=>!node.draggable));
  context.listRows.find(row=>row.id==='chat-6').recency=200;context.listRows.sort((a,b)=>b.recency-a.recency);context.renderList();
  assert.deepEqual(ids(),['chat-7','chat-8','chat-6','chat-0','chat-1','chat-2','chat-3']);
  context.listRows.find(row=>row.id==='chat-8').recency=300;context.listRows.sort((a,b)=>b.recency-a.recency);context.renderList();
  assert.deepEqual(ids(),['chat-8','chat-7','chat-6','chat-0','chat-1','chat-2','chat-3']);
  context.listRenderStamp='';context.renderList();
  assert.deepEqual(ids(),['chat-8','chat-7','chat-6','chat-0','chat-1','chat-2','chat-3']);
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

test('分区项目默认显示明确状态，初始灰点和普通置顶聊天点击后分页显示',async()=>{
  const {context,nodes}=fixture();
  context.listRows=Array.from({length:32},(_,i)=>({id:'chat-'+i,host:'local',title:'Chat '+i,projectKey:'local|p',projectName:'Project',recency:100-i}));
  context.listRows.push({id:'other',host:'local',title:'Other',projectKey:'local|other',projectName:'Other'});
  const activity=context.sessionActivity;
  activity.update([
    {id:'chat-25',host:'local',connected:true,status:'idle',waitingForUser:true},
    {id:'chat-26',host:'local',connected:true,status:'active'},
    {id:'chat-27',host:'local',connected:false,status:'unknown'},
    {id:'chat-28',host:'local',connected:true,status:'idle',completionToken:'turn:interrupted'},
  ]);
  activity.markUnread('local|chat-29');
  activity.updateSideChat({id:'chat-30',host:'local'},{id:'side',connected:true,status:'active'});
  context.projectPins.toggle('local|p','chat-26');context.projectPins.toggle('local|p','chat-24');
  const group=key=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key);
  const ids=()=>group('local|p').children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  const more=()=>group('local|p').querySelectorAll('.project-load-more')[0]||group('local|p').querySelectorAll('.project-chat-toggle')[0];
  context.renderList();
  const marked=['chat-26','chat-25','chat-28','chat-29','chat-30'];
  assert.deepEqual(ids(),marked,'红绿蓝橙及侧边汇总标记默认显示，带标记的置顶优先');
  assert.equal(group('local|other').children.filter(node=>node.dataset.id).length,0);
  const ordinary=['chat-24',...Array.from({length:24},(_,i)=>'chat-'+i),'chat-27','chat-31'];
  for(const count of [3,13,23,27]){
    await more().onclick({preventDefault(){},stopPropagation(){}});
    assert.deepEqual(new Set(ids()),new Set([...marked,...ordinary.slice(0,count)]));
    assert.equal(ids()[0],'chat-24','加载后仍保持项目置顶优先');
    assert.equal(group('local|other').children.filter(node=>node.dataset.id).length,0,'加载进度不影响其他项目');
    context.listRows[0].title+='!';context.renderList();
    assert.equal(ids().length,marked.length+count,'刷新保留加载进度');
  }
  assert.equal(group('local|p').querySelectorAll('.project-load-more').length,0);
  assert.equal(more()['aria-expanded'],'true');
});

for(const marked of [0,1,2])test('分区项目只有 '+marked+' 条状态聊天时，箭头仅放在标题且空项目不显示入口',async()=>{
  const {context,nodes,selected}=fixture();
  context.listRows=Array.from({length:marked+3},(_,i)=>({id:'small-'+i,host:'local',title:'Small '+i,projectKey:'local|p',projectName:'Project',recency:100-i}));
  context.sessionActivity.update(context.listRows.slice(0,marked).map(row=>({...row,connected:true,status:'active'})));
  context.renderList();
  const group=key=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key);
  const toggle=()=>group('local|p').querySelectorAll('.project-chat-toggle')[0];
  const count=()=>group('local|p').children.filter(node=>node.dataset.id).length;
  assert.equal(count(),marked);
  assert.equal(group('local|p').querySelectorAll('.project-load-more').length,0);
  assert.equal(group('local|empty').querySelectorAll('.project-chat-toggle').length,0);
  let prevented=false,stopped=false;
  group('local|p').open=false;
  await toggle().onclick({preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.ok(prevented&&stopped);assert.equal(group('local|p').open,true);
  assert.equal(count(),marked+3);assert.equal(toggle()['aria-expanded'],'true');
  assert.equal(group('local|p').querySelectorAll('.project-load-more').length,0);
  toggle().onclick({preventDefault(){},stopPropagation(){}});
  assert.equal(count(),marked);assert.equal(toggle()['aria-expanded'],'false');
  group('local|p').querySelectorAll('.project-create')[0].onclick({preventDefault(){},stopPropagation(){}});
  assert.equal(selected[0].key,'local|p');assert.equal(count(),marked);
});

test('标题加载失败可通过底部箭头重试，已确认空项目不保留展开入口',async()=>{
  const {context,nodes}=fixture();context.listHasMore=true;
  const group=key=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key);
  context.loadList=async()=>{throw Error('offline');};
  await context.loadProjectChats('local|empty');
  assert.equal(context.projectPage('local|empty').expanded,true);
  assert.equal(group('local|empty').querySelectorAll('.project-load-more')[0].disabled,false);
  context.loadList=async()=>{context.listHasMore=false;return true;};
  await group('local|empty').querySelectorAll('.project-load-more')[0].onclick();
  assert.equal(context.projectPage('local|empty').expanded,false);
  assert.equal(group('local|empty').querySelectorAll('.project-chat-toggle').length,0);
});

test('标题转圈期间可以收起，旧读取完成不能恢复展开',async()=>{
  const {context,nodes}=fixture();context.listHasMore=true;
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const toggle=()=>group().querySelectorAll('.project-chat-toggle')[0];
  let finish;context.loadList=()=>new Promise(resolve=>finish=resolve);
  const pending=context.loadProjectChats('local|p');
  assert.equal(toggle()['aria-busy'],'true');assert.equal(toggle().disabled,false);
  toggle().onclick({preventDefault(){},stopPropagation(){}});
  context.listRows.push(...Array.from({length:15},(_,i)=>({...context.listRows[0],id:'arrow-late-'+i})));
  context.listHasMore=false;finish(true);await pending;
  assert.equal(context.projectPage('local|p').expanded,false);
  assert.equal(toggle()['aria-expanded'],'false');
  assert.deepEqual(group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id),['thread']);
});

test('分区项目已显示的聊天在已读和状态消失后留在原处，新页面才恢复默认筛选',()=>{
  const {context,nodes}=fixture();
  const project=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>project().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),['thread']);
  context.sessionActivity.update([{id:'thread',host:'local',connected:true,status:'idle'}]);context.renderList();
  assert.deepEqual(ids(),['thread']);
  context.sessionActivity.markUnread('local|thread');context.renderList();assert.deepEqual(ids(),['thread']);
  context.sessionActivity.read('local|thread',{explicit:true});context.renderList();assert.deepEqual(ids(),['thread']);
  context.listRenderStamp='';context.renderList();assert.deepEqual(ids(),['thread'],'普通重绘和后台刷新不会移除刚读完的聊天');
  context.projectChatPages.clear();context.listRenderStamp='';context.renderList();assert.deepEqual(ids(),[],'新页面不保留无状态聊天');
  nodes['list-mode'].value='project';context.renderList();assert.deepEqual(ids(),['thread','direct']);
  nodes['list-mode'].value='codex';context.renderList();assert.deepEqual(ids(),[],'按项目的默认五条不会泄漏到分区视图');
});

test('首次未知的灰点不批量展开聊天，读取为空闲后列表保持稳定',async()=>{
  const {context,nodes}=fixture();
  context.listRows=Array.from({length:12},(_,i)=>({id:'gray-'+i,host:'local',title:'Gray '+i,projectKey:'local|p',projectName:'Project',recency:100-i}));
  const ids=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p').children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  context.sessionActivity.update(context.listRows.map(row=>({...row,connected:false,status:'unknown'})));context.renderList();
  assert.deepEqual(ids(),[],'尚未确认的灰点不使整个项目先展开');
  context.sessionActivity.update(context.listRows.map(row=>({...row,connected:true,status:'idle'})));context.renderList();
  assert.deepEqual(ids(),[],'状态读取结束后不会大批消失');
  context.sessionActivity.update([{...context.listRows[11],connected:true,status:'active'}]);context.renderList();
  assert.deepEqual(ids(),['gray-11'],'明确的运行状态仍能自动出现');
  context.sessionActivity.update([{...context.listRows[11],connected:false,status:'unknown'}]);
  context.sessionActivity.now=()=>1000000;context.renderList();
  assert.equal(context.sessionActivity.indicator('local|gray-11').kind,'unknown','断线缓冲到期后确实显示灰点');
  assert.deepEqual(ids(),['gray-11'],'已显示的聊天遇到断线灰点仍保留');
  await context.loadProjectChats('local|p');
  assert.equal(ids().length,4,'保留的聊天不占首次展开的三条名额');
});

test('分区首次展开只计无标记聊天，并跨全局分页补足三条',async()=>{
  const {context,nodes}=fixture();context.listHasMore=true;
  let reads=0;
  context.loadList=async()=>{
    reads++;
    if(reads===1){context.listRows.push({...context.listRows[0],id:'marked'});context.sessionActivity.markUnread('local|marked');}
    else{context.listRows.push(...Array.from({length:12},(_,i)=>({...context.listRows[0],id:'idle-'+i})));context.listHasMore=false;}
    return true;
  };
  await context.loadProjectChats('local|p');assert.equal(reads,2);
  const group=nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  assert.equal(group.children.filter(node=>node.dataset.id).length,5,'两条带标记聊天不占三条普通聊天名额');
  assert.equal(context.projectPage('local|p').statusLimit,3);
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

test('分区状态刷新保留刚展开但尚未派发 toggle 事件的项目',()=>{
  const {context,nodes}=fixture();
  const project=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  project().open=false;project().ontoggle();
  project().open=true;
  context.listRows[0].title='Updated';context.renderList();
  assert.equal(project().open,true,'立即采用当前节点的展开状态，不被旧的已折叠存储覆盖');
});

function bindSidebarMenu({context}){
  vm.runInContext(fs.readFileSync('web/features/chat/sidebar-management.js','utf8'),context);
  context.sidebarManagement=new context.SidebarManagementUI({snapshot:()=>context.sidebarData});
  context.ChatContextMenu=class{constructor(_root,items){context.menuItems=items;}};
  vm.runInContext(source.slice(source.indexOf("new ChatContextMenu($('sessions'),"),source.indexOf('\nasync function changeSidebarPlacement(')),context);
}

for(const mode of ['codex','project'])for(const native of [true,false])test('复制项目主目录，保留本机远程路径且不读取聊天，视图='+mode+'，原生菜单='+native,async()=>{
  const f=fixture(mode),{context,nodes}=f;bindSidebarMenu(f);
  if(!native)context.sidebarManagement=null;
  const cwd='D:\\项目 文件夹\\主目录';
  context.sidebarData.projects[0].cwd=cwd;
  context.sidebarData.projects.push({key:'ssh|p',host:'ssh',name:'远程项目',cwd:'/home/user/项目 space'},
    {key:'local|missing',host:'local',name:'无目录'});
  context.listRows[0].cwd=cwd+'\\子目录';
  context.listRows.push({id:'cli',host:'local',projectKey:'cli|local|fixture',projectName:'CLI 目录',cwd:'/cli/work',title:'CLI Chat',access:{source:'cli'}});
  context.renderList();
  const copies=[],copyButton={};
  context.window={BridgeClipboard:{copy:async(getText,button)=>copies.push({text:await getText(),button})}};
  context.api=()=>{throw Error('复制项目路径不应请求接口或打开聊天');};
  const menu=key=>context.menuItems(nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key).children[0]);
  for(const [key,path] of [['local|p',cwd],['local|empty','/empty'],['ssh|p','/home/user/项目 space'],['cli|local|fixture','/cli/work']]){
    const items=menu(key),copy=items.find(row=>row.label==='复制项目路径');
    assert.equal(items.filter(row=>row.label==='复制项目路径').length,1);
    assert.equal(copy.copy,true);assert.equal(copy.disabled,false);
    await copy.run(copyButton);assert.deepEqual(copies.at(-1),{text:path,button:copyButton});
  }
  assert.equal(menu('local|missing').find(row=>row.label==='复制项目路径').disabled,true);
  const chat=nodes.sessions.querySelectorAll('.session').find(node=>node.dataset.id==='thread');
  assert.ok(!context.menuItems(chat).some(row=>row.label==='复制项目路径'),'聊天菜单保留复制会话路径的独立含义');
});

for(const mode of ['codex','project'])for(const native of [true,false])test('项目右键菜单保留置顶和取消置顶，视图='+mode+'，原生菜单='+native,async()=>{
  const f=fixture(mode),{context,nodes}=f;bindSidebarMenu(f);
  if(!native)context.sidebarManagement=null;
  vm.runInContext(source.slice(source.indexOf('async function changeSidebarPlacement('),source.indexOf('\nfunction openSidebarPlacement(')),context);
  context.sidebarData.projects.push({key:'ssh|remote',host:'ssh',name:'Remote'});
  context.renderList();
  const group=key=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key);
  const menu=key=>context.menuItems(group(key).children[0]);
  for(const key of ['local|p','local|empty','ssh|remote']){
    const original=JSON.stringify(context.sidebarData),before=menu(key);
    const pin=before.find(row=>row.label==='置顶');
    assert.ok(pin,'项目右键菜单应显示置顶：'+key);
    assert.ok(!pin.disabled,'远程项目也能使用网关共享置顶');
    assert.equal(before.filter(row=>row.label==='移动到分区…').length,1,'保留单一分区移动入口');
    await pin.run();
    assert.equal(group(key).parent.dataset.section,'pinned','点击后进入置顶分区');
    context.listRenderStamp='';context.renderList();
    const unpin=menu(key).find(row=>row.label==='取消置顶');
    assert.ok(unpin,'刷新后菜单显示取消置顶');
    assert.ok(!menu(key).some(row=>row.label==='置顶'));
    await unpin.run();
    assert.equal(group(key).parent.dataset.section,key==='local|p'?'custom':'projects','取消后回到原分区或普通项目');
    assert.ok(menu(key).some(row=>row.label==='置顶'));
    assert.equal(JSON.stringify(context.sidebarData),original,'置顶复用共享偏好，不改写原生项目');
  }
});

for(const native of [true,false])test('项目菜单隐藏无状态聊天并保留其他项目和加载更多入口，原生菜单='+native,async()=>{
  const f=fixture(),{context,nodes}=f;
  context.listRows.push(...Array.from({length:12},(_,i)=>({...context.listRows[0],id:'idle-'+i})),{...context.listRows[0],id:'other',projectKey:'local|other'});
  context.sessionActivity.markUnread('local|idle-11');
  context.renderList();bindSidebarMenu(f);
  if(!native)context.sidebarManagement=null;
  await context.loadProjectChats('local|p');await context.loadProjectChats('local|other');
  const group=key=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key);
  const ids=key=>group(key).children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  context.sessionActivity.read('local|idle-11',{explicit:true});context.renderList();
  const beforeRows=JSON.stringify(context.listRows),other=ids('local|other');
  assert.ok(ids('local|p').includes('idle-0'));
  group('local|p').open=false;group('local|p').ontoggle();
  const action=context.menuItems(group('local|p').children[0]).find(row=>row.label==='隐藏无状态聊天');
  assert.ok(action);action.run();
  assert.deepEqual(ids('local|p'),['thread'],'收起加载出的普通聊天及已读保留聊天，保留有状态聊天');
  assert.equal(group('local|p').open,false,'保留项目折叠状态');
  assert.deepEqual(ids('local|other'),other,'只收起当前项目');
  assert.equal(JSON.stringify(context.listRows),beforeRows,'只修改本页面显示，不改聊天和归属');
  context.listRows[0].title='Updated';context.renderList();assert.deepEqual(ids('local|p'),['thread']);
  assert.ok(group('local|p').querySelectorAll('.project-chat-toggle').length);
  await context.loadProjectChats('local|p');assert.equal(ids('local|p').length,4,'隐藏后再次展开仍只加载三条普通聊天');
});

test('隐藏无状态聊天使在途加载更多失效，旧回包不会重新展开',async()=>{
  const f=fixture(),{context,nodes}=f;bindSidebarMenu(f);context.listHasMore=true;
  let finish;context.loadList=()=>new Promise(resolve=>finish=resolve);
  const pending=context.loadProjectChats('local|p');
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  context.menuItems(group().children[0]).find(row=>row.label==='隐藏无状态聊天').run();
  context.listRows.push(...Array.from({length:15},(_,i)=>({...context.listRows[0],id:'late-'+i})));
  context.listHasMore=false;finish(true);await pending;
  assert.equal(context.projectPage('local|p').statusLimit,0);
  assert.deepEqual(group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id),['thread']);
});

test('无状态聊天隐藏入口仅属于分区项目，过期项目操作不会影响现有项目',()=>{
  const f=fixture(),{context,nodes}=f;bindSidebarMenu(f);
  const group=nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const action=context.menuItems(group.children[0]).find(row=>row.label==='隐藏无状态聊天');
  assert.ok(!context.menuItems(group.children.find(node=>node.dataset.id)).some(row=>row.label==='隐藏无状态聊天'));
  nodes['list-mode'].value='project';assert.ok(!context.menuItems(group.children[0]).some(row=>row.label==='隐藏无状态聊天'));
  context.sidebarData.projects=[];context.listRows=[];
  assert.throws(()=>action.run(),/侧栏条目已变化/);
});

test('新建聊天没有状态也立即显示，列表接管和隐藏普通聊天后继续保留',async()=>{
  const f=fixture(),{context,nodes}=f;bindSidebarMenu(f);
  context.listRows.push(...Array.from({length:12},(_,i)=>({...context.listRows[0],id:'idle-'+i})));
  const attempt={project:'local|p',kind:'desktop',title:'New chat',autoTitle:false};
  context.rememberCreatedChat({id:'created',host:'local'},attempt);
  const group=()=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  const ids=()=>group().children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.deepEqual(ids(),['created','thread'],'尚无运行状态时立即显示新聊天');
  assert.equal(context.sessionActivity.indicator('local|created'),null,'保留显示不制造状态圆点');
  const pending=context.mergeCreatedChats(context.listRows.filter(row=>row.id!=='created'),'local','',false,'all');
  assert.ok(pending.some(row=>row.id==='created'),'后台列表暂未包含新聊天时仍保留');
  context.listRows=context.mergeCreatedChats(context.listRows.map(row=>row.id==='created'?{...row,title:'Native title'}:row),'local','',false,'all');context.renderList();
  assert.equal(context.createdChats.size,0,'权威列表接管后不继续使用临时元数据');
  await context.loadProjectChats('local|p');assert.equal(ids().length,5,'新聊天不占首次展开的三条分页名额');
  context.menuItems(group().children[0]).find(row=>row.label==='隐藏无状态聊天').run();
  assert.deepEqual(ids(),['created','thread'],'隐藏操作保留新聊天');
  context.sessionActivity.update([{id:'created',host:'local',connected:true,status:'idle'}]);
  context.projectChatPages.clear();context.listRenderStamp='';context.renderList();
  assert.deepEqual(ids(),['created','thread'],'本页面筛选和项目分页重建后仍保留');
});

test('新建聊天的显示保留按主机隔离，不使其他主机的同名标识聊天展开',()=>{
  const {context,nodes}=fixture();
  context.listRows.push({...context.listRows[0],id:'created',host:'ssh',projectKey:'ssh|p'});
  context.rememberCreatedChat({id:'created',host:'local'},{project:'local|p',kind:'desktop',title:'New chat'});
  const ids=key=>nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey===key).children.filter(node=>node.dataset.id).map(node=>node.dataset.id);
  assert.ok(ids('local|p').includes('created'));assert.deepEqual(ids('ssh|p'),[]);
});

for(const mode of ['codex','project'])test('project and chat menus do not offer manual chat ordering in '+mode+' mode',()=>{
  const f=fixture(mode),{context,nodes}=f;
  context.renderList();bindSidebarMenu(f);
  const group=nodes.sessions.querySelectorAll('.project-group').find(node=>node.dataset.projectKey==='local|p');
  assert.ok(!context.menuItems(group.children[0]).some(item=>item.label==='聊天按最近交互排序'));
  context.sidebarManagement=null;
  const button=group.children.find(node=>node.dataset.id),labels=context.menuItems(button).map(item=>item.label);
  assert.ok(labels.includes('在项目内置顶'));
  assert.ok(!labels.includes('在项目中上移')&&!labels.includes('在项目中下移'));
});

for(const mode of ['codex','project'])test('native project management retains sibling ordering in '+mode+' mode',async()=>{
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
  await first.find(row=>row.label==='下移').run();
  const scope=mode==='codex'?'custom':'projects';
  assert.deepEqual(Array.from(context.sectionProjectOrder.sort(scope,['local|p','local|b','ssh|r'])),['local|b','local|p','ssh|r']);
  const ordered=keys();assert.ok(ordered.indexOf('local|b')<ordered.indexOf('local|p'));
  const remote=menu('ssh|r');assert.equal(remote.find(row=>row.label==='修改名称').disabled,true);
  assert.equal(remote.find(row=>row.label==='上移').disabled,false);assert.equal(remote.find(row=>row.label==='下移').disabled,true);
  await remote.find(row=>row.label==='上移').run();
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
test('最近交互的蓝点已读后保留位置，轮询不会使聊天突然掉到列表后面',()=>{
  const {context,nodes}=fixture('recent'),activity=context.sessionActivity;
  context.listRows=[{id:'newer',recency:100},{id:'older',recency:1}].map(row=>({...row,host:'local',title:row.id,projectKey:'local|p',projectName:'Project'}));
  activity.update(context.listRows.map(row=>({...row,connected:true,status:'idle'})));
  activity.markUnread('local|older');context.renderList();
  const ids=()=>nodes.sessions.children.map(node=>node.dataset.id);
  assert.deepEqual(ids(),['older','newer']);
  activity.read('local|older',{explicit:true,sync:false});context.renderList();
  assert.equal(activity.indicator('local|older'),null,'已读仍正常清除蓝点');
  assert.deepEqual(ids(),['older','newer'],'已读不能马上移动聊天');
  activity.update(context.listRows.map(row=>({...row,connected:true,status:'idle'})));context.renderList();
  assert.deepEqual(ids(),['older','newer'],'后续轮询仍保留位置');
  nodes['list-mode'].value='project';context.renderList();nodes['list-mode'].value='recent';context.renderList();
  assert.deepEqual(ids(),['newer','older'],'重新进入列表恢复实时状态排序');
  assert.deepEqual(context.listRows.map(row=>row.recency),[100,1]);
});

test('recent mode preserves the flat list and project mode offers creation',()=>{
  const recent=fixture('recent');assert.equal(recent.nodes.sessions.children.length,2);
  assert.ok(recent.nodes.sessions.children.every(n=>n.className.startsWith('session')));
  const grouped=fixture('project');assert.equal(grouped.nodes.sessions.children.length,2);
  assert.equal(grouped.nodes.sessions.children[0].children[0].children[1].className,'plain project-create');
});

test('最近交互位置保留隔离主机，筛选、移除、清理身份和新页面均不复活旧位置',()=>{
  const saved=new Map(),storage={getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
  const activity=new SessionActivity({storage}),keys=['local|same','remote|same'];
  activity.markUnread(keys[0]);assert.deepEqual([...activity.recentStatusKeys(keys,'all')],[keys[0]]);
  activity.read(keys[0],{explicit:true,sync:false});assert.deepEqual([...activity.recentStatusKeys(keys,'all')],[keys[0]]);
  assert.deepEqual([...new SessionActivity({storage}).recentStatusKeys(keys,'all')],[],'只保存真实已读记录，不保存位置保留');
  assert.deepEqual([...activity.recentStatusKeys(keys,'filtered')],[]);
  activity.markUnread(keys[0]);activity.recentStatusKeys(keys,'filtered');activity.forget(keys[0]);
  assert.deepEqual([...activity.recentStatusKeys(keys,'filtered')],[]);
  activity.markUnread(keys[1]);activity.recentStatusKeys(keys,'filtered');activity.clear();
  assert.deepEqual([...activity.recentStatusKeys(keys,'filtered')],[]);
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
    newChatProjectPicker:null,newChatSidebar:null,newChatProjectRequest:0,sidebarData:{projects},sidebarPreferences:{refresh:async()=>{}},
    document:{createElement:()=>({append(){}})},newChatProjectGroups:()=>[{id:'projects',name:'项目',projects}],SidebarProjectGroups:{host:()=> '此电脑'},
    NewChatProjectPicker:class{constructor(){this.button={};}close(){}setGroups(){}sync(){}},
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
