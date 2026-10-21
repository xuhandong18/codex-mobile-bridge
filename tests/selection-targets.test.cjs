'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
  let next=0;const notices=[],saved=new Map(),creates=[];
  class Node{
    constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.value='';this.maxLength=20000;}
    before(){}append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}setAttribute(){}
    addEventListener(name,run){this['on'+name]=run;}dispatchEvent(event){this['on'+event.type]?.(event);}focus(){this.focused=true;}
    showModal(){this.open=true;}close(){this.open=false;this.onclose?.();}remove(){}
  }
  const document={createElement:tag=>new Node(tag),body:new Node('body')};
  const context=vm.createContext({document,window:{getSelection:()=>({removeAllRanges(){}})},Event,uuid:()=>String(++next),BridgeI18n:{t:text=>text},sessionStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)}});
  for(const file of ['file-quotes','selection-targets'])vm.runInContext(fs.readFileSync('web/features/chat/'+file+'.js','utf8'),context);
  vm.runInContext(fs.readFileSync('web/features/workspace/side-chat.js','utf8'),context);
  const Drafts=vm.runInContext('FileQuoteDrafts',context),Targets=vm.runInContext('ChatSelectionTargets',context),Panel=vm.runInContext('SideChatPanel',context);
  const draft=key=>{const input=new Node('textarea'),quotes=new Drafts({input});quotes.open(key);return quotes;};
  const session={id:'parent',key:'local|parent',host:'local',files:[]};
  const wb={current:session,sessions:new Map([[session.key,session]]),fileQuotes:draft(session.key),canQuoteMain:()=>true,
    node:(tag,cls,text)=>{const node=new Node(tag);node.className=cls;node.textContent=text;return node;},
    button:(text,run)=>{const node=new Node('button');node.textContent=text;node.onclick=run;return node;},raw:node=>node,
    notify:message=>notices.push(message),closePreviewFullscreen(){},select:id=>{session.active=id;},
    createSideChat:(_session,slot)=>{const tab={id:'sidechat:'+slot,name:'Side '+slot};
      tab.sideChat=Object.assign(Object.create(Panel.prototype),{tab,status:{},creationId:'create-'+slot,fileQuotes:draft(session.key+'|'+tab.id),collapse(){},controls(){},
        request:async body=>{creates.push({slot,body});return {id:'child-'+slot,connected:true};},apply(state){this.state=state;}});
      session.files.push(tab);return tab;}};
  const router=wb.selectionTargets=new Targets(wb);
  const choose=id=>router.dialog.children[1].children.find(button=>button.dataset.quoteTarget===id).onclick();
  return {wb,session,router,choose,notices,draft,creates};
}

test('选区操作中新建侧边聊天直接创建并保留引用，不需要再次点击创建',async()=>{
  const {wb,session,router,choose,creates}=fixture();wb.fileQuotes.input.value='主聊天草稿';
  router.addText('第一行\n第二行');choose('new-sidechat');
  const panel=session.files[0].sideChat;
  assert.equal(creates.length,1,'选择新建侧边聊天后应立即发起创建');
  assert.equal(creates[0].body.action,'create');
  await new Promise(setImmediate);
  assert.ok(panel.state?.id);assert.equal(panel.state.connected,true);
  assert.equal(panel.fileQuotes.input.value,'> 第一行\n> 第二行\n\n');
  assert.equal(wb.fileQuotes.input.value,'主聊天草稿');
  assert.equal(session.active,session.files[0].id);assert.equal(router.dialog,null);
  assert.equal(creates.length,1,'创建不会自动发送选中的内容');
});

test('message quotes can target the main draft, each existing side draft, or a fresh side draft',()=>{
  const {wb,session,router,choose,creates}=fixture(),one=wb.createSideChat(session,'one'),two=wb.createSideChat(session,'two');
  wb.fileQuotes.input.value='Existing draft';
  for(const id of ['chat',one.id,two.id,'new-sidechat']){router.addText('selected '+id);assert.equal(router.dialog.children[1].children.length,4);choose(id);}
  assert.equal(wb.fileQuotes.input.value,'Existing draft\n\n> selected chat\n\n');
  assert.equal(one.sideChat.fileQuotes.input.value,'> selected sidechat:one\n\n');
  assert.equal(two.sideChat.fileQuotes.input.value,'> selected sidechat:two\n\n');
  assert.equal(session.files[2].sideChat.fileQuotes.input.value,'> selected new-sidechat\n\n');
  assert.equal(creates.length,1);assert.equal(creates[0].slot,session.files[2].sideChat.tab.id.slice('sidechat:'.length));
  assert.equal(session.active,session.files[2].id);assert.equal(router.dialog,null);
});

