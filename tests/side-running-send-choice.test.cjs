'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const tick=()=>new Promise(setImmediate);
const busyError=()=>Object.assign(Error('请先等待回复完成，或选择完成后发送／补充当前任务'),{status:400});

function fixture({active=true}={}){
  class Element{
    constructor(tag='div',className='',textContent=''){Object.assign(this,{tag,className,textContent,children:[],dataset:{},listeners:{},value:'',open:false});this.classList={add(){},toggle(){}};}
    append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
    before(){}
    replaceChildren(...nodes){this.children=[];this.append(...nodes);}
    setAttribute(name,value){this[name]=value;}
    querySelector(selector){return this.options?.find(option=>selector.includes(option.value));}
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
    showModal(){this.open=true;}
    close(){if(!this.open)return;this.open=false;for(const fn of this.listeners.close||[])fn();}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
    focus(){document.activeElement=this;}
  }
  const document={body:new Element('body'),createElement:tag=>new Element(tag)},calls=[];
  const context=vm.createContext({document,uuid:()=> 'submission-'+(++context.serial),serial:0,BridgeI18n:{t:text=>text},sessionStorage:{getItem(){},setItem(){}}});
  vm.runInContext(fs.readFileSync('web/features/chat/file-quotes.js','utf8'),context);
  vm.runInContext(fs.readFileSync('web/features/workspace/side-chat.js','utf8'),context);
  const Panel=vm.runInContext('SideChatPanel',context),panel=Object.create(Panel.prototype),session={id:'parent'},tab={id:'side'};
  for(const name of ['form','landing','head','messageArea','messages','queued','latestButton','input','modelButton','permissionsButton','referenceButton','sendMode','workMode','sendButton','createButton','stopButton','endButton','newButton','renameButton','status'])panel[name]=new Element();
  panel.input.value='运行中的补充';panel.input.style={};panel.sendMode.value='send';panel.workMode.value='plan';panel.sendMode.options=['send','queue','steer'].map(value=>({value}));
  Object.assign(panel,{session,tab,state:{id:'child',connected:true,status:active?'active':'idle',requests:[]},visible:true,files:['image'],references:{close(){}},resizeInput(){},async load(){}});
  panel.workbench={current:session,isVisible:()=>panel.visible,node:(...args)=>new Element(...args),button:(text,onclick)=>Object.assign(new Element('button','',text),{onclick})};
  panel.attachments={locked:false,ids:()=>[...panel.files],ready:()=>true,setLocked(value){this.locked=value;},clear(){panel.files=[];}};
  context.input=panel.input;panel.fileQuotes=vm.runInContext('new FileQuoteDrafts({input})',context);panel.fileQuotes.open('child');
  let handler=async body=>({status:body.mode==='queue'?'queued':'accepted'});
  panel.request=async body=>{calls.push(structuredClone(body));return handler(body);};
  panel.controls();
  return {panel,calls,document,setHandler:fn=>handler=fn,choice:()=>panel.runningSendChoice,
    choose(mode){const choice=panel.runningSendChoice,options=choice.dialog.children.find(node=>node.className==='running-send-options');options.children.find(node=>node.dataset.sendMode===mode).onclick();},
    cancel(){panel.runningSendChoice.finish(null);}};
}

test('运行中的侧边聊天可以点击发送，取消选择保留文字、引用和附件',async()=>{
  const ui=fixture(),{panel}=ui;panel.fileQuotes.add({path:'/project/file',text:'选区'});panel.controls();
  assert.equal(panel.sendButton.disabled,false);
  const pending=panel.send();assert.ok(ui.choice());assert.equal(ui.calls.length,0);assert.equal(panel.sendButton.disabled,true);
  assert.equal(ui.document.activeElement.textContent,'取消');await panel.send();ui.cancel();await pending;
  assert.equal(ui.calls.length,0);assert.equal(panel.input.value,'运行中的补充');assert.equal(panel.fileQuotes.rows.length,1);assert.deepEqual(panel.files,['image']);assert.equal(panel.sendButton.disabled,false);
});

