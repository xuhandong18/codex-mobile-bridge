'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
  const context=vm.createContext({BridgeI18n:{t:x=>x}});
  vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8'),context);
  vm.runInContext(fs.readFileSync('web/features/chat/new-chat-projects.js','utf8'),context);
  return vm.runInContext('({Groups:SidebarProjectGroups,Order:SidebarItemOrder})',context);
}
test('新建项目按导航分区、原生条目和同步项目顺序排列，不混淆同名主机项目',()=>{
  const {Groups,Order}=fixture(),saved=new Map(),order=new Order({getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value)});
  const projects=['a','b','c','d','e'].map(id=>({key:'local|'+id,host:'local',name:'同名项目'}));
  projects.push({key:'remote|a',host:'remote',hostLabel:'远程主机',name:'同名项目'});
  const metadata={sections:[{id:'work',name:'工作',itemKeys:['codex:project:c','codex:project:a','codex:project:b']}],
    sectionOrder:['custom:work','pinned','projects','threads'],projectOrder:['b','a','c']};
  order.move('work',['local|c','local|a','local|b'],'local|b','local|c');
  const destination=project=>project.host==='remote'?'projects':['a','b','c'].includes(project.key.split('|')[1])?'section:work':project.key==='local|d'?'pinned':'home';
  const groups=Groups.group(projects,metadata,destination,order);
  assert.deepEqual(Array.from(groups,g=>g.id),['work','pinned','projects']);
  assert.deepEqual(Array.from(groups[0].projects,p=>p.key),['local|b','local|c','local|a']);
  assert.deepEqual(Array.from(groups[2].projects,p=>p.key),['remote|a','local|e']);
});

test('分区缺失时保留可用项目，搜索能匹配分区、主机、目录且保持原顺序',()=>{
  const {Groups}=fixture(),projects=[{key:'local|a',host:'local',name:'前端',cwd:'D:/long/project'},
    {key:'ssh|b',host:'ssh',hostLabel:'生产主机',name:'后端',cwd:'/srv/api'}];
  const groups=Groups.group(projects,{},()=> 'section:deleted',{sort:(_scope,ids)=>ids});
  assert.equal(groups.length,1);assert.equal(groups[0].id,'projects');
  assert.deepEqual(Array.from(Groups.filter(groups,'生产主机')[0].projects,p=>p.key),['ssh|b']);
  assert.deepEqual(Array.from(Groups.filter(groups,'D:/LONG')[0].projects,p=>p.key),['local|a']);
  assert.equal(Groups.filter(groups,'项目')[0].projects.length,2);
  assert.equal(Groups.filter(groups,'没有匹配').length,0);
});