test('file quotes create a ready side chat with compact tags and remain separate from the main draft',async()=>{
  const {wb,session,router,choose,creates}=fixture(),file={name:'code.js',path:'/project/code.js',text:'a long selection'};
  router.choose(session,{file});choose('new-sidechat');const side=session.files[0].sideChat;
  assert.equal(creates.length,1);await new Promise(setImmediate);assert.ok(side.state?.id);
  assert.equal(side.fileQuotes.rows[0].path,file.path);assert.equal(side.fileQuotes.rows[0].text,file.text);
  assert.equal(side.fileQuotes.input.value,'');assert.equal(wb.fileQuotes.rows.length,0);
});

test('cancelled and stale target pickers cannot change any draft or create side tabs',()=>{
  const {wb,session,router,choose,creates}=fixture();router.addText('cancel');const cancelled=router.dialog.children[1].children[0];router.close();cancelled.onclick();assert.equal(wb.fileQuotes.input.value,'');
  router.addText('stale');wb.current={};choose('new-sidechat');assert.equal(session.files.length,0);assert.equal(wb.fileQuotes.input.value,'');
  wb.current=session;const side=wb.createSideChat(session,'closed');router.addText('closed target');session.files=[];choose(side.id);
  assert.equal(side.sideChat.fileQuotes.input.value,'');
  let valid=true;router.choose(session,{file:{path:'/p',text:'closed source'}},()=>valid);valid=false;choose('new-sidechat');assert.equal(session.files.length,0);
  assert.equal(creates.length,0);
});

test('oversized references are rejected before creating a new side tab and include existing file tags in limits',()=>{
  const {wb,session,router,choose,notices,creates}=fixture();router.addText('x'.repeat(20000));choose('new-sidechat');assert.equal(session.files.length,0);assert.equal(notices.length,1);assert.equal(creates.length,0);
  router.close();wb.fileQuotes.input.maxLength=45;wb.fileQuotes.add({path:'/p',text:'x'.repeat(20)});router.addText('some more text');choose('chat');
  assert.equal(wb.fileQuotes.input.value,'');assert.equal(wb.fileQuotes.rows.length,1);assert.equal(notices.length,2);
});

test('a read-only main chat can still quote to available side drafts while unsupported providers cannot create sides',()=>{
  const {wb,session,router,choose}=fixture();wb.canQuoteMain=()=>false;const tab=wb.createSideChat(session,'one');
  router.addText('side only');assert.equal(router.dialog.children[1].children[0].disabled,true);choose(tab.id);assert.equal(tab.sideChat.fileQuotes.input.value,'> side only\n\n');
  session.provider='claude';assert.equal(router.targets(session).some(target=>target.create),false);
});

test('an initial side read finishing after creation cannot erase the quoted draft or new child identity',async()=>{
  const context=vm.createContext({BridgeI18n:{t:text=>text}});vm.runInContext(fs.readFileSync('web/features/workspace/side-chat.js','utf8'),context);
  const Panel=vm.runInContext('SideChatPanel',context),panel=Object.create(Panel.prototype);let finish;
  Object.assign(panel,{status:{},input:{value:'quoted draft'},controls(){},workbench:{syncSideChats(){}},
    request:body=>body?Promise.resolve({id:'new-child'}):new Promise(resolve=>finish=resolve),
    apply(state){if(this.state?.id&&this.state.id!==state.id)this.input.value='';this.state=state;}});
  const reading=panel.load();await panel.create();finish({id:null,slots:[]});await reading;
  assert.equal(panel.state.id,'new-child');assert.equal(panel.input.value,'quoted draft');
});
