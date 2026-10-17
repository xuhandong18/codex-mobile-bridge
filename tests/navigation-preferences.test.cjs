'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const scripts=['web/layouts/viewport.js','web/features/chat/context-menu.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
function fixture(){
  const values=new Map(),buttons=[],classes=new Set(),changes={},events={},tasks=new Map();let nextTimer=0;
  const media={matches:true,addEventListener(name,fn){changes[name]=fn;}};
  const context=vm.createContext({matchMedia:()=>media,BridgeI18n:{t:x=>x},localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},
    document:{createElement:()=>({setAttribute(){}}),addEventListener(){},querySelector:()=>null},setTimeout:fn=>{tasks.set(++nextTimer,fn);return nextTimer;},clearTimeout:id=>tasks.delete(id),Date,Math,
    root:{classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);}},querySelectorAll:()=>[{prepend(button){buttons.push(button);}}],addEventListener(name,fn){events[name]=fn;}}});
  vm.runInContext(scripts,context);return {context,values,buttons,classes,media,changes,events,tasks,run:code=>vm.runInContext(code,context)};
}
test('sidebar choice survives viewport changes and new controller instances',()=>{
  const ui=fixture();ui.run('var navigation=new SidebarNavigation(root)');assert.ok(ui.classes.has('sidebar-open'));
  ui.buttons[0].onclick();assert.equal(ui.values.get('navigation:sidebar'),'closed');
  ui.media.matches=false;ui.changes.change();ui.media.matches=true;ui.changes.change();assert.ok(ui.classes.has('sidebar-closed'));
  ui.run('navigation=new SidebarNavigation(root)');assert.ok(ui.classes.has('sidebar-closed'));
  ui.run('navigation.set(true)');ui.media.matches=false;ui.changes.change();assert.ok(ui.classes.has('sidebar-open'));
});
test('new chat defaults retain partial changes and isolate account, host and chat kind',()=>{
  const ui=fixture();ui.run("var defaults=new NewChatDefaults();defaults.remember('account|local|desktop',{model:'fixture',effort:'high'});defaults.remember('account|local|desktop',{permission:'ask'});");
  assert.deepEqual(JSON.parse(ui.values.get('new-chat-defaults:account|local|desktop')),{model:'fixture',effort:'high',permission:'ask'});
  for(const scope of ['other|local|desktop','account|remote|desktop','account|local|cli'])assert.equal(ui.run(`Object.keys(defaults.read('${scope}')).length`),0);
  ui.values.set('new-chat-defaults:broken','null');assert.equal(ui.run("Object.keys(defaults.read('broken')).length"),0);
});
test('touch long press cancels on scrolling or movement and suppresses the subsequent row click',()=>{
  const ui=fixture();ui.run('var menu=new ChatContextMenu(root,()=>[]);var opened=0;menu.open=()=>{opened++;return true;}');
  const pointer={pointerType:'touch',isPrimary:true,clientX:30,clientY:40,target:{}};
  ui.events.pointerdown(pointer);ui.events.pointermove({...pointer,clientX:50});assert.equal(ui.tasks.size,0);
  ui.events.pointerdown(pointer);ui.events.scroll();assert.equal(ui.tasks.size,0);
  ui.events.pointerdown(pointer);[...ui.tasks.values()][0]();assert.equal(ui.run('opened'),1);
  let prevented=false,stopped=false;ui.events.click({preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});assert.ok(prevented&&stopped);
});

test('copy session path returns the native thread link for local, remote and CLI chats',async()=>{
  const source=fs.readFileSync('web/shell/app.js','utf8');
  const menu=source.slice(source.indexOf("new ChatContextMenu($('sessions'),"),source.indexOf('\nfunction sidebarPlacementActions'));
  const id='01a14508-cf48-75f2-a75b-5a7244ea67ff';
  for(const [host,origin,archived] of [['local','desktop',false],['ssh:fixture','desktop',true],['local','cli',false]]){
    const button={dataset:{id,host}},copyButton={},copies=[];let items;
    const context=vm.createContext({$:()=>({}),sidebarManagement:null,ChatContextMenu:class{constructor(_root,callback){items=callback;}},
      listRows:[{id,host,archived,access:{source:origin}}],sidebarEntry:()=>({}),sidebarPlacementActions:()=>[],projectChatRows:()=>[],sessionAccess:access=>access,sessionUrl:()=>'/fixture/record-path',
      api:()=>{throw Error('Copying a chat link must not read its rollout file');},
      window:{BridgeClipboard:{copy:async(getText,button)=>copies.push({text:await getText(),button})}}});
    vm.runInContext(menu,context);
    const copy=items({closest:()=>button}).find(item=>item.label==='复制会话路径');
    assert.equal(copy.copy,true);await copy.run(copyButton);
    assert.deepEqual(copies,[{text:'codex://threads/'+id,button:copyButton}]);
  }
});

test('message touch selection retains the Android menu while a mouse right-click opens web actions',()=>{
  const ui=fixture();ui.run('var menu=new ChatContextMenu(root,()=>[],{touch:false});var opened=0;menu.open=()=>{opened++;return true;}');
  const touch={pointerType:'touch',isPrimary:true,clientX:30,clientY:40,target:{}};
  ui.events.pointerdown(touch);assert.equal(ui.tasks.size,0);
  let prevented=false;ui.events.contextmenu({...touch,preventDefault(){prevented=true;}});
  assert.equal(ui.run('opened'),0);assert.equal(prevented,false);
  ui.events.contextmenu({...touch,pointerType:'mouse',preventDefault(){prevented=true;}});
  assert.equal(ui.run('opened'),1);assert.equal(prevented,true);
});