for(const mode of ['queue','steer'])test('选择'+mode+'只提交一次，并保留侧边身份与正确的工作模式',async()=>{
  const ui=fixture(),{panel}=ui;panel.fileQuotes.add({path:'/file',text:'引用内容'});panel.controls();
  const pending=panel.send();await panel.send();ui.choose(mode);await pending;
  assert.equal(ui.calls.length,1);const body=ui.calls[0];
  assert.equal(body.id,'child');assert.equal(body.mode,mode);assert.equal(body.workMode,mode==='steer'?null:'plan');assert.deepEqual(body.attachments,['image']);assert.match(body.text,/文件：\/file\n> 引用内容/);
  assert.equal(panel.input.value,'');assert.equal(panel.fileQuotes.rows.length,0);assert.equal(panel.pending,null);
});

test('空闲时直接发送，显式选择排队或补充时按选择发送',async()=>{
  for(const mode of ['send','queue','steer']){
    const ui=fixture({active:mode!=='send'});ui.panel.sendMode.value=mode;ui.panel.controls();await ui.panel.send();
    assert.equal(ui.choice(),undefined);assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].mode,mode);
  }
});

for(const change of ['text','quote','attachment','hidden','identity','disconnected'])test('选择期间'+change+'变化不能投递旧消息',async()=>{
  const ui=fixture(),{panel}=ui;panel.fileQuotes.add({path:'/file',text:'选区'});panel.controls();const pending=panel.send();
  if(change==='text')panel.input.value='已修改';
  if(change==='quote')panel.fileQuotes.clear('child',panel.fileQuotes.rows.map(row=>row.id));
  if(change==='attachment')panel.files=[];
  if(change==='hidden')panel.visible=false;
  if(change==='identity')panel.state.id='another-child';
  if(change==='disconnected')panel.state.connected=false;
  ui.choose('queue');await pending;assert.equal(ui.calls.length,0);assert.ok(panel.input.value);
});

test('任务结束后禁用补充，仍可选择排队发送下一条',async()=>{
  const ui=fixture(),pending=ui.panel.send();ui.panel.state.status='idle';ui.panel.controls();
  assert.equal(ui.choice().steer.disabled,true);ui.choose('steer');assert.equal(ui.calls.length,0);assert.ok(ui.choice());ui.choose('queue');await pending;assert.equal(ui.calls[0].mode,'queue');
});

test('等待审批或回答时只允许排队，断开后自动关闭选择且保留草稿',async()=>{
  const ui=fixture();ui.panel.state.requests=[{id:'approval'}];ui.panel.controls();const pending=ui.panel.send();
  assert.equal(ui.choice().steer.disabled,true);ui.panel.state.connected=false;ui.panel.controls();await pending;
  assert.equal(ui.choice(),null);assert.equal(ui.calls.length,0);assert.ok(ui.panel.input.value);
});

for(const choice of [null,'queue','steer'])test('发送时才发现任务运行，明确拒绝后等待用户选择'+choice,async()=>{
  const ui=fixture({active:false});ui.setHandler(async body=>{if(ui.calls.length===1){ui.panel.state.status='active';throw busyError();}return {status:body.mode==='queue'?'queued':'accepted'};});
  const pending=ui.panel.send();await tick();assert.ok(ui.choice());assert.equal(ui.calls.length,1);assert.equal(ui.panel.pending,null);
  choice?ui.choose(choice):ui.cancel();await pending;
  assert.equal(ui.calls.length,choice?2:1);if(choice){assert.equal(ui.calls[1].mode,choice);assert.notEqual(ui.calls[1].submissionId,ui.calls[0].submissionId);}else assert.ok(ui.panel.input.value);
});

for(const result of ['unknown','network','server'])test('发送结果'+result+'保留原提交，不弹出新选择或自动重发',async()=>{
  const ui=fixture({active:false});ui.setHandler(async()=>{if(result==='unknown')return {status:'unknown'};throw Object.assign(Error('结果未确认'),result==='server'?{status:500}:{});});
  await ui.panel.send();const submission=ui.panel.pending.submissionId;await ui.panel.send();
  assert.equal(ui.calls.length,1);assert.equal(ui.choice(),undefined);assert.equal(ui.panel.pending.submissionId,submission);assert.ok(ui.panel.input.value);assert.equal(ui.panel.sendButton.disabled,true);
});
