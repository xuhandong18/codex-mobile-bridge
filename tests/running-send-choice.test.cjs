'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/shell/app.js','utf8');
const code=source.slice(source.indexOf('function chooseRunningSendMode(){'),source.indexOf("$('message').onkeydown="));
const busyError=()=>Object.assign(Error('Codex 正在执行。请选择「排队发送」或「补充当前任务」。'),{status:400});
const tick=()=>new Promise(setImmediate);

function fixture({active=true}={}){
  const nodes=new Map(),saved=new Map(),calls=[],notices=[];
  class Element{
    constructor(tag,cls='',text=''){this.tag=tag;this.className=cls;this.textContent=text;this.children=[];this.dataset={};this.listeners={};this.value='';this.open=false;}
    before(){}
    replaceChildren(...items){this.children=[];this.append(...items);}
    append(...items){for(const item of items){item.parent=this;this.children.push(item);}}
    setAttribute(name,value){this[name]=value;}
    addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
    showModal(){this.open=true;}
    close(){if(!this.open)return;this.open=false;for(const fn of this.listeners.close||[])fn();}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);}
    focus(){document.activeElement=this;}
  }
  const document={body:new Element('body'),activeElement:null,createElement:tag=>new Element(tag)};
  const $=id=>{if(!nodes.has(id))nodes.set(id,new Element('div'));return nodes.get(id);};
  $('message').value='A follow-up with an attachment';$('send-mode').value='send';
  const ctx={$,t:value=>value,document,el:(...args)=>new Element(...args),currentId:'parent',currentHost:'local',
    state:{status:active?'active':'idle'},runningSendChoice:null,sending:false,applyingNewChat:null,
    currentAccess:()=>({canSend:true}),uuid:()=>String(++ctx.ids),ids:0,
    chatKey:(id=ctx.currentId,host=ctx.currentHost)=>host+'|'+id,
    sessionUrl:(id,action,host)=>host+'/'+id+'/'+action,
    sessionStorage:{getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},
    workModes:{value:mode=>mode==='steer'?null:'plan',render(){},submitted(){}},
    files:['file-a'],attachments:{ready:()=>true,ids:()=>[...ctx.files],setLocked(value){this.locked=value;},clear(){ctx.files=[];}},
    BridgeI18n:{locale:()=> 'zh-CN',t:text=>text},window:{BridgePresentation:{resizeMessage(){},showError(){}}},
    bumpRecency(){},toast:text=>notices.push(text)};
  let handler=async(_url,body)=>({status:body.mode==='queue'?'queued':'accepted'});
  ctx.api=async(url,body)=>{calls.push({url,body:structuredClone(body)});return handler(url,body);};
  vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/features/chat/file-quotes.js','utf8'),ctx);
  ctx.workbench={fileQuotes:vm.runInContext("new FileQuoteDrafts({input:$('message')})",ctx)};ctx.workbench.fileQuotes.open('local|parent');
  vm.runInContext(code,ctx);
  return {ctx,$,saved,calls,notices,document,setHandler:fn=>handler=fn,
    submit:()=>$('composer').onsubmit({preventDefault(){}}),
    dialog:()=>document.body.children.find(node=>node.open),
    choose(mode){const dialog=this.dialog();const options=dialog.children.find(node=>node.className==='running-send-options');options.children.find(node=>node.dataset.sendMode===mode).onclick();},
    cancel(){this.dialog().children.find(node=>node['data-close']==='running-send-dialog').onclick();}};
}

test('a running chat opens a choice before any request and cancellation preserves the complete draft',async()=>{
  const ui=fixture(),pending=ui.submit();
  assert.ok(ui.dialog());assert.equal(ui.calls.length,0);assert.equal(ui.saved.size,0);
  assert.equal(ui.document.activeElement.textContent,'取消');
  ui.cancel();await pending;
  assert.equal(ui.calls.length,0);assert.equal(ui.$('message').value,'A follow-up with an attachment');
  assert.deepEqual(ui.ctx.files,['file-a']);
  assert.equal(ui.ctx.runningSendChoice,null);
});

test('closing the native dialog without a choice never queues or steers a message',async()=>{
  const ui=fixture(),pending=ui.submit();ui.dialog().close();await pending;
  assert.equal(ui.calls.length,0);assert.equal(ui.saved.size,0);assert.ok(ui.$('message').value);
});

for(const mode of ['queue','steer'])test('choosing '+mode+' submits exactly once with the original attachments and correct work mode',async()=>{
  const ui=fixture(),pending=ui.submit();
  await ui.submit();assert.equal(ui.calls.length,0,'repeated Send must not bypass or duplicate the dialog');
  ui.choose(mode);await pending;
  assert.equal(ui.calls.length,1);const {body,url}=ui.calls[0];
  assert.equal(body.mode,mode);assert.equal(body.workMode,mode==='steer'?null:'plan');
  assert.deepEqual(body.attachments,['file-a']);assert.equal(body.skills,undefined);assert.equal(url,'local/parent/send');
  assert.equal(ui.$('message').value,'');assert.equal(ui.ctx.runningSendChoice,null);
});

test('an earlier dropdown setting does not silently send the next running-chat message',async()=>{
  const ui=fixture();ui.$('send-mode').value='queue';const pending=ui.submit();
  assert.ok(ui.dialog());assert.equal(ui.calls.length,0);ui.cancel();await pending;assert.equal(ui.calls.length,0);
});

