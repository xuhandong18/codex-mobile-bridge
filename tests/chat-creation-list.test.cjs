'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/shell/app.js','utf8');
function fixture({preferences={},settings=async()=>({confirmed:true}),openError=null,read=read=>read(),opening=async()=>{}}={}){
  const calls=[],notices=[],storage=new Map(),nodes=new Map(),id='11111111-1111-4111-8111-111111111111';
  const $=key=>{if(!nodes.has(key))nodes.set(key,{value:'',dataset:{},textContent:'',disabled:false,open:true,querySelectorAll:()=>[],close(){this.open=false;}});return nodes.get(key);};
  $('new-chat-project').value='local|p';$('new-chat-title').value='New chat';$('new-chat-title').dataset.edited='true';$('new-chat-type').value='desktop';
  const context={$,t:x=>x,creatingChat:false,setLanguageBusy(){},newChatSettings:{loading:false,value:()=>preferences,key:'local|desktop',model:{value:''},defaults:{remember(){}}},
    sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},localStorage:{setItem(){}},
    newChatScopes:new Map(),newChatProjects:[{key:'local|p',name:'Project',host:'local',cwd:'/project'}],listRows:[],sidebarData:{projects:[],sections:[]},listRenderStamp:'',createdChats:new Map(),listSource:'all',renderSourceFilter(){},
    waitForCreatedChat:read,confirm:()=>true,sessionUrl:(id,action)=>'/'+action,uuid:()=>id,chatKey:(id,host)=>host+'|'+id,
    api:async(url,body)=>{calls.push({url,body});return url==='/api/sessions'?{id,host:'local',message:'Created'}:settings(url,body);},toast:message=>notices.push(message),renderList(){},
    loadList:()=>new Promise(()=>{}),document:{querySelector:()=>({disabled:false})},
    openChat:async()=>{assert.equal(context.listRows.filter(row=>row.id===id).length,1,'created chat must already be in the sidebar');await opening();if(openError)throw Error(openError);},applyingNewChat:null,applyingNewChatPreferences:null,state:null};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function rememberCreatedChat('),source.indexOf('function renderList(){')),context);
  vm.runInContext(source.slice(source.indexOf("$('new-chat-form').onsubmit="),source.indexOf('const messageActions=')),context);
  return {calls,notices,context,$,id,submit:()=>$('new-chat-form').onsubmit({preventDefault(){}})};
}
const selected={model:'model-b',effort:'xhigh',permission:'full-access'};

test('新聊天设置不等待聊天历史读取',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const ui=fixture({preferences:selected,opening:()=>pending}),submit=ui.submit();
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(ui.calls.some(call=>call.url==='/settings'),'模型和思考程度应在历史仍未返回时提交');
    assert.ok(ui.calls.some(call=>call.url==='/permissions'),'权限应在历史仍未返回时提交');
    assert.equal(ui.context.applyingNewChat,'local|'+ui.id,'设置未处理完前保持发送保护');
  }finally{release();await submit;}
});

test('新聊天不再重复预读元数据才打开页面',async()=>{
  const ui=fixture({preferences:selected,read:()=>{throw Error('不应重复预读');}});await ui.submit();
  assert.deepEqual(ui.calls.map(call=>call.url),['/api/sessions','/settings','/permissions']);
  assert.equal(ui.notices.some(message=>message.includes('不应重复预读')),false);
});

test('模型确认仍在等待时权限独立提交，所有写入只执行一次',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const ui=fixture({preferences:selected,settings:url=>url==='/settings'?pending:Promise.resolve({confirmed:true})}),submit=ui.submit();
  try{
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(ui.calls.map(call=>call.url),['/api/sessions','/settings','/permissions']);
    assert.equal(ui.context.applyingNewChat,'local|'+ui.id);
  }finally{release({confirmed:false});await submit;}
  assert.equal(ui.context.applyingNewChat,null);assert.equal(ui.context.applyingNewChatPreferences,null);
  assert.equal(ui.calls.filter(call=>call.url==='/settings').length,1);
  assert.ok(ui.notices.some(message=>message.includes('模型和推理强度：')));
});
test('a confirmed new chat appears before its background list refresh returns',async()=>{
  const ui=fixture();await ui.submit();
  assert.equal(ui.context.listRows.filter(row=>row.id===ui.id).length,1);
  assert.deepEqual(ui.calls.map(call=>call.url),['/api/sessions']);
});

test('choosing no project submits an independent chat even when another project was selected before',async()=>{
  const ui=fixture();
  ui.context.listRows=[{id:'previous',host:'local',projectKey:'local|p',title:'Previous'}];
  ui.$('new-chat-project').value='local|independent';
  await ui.submit();
  assert.equal(ui.calls[0].body.project,'local|independent');
  const row=ui.context.listRows.find(row=>row.id===ui.id);
  assert.equal(row.projectKey,'local|independent');
  assert.equal(row.projectName,'独立聊天');
  assert.equal(row.cwd,'');
});
for(const failure of ['unconfirmed','failed'])test(failure+' model settings do not skip explicitly selected full access',async()=>{
  const ui=fixture({preferences:selected,settings:async url=>{
    if(url==='/permissions')return {confirmed:true};
    if(failure==='failed')throw Error('settings unavailable');
    return {confirmed:false};
  }});
  await ui.submit();
  assert.deepEqual(ui.calls.map(call=>call.url),['/api/sessions','/settings','/permissions']);
  assert.equal(ui.calls[1].body.effort,'xhigh');assert.equal(ui.calls[2].body.confirmed,true);
  assert.ok(ui.notices.some(message=>message.includes('模型和推理强度：')));
});
test('a failed timeline read does not discard settings for the created chat',async()=>{
  const ui=fixture({preferences:selected,openError:'timeline unavailable'});await ui.submit();
  assert.deepEqual(ui.calls.map(call=>call.url),['/api/sessions','/settings','/permissions']);
  assert.ok(ui.notices.some(message=>message.includes('timeline unavailable')));
});
test('both settings are applied once and their failures are reported separately',async()=>{
  const ui=fixture({preferences:selected,settings:async url=>{throw Error(url==='/settings'?'model rejected':'permissions rejected');}});
  await ui.submit();
  assert.deepEqual(ui.calls.map(call=>call.url),['/api/sessions','/settings','/permissions']);
  const message=ui.notices.find(message=>message.includes('model rejected'));
  assert.ok(message.includes('permissions rejected'));assert.ok(message.includes('权限：'));
});
