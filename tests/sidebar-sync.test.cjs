const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('web/shell/app.js','utf8');
const render=source.slice(source.indexOf('function renderList(){'),source.indexOf('async function loadList('));
class Element{
  constructor(tag,cls='',text=''){this.tag=tag;this.className=cls;this.textContent=text;this.children=[];this.dataset={};this.scrollTop=0;}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(name,value){this[name]=value;}
  remove(){this.parent.children=this.parent.children.filter(n=>n!==this);}
}
function fixture(mode='codex'){
  const nodes={sessions:new Element('div'),'list-mode':{value:mode},search:{value:''},archived:{checked:false}};
  const selected=[];
  const context={$:id=>nodes[id],el:(...args)=>new Element(...args),localStorage:{getItem:()=>null,setItem:()=>{}},t:x=>x,BridgeI18n:{locale:()=> 'zh'},
    currentId:null,currentHost:'local',availableSources:[],listSource:'all',listRenderStamp:'',listComplete:true,listReadFinished:true,
    renderActivity(){},sessionAccess:x=>x||{source:'desktop'},sourceLabel:()=>'',dateText:()=>'',openChat:async()=>{},toast(){},openNewChat:p=>selected.push(p),
    sidebarData:{sections:[{id:'custom',name:'Daily',itemKeys:['codex:project:p'],hostSectionIds:{local:'native'}}],projects:[{key:'local|p',name:'Project',host:'local',cwd:'/work'},{key:'local|empty',name:'Empty',host:'local',cwd:'/empty'}]},
    listRows:[{id:'thread',host:'local',projectKey:'local|p',projectName:'Project',title:'Chat',recency:1},{id:'direct',host:'local',projectKey:'local|p',projectName:'Project',thread_section_id:'native',title:'Direct',recency:2}]};
  vm.createContext(context);vm.runInContext(render,context);context.renderList();return {context,nodes,selected};
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
test('recent mode preserves the flat list and project mode offers creation',()=>{
  const recent=fixture('recent');assert.equal(recent.nodes.sessions.children.length,2);
  assert.ok(recent.nodes.sessions.children.every(n=>n.className.startsWith('session')));
  const grouped=fixture('project');assert.equal(grouped.nodes.sessions.children.length,1);
  assert.equal(grouped.nodes.sessions.children[0].children[0].children[1].className,'plain project-create');
});
test('section rename is rendered on the next metadata refresh',()=>{
  const {context,nodes}=fixture();context.sidebarData.sections[0].name='Renamed';context.renderList();
  assert.equal(nodes.sessions.children.find(n=>n.dataset.section==='custom').children[0].textContent,'Renamed');
});


test('project create dialog selects the clicked project and blocks a removed project',async()=>{
  const nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',disabled:false,open:false,children:[],
    append(option){this.children.push(option);if(!this.value)this.value=option.value;},
    replaceChildren(){this.children=[];this.value='';},showModal(){this.open=true;}});return nodes.get(id);};
  const projects=[{key:'local|a',name:'A',host:'local',cwd:'/a',type:'desktop'},{key:'local|b',name:'B',host:'local',cwd:'/b',type:'desktop'}];
  const context={$,t:x=>x,creatingChat:false,newChatProjects:[],listRows:[],currentId:null,currentHost:'local',api:async()=>({projects}),
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