test('idle chats continue to send directly',async()=>{
  const ui=fixture({active:false});await ui.submit();assert.equal(ui.dialog(),undefined);
  assert.equal(ui.calls.length,1);assert.equal(ui.calls[0].body.mode,'send');
});

test('a quote-only draft sends full path and selected text and clears the tag only after acceptance',async()=>{
  const ui=fixture({active:false});ui.ctx.files=[];ui.$('message').value='';
  const quotes=ui.ctx.workbench.fileQuotes;quotes.add({path:'/project/file.js',text:'selected\n  text',name:'file.js'});
  ui.setHandler(async()=>({status:'unknown'}));await ui.submit();assert.equal(quotes.rows.length,1);
  const first=ui.calls[0].body;assert.equal(first.text,'文件：/project/file.js\n> selected\n>   text');
  ui.setHandler(async()=>({status:'accepted'}));await ui.submit();assert.deepEqual(ui.calls[1].body,first);
  assert.equal(quotes.rows.length,0);assert.equal(ui.$('message').value,'');
});

test('removing an excerpt while the running-send choice is open cancels that submission',async()=>{
  const ui=fixture(),quotes=ui.ctx.workbench.fileQuotes;quotes.add({path:'/file',text:'excerpt'});
  const pending=ui.submit();quotes.clear(quotes.key,quotes.rows.map(row=>row.id));ui.choose('queue');await pending;
  assert.equal(ui.calls.length,0);assert.ok(ui.$('message').value);
});

test('all reference types send as literal message text with no hidden skill selection',async()=>{
  const ui=fixture({active:false}),text='$code-review\nD:\\project\\src\\index.js\ncodex://threads/reference\nReview these';
  ui.$('message').value=text;await ui.submit();assert.equal(ui.calls[0].body.text,text);
  assert.equal(Object.hasOwn(ui.calls[0].body,'skills'),false);
});

test('an uncertain submission from the old skill picker retains its original payload identity',async()=>{
  const ui=fixture({active:false}),old={id:'old-request',text:ui.$('message').value,mode:'send',workMode:'plan',skills:['old-skill'],attachments:['file-a']};
  ui.saved.set('pending:local|parent',JSON.stringify(old));ui.setHandler(async()=>({status:'unknown'}));
  await ui.submit();assert.deepEqual(ui.calls[0].body,old);assert.equal(ui.dialog(),undefined);
});

for(const choice of [null,'queue','steer'])test('a definite busy rejection opens the choice and waits for '+String(choice),async()=>{
  const ui=fixture({active:false});let attempts=0;
  ui.setHandler(async(_url,body)=>{if(++attempts===1)throw busyError();return {status:body.mode==='queue'?'queued':'accepted'};});
  const pending=ui.submit();await tick();assert.ok(ui.dialog());assert.equal(ui.calls.length,1);
  assert.equal(ui.saved.has('pending:local|parent'),false);assert.equal(ui.$('send-error').textContent,'');
  choice?ui.choose(choice):ui.cancel();await pending;
  assert.equal(ui.calls.length,choice?2:1);
  if(choice){assert.equal(ui.calls[1].body.mode,choice);assert.notEqual(ui.calls[1].body.id,ui.calls[0].body.id);}
  else assert.ok(ui.$('message').value);
});

test('unknown delivery keeps the same attempt identity and never offers a new queue or steer write',async()=>{
  const ui=fixture({active:false});ui.setHandler(async()=>({status:'unknown'}));
  await ui.submit();assert.match(ui.$('send-error').textContent,/可能已送达/);assert.ok(ui.$('message').value);
  ui.ctx.state.status='active';await ui.submit();
  assert.equal(ui.dialog(),undefined);assert.equal(ui.calls.length,2);
  assert.equal(ui.calls[0].body.id,ui.calls[1].body.id);assert.equal(ui.calls[1].body.mode,'send');
});

for(const mode of ['queue','steer'])test('an uncertain '+mode+' choice keeps its original mode even when the dropdown still says send',async()=>{
  const ui=fixture();ui.setHandler(async()=>({status:'unknown'}));
  const pending=ui.submit();ui.choose(mode);await pending;
  assert.equal(ui.$('send-mode').value,'send');
  await ui.submit();assert.equal(ui.dialog(),undefined);assert.equal(ui.calls.length,2);
  assert.equal(ui.calls[0].body.id,ui.calls[1].body.id);assert.equal(ui.calls[1].body.mode,mode);
});

for(const error of [new TypeError('network failure'),Object.assign(busyError(),{status:500})])test('uncertain or unrelated errors do not offer an automatic resend: '+error.status,async()=>{
  const ui=fixture({active:false});ui.setHandler(async()=>{throw error;});await ui.submit();
  assert.equal(ui.dialog(),undefined);assert.equal(ui.calls.length,1);assert.ok(ui.$('message').value);
  assert.equal(ui.saved.has('pending:local|parent'),true);
});

test('changing the conversation while choosing cannot send into either chat',async()=>{
  const ui=fixture(),pending=ui.submit();ui.ctx.currentHost='remote';ui.ctx.currentId='another';
  ui.$('message').value='Another conversation draft';ui.choose('queue');await pending;
  assert.equal(ui.calls.length,0);assert.equal(ui.$('message').value,'Another conversation draft');
});

test('editing the draft while choosing requires another explicit Send',async()=>{
  const ui=fixture(),pending=ui.submit();ui.$('message').value='An updated draft';ui.choose('steer');await pending;
  assert.equal(ui.calls.length,0);assert.equal(ui.$('message').value,'An updated draft');
});
