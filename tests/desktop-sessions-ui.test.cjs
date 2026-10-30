'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),{webcrypto}=require('node:crypto');
function fixture(){
 // Draft transport is covered by the isolated real-DOM answer-draft driver.
 const listeners={},storage=new Map();let document;
 class Node {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.dataset={};this.attributes={};this.hidden=false;this.disabled=false;this.value='';this.className='';this._text='';this.style={setProperty(){}};this.scrollHeight=100;this.scrollTop=0;this.clientHeight=100;this.clientWidth=1000;this.open=false;this.options=this.children;this.classList={contains:n=>this.className.split(' ').includes(n),add:(...ns)=>this.className=[...new Set([...this.className.split(' ').filter(Boolean),...ns])].join(' '),remove:(...ns)=>this.className=this.className.split(' ').filter(n=>!ns.includes(n)).join(' '),toggle:(n,v)=>{v=v??!this.classList.contains(n);this.classList[v?'add':'remove'](n);return v;}};}
  get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}set textContent(v){this._text=String(v??'');this.children=[];this.options=this.children;}
  getBoundingClientRect(){return {width:this.clientWidth,top:0,bottom:this.clientHeight};}
  get firstElementChild(){return this.children[0];}get lastChild(){return this.children.at(-1);}get childNodes(){return this.children;}get isConnected(){return !!this.parentElement;}
  append(...nodes){for(let n of nodes){if(typeof n==='string')n=document.createTextNode(n);n.remove();n.parentElement=this;this.children.push(n);}}
  prepend(...nodes){for(const n of [...nodes].reverse()){n.remove();n.parentElement=this;this.children.unshift(n);}}
  replaceChildren(...nodes){for(const n of this.children)n.parentElement=null;this.children=[];this.options=this.children;this._text='';this.append(...nodes);}
  remove(){if(this.parentElement){const p=this.parentElement;p.children.splice(p.children.indexOf(this),1);this.parentElement=null;}}
  after(...nodes){const p=this.parentElement;if(!p)return;let i=p.children.indexOf(this)+1;for(const n of nodes){n.remove();n.parentElement=p;p.children.splice(i++,0,n);}}
  before(...nodes){for(const node of nodes)this.parentElement?.insertBefore(node,this);}
  insertBefore(n,next){n.remove();n.parentElement=this;const i=this.children.indexOf(next);this.children.splice(i<0?this.children.length:i,0,n);}
  add(option){this.append(option);if(this.children.length===1)this.value=option.value;}
  setAttribute(k,v){this.attributes[k]=String(v);if(k==='class')this.className=v;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;}
  getAttribute(k){return this.attributes[k];}removeAttribute(k){delete this.attributes[k];}addEventListener(type,fn){this['on'+type]=fn;}
  matches(selector){return selector.split(',').some(s=>{s=s.trim();if(s==='input:checked')return this.tagName==='INPUT'&&this.checked;if(s.startsWith('.'))return this.classList.contains(s.slice(1));if(s.startsWith('#'))return this.id===s.slice(1);const attr=s.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/);if(attr)return attr[2]===undefined?this.attributes[attr[1]]!==undefined:this.attributes[attr[1]]===attr[2];return this.tagName===s.toUpperCase();});}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  querySelectorAll(selector){return this.children.flatMap(n=>[...(n.matches(selector)?[n]:[]),...n.querySelectorAll(selector)]);}querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  showModal(){this.open=true;}close(){this.open=false;this.onclose?.();}focus(){document.activeElement=this;}select(){}setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.setSelectionRange(start+text.length,start+text.length);}dispatchEvent(event){return this['on'+event.type]?.(event);}click(){if(!this.disabled)return this.onclick?.({preventDefault(){}});}contains(n){return n===this||this.children.some(c=>c.contains(n));}
 }
 document={body:new Node('body'),documentElement:new Node('html'),hidden:false,activeElement:null,createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),createTextNode:text=>{const n=new Node('#text');n.textContent=text;return n;},querySelectorAll:s=>document.body.querySelectorAll(s),querySelector:s=>document.body.querySelector(s),getElementById:id=>document.body.querySelector('#'+id),addEventListener:(type,fn)=>listeners[type]=fn,dispatchEvent:event=>listeners[event.type]?.(event)};
 const root=new Node('div');root.className='app';document.body.append(root);const select=new Node('select'),calls=[],notices=[];let uploadHandler=async()=>({ok:true,status:200,json:async()=>({image:true,size:16,name:'image.png'})}),handler=async(url,body)=>body?{status:'accepted'}:url.includes('/detail')?{session:{id:'a',title:'Chat',model:'model-a',effort:'high',status:'idle',capabilities:{}},messages:[]}:url.includes('/workspace')?{entries:[],total:0,project:'/project'}:{sessions:[]};
 const context=vm.createContext({document,window:{AnswerDrafts:{bind(){}},addEventListener(){}},navigator:{},location:{href:'https://bridge.example/relay/device/?client=claude#old',pathname:'/relay/device/'},history:{replaceState(){}},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},crypto:{getRandomValues:array=>webcrypto.getRandomValues(array)},Uint8Array,TextEncoder,URL,Event,Option:class extends Node{constructor(text,value){super('option');this.textContent=text;this.value=value;this.setAttribute('value',value);}},ResizeObserver:class{observe(){}},MutationObserver:class{observe(){}},AbortController,requestAnimationFrame:fn=>fn(),cancelAnimationFrame(){},getComputedStyle:()=>({getPropertyValue:()=>8}),setTimeout(){return 1;},clearTimeout(){},fetch:async(url,options)=>{calls.push({url,upload:options});return uploadHandler(url,options);},renderMarkdown:(node,text)=>node.textContent=text,CustomEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8').match(/^function uuid\(\).*$/m)[0],context);
 for(const file of ['web/features/chat/message-groups.js','web/layouts/viewport.js','web/features/chat/activity.js','web/features/chat/modes.js','web/features/chat/attachments.js','web/shared/i18n.js','web/features/clients/client-lifecycle.js','web/features/chat/message-actions.js','web/features/chat/permissions.js','web/features/chat/context-menu.js','web/features/chat/file-quotes.js','web/features/chat/selection-targets.js','web/features/workspace/file-selection.js','web/features/workspace/workbench.js','web/features/chat/list-sync.js','web/features/chat/reference-picker.js','web/features/clients/desktop-sessions.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
 const View=vm.runInContext('DesktopSessionsView',context),view=new View({root,select,request:(url,body,signal)=>{calls.push({url,body,signal});return handler(url,body,signal);},notify:text=>notices.push(text),onSelect(){},csrf:()=>'csrf-test',onUnauthorized(){}});
 return {view,root,document,calls,notices,setHandler:fn=>handler=fn,setUploadHandler:fn=>uploadHandler=fn,run:s=>vm.runInContext(s,context),text:n=>n.textContent};
}
async function opened(){const ui=fixture();await ui.view.choose('claude');await ui.view.open('a');return ui;}

test('DeepSeek only syncs fresh completed detail while the chat is visible, including completion during reading',async()=>{
 const ui=fixture(),view=ui.view;await view.choose('deepseek');view.prepareChat('a');
 const detail={connected:true,session:{id:'a',title:'Chat',status:'idle'},messages:[],turns:[{turnId:'1',status:'completed'}]};
 const reads=()=>ui.calls.filter(call=>call.url.includes('/read-state'));
 view.updateActivity([{...detail.session,turnId:'1',turnStatus:'completed'}]);assert.equal(reads().length,0);
 view.applyDetail(detail,true);assert.equal(reads().length,0);
 view.applyDetail(detail);await Promise.resolve();assert.equal(reads().length,1);assert.equal(reads()[0].body.sessionId,'a');assert.equal(reads()[0].body.turnId,'1');
 view.applyDetail(detail);assert.equal(reads().length,1);
 view.applyDetail({...detail,session:{...detail.session,status:'active'},turns:[{turnId:'2',status:'inProgress'}]});assert.equal(reads().length,1);
 ui.document.hidden=true;view.applyDetail({...detail,turns:[{turnId:'2',status:'completed'}]});assert.equal(reads().length,1);
 ui.document.hidden=false;view.applyDetail({...detail,turns:[{turnId:'2',status:'completed'}]});assert.equal(reads().length,2);
 view.provider='claude';view.applyDetail({...detail,turns:[{turnId:'3',status:'completed'}]});assert.equal(reads().length,2);
});

test('client composers send quote-only drafts as text and preserve unconfirmed excerpt tags',async()=>{
 const ui=await opened(),view=ui.view,quotes=view.workbench.fileQuotes;quotes.add({name:'file.py',path:'/project/file.py',text:'selected code'});
 ui.setHandler(async(_url,body)=>body?{status:'unknown'}:{sessions:[]});await view.submit();
 const first=ui.calls.filter(call=>call.body?.text).at(-1).body;assert.match(first.text,/文件：\/project\/file.py\n> selected code/);assert.equal(quotes.rows.length,1);
 ui.setHandler(async(_url,body)=>body?{status:'accepted'}:{sessions:[]});view.freshDetail=true;await view.submit();
 assert.equal(ui.calls.filter(call=>call.body?.text).at(-1).body.id,first.id);assert.equal(quotes.rows.length,0);
});

test('a client composer cannot restore cached excerpt tags after logout cleared session storage',async()=>{
 const ui=await opened(),view=ui.view,quotes=view.workbench.fileQuotes;quotes.add({path:'/private/file',text:'private excerpt'});
 ui.run("sessionStorage.removeItem('file-quotes:'+"+JSON.stringify(quotes.key)+")");view.clear();
 assert.equal(quotes.rows.length,0);assert.equal(quotes.states.size,0);
 await view.choose('claude');await view.open('a');assert.equal(quotes.rows.length,0);
});
async function pendingAttachmentSend(provider='claude'){
 const ui=fixture(),view=ui.view,read=url=>url.includes('/detail')?{session:{id:new URL(url,'https://fixture').searchParams.get('sessionId'),title:'Chat',status:'idle'},capabilities:{attachments:true},messages:[]}:{sessions:[]};
 ui.setHandler(async url=>read(url));await view.choose(provider);await view.open('a');view.input.value='$review';view.input.oninput();view.attachments.rows.push({id:'sent-upload',name:'sent.png',status:'ready',size:16});view.attachments.save(view.attachments.key,view.attachments.rows);
 const clears=[],clear=view.attachments.clear.bind(view.attachments);view.attachments.clear=(key,ids)=>{clears.push({key,ids:[...ids]});return clear(key,ids);};let finish;ui.setHandler((url,body)=>body?new Promise(resolve=>finish=resolve):Promise.resolve(read(url)));const sending=view.submit();return {...ui,sending,clears,finish:result=>finish(result)};
}

test('search stays short in both languages while its accessible name stays specific',()=>{
 const ui=fixture();
 assert.equal(ui.view.search.placeholder,'搜索');
 assert.equal(ui.view.search.getAttribute('aria-label'),'搜索聊天或项目');
 ui.run("BridgeI18n.setLanguage('en');BridgeI18n.apply()");
 assert.equal(ui.view.search.placeholder,'Search');
 assert.equal(ui.view.search.dataset.i18nAriaLabel,'搜索聊天或项目');
 assert.equal(ui.run("BridgeI18n.t('搜索聊天或项目')"),'Search chats or projects');
});

test('session list explains a pending connection and offers retry only after timeout',async()=>{
 const ui=fixture(),client={id:'deepseek',enabled:true,configured:true,running:false,connected:false,connectionState:'starting',reason:'正在启动 Harness 桌面应用'},retries=[];
 ui.view.setClientStates([client],async id=>retries.push(id));ui.setHandler(async()=>{throw Error('客户端连接不可用，请在电脑端检查');});await ui.view.choose('deepseek');
 assert.match(ui.view.listStatus.textContent,/正在启动/);assert.doesNotMatch(ui.view.listStatus.textContent,/请在电脑端检查/);assert.equal(ui.view.listStatus.attributes['aria-busy'],'true');assert.equal(ui.view.connectionRetry.hidden,true);assert.equal(ui.calls.length,0);
 ui.view.setClientStates([{...client,connectionState:'timeout',retryable:true,reason:'Harness 连接超时，请检查桌面应用后重试接入'}],async id=>retries.push(id));await ui.view.refresh();assert.match(ui.view.listStatus.textContent,/连接超时/);assert.equal(ui.view.listStatus.attributes['aria-busy'],'false');assert.equal(ui.view.connectionRetry.hidden,false);await ui.view.connectionRetry.click();assert.deepEqual(retries,['deepseek']);
 ui.setHandler(async()=>({connected:true,sessions:[]}));await ui.view.setClientStates([{...client,connectionState:'connected',connected:true}]);assert.equal(ui.view.listStatus.textContent,'电脑上还没有聊天');assert.equal(ui.view.connectionRetry.hidden,true);
});

test('Claude session list exposes the confirmed initialization flow without running chat RPCs',async()=>{
 const ui=fixture(),client={id:'claude',name:'Claude',enabled:true,installed:true,connected:false,setupStatus:'needs-initialization'},initialized=[];
 ui.view.setClientStates([client],undefined,async id=>initialized.push(id));await ui.view.choose('claude');assert.match(ui.view.listStatus.textContent,/需要初始化连接/);assert.equal(ui.view.connectionInitialize.hidden,false);assert.equal(ui.calls.length,0);
 await ui.view.connectionInitialize.click();assert.deepEqual(initialized,['claude']);ui.run("BridgeI18n.setLanguage('en')");assert.match(ui.view.listStatus.textContent,/Connection initialization required/);assert.doesNotMatch(ui.view.listStatus.textContent,/[\u4e00-\u9fff]/);
 ui.view.setClientStates([{...client,connectionState:'connecting'}]);assert.equal(ui.view.connectionInitialize.hidden,true);await ui.view.refresh();assert.equal(ui.calls.length,0);
});

test('prepared Claude lists offer separate reconnect and reinitialization actions',async()=>{
 const ui=fixture(),client={id:'claude',name:'Claude',enabled:true,installed:true,connected:false,setupStatus:'needs-initialization',reconnectSupported:true,canReconnect:true},reconnects=[],initializations=[];
 ui.view.setClientStates([client],undefined,id=>initializations.push(id),undefined,id=>reconnects.push(id));await ui.view.choose('claude');
 assert.equal(ui.view.connectionReconnect.hidden,false);assert.equal(ui.view.connectionReconnect.textContent,'重新连接 Desktop');assert.equal(ui.view.connectionInitialize.hidden,false);
 assert.equal(ui.view.connectionInitialize.textContent,'重新初始化连接');
 ui.run("BridgeI18n.setLanguage('en')");ui.view.renderConnectionStatus();assert.equal(ui.view.connectionReconnect.textContent,'Reconnect Desktop');ui.run("BridgeI18n.setLanguage('zh')");
 await ui.view.connectionReconnect.click();assert.deepEqual(reconnects,['claude']);assert.deepEqual(initializations,[]);
 await ui.view.connectionInitialize.click();assert.deepEqual(initializations,['claude']);
 ui.view.setClientStates([{...client,operationUncertain:true}],undefined,()=>{throw Error('unexpected initialize');},undefined,()=>{throw Error('unexpected reconnect');});
 assert.equal(ui.view.connectionReconnect.hidden,true);assert.equal(ui.view.connectionInitialize.hidden,true);
 ui.view.setClientStates([{...client,setupStatus:'owner-conflict',reason:'Claude 桥接连接被其他网关占用，请先停止旧网关；旧版连接还需重新加载 Claude'}]);
 assert.match(ui.view.listStatus.textContent,/其他网关占用/);assert.equal(ui.view.connectionReconnect.hidden,false);
});

test('unknown operations offer refresh only and a failed quit does not block connected chats',async()=>{
 const ui=fixture(),client={id:'claude',enabled:true,installed:true,connected:false,initializationMode:'background',setupStatus:'needs-unlock',connectionState:'needs-initialization',operationFailure:{action:'initialize',message:'timeout',uncertain:true}},refreshes=[];
 ui.view.setClientStates([client],()=>{throw Error('no replay');},()=>{throw Error('no initialization');},async()=>refreshes.push(true));await ui.view.choose('claude');assert.match(ui.view.listStatus.textContent,/电脑已锁定/);assert.match(ui.view.connectionNotice.textContent,/尚未确认/);assert.equal(ui.view.connectionInitialize.hidden,true);assert.equal(ui.view.connectionRetry.hidden,true);assert.equal(ui.view.connectionRefresh.hidden,false);await ui.view.connectionRefresh.click();assert.equal(refreshes.length,1);assert.equal(ui.calls.length,0);
 await ui.view.setClientStates([{...client,connected:true,connectionState:'connected',operationFailure:{action:'quit',message:'退出未完成',uncertain:false}}]);assert.ok(ui.calls.some(call=>call.url.includes('/list')));assert.equal(ui.view.listStatus.textContent,'电脑上还没有聊天');assert.equal(ui.view.connectionNotice.textContent,'退出未完成');assert.equal(ui.view.connectionInitialize.hidden,true);
});

test('session list surfaces genuine failures outside startup and never claims disconnected data is connected',async()=>{
 const ui=fixture();ui.view.setClientStates([{id:'deepseek',enabled:true,connected:false,connectionState:'idle'}]);ui.setHandler(async()=>{throw Error('real failure');});await ui.view.choose('deepseek');assert.equal(ui.view.listStatus.textContent,'real failure');
 ui.setHandler(async()=>({connected:false,sessions:[]}));await ui.view.refresh();assert.equal(ui.view.listStatus.textContent,'尚未连接');
});
test('desktop client keeps cached rows through brief polling failures and clears sustained failure after recovery',async()=>{
 const ui=fixture();ui.setHandler(async()=>({sessions:[{id:'a',title:'Saved chat',backend:'code'}]}));await ui.view.choose('claude');
 ui.setHandler(async()=>{throw Error('network unavailable');});
 for(let attempt=1;attempt<=3;attempt++){await assert.rejects(ui.view.refreshList(),/network unavailable/);assert.match(ui.view.rowsRoot.textContent,/Saved chat/);assert.equal(ui.view.listStatus.textContent,'');assert.equal(ui.view.listHint.hidden,attempt<3);}
 ui.setHandler(async()=>({sessions:[{id:'a',title:'Current chat',backend:'code'}]}));await ui.view.refreshList();assert.match(ui.view.rowsRoot.textContent,/Current chat/);
});

for(const provider of ['claude','deepseek'])test(provider+'状态读取短暂失败时保留绿点并说明旧状态，超时及恢复同步到头部',async()=>{
 const ui=fixture(),view=ui.view;let now=0;view.activity.now=()=>now;
 const session={id:'a',title:'Running chat',status:'active',turnId:'one',turnStatus:'inProgress'};
 const ready=async url=>url.includes('/detail')?{connected:true,session,messages:[]}:{connected:true,sessions:[session]};
 ui.setHandler(ready);await view.choose(provider);await view.open('a');
 ui.setHandler(async()=>{throw Error('offline');});
 await assert.rejects(view.detail(view.generation),/offline/);
 await assert.rejects(view.refreshList(),/offline/);
 assert.equal(view.activity.rows[provider+'|a'].offline,true);
 assert.equal(view.rowsRoot.querySelector('.session-indicator').classList.contains('running'),true);
 assert.equal(view.rowsRoot.querySelector('.session-indicator').title,'上次确认运行中，正在重新确认');
 assert.equal(view.status.textContent,'上次确认运行中，正在重新确认');
 assert.equal(view.canMutate(),false);assert.equal(view.send.disabled,true);
 now=29000;await assert.rejects(view.refreshList(),/offline/);
 assert.equal(view.status.textContent,'上次确认运行中，正在重新确认');
 now=30000;view.renderIndicators();
 assert.equal(view.rowsRoot.querySelector('.session-indicator').classList.contains('unknown'),true);
 assert.equal(view.rowsRoot.querySelector('.session-indicator').title,'运行状态暂不可用');
 assert.equal(view.status.textContent,'运行状态暂不可用');
 ui.setHandler(ready);await view.refreshList();await view.detail(view.generation);
 assert.equal(view.rowsRoot.querySelector('.session-indicator').classList.contains('running'),true);
 assert.equal(view.rowsRoot.querySelector('.session-indicator').title,'运行中');
 assert.equal(view.status.textContent,'运行中');assert.equal(view.canMutate(),true);
});

for(const provider of ['claude','deepseek'])test(provider+'列表失败不能把缓存侧边当成新状态续期，也不能清除已确认的派生等待',async()=>{
 const ui=fixture(),view=ui.view;await view.choose(provider);let now=0;view.activity.now=()=>now;
 const parent={id:'a',status:'idle',waitingSubagents:0,sideChats:[{id:'side',connected:true,status:'active'}]};
 view.updateActivity([parent]);view.updateActivity([parent],false);
 assert.equal(view.activity.rows[provider+'|a/side/side'].offline,true);
 assert.equal(view.activity.indicator(provider+'|a')?.stale,true);
 now=29000;view.updateActivity([parent],false);now=30000;
 assert.equal(view.activity.indicator(provider+'|a')?.kind,'unknown');
 view.updateActivity([{...parent,sideChats:[],waitingSubagents:1}]);
 view.updateActivity([parent],false);
 assert.equal(view.activity.indicator(provider+'|a')?.kind,'awaiting');
 view.updateActivity([{...parent,sideChats:[{...parent.sideChats[0],waitingSubagents:1}]}]);
 view.updateActivity([{...parent,sideChats:[{...parent.sideChats[0],waitingSubagents:0}]}],false);
 assert.equal(view.activity.indicator(provider+'|a')?.kind,'awaiting','缓存侧边中的派生等待摘要也不能解除新确认的红色');
});
test('LAN HTTP send creates a secure id and retries the same unconfirmed operation',async()=>{
 const ui=await opened();ui.run('uuid=undefined');let attempt=0;ui.setHandler(async(url,body)=>{if(body){if(++attempt===1)throw Error('connection lost');return {status:'accepted'};}return url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle'},messages:[]}:{sessions:[]};});
 ui.view.input.value='hello';await ui.view.submit();assert.equal(ui.view.input.value,'hello');await ui.view.detail(ui.view.generation);await ui.view.submit();const writes=ui.calls.filter(c=>c.body);assert.equal(writes.length,2);assert.match(writes[0].body.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);assert.equal(writes[0].body.id,writes[1].body.id);assert.equal(ui.view.input.value,'');
});
test('Harness goal controls retain a secure request identity on LAN HTTP',async()=>{
 const ui=fixture();ui.run('uuid=undefined');
 ui.setHandler(async(url,body)=>body?{status:'accepted'}:url.includes('/detail')?{session:{id:'a',title:'Goal',status:'idle',goal:{goalId:'native-goal',revision:2,objective:'完成任务',status:'active'}},capabilities:{workModes:true,goal:true},connected:true,messages:[]}:{sessions:[]});
 await ui.view.choose('deepseek');await ui.view.open('a');await ui.view.workModes.setStatus('paused');
 const write=ui.calls.find(call=>call.body?.goalAction==='paused');assert.ok(write);assert.equal(write.body.sessionId,'a');assert.equal(write.body.expected.goalId,'native-goal');assert.equal(write.body.expected.revision,2);assert.match(write.body.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('client shell and welcome appear before the first list response',async()=>{
 const ui=fixture();let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const reading=ui.view.choose('claude');assert.equal(ui.view.container.hidden,false);assert.equal(ui.view.welcome.hidden,false);assert.match(ui.view.welcome.textContent,/从一条聊天继续/);assert.equal(ui.view.conversation.hidden,true);assert.match(ui.view.listStatus.textContent,/读取|加载|连接/);finish({sessions:[]});await reading;
});
test('returning to list clears selection and prevents an old detail from reopening chat',async()=>{
 const ui=await opened();ui.view.input.value='draft';let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const reading=ui.view.open('b');assert.equal(ui.view.isChatOpen,true);ui.view.backToList();assert.equal(ui.view.sid,null);assert.equal(ui.view.isChatOpen,false);assert.equal(ui.view.welcome.hidden,false);finish({session:{id:'b',title:'late',status:'idle'},messages:[]});await reading;assert.equal(ui.view.sid,null);assert.equal(ui.view.conversation.hidden,true);assert.equal(ui.view.drafts.get('claude:a'),'draft');
});
test('composer and historical replies show their own model and effort without rewriting history',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async()=>({session:{id:'a',title:'Chat',model:'new-model',effort:'high',status:'idle',capabilities:{}},messages:[{id:'1',role:'assistant',model:'old-model',effort:'low',text:'answer'},{id:'2',role:'assistant',text:'no metadata'}]}));await ui.view.open('a');assert.match(ui.view.modelButton.textContent,/new-model/);assert.match(ui.view.modelButton.textContent,/high/);assert.match(ui.view.messages.children[0].textContent,/old-model.*low/);assert.doesNotMatch(ui.view.messages.children[1].textContent,/new-model|high/);assert.ok(ui.view.modelButton.classList.contains('tool-button'));assert.equal(ui.view.input.rows,1);ui.view.composerToggle.click();assert.equal(ui.view.composerBody.hidden,true);ui.view.composerToggle.click();assert.equal(ui.view.composerBody.hidden,false);
});
test('Claude recent list combines types chronologically and retains archive, search and project filters',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.view.rows=[{id:'a',title:'Code chat',backend:'code',cwd:'/same',updatedAt:1},{id:'b',title:'Cowork chat',backend:'cowork',cwd:'/same',updatedAt:2},{id:'c',title:'Archive',backend:'code',cwd:'/same',archived:true}];ui.view.renderList();
 assert.deepEqual(ui.view.rowsRoot.querySelectorAll('.session').map(n=>n.dataset.id),['b','a']);assert.equal(ui.view.rowsRoot.querySelector('details'),null);assert.equal(ui.view.surface.hidden,false);assert.deepEqual(ui.view.surface.children.map(n=>n.value),['all','code','cowork']);assert.doesNotMatch(ui.view.rowsRoot.textContent,/Archive/);
 ui.view.search.value='Cowork';ui.view.renderList();assert.match(ui.view.rowsRoot.textContent,/Cowork chat/);assert.doesNotMatch(ui.view.rowsRoot.textContent,/Code chat/);
 ui.view.search.value='';ui.view.archived.checked=true;ui.view.listMode.value='project';ui.view.renderList();assert.match(ui.view.rowsRoot.textContent,/Archive/);assert.equal(ui.view.rowsRoot.querySelectorAll('details').length,1);assert.equal(ui.view.rowsRoot.querySelector('summary').textContent,'/same');
});
test('Claude recent list compares Desktop milliseconds and CLI seconds as the same time scale',async()=>{
 const ui=fixture();await ui.view.choose('claude');
 const desktopOlder=Date.UTC(2026,9,14,12),cliNewest=Date.UTC(2026,9,16,12),desktopMiddle=Date.UTC(2026,9,15,12);
 ui.view.rows=[{id:'code',title:'Desktop Code',backend:'code',cwd:'/same',updatedAt:desktopOlder},
  {id:'cli',title:'CLI latest',backend:'cli',cwd:'/same',updatedAt:cliNewest/1000},
  {id:'cowork',title:'Desktop Cowork',backend:'cowork',cwd:'/same',updatedAt:desktopMiddle}];
 ui.view.renderList();
 const ids=()=>ui.view.rowsRoot.querySelectorAll('.session').map(row=>row.dataset.id);
 assert.deepEqual(ids(),['cli','cowork','code']);
 assert.equal(ui.view.rowsRoot.querySelector('.session').querySelector('time').textContent,
  new Date(cliNewest).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'}));
 ui.view.surface.value='cli';ui.view.surface.onchange();assert.deepEqual(ids(),['cli']);
 ui.view.surface.value='all';ui.view.surface.onchange();ui.view.search.value='Desktop';ui.view.renderList();assert.deepEqual(ids(),['cowork','code']);
 ui.view.search.value='';ui.view.listMode.value='project';ui.view.renderList();assert.deepEqual(ids(),['cli','cowork','code']);
});
test('Claude type filter uses full inventory and returns to all when a type disappears',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.view.rows=[{id:'code',title:'Code chat',backend:'code',updatedAt:2},{id:'cli',title:'CLI chat',backend:'cli',updatedAt:1}];ui.view.renderList();const selector=ui.view.surface;assert.equal(selector.hidden,false);assert.deepEqual(selector.children.map(n=>n.value),['all','code','cli']);assert.equal(selector.children[0].textContent,'全部会话');assert.deepEqual(ui.view.rowsRoot.querySelectorAll('.session').map(n=>n.dataset.id),['code','cli']);
 selector.value='cli';selector.onchange();assert.deepEqual(ui.view.rowsRoot.querySelectorAll('.session').map(n=>n.dataset.id),['cli']);const options=[...selector.children];ui.view.rows=[{id:'code',title:'Code updated',backend:'code',updatedAt:3},{id:'cli',title:'CLI chat',backend:'cli',updatedAt:1}];ui.view.renderList();assert.strictEqual(selector.children[0],options[0]);assert.strictEqual(selector.children[2],options[2]);ui.view.search.value='Code';ui.view.renderList();assert.strictEqual(selector.children[2],options[2]);assert.equal(selector.hidden,false);assert.equal(selector.value,'cli');ui.run("BridgeI18n.setLanguage('en')");ui.view.relabel();assert.equal(selector.children[0].textContent,'All');assert.equal(selector.value,'cli');ui.view.search.value='';ui.view.rows=[{id:'code',title:'Code chat',backend:'code',updatedAt:2}];ui.view.renderList();assert.equal(selector.hidden,true);assert.equal(selector.value,'all');assert.equal(ui.view.rowsRoot.querySelector('.ds-session-type').textContent,'Code');assert.equal(ui.view.rowsRoot.querySelector('.session').classList.contains('ds-session-row'),true);
});
test('single-source Claude and DSH rows retain their type label above the date',()=>{
 const ui=fixture();
 for(const [provider,backend,label] of [['claude','code','Code'],['claude','cowork','Cowork'],['claude','cli','CLI'],['deepseek','chat','APP']]){
  ui.view.provider=provider;ui.view.rows=[{id:'single',backend,title:'Only source',updatedAt:1}];ui.view.renderList();
  const row=ui.view.rowsRoot.querySelector('.session');
  assert.equal(ui.view.surface.hidden,true);assert.ok(row.classList.contains('ds-session-row'));
  assert.equal(row.children[1].className,'ds-session-type');assert.equal(row.children[1].textContent,label);
  assert.equal(row.children[2].tagName,'SMALL');assert.ok(row.children[2].querySelector('time'));
 }
});
test('Claude type choice survives provider switches but not loss of that type',async()=>{
 const ui=fixture();ui.setHandler(async url=>({sessions:url.includes('/claude/')?[{id:'code',title:'Code',backend:'code'},{id:'cowork',title:'Cowork',backend:'cowork'}]:[]}));await ui.view.choose('claude');ui.view.surface.value='cowork';ui.view.surface.onchange();await ui.view.choose('deepseek');assert.equal(ui.view.surface.hidden,true);await ui.view.choose('claude');assert.equal(ui.view.surface.value,'cowork');assert.deepEqual(ui.view.rowsRoot.querySelectorAll('.session').map(n=>n.dataset.id),['cowork']);
});
test('workspace tabs use the real Workbench provider routes and split behavior',async()=>{
 const ui=await opened();assert.equal(ui.view.workbench.current.provider,'claude');ui.view.workbench.files();await Promise.resolve();assert.ok(ui.calls.some(c=>c.url.includes('/api/desktop-sessions/claude/workspace?sessionId=a')));ui.view.workbench.split('files');assert.equal(ui.view.workbench.splitMode,true);assert.ok(ui.view.conversation.classList.contains('wb-split'));assert.equal(ui.view.workbench.current.splitTab,'files');
});
test('PDF reading position survives file-tab and chat-back navigation',async()=>{
 const ui=await opened(),wb=ui.view.workbench,session=wb.current;
 const files={id:'files',name:'Files',body:wb.node('div','wb-browser')};
 const pdf={id:'file:report.pdf',name:'report.pdf',body:wb.node('div','wb-preview')};
 const stage=wb.node('div','wb-pdf-stage');pdf.body.append(stage);session.files=[files,pdf];
 wb.select(pdf.id);stage.scrollTop=720;stage.scrollLeft=42;
 wb.select(files.id);stage.scrollTop=0;stage.scrollLeft=0;
 wb.select(pdf.id);assert.equal(stage.scrollTop,720);assert.equal(stage.scrollLeft,42);
 stage.scrollTop=915;stage.scrollLeft=19;
 assert.equal(wb.back(),true);assert.equal(session.active,'chat');
 stage.scrollTop=0;stage.scrollLeft=0;
 wb.select(pdf.id);assert.equal(stage.scrollTop,915);assert.equal(stage.scrollLeft,19);
});
test('file back follows parent directories before returning to chat on the shared page button',async()=>{
 const ui=await opened(),wb=ui.view.workbench,session=wb.current;
 const settle=()=>new Promise(setImmediate);
 const entries={'':[{'name':'src','path':'src','kind':'directory'}],src:[{'name':'lib','path':'src/lib','kind':'directory'}],'src/lib':[]};
 ui.setHandler(async url=>{const at=new URL(url,'http://fixture').searchParams.get('path');return {project:'/project',total:entries[at]?.length||0,entries:entries[at]||[],nextOffset:null};});
 wb.files();await settle();const tab=session.files.find(t=>t.id==='files');
 tab.list.querySelector('.wb-file').click();await settle();tab.list.querySelector('.wb-file').click();await settle();assert.equal(session.directory,'src/lib');
 await ui.view.back.click();assert.equal(session.directory,'src');assert.equal(session.active,'files');
 await ui.view.back.click();assert.equal(session.directory,'');assert.equal(session.active,'files');
 await ui.view.back.click();assert.equal(session.active,'chat');assert.equal(ui.view.isChatOpen,true);
 await ui.view.back.click();assert.equal(ui.view.isChatOpen,false);
});
test('rapid file backs ignore stale responses and a failed parent read stays in the file browser',async()=>{
 const ui=await opened(),wb=ui.view.workbench,session=wb.current,pending=[];
 ui.setHandler((url,_body)=>{const path=new URL(url,'http://fixture').searchParams.get('path');if(path==='')return Promise.resolve({project:'/project',total:0,entries:[],nextOffset:null});return new Promise((resolve,reject)=>pending.push({path,resolve,reject}));});
 wb.files();await Promise.resolve();const tab=session.files.find(t=>t.id==='files');
 const deep=wb.directory(session,tab,'src/lib');assert.equal(wb.back(),true);assert.equal(session.directory,'src');
 const parent=pending.at(-1);assert.equal(parent.path,'src');assert.equal(wb.back(),true);assert.equal(session.directory,'');
 parent.reject(Error('late parent failure'));pending[0].resolve({project:'/old',total:1,entries:[{name:'old',path:'old',kind:'file'}],nextOffset:null});
 await deep;await Promise.resolve();assert.equal(session.directory,'');assert.equal(tab.status.classList.contains('error'),false);assert.equal(tab.list.children.length,0);
 const failed=wb.directory(session,tab,'src');pending.at(-1).reject(Error('directory unavailable'));await failed;
 assert.equal(session.active,'files');assert.equal(session.directory,'src');assert.equal(tab.status.classList.contains('error'),true);
 assert.equal(wb.back(),true);await Promise.resolve();assert.equal(session.directory,'');assert.equal(session.active,'files');
});
test('a directory response from an earlier chat cannot replace the selected chat file view',async()=>{
 const ui=await opened(),wb=ui.view.workbench,first=wb.current;let finish;
 ui.setHandler(url=>new Promise(resolve=>{const path=new URL(url,'http://fixture').searchParams.get('path');if(path==='src')finish=resolve;else resolve({project:'/second',total:0,entries:[],nextOffset:null});}));
 wb.files();await Promise.resolve();const oldTab=first.files.find(t=>t.id==='files'),reading=wb.directory(first,oldTab,'src');
 wb.open('b','local');wb.files();await Promise.resolve();const second=wb.current,secondTab=second.files.find(t=>t.id==='files');
 finish({project:'/first',total:1,entries:[{name:'old',path:'src/old',kind:'file'}],nextOffset:null});await reading;
 assert.equal(wb.current,second);assert.equal(second.directory,'');assert.equal(secondTab.list.children.length,0);assert.equal(wb.panel.firstElementChild,secondTab.body);
});
test('wide split file back consumes the visible file tab, then returns to unsplit chat',async()=>{
 const ui=await opened(),wb=ui.view.workbench,session=wb.current;
 ui.setHandler(async()=>({project:'/project',total:0,entries:[],nextOffset:null}));wb.files();await Promise.resolve();const tab=session.files.find(t=>t.id==='files');
 wb.split('files');await wb.directory(session,tab,'src/lib');assert.equal(wb.isFileVisible,false);
 assert.equal(wb.back(),true);assert.equal(session.directory,'src');assert.equal(wb.splitMode,true);
 assert.equal(wb.back(),true);assert.equal(session.directory,'');assert.equal(wb.splitMode,true);
 assert.equal(wb.back(),true);assert.equal(session.active,'chat');assert.equal(session.splitTab,null);assert.equal(wb.splitMode,false);
 assert.equal(wb.back(),false);
});

for(const [closed,next] of [['files','terminal'],['terminal','file:preview'],['file:preview','terminal']])test(`closing active split ${closed} selects adjacent ${next} and preserves the main chat`,async()=>{
 const ui=await opened(),wb=ui.view.workbench,session=wb.current,disposed=[];
 session.files=['files','terminal','file:preview'].map(id=>({id,name:id,body:wb.node('div'),terminal:id==='terminal'?{dispose:()=>disposed.push(id)}:undefined}));
 ui.view.input.value='unsent draft';ui.view.messages.scrollTop=42;wb.split(closed);session.splitRatio=.6;
 await wb.close(closed);assert.equal(session.splitTab,next);assert.equal(session.active,next);assert.equal(wb.splitMode,true);assert.equal(wb.panel.firstElementChild,session.files.find(t=>t.id===next).body);assert.equal(ui.view.input.value,'unsent draft');assert.equal(ui.view.messages.scrollTop,42);assert.equal(session.splitRatio,.6);assert.deepEqual(disposed,closed==='terminal'?['terminal']:[]);
});
test('inactive closes and consecutive closes preserve split until the final tool is closed',async()=>{
 const ui=await opened(),wb=ui.view.workbench,s=wb.current;
 s.files=['files','terminal','file:preview'].map(id=>({id,name:id,body:wb.node('div')}));wb.split('terminal');
 await wb.close('files');assert.equal(s.splitTab,'terminal');await wb.close('terminal');assert.equal(s.splitTab,'file:preview');assert.equal(wb.splitMode,true);
 await wb.close('file:preview');assert.equal(s.splitTab,null);assert.equal(s.active,'chat');assert.equal(wb.splitMode,false);assert.equal(wb.panel.hidden,true);
});
test('closing a split tool while narrow preserves the adjacent tool when widened',async()=>{
 const ui=await opened(),wb=ui.view.workbench,s=wb.current;
 s.files=['files','file:preview'].map(id=>({id,name:id,body:wb.node('div')}));wb.split('file:preview');ui.view.conversation.clientWidth=390;wb.paint();
 await wb.close('file:preview');assert.equal(s.splitTab,'files');assert.equal(wb.splitMode,false);ui.view.conversation.clientWidth=1000;wb.paint();assert.equal(wb.splitMode,true);assert.equal(wb.panel.firstElementChild,s.files[0].body);
 wb.unsplit();await wb.close('files');assert.equal(s.active,'chat');assert.equal(s.splitTab,null);
});
test('a pending Harness side-chat close updates only its original session and respects cancellation',async()=>{
 const ui=await opened(),wb=ui.view.workbench,s=wb.current;let finish;
 s.provider='deepseek';
 s.files=['files','sidechat'].map(id=>({id,name:id,body:wb.node('div')}));s.files[1].sideChat={end:()=>new Promise(resolve=>finish=resolve),references:{close(){}},dispose(){}};wb.split('sidechat');
 const cancelled=wb.close('sidechat');finish(false);await cancelled;assert.equal(s.splitTab,'sidechat');assert.equal(s.files.length,2);
 const closing=wb.close('sidechat');wb.open('other','local');const other=wb.current;finish(true);await closing;assert.equal(wb.current,other);assert.equal(s.splitTab,'files');assert.equal(s.active,'files');assert.equal(other.active,'chat');
});

test('model picker preserves current effort only for compatible models',async()=>{
 const ui=await opened();ui.setHandler(async()=>({models:[{id:'model-a',efforts:['high','low']},{id:'model-b',efforts:['low'],defaultEffort:'low'}],currentModel:'model-a',currentEffort:'high'}));await ui.view.models();const dialog=ui.document.querySelector('dialog'),selects=dialog.querySelectorAll('select');assert.equal(selects[1].value,'high');selects[0].value='model-b';selects[0].onchange();assert.equal(selects[1].value,'low');
});
test('Claude creation selects Code or Cowork explicitly and requires the first message',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async()=>({projects:[{key:'code:/project',name:'Project Code',cwd:'/project',surface:'code'},{key:'cowork:/project',name:'Project Cowork',cwd:'/project',surface:'cowork'}],requiresMessage:true}));await ui.view.create();const dialog=ui.document.querySelector('dialog'),selects=dialog.querySelectorAll('select');assert.equal(selects.length,2);assert.deepEqual(selects[0].children.map(n=>n.value),['code','cowork']);assert.equal(dialog.querySelector('textarea').required,true);selects[0].value='cowork';selects[0].onchange();assert.deepEqual(selects[1].children.map(n=>n.value),['cowork:/project']);
});
test('late send completion preserves text typed while the request was in flight',async()=>{
 const ui=await opened();let finish;ui.setHandler((url,body)=>body?new Promise(resolve=>finish=resolve):Promise.resolve({sessions:[]}));ui.view.input.value='sent';const sending=ui.view.submit();ui.view.input.value='next draft';ui.view.input.oninput();finish({status:'accepted'});await sending;assert.equal(ui.view.input.value,'next draft');assert.equal(ui.view.drafts.get('claude:a'),'next draft');
});
for(const provider of ['claude','deepseek'])for(const scope of ['current','background'])test(`${provider} late send cannot clear a new account draft or attachments after a ${scope} account switch`,async()=>{
 const ui=await pendingAttachmentSend(provider),view=ui.view;
 if(scope==='background'){await view.choose(provider==='claude'?'deepseek':'claude');await view.open('a');}
 await view.accountChanged(provider,{activeId:'old'},{activeId:'new'});if(view.provider!==provider)await view.choose(provider);await view.open('a');view.input.value='$review';view.input.oninput();view.attachments.rows.push({id:'new-upload',name:'new.png',status:'ready',size:16});view.attachments.save(view.attachments.key,view.attachments.rows);
 ui.finish({status:'accepted'});await ui.sending;assert.equal(view.input.value,'$review');assert.equal(view.drafts.get(provider+':a'),'$review');assert.deepEqual(Array.from(view.attachments.ids()),['new-upload']);assert.equal(ui.clears.length,0);assert.equal(ui.calls.filter(call=>call.body).length,1);
});
for(const provider of ['claude','deepseek'])test(`${provider} late send cannot clear a new login draft or attachments with the same chat id and text`,async()=>{
 const ui=await pendingAttachmentSend(provider),view=ui.view;view.clear();await view.choose(provider);await view.open('a');view.input.value='$review';view.input.oninput();view.attachments.rows.push({id:'login-upload',name:'login.png',status:'ready',size:16});view.attachments.save(view.attachments.key,view.attachments.rows);const uploadIds=Array.from(view.attachments.ids());
 ui.finish({status:'accepted'});await ui.sending;assert.equal(view.input.value,'$review');assert.equal(view.drafts.get(provider+':a'),'$review');assert.deepEqual(Array.from(view.attachments.ids()),uploadIds);assert.equal(ui.clears.length,0);
});
for(const destination of ['chat','provider'])test(`accepted send still clears only the original chat attachments after switching ${destination}`,async()=>{
 const ui=await pendingAttachmentSend(),view=ui.view;
 if(destination==='provider'){await view.choose('deepseek');await view.accountChanged('deepseek',{activeId:'old'},{activeId:'new'});}
 await view.open(destination==='chat'?'b':'a');view.input.value='another draft';view.input.oninput();view.attachments.rows.push({id:'other-upload',name:'other.png',status:'ready',size:16});view.attachments.save(view.attachments.key,view.attachments.rows);const currentKey=view.attachments.key;
 ui.finish({status:'accepted'});await ui.sending;assert.equal(ui.clears.length,1);assert.equal(ui.clears[0].key,'["claude","a"]');assert.deepEqual(ui.clears[0].ids,['sent-upload']);assert.equal(view.attachments.drafts.get('["claude","a"]').length,0);assert.equal(view.attachments.key,currentKey);assert.deepEqual(Array.from(view.attachments.ids()),['other-upload']);assert.equal(view.input.value,'another draft');assert.equal(view.drafts.get(view.provider+':'+view.sid),'another draft');
});
test('detail capabilities gate actual model, permission and queue actions',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async()=>({session:{id:'a',title:'Chat',status:'active'},capabilities:{models:false,permissions:false,queue:false,steer:false},messages:[]}));await ui.view.open('a');assert.equal(ui.view.modelButton.disabled,true);assert.equal(ui.view.permissionsButton.hidden,true);assert.equal(ui.view.mode.options[1].disabled,true);assert.equal(ui.view.mode.options[2].disabled,true);
});
test('HTTP clipboard fallback uses the shared selectable copy dialog',async()=>{
 const ui=fixture();await ui.view.choose('deepseek');ui.setHandler(async()=>({session:{id:'a',title:'Chat',status:'idle'},messages:[{id:'1',role:'assistant',text:'copy me'}]}));await ui.view.open('a');await ui.view.messages.querySelector('button').click();assert.equal(ui.document.querySelector('.copy-dialog').querySelector('textarea').value,'copy me');
});
for(const provider of ['claude','deepseek'])test(`${provider} message Copy uses the native clipboard after an actual trusted button click`,async()=>{
 const ui=fixture(),text='第一行\n\n```js\nconst answer = 42;\n```\n🙂';await ui.view.choose(provider);ui.view.renderMessages([{id:'native-copy',role:'assistant',text}]);
 ui.run('window.top=window;globalThis.nativeCopies=[];window.prompt=(command,text)=>{if(command.startsWith("codexbridge-copy:")){nativeCopies.push(text);return "copied";}};');ui.run(fs.readFileSync(path.join(__dirname,'../mobile/shared/web/mobile-clipboard.js'),'utf8'));
 const copy=ui.view.messages.querySelector('button');ui.document.dispatchEvent({type:'click',isTrusted:true,target:copy});await copy.click();assert.deepEqual(Array.from(ui.run('nativeCopies')),[text]);assert.equal(copy.textContent,'已复制');assert.equal(copy.disabled,false);
});
test('native Claude message copy rejection surfaces an error and restores the button',async()=>{
 const ui=await opened(),errors=[];ui.view.renderMessages([{id:'native-failure',role:'assistant',text:'copy fails'}]);ui.document.addEventListener('bridge-message-error',event=>errors.push(event.detail));ui.run('window.top=window;window.prompt=()=>"rejected";');ui.run(fs.readFileSync(path.join(__dirname,'../mobile/shared/web/mobile-clipboard.js'),'utf8'));
 const copy=ui.view.messages.querySelector('button');ui.document.dispatchEvent({type:'click',isTrusted:true,target:copy});await copy.click();assert.deepEqual(errors,['复制失败，请重试']);assert.equal(copy.textContent,'复制');assert.equal(copy.disabled,false);
});
test('permissions render the native catalog choices using shared permissionOption',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async()=>({session:{id:'a',title:'Chat',status:'idle'},capabilities:{permissions:true},messages:[]}));await ui.view.open('a');ui.setHandler(async(url,body)=>body?{status:'accepted'}:{mode:'default',options:[{value:'default',label:'Default',description:'Ask first'},{value:'acceptEdits',label:'Accept edits',description:'Edit files'}]});await ui.view.permissions();const buttons=ui.document.querySelectorAll('.permission-option');assert.equal(buttons.length,2);assert.equal(buttons[0].getAttribute('aria-pressed'),'true');await buttons[1].click();assert.equal(ui.calls.find(c=>c.body).body.mode,'acceptEdits');
});
test('Claude creation sends the selected surface project and explicit first message only on submit',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async(url,body)=>body?{status:'ready',result:{id:'created'}}:url.includes('/projects')?{projects:[{key:'cowork:/p',name:'Project',cwd:'/p',surface:'cowork'}],createRequiresMessage:true}:url.includes('/detail')?{session:{id:'created',title:'Custom title',status:'idle'},messages:[]}:{sessions:[]});await ui.view.create();assert.equal(ui.calls.some(c=>c.body),false);const dialog=ui.document.querySelector('dialog');dialog.querySelector('input').value='Custom title';dialog.querySelector('textarea').value='First instruction';await dialog.querySelector('form').onsubmit({preventDefault(){}});const sent=ui.calls.find(c=>c.body);assert.equal(sent.body.projectKey,'cowork:/p');assert.equal(sent.body.firstMessage,'First instruction');assert.equal(sent.body.title,'Custom title');assert.equal(sent.body.sessionId,null);
});
test('Claude CLI creation uses its own project and native first message without a title',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async(url,body)=>body?{status:'ready',result:{id:'cli-created'}}:url.includes('/projects')?{projects:[{key:'code:/p',name:'Desktop',cwd:'/p',surface:'code'},{key:'cli:opaque',name:'Local CLI',cwd:'/cli',surface:'cli'}],createRequiresMessage:true}:url.includes('/detail')?{session:{id:'cli-created',title:'Native title',status:'idle'},messages:[]}:{sessions:[]});await ui.view.create();const dialog=ui.document.querySelector('dialog'),selects=dialog.querySelectorAll('select');assert.deepEqual(selects[0].children.map(n=>n.value),['code','cli']);selects[0].value='cli';selects[0].onchange();assert.deepEqual(selects[1].children.map(n=>n.value),['cli:opaque']);assert.equal(dialog.querySelector('input').parentElement.hidden,true);dialog.querySelector('textarea').value='Native first request';await dialog.querySelector('form').onsubmit({preventDefault(){}});const sent=ui.calls.find(c=>c.body);assert.equal(sent.body.projectKey,'cli:opaque');assert.equal(sent.body.firstMessage,'Native first request');assert.equal(Object.hasOwn(sent.body,'title'),false);
});

test('shared attachments handle paste, block send until upload, and submit only upload ids',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async(url,body)=>body?{status:'accepted'}:url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle'},capabilities:{attachments:true},messages:[]}:{sessions:[]});await ui.view.open('a');let finish;ui.setUploadHandler(()=>new Promise(resolve=>finish=resolve));let prevented=false;ui.view.input.onpaste({clipboardData:{files:[{name:'image.png',type:'image/png',size:16}]},preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(ui.view.send.disabled,true);assert.equal(ui.view.attachments.rows[0].status,'uploading');await ui.view.submit();assert.equal(ui.calls.some(c=>c.body),false);
 finish({ok:true,status:200,json:async()=>({name:'image.png',size:16,image:true})});await new Promise(setImmediate);assert.equal(ui.view.send.disabled,false);const row=ui.view.attachments.rows[0];assert.equal(row.status,'ready');assert.match(ui.calls.find(c=>c.upload).url,/claude\/uploads\?sessionId=a&id=/);assert.equal(ui.calls.find(c=>c.upload).upload.headers['X-CSRF-Token'],'csrf-test');await ui.view.submit();assert.equal(ui.calls.find(c=>c.body).body.attachments[0],row.id);assert.equal(ui.view.attachments.rows.length,0);
});
test('attachment upload remains scoped to its source chat after provider switching',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle'},capabilities:{attachments:true},messages:[]}:{sessions:[]});await ui.view.choose('claude');await ui.view.open('a');let finish;ui.setUploadHandler(()=>new Promise(resolve=>finish=resolve));ui.view.attachments.add([{name:'source.png',type:'image/png',size:16}]);await ui.view.choose('deepseek');await ui.view.open('a');finish({ok:true,status:200,json:async()=>({name:'source.png',size:16,image:true})});await new Promise(setImmediate);assert.equal(ui.view.attachments.rows.length,0);assert.equal(ui.view.attachments.drafts.get('["claude","a"]')[0].status,'ready');assert.ok(ui.calls.filter(c=>c.upload).every(c=>c.url.includes('/claude/')));
});
test('unsupported attachment types are explicit and never uploaded',async()=>{
 const ui=await opened();ui.view.state.capabilities={attachments:true};ui.view.updateComposer();ui.view.attachments.add([{name:'notes.txt',type:'text/plain',size:16}]);assert.match(ui.view.attachments.error,/仅支持图片/);assert.equal(ui.calls.some(c=>c.upload),false);assert.equal(ui.view.attachments.rows.length,0);
});

test('a send finishing during polling schedules a fresh detail after the stale response',async()=>{
 const ui=await opened();let finishList,listCalls=0,detailCalls=0;ui.setHandler(async(url,body)=>{if(body)return {status:'accepted'};if(url.includes('/list')){listCalls++;if(listCalls===1)return new Promise(resolve=>finishList=resolve);return {sessions:[]};}return {session:{id:'a',title:'Chat',status:'idle'},messages:[{id:'reply',role:'assistant',text:++detailCalls===1?'old snapshot':'new reply'}]};});
 const polling=ui.view.refresh();ui.view.input.value='send while polling';await ui.view.submit();finishList({sessions:[]});await polling;await new Promise(setImmediate);assert.equal(listCalls,2);assert.match(ui.view.messages.textContent,/new reply/);
});
test('form submission respects the session send capability',async()=>{
 const ui=await opened();ui.view.state.capabilities.send=false;ui.view.updateComposer();ui.view.input.value='must not send';await ui.view.form.onsubmit({preventDefault(){}});assert.equal(ui.calls.some(c=>c.body),false);
});
test('question cards submit exact native question keys and do not invent Harness denial',async()=>{
 const ui=await opened();ui.view.renderRequests([{id:'q1',tool:'AskUserQuestion',needsInput:true,input:{questions:[{id:'native-id',question:'Choose',options:[{label:'A'},{label:'B'}]}]}}]);const form=ui.view.requests.querySelector('form'),inputs=form.querySelectorAll('input');inputs[1].checked=true;inputs[2].value='custom detail';await form.onsubmit({preventDefault(){}});await Promise.resolve();const body=ui.calls.find(c=>c.body).body;assert.equal(body.requestId,'q1');assert.equal(body.decision,'accept');assert.deepEqual(Array.from(body.answers['native-id'].answers),['B','custom detail']);
 await ui.view.choose('deepseek');await ui.view.open('a');ui.view.renderRequests([{id:'q2',tool:'Question',needsInput:true,input:{questions:[]}}]);assert.equal(ui.view.requests.querySelectorAll('button').length,1);ui.view.renderRequests([{id:'approval',tool:'Write',needsInput:false,input:{reason:'write a file'}}]);await ui.view.requests.querySelectorAll('button')[1].click();assert.equal(ui.calls.filter(c=>c.body).at(-1).body.decision,'decline');
});
test('the plus picker inserts skill text, disables plugins and preserves an unconfirmed draft across clients',async()=>{
 const ui=fixture();ui.setHandler(async(url,body)=>body?{status:'unknown'}:url.includes('/catalog')?{skills:[{id:'review',name:'Review',kind:'skill',selectable:true},{id:'installed:tools',name:'Tools',kind:'plugin',selectable:false}]}:url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle'},capabilities:{skills:true},messages:[]}:{sessions:[]});await ui.view.choose('deepseek');await ui.view.open('a');
 assert.equal(ui.view.referenceButton.textContent,'＋');assert.equal(ui.view.referenceButton.hidden,false);assert.equal(ui.view.skillPills,undefined);assert.equal(ui.view.skillSelections,undefined);
 await ui.view.referenceButton.click();await new Promise(setImmediate);const dialog=ui.document.querySelector('dialog'),options=dialog.querySelectorAll('button'),skill=options.find(node=>node.textContent.includes('Review')),plugin=options.find(node=>node.textContent.includes('Tools'));assert.ok(skill);assert.equal(plugin.disabled,true);await skill.click();
 assert.match(ui.view.input.value,/\$Review/);assert.equal(ui.view.drafts.get('deepseek:a'),ui.view.input.value);const draft=ui.view.input.value;await ui.view.submit();const sent=ui.calls.find(call=>call.body).body;assert.equal(sent.text,draft.trim());assert.equal(Object.hasOwn(sent,'plugins'),false);assert.equal(Object.hasOwn(sent,'skills'),false);assert.equal(ui.view.input.value,draft);
 await ui.view.choose('claude');await ui.view.open('a');assert.equal(ui.view.input.value,'');await ui.view.choose('deepseek');await ui.view.open('a');assert.equal(ui.view.input.value,draft);
});
test('Claude request-size limit stays in attachment help and rejects oversized images before upload',async()=>{
 const ui=fixture();await ui.view.choose('claude');ui.setHandler(async()=>({session:{id:'a',title:'Chat',status:'idle'},capabilities:{attachments:true},maxRequestBytes:10*1024*1024,messages:[]}));await ui.view.open('a');assert.ok(!ui.view.composerBody.querySelector('.ds-attachment-hint'));assert.match(ui.view.attachButton.title,/10 MiB/);ui.view.attachments.add([{name:'large.png',type:'image/png',size:8*1024*1024}]);assert.equal(ui.calls.some(c=>c.upload),false);assert.match(ui.view.attachments.error,/10 MiB/);
});
test('history updates retain expanded activities and honor visibility settings',async()=>{
 const ui=await opened();ui.view.renderMessages([{id:'step',role:'activity',title:'Write',text:'before'}]);ui.view.messages.children[0].open=true;ui.view.renderMessages([{id:'step',role:'activity',title:'Write',text:'after'},{id:'thought',role:'reasoning',text:'summary'}]);assert.equal(ui.view.messages.children[0].open,true);ui.document.documentElement.dataset.showProcess='false';ui.document.documentElement.dataset.showReasoning='false';ui.view.renderMessages(ui.view.lastMessages);assert.ok(ui.view.messages.children.every(n=>n.hidden));
});

test('inserted references remain ordinary text when the catalog changes and clear after acceptance',async()=>{
 const ui=fixture();let available=true;ui.setHandler(async(url,body)=>body?{status:'accepted'}:url.includes('/catalog')?{skills:available?[{id:'review',name:'Review',selectable:true}]:[]}:url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle'},capabilities:{skills:true},messages:[]}:{sessions:[]});await ui.view.choose('claude');await ui.view.open('a');await ui.view.referenceButton.click();await new Promise(setImmediate);await ui.document.querySelector('dialog').querySelectorAll('button').find(node=>node.textContent.includes('Review')).click();
 available=false;const result=await ui.view.loadReferences('skills',{target:ui.view.referenceContext()});assert.equal(result.items.length,0);assert.match(ui.view.input.value,/\$Review/);await ui.view.submit();assert.equal(ui.calls.find(call=>call.body).body.text,'$Review');assert.equal(ui.view.input.value,'');assert.equal(ui.view.drafts.has('claude:a'),false);await new Promise(setImmediate);assert.equal(ui.view.send.disabled,false);
});

test('reference tabs remain available without skills and never resume a closed Claude CLI chat',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/detail')?cliDetail():url.includes('/workspace')?{root:'/cli-project',entries:[],nextOffset:null}:{sessions:[]});ui.view.setClientStates([{id:'claude',enabled:true,connected:false,cliAvailable:true}]);await ui.view.choose('claude');await ui.view.open('cli-a');await ui.view.referenceButton.click();const picker=ui.view.referencePicker;
 assert.equal(picker.tab,'files');assert.equal(picker.tabButtons.get('skills').disabled,true);assert.equal(picker.tabButtons.get('files').disabled,false);assert.equal(picker.tabButtons.get('sessions').disabled,false);await picker.tabButtons.get('sessions').click();assert.match(picker.notice.textContent,/未提供原生会话链接/);assert.equal(ui.calls.some(call=>call.body),false);assert.equal(ui.calls.some(call=>call.url.includes('/catalog')),false);
});

test('skill references insert the native name and filter unavailable commands without using display names as invocation text',async()=>{
 const ui=await opened();ui.view.state.capabilities.skills=true;ui.setHandler(async()=>({skills:[{id:'opaque',name:'native-review',displayName:'Review display',description:'Check changes'},{id:'disabled',name:'disabled',enabled:false},{id:'not-invocable',name:'internal',selectable:false},{id:'missing-name',displayName:'No invocation'}]}));await ui.view.referenceButton.click();const picker=ui.view.referencePicker;
 assert.equal(picker.active.items[0].value,'$native-review');assert.ok(picker.active.items.slice(1).every(item=>item.disabled));await picker.list.querySelectorAll('button').find(node=>node.textContent.includes('Review display')).click();assert.equal(ui.view.input.value.trim(),'$native-review');assert.equal(ui.calls.some(call=>call.body),false);
});

test('file references lazily expand a full directory tree and insert the backend Windows root into the draft',async()=>{
 const ui=await opened();ui.view.state.cwd='C:\\stale-root';ui.view.input.value='inspect';ui.view.input.setSelectionRange(7,7);const entries={'':[{name:'src',path:'src',kind:'directory'}],src:[{name:'lib',path:'src/lib',kind:'directory'}],'src/lib':[{name:'source.js',path:'src/lib/source.js',kind:'file'},{name:'blocked',path:'src/lib/blocked',kind:'blocked'}]};
 ui.setHandler(async url=>{const path=new URL(url,'https://fixture').searchParams.get('path');return {root:'D:\\Current project',project:'Current project',entries:entries[path]||[],nextOffset:null};});await ui.view.referenceButton.click();const picker=ui.view.referencePicker;assert.equal(picker.project.textContent,'D:\\Current project');
 let directory=picker.list.querySelector('details');directory.open=true;directory.ontoggle();await new Promise(setImmediate);directory=picker.list.querySelectorAll('details').find(node=>node.dataset.referenceGroup==='directory:src/lib');assert.ok(directory);directory.open=true;directory.ontoggle();await new Promise(setImmediate);
 const rows=picker.list.querySelectorAll('button');assert.equal(rows.find(node=>node.textContent.includes('blocked')).disabled,true);await rows.find(node=>node.textContent.includes('source.js')).click();assert.equal(ui.view.input.value,'inspect\nD:\\Current project\\src\\lib\\source.js\n');assert.equal(ui.view.drafts.get('claude:a'),ui.view.input.value);assert.equal(picker.dialog.open,false);assert.deepEqual(ui.calls.filter(call=>call.url.includes('/workspace')).map(call=>new URL(call.url,'https://fixture').searchParams.get('path')),['','src','src/lib']);assert.equal(ui.calls.some(call=>call.body),false);
});

test('project file search sends recursive, hidden, offset and abort parameters while retaining directory groups',async()=>{
 const ui=await opened(),controller=new AbortController();ui.setHandler(async()=>({root:'/actual/project',project:'project',entries:[{name:'needle.txt',path:'src/deep/needle.txt',kind:'file'}],nextOffset:400,truncated:true}));const result=await ui.view.loadReferences('files',{target:ui.view.referenceContext(),query:'needle',path:'src',offset:200,hidden:true,signal:controller.signal});const read=ui.calls.at(-1),url=new URL(read.url,'https://fixture');
 assert.equal(url.pathname,'/api/desktop-sessions/claude/workspace');assert.equal(url.searchParams.get('sessionId'),'a');assert.equal(url.searchParams.get('path'),'src');assert.equal(url.searchParams.get('search'),'needle');assert.equal(url.searchParams.get('recursive'),'true');assert.equal(url.searchParams.get('hidden'),'true');assert.equal(url.searchParams.get('offset'),'200');assert.equal(read.signal,controller.signal);assert.equal(read.body,undefined);assert.equal(result.nextOffset,400);assert.equal(result.items[0].value,'/actual/project/src/deep/needle.txt');assert.deepEqual(Array.from(result.items[0].groups,group=>group.path),['src','src/deep']);assert.match(result.notice,/搜索结果未全部列出/);
 await ui.view.loadReferences('files',{target:ui.view.referenceContext()});const defaults=new URL(ui.calls.at(-1).url,'https://fixture').searchParams;assert.equal(defaults.get('hidden'),'false');assert.equal(defaults.has('recursive'),false);
});

test('recursive search renders nested file groups and inserts a POSIX absolute path',async()=>{
 const ui=await opened();ui.setHandler(async()=>({root:'/project',entries:[{name:'needle.txt',path:'src/lib/needle.txt',kind:'file'}],nextOffset:null}));await ui.view.referenceButton.click();const picker=ui.view.referencePicker;picker.search.value='needle';picker.search.oninput();await picker.loadPage();assert.deepEqual(picker.list.querySelectorAll('summary').map(node=>node.textContent),['src','lib']);assert.ok(picker.list.querySelectorAll('details').every(node=>node.open));await picker.list.querySelector('button').click();assert.equal(ui.view.input.value.trim(),'/project/src/lib/needle.txt');assert.equal(ui.view.drafts.get('claude:a'),ui.view.input.value);
});

test('missing roots, blocked paths and remote workspaces cannot become invented local file references',async()=>{
 const ui=await opened();ui.view.state.cwd='/cached/guess';ui.setHandler(async()=>({project:'basename',entries:[{name:'a.txt',path:'a.txt',kind:'file'}],nextOffset:null}));const missing=await ui.view.loadReferences('files',{target:ui.view.referenceContext()});assert.equal(missing.items[0].value,'');assert.equal(missing.items[0].disabled,true);assert.match(missing.error,/完整目录/);
 const before=ui.calls.length;const remote=await ui.view.loadReferences('files',{target:{...ui.view.referenceContext(),host:'ssh:server'}});assert.equal(ui.calls.length,before);assert.equal(remote.items.length,0);assert.match(remote.error,/不支持 SSH/);
});

for(const provider of ['claude','deepseek'])test(`${provider} reference sessions keep section and project hierarchy and use existing relay-safe chat links`,async()=>{
 const ui=fixture();await ui.view.choose(provider);await ui.view.open('a');const rows=[{id:'chat~one/中文',title:'First chat',cwd:'/work/alpha',backend:provider==='claude'?'code':'deepseek'},{id:'b',title:'Second chat',cwd:'/work/beta'},{id:'remote',title:'Remote chat',cwd:'/work/alpha',host:'server',hostLabel:'Remote server'}];ui.setHandler(async()=>({sessions:rows}));await ui.view.referenceButton.click();const picker=ui.view.referencePicker;await picker.tabButtons.get('sessions').click();
 assert.equal(picker.active.items.length,3);assert.deepEqual(Array.from(picker.active.items[0].groups,group=>group.title),['默认分区','alpha']);assert.notEqual(picker.active.items[0].groups[1].id,picker.active.items[2].groups[1].id);assert.match(picker.notice.textContent,/未提供原生会话链接/);assert.deepEqual(picker.list.querySelectorAll('summary').map(node=>node.textContent),['默认分区','alpha','beta','默认分区 · Remote server','alpha']);
 const item=picker.active.items[0],url=new URL(item.value);assert.equal(url.origin,'https://bridge.example');assert.equal(url.pathname,'/relay/device/');assert.equal(url.search,'');assert.equal(url.hash,'#chat%7Eone%2F%E4%B8%AD%E6%96%87~desktop%3A'+provider);ui.run(fs.readFileSync(path.join(__dirname,'../web/features/clients/client-navigation.js'),'utf8'));const target=ui.run('ClientNavigation.prototype.chatTarget.call({},'+JSON.stringify(url.hash)+')');assert.equal(target.provider,provider);assert.equal(target.id,rows[0].id);await picker.list.querySelectorAll('button').find(node=>node.textContent.includes('First chat')).click();assert.equal(ui.view.input.value.trim(),item.value);assert.equal(ui.calls.some(call=>call.body),false);
});

test('session search filters within project hierarchy and pagination keeps complete groups',async()=>{
 const ui=await opened();ui.setHandler(async()=>({sessions:Array.from({length:205},(_,index)=>({id:'s'+index,title:'Chat '+index,cwd:'/work/alpha'})).concat({id:'other',title:'Other chat',cwd:'/work/beta'})}));const target=ui.view.referenceContext(),first=await ui.view.loadReferences('sessions',{target,query:'alpha'}),second=await ui.view.loadReferences('sessions',{target,query:'alpha',offset:200});assert.equal(first.items.length,200);assert.equal(first.nextOffset,200);assert.equal(second.items.length,5);assert.equal(second.nextOffset,null);assert.ok([...first.items,...second.items].every(item=>item.groups[1].title==='alpha'));const byTitle=await ui.view.loadReferences('sessions',{target,query:'Other chat'});assert.equal(byTitle.items.length,1);assert.equal(byTitle.items[0].groups[1].title,'beta');
});

test('late reference reads abort on client switches and cannot populate an identically named chat',async()=>{
 const ui=await opened();let finish,source;ui.setHandler((url,_body,signal)=>url.includes('/workspace')?new Promise(resolve=>{finish=resolve;source={url,signal};}):Promise.resolve(url.includes('/detail')?{session:{id:'a',title:'Other',status:'idle'},messages:[]}:{sessions:[]}));const reading=ui.view.referenceButton.click();await ui.view.choose('deepseek');await ui.view.open('a');ui.view.input.value='new client draft';ui.view.input.oninput();assert.equal(source.signal.aborted,true);finish({root:'/old',entries:[{name:'old.txt',path:'old.txt',kind:'file'}],nextOffset:null});await reading;const picker=ui.view.referencePicker;assert.equal(picker.dialog.open,false);assert.equal(ui.view.input.value,'new client draft');assert.equal(picker.active.items.length,0);assert.match(source.url,/\/claude\/workspace\?sessionId=a/);assert.equal(ui.calls.some(call=>call.body),false);
});

test('reference dialogs close on chat changes, list return, account invalidation and logout',async()=>{
 const ui=await opened();ui.setHandler(async url=>url.includes('/workspace')?{root:'/project',entries:[],nextOffset:null}:url.includes('/detail')?{session:{id:new URL(url,'https://fixture').searchParams.get('sessionId'),title:'Chat',status:'idle'},messages:[]}:{sessions:[]});const picker=ui.view.referencePicker;await picker.open();const key=picker.target.key;await ui.view.open('b');assert.equal(picker.dialog.open,false);assert.notEqual(ui.view.referenceContext().key,key);await picker.open();ui.view.backToList();assert.equal(picker.dialog.open,false);await ui.view.open('b');await picker.open();await ui.view.accountChanged('claude',{activeId:'old'},{activeId:'new'});assert.equal(picker.dialog.open,false);assert.equal(ui.view.referenceContext(),null);await ui.view.open('b');await picker.open();ui.view.clear();assert.equal(picker.dialog.open,false);assert.equal(ui.view.referenceContext(),null);
});

test('reference insertion replaces the current selection and respects maxlength without losing the draft',async()=>{
 const ui=await opened();ui.view.state.capabilities.skills=true;ui.setHandler(async()=>({skills:[{id:'r',name:'review'}]}));ui.view.input.value='prefix replace suffix';ui.view.input.oninput();ui.view.input.setSelectionRange(7,14);await ui.view.referenceButton.click();const picker=ui.view.referencePicker;await picker.list.querySelector('button').click();assert.equal(ui.view.input.value,'prefix $review suffix');assert.equal(ui.view.drafts.get('claude:a'),'prefix $review suffix');ui.view.input.maxLength=ui.view.input.value.length;ui.view.input.setSelectionRange(ui.view.input.value.length,ui.view.input.value.length);await picker.open();await picker.list.querySelector('button').click();assert.equal(picker.dialog.open,true);assert.match(picker.error.textContent,/长度限制/);assert.equal(ui.view.input.value,'prefix $review suffix');
});

test('unconfirmed reference sends keep their original request id and attachments until explicit retry succeeds',async()=>{
 const ui=fixture();let accepted=false;ui.setHandler(async(url,body)=>body?{status:accepted?'accepted':'unknown'}:url.includes('/catalog')?{skills:[{id:'review',name:'review'}]}:url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle'},capabilities:{skills:true,attachments:true},messages:[]}:{sessions:[]});await ui.view.choose('claude');await ui.view.open('a');ui.view.attachments.add([{name:'draft.png',type:'image/png',size:16}]);await new Promise(setImmediate);await ui.view.referenceButton.click();await ui.view.referencePicker.list.querySelector('button').click();const raw=ui.view.input.value,id=ui.view.attachments.ids()[0];await ui.view.submit();await new Promise(setImmediate);assert.equal(ui.view.input.value,raw);assert.equal(ui.view.attachments.ids()[0],id);assert.equal(ui.calls.filter(call=>call.body).length,1);await ui.view.detail(ui.view.generation);accepted=true;await ui.view.submit();const writes=ui.calls.filter(call=>call.body);assert.equal(writes.length,2);assert.equal(writes[0].body.id,writes[1].body.id);assert.equal(writes[0].body.text,'$review');assert.deepEqual(Array.from(writes[0].body.attachments),[id]);assert.equal(Object.hasOwn(writes[0].body,'plugins'),false);assert.equal(ui.view.input.value,'');assert.equal(ui.view.attachments.rows.length,0);
});

test('request updates and language changes preserve answers already entered',async()=>{
 const ui=await opened(),question={id:'q1',tool:'AskUserQuestion',needsInput:true,input:{questions:[{id:'native-id',question:'Choose',options:[{label:'A'},{label:'B'}]}]}};ui.view.renderRequests([question]);let inputs=ui.view.requests.querySelector('form').querySelectorAll('input');inputs[1].checked=true;inputs[2].value='written answer';ui.view.renderRequests([question,{id:'approval',tool:'Write',input:{reason:'write'}}]);inputs=ui.view.requests.querySelector('form').querySelectorAll('input');assert.equal(inputs[1].checked,true);assert.equal(inputs[2].value,'written answer');ui.view.state.requests=[question];ui.view.relabel();inputs=ui.view.requests.querySelector('form').querySelectorAll('input');assert.equal(inputs[1].checked,true);assert.equal(inputs[2].value,'written answer');
});


test('provider activity dots use explicit statuses and never turn ordinary idle into completed',async()=>{
 const ui=fixture();let rows=[{id:'same',title:'Run',status:'active',backend:'code'},{id:'idle',title:'Idle',status:'idle',backend:'code'},{id:'ask',title:'Ask',status:'active',requests:[{id:'permission'}],backend:'cowork'}];ui.setHandler(async()=>({sessions:rows}));await ui.view.choose('claude');const byId=id=>ui.view.rowsRoot.querySelectorAll('.session').find(n=>n.dataset.id===id);assert.ok(byId('same').querySelector('.session-indicator').classList.contains('running'));assert.equal(byId('idle').querySelector('.session-indicator'),null);assert.ok(byId('ask').querySelector('.session-indicator').classList.contains('awaiting'));
 rows=[{id:'same',title:'Run',status:'idle',turnId:'native-turn',turnStatus:'completed',backend:'code'}];await ui.view.refresh();assert.ok(byId('same').querySelector('.session-indicator').classList.contains('completed'));await ui.view.choose('deepseek');assert.equal(byId('same').querySelector('.session-indicator'),null);await ui.view.choose('claude');assert.ok(byId('same').querySelector('.session-indicator').classList.contains('completed'));
 ui.setHandler(async()=>({session:{id:'same',title:'Run',status:'idle',turnId:'native-turn',turnStatus:'completed'},messages:[]}));await ui.view.open('same');assert.equal(byId('same').querySelector('.session-indicator'),null);
});
test('Claude project groups remember their collapsed state across refresh and provider switches',async()=>{
 const ui=fixture();ui.setHandler(async()=>({sessions:[{id:'a',title:'Code chat',backend:'code',cwd:'/code'},{id:'b',title:'Cowork chat',backend:'cowork',cwd:'/cowork'}]}));await ui.view.choose('claude');ui.view.listMode.value='project';ui.view.renderList();let group=ui.view.rowsRoot.querySelectorAll('details').find(n=>n.querySelector('summary')?.textContent==='/code');assert.ok(group);group.open=false;group.ontoggle();ui.view.listStamp='';ui.view.renderList();group=ui.view.rowsRoot.querySelectorAll('details').find(n=>n.querySelector('summary')?.textContent==='/code');assert.equal(group.open,false);await ui.view.choose('deepseek');await ui.view.choose('claude');group=ui.view.rowsRoot.querySelectorAll('details').find(n=>n.querySelector('summary')?.textContent==='/code');assert.equal(group.open,false);assert.equal(ui.view.rowsRoot.querySelectorAll('details').find(n=>n.querySelector('summary')?.textContent==='/cowork').open,true);
});
test('composer has no redundant file button while Workbench retains files and split tabs',async()=>{
 const ui=await opened();assert.equal(ui.view.tools.querySelectorAll('button').some(n=>n.textContent==='文件'),false);ui.view.workbench.files();await Promise.resolve();assert.ok(ui.view.workbench.current.files.some(n=>n.id==='files'));ui.view.workbench.split('files');assert.equal(ui.view.workbench.current.splitTab,'files');
});
test('opening a chat and polling share one detail read and show its first successful response',async()=>{
 for(const provider of ['claude','deepseek']){
  const ui=fixture();ui.setHandler(async()=>({sessions:[{id:'a',title:'First response',backend:'code'}]}));await ui.view.choose(provider);
  const pending=[];ui.setHandler(url=>url.includes('/detail')?new Promise(resolve=>pending.push(resolve)):Promise.resolve({sessions:ui.view.rows}));
  const opening=ui.view.open('a'),polling=ui.view.refresh();assert.equal(pending.length,1,'polling must join the opening read');
  pending[0]({session:{id:'a',title:'First response',status:'idle'},capabilities:{send:true},messages:[{id:'first',role:'assistant',text:'first successful history'}]});await Promise.all([opening,polling]);
  assert.match(ui.view.messages.textContent,/first successful history/);assert.equal(ui.view.send.disabled,false);
 }
});

test('selecting the current provider keeps the live conversation without starting new reads',async()=>{
 const ui=await opened();ui.view.input.value='keep typing';const count=ui.calls.length,message=ui.view.messages.textContent;ui.setHandler(()=>new Promise(()=>{}));
 const selected=ui.view.choose('claude');assert.equal(ui.calls.length,count);assert.equal(ui.view.messages.textContent,message);assert.equal(ui.view.input.value,'keep typing');assert.equal(ui.view.send.disabled,false);await selected;
});

test('a pending history read does not block subsequent session list refreshes',async()=>{
 const ui=await opened();let finish,listReads=0,detailReads=0;ui.setHandler(url=>url.includes('/detail')?(detailReads++,new Promise(resolve=>finish=resolve)):Promise.resolve({sessions:[{id:'a',title:'List '+(++listReads),backend:'code'}]}));
 const first=ui.view.refresh();await new Promise(setImmediate);const second=ui.view.refresh();await new Promise(setImmediate);
 assert.equal(listReads,2);assert.match(ui.view.rowsRoot.textContent,/List 2/);assert.equal(detailReads,1,'list polling must keep joining the pending detail');
 finish({session:{id:'a',title:'Finished',status:'idle'},messages:[]});await Promise.all([first,second]);
});

test('a completed mutation cannot reuse an earlier history read as fresh state',async()=>{
 const ui=await opened(),pending=[];ui.setHandler((url,body)=>body?Promise.resolve({status:'accepted'}):url.includes('/detail')?new Promise(resolve=>pending.push(resolve)):Promise.resolve({sessions:[]}));
 const old=ui.view.detail(ui.view.generation);await ui.view.mutate('settings',{model:'new-model'});assert.equal(pending.length,2,'write completion must start a new detail read');
 pending[0]({session:{id:'a',title:'Obsolete',model:'obsolete-model',status:'idle'},messages:[{id:'old',role:'assistant',text:'obsolete history'}]});await old;
 assert.doesNotMatch(ui.view.messages.textContent,/obsolete history/);assert.equal(ui.view.send.disabled,true);
 pending[1]({session:{id:'a',title:'Current',model:'new-model',status:'idle'},messages:[{id:'new',role:'assistant',text:'current history'}]});await new Promise(setImmediate);assert.match(ui.view.messages.textContent,/current history/);assert.equal(ui.view.send.disabled,false);
});

test('cached, failed and disconnected details remain readable without allowing task mutations',async()=>{
 for(const mode of ['cache','failure','disconnected','inventory']){
  const ui=fixture(),value={session:{id:'a',title:'Active chat',status:'active',requests:[{id:'approval',tool:'Write',input:{}}]},capabilities:{send:true,stop:true},messages:[{id:'m',role:'assistant',text:'readable history'}]};
  ui.setHandler(async url=>url.includes('/detail')?value:{sessions:[{id:'a',title:'Active chat',backend:'code'}]});await ui.view.choose('claude');await ui.view.open('a');assert.equal(ui.view.stop.disabled,false);
  let opening,finish;if(mode==='cache'){ui.view.backToList();ui.setHandler(()=>new Promise(resolve=>finish=resolve));opening=ui.view.open('a');}
  else if(mode==='inventory')ui.view.setClientStates([{id:'claude',enabled:true,connected:false,connectionState:'idle'}]);
  else{ui.setHandler(async url=>{if(url.includes('/detail')){if(mode==='failure')throw Error('offline');return {...value,connected:false};}return {sessions:ui.view.rows};});await ui.view.refresh();await new Promise(setImmediate);}
  assert.match(ui.view.messages.textContent,/readable history/);assert.equal(ui.view.send.disabled,true,mode);assert.equal(ui.view.stop.disabled,true,mode);const writes=ui.calls.filter(c=>c.body).length;
  await ui.view.stop.click();await ui.view.mutate('respond',{requestId:'approval',decision:'accept'});assert.equal(ui.calls.filter(c=>c.body).length,writes,mode);
  if(finish){finish(value);await opening;}
 }
});

test('visible connected providers prefetch only their lists and reuse the cache on first selection',async()=>{
 const ui=fixture(),clients=[{id:'codex',enabled:true,connected:true},{id:'claude',enabled:true,connected:true},{id:'deepseek',enabled:false,connected:true}];ui.setHandler(async()=>({sessions:[{id:'a',title:'Prefetched list',backend:'code'}]}));
 ui.document.hidden=true;ui.view.setClientStates(clients);assert.equal(ui.calls.length,0);ui.document.hidden=false;ui.document.dispatchEvent({type:'visibilitychange'});await new Promise(setImmediate);
 assert.deepEqual(ui.calls.map(c=>c.url),['/api/desktop-sessions/claude/list']);ui.view.setClientStates(clients);ui.document.dispatchEvent({type:'visibilitychange'});await new Promise(setImmediate);assert.equal(ui.calls.length,1);
 let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const selecting=ui.view.choose('claude');assert.match(ui.view.rowsRoot.textContent,/Prefetched list/);assert.equal(ui.calls.some(c=>c.url.includes('/detail')),false);finish({sessions:[]});await selecting;
});

test('history caching evicts older chats and does not retain an oversized transcript',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/detail')?{session:{id:new URL(url,'http://fixture').searchParams.get('sessionId'),title:'Chat',status:'idle'},messages:[{id:'m',role:'assistant',text:'cached '+new URL(url,'http://fixture').searchParams.get('sessionId')}]}:{sessions:[]});await ui.view.choose('claude');
 for(let i=0;i<13;i++)await ui.view.open(String(i));ui.view.backToList();let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const old=ui.view.open('0');assert.equal(ui.view.messages.textContent.includes('cached 0'),false);finish({session:{id:'0',title:'Chat',status:'idle'},messages:[]});await old;
 ui.view.backToList();const recent=ui.view.open('12');assert.match(ui.view.messages.textContent,/cached 12/);finish({session:{id:'12',title:'Chat',status:'idle'},messages:[]});await recent;
 ui.setHandler(async()=>({session:{id:'huge',title:'Large',status:'idle'},messages:[{id:'m',role:'assistant',text:'oversized marker '+('x'.repeat(4*1024*1024))}]}));await ui.view.open('huge');ui.view.backToList();ui.setHandler(()=>new Promise(resolve=>finish=resolve));const huge=ui.view.open('huge');assert.equal(ui.view.messages.textContent.includes('oversized marker'),false);finish({session:{id:'huge',title:'Large',status:'idle'},messages:[]});await huge;
});

test('an invalidated list failure cannot replace the status of a newer successful read',async()=>{
 const ui=await opened();let rejectOld,reads=0;ui.setHandler((url,body)=>body?Promise.resolve({status:'accepted'}):url.includes('/list')?++reads===1?new Promise((_,reject)=>rejectOld=reject):Promise.resolve({sessions:[{id:'a',title:'Fresh list',backend:'code'}]}):Promise.resolve({session:{id:'a',title:'Fresh',status:'idle'},messages:[]}));
 const stale=ui.view.refresh();await new Promise(setImmediate);await ui.view.mutate('settings',{model:'new'});await new Promise(setImmediate);rejectOld(Error('obsolete list failure'));await stale;
 assert.match(ui.view.rowsRoot.textContent,/Fresh list/);assert.equal(ui.view.listStatus.textContent,'');
});

test('account changes, disabling and logout reject old background list and history replies',async()=>{
 for(const mode of ['account','disable','logout']){
  const ui=fixture(),client={id:'claude',enabled:true,connected:true},pending=[];ui.setHandler(url=>new Promise(resolve=>pending.push({url,resolve})));ui.view.setClientStates([client]);const listing=ui.view.choose('claude'),opening=ui.view.open('a');await ui.view.choose('codex');
  if(mode==='account')await ui.view.accountChanged('claude',{activeId:'old'},{activeId:'new'});else if(mode==='disable')ui.view.setClientStates([{...client,enabled:false}]);else ui.view.clear();
  for(const call of pending)call.resolve(call.url.includes('/detail')?{session:{id:'a',title:'Old identity',status:'idle'},messages:[{id:'secret',role:'assistant',text:'old identity history'}]}:{sessions:[{id:'a',title:'Old identity list',backend:'code'}]});await Promise.all([listing,opening]);
  const current=[];ui.setHandler(url=>new Promise(resolve=>current.push({url,resolve})));ui.view.setClientStates([client]);const selecting=ui.view.choose('claude');assert.equal(ui.view.rowsRoot.textContent.includes('Old identity'),false,mode);assert.equal(ui.view.messages.textContent.includes('old identity history'),false,mode);
  for(const call of current)call.resolve(call.url.includes('/detail')?{session:{id:'a',title:'Current identity',status:'idle'},messages:[]}:{sessions:[]});await selecting;
 }
});

test('reads started before and during a write never replace its completion refresh',async()=>{
 const ui=await opened(),pending=[];let accept;ui.setHandler((url,body)=>body?new Promise(resolve=>accept=resolve):url.includes('/detail')?new Promise(resolve=>pending.push(resolve)):Promise.resolve({sessions:[]}));
 const old=ui.view.detail(ui.view.generation),writing=ui.view.mutate('settings',{model:'new'}),during=ui.view.refresh();pending[0]({session:{id:'a',title:'Before',status:'idle'},messages:[{id:'old',role:'assistant',text:'before write'}]});await old;assert.equal(ui.view.messages.textContent.includes('before write'),false);
 accept({status:'accepted'});await writing;assert.equal(pending.length,3);pending[1]({session:{id:'a',title:'During',status:'idle'},messages:[{id:'mid',role:'assistant',text:'during write'}]});await during;await new Promise(setImmediate);assert.equal(ui.view.messages.textContent.includes('during write'),false);assert.equal(ui.view.send.disabled,true);
 pending[2]({session:{id:'a',title:'After',status:'idle'},messages:[{id:'new',role:'assistant',text:'after write'}]});await new Promise(setImmediate);assert.match(ui.view.messages.textContent,/after write/);assert.equal(ui.view.send.disabled,false);
});

test('an old account write cannot invalidate the new account list refresh',async()=>{
 const ui=await opened();let accept,finishList;ui.setHandler((url,body)=>body?new Promise(resolve=>accept=resolve):Promise.resolve({sessions:[]}));const writing=ui.view.mutate('settings',{model:'new'});
 ui.setHandler(()=>new Promise(resolve=>finishList=resolve));const changing=ui.view.accountChanged('claude',{activeId:'old'},{activeId:'new'});accept({status:'accepted'});await writing;
 finishList({sessions:[{id:'b',title:'New account list',backend:'code'}]});await changing;assert.match(ui.view.rowsRoot.textContent,/New account list/);assert.equal(ui.view.listStatus.textContent,'');
});

test('provider return paints cached list and selected history before either network response',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/detail')?{session:{id:'a',title:'Cached chat',status:'idle'},capabilities:{attachments:true,skills:true},messages:[{id:'m',role:'assistant',text:'cached answer'}]}:{sessions:[{id:'a',title:'Cached chat',backend:'code'}]});await ui.view.choose('claude');await ui.view.open('a');ui.view.input.value='unfinished $review';ui.view.input.oninput();ui.view.attachments.add([{name:'draft.png',type:'image/png',size:16}]);await new Promise(setImmediate);await ui.view.choose('deepseek');
 const pending=[];ui.setHandler(url=>new Promise(resolve=>pending.push({url,resolve})));const returning=ui.view.choose('claude');assert.match(ui.view.rowsRoot.textContent,/Cached chat/);assert.equal(ui.view.sid,'a');assert.match(ui.view.messages.textContent,/cached answer/);assert.equal(ui.view.input.value,'unfinished $review');assert.equal(ui.view.attachments.rows.length,1);assert.equal(ui.view.attachments.rows[0].status,'ready');assert.equal(ui.view.send.disabled,true);
 for(const call of pending)call.resolve(call.url.includes('/detail')?{session:{id:'a',title:'Fresh chat',status:'idle'},capabilities:{attachments:true,skills:true},messages:[{id:'m',role:'assistant',text:'fresh answer'}]}:{sessions:[{id:'a',title:'Fresh chat',backend:'code'}]});await returning;assert.match(ui.view.messages.textContent,/fresh answer/);assert.equal(ui.view.input.value,'unfinished $review');assert.equal(ui.view.send.disabled,false);
});

test('reads finishing after a provider switch warm only their own list and history cache',async()=>{
 const ui=fixture(),pending=[];ui.setHandler(url=>new Promise(resolve=>pending.push({url,resolve})));const first=ui.view.choose('claude');await ui.view.choose('codex');pending[0].resolve({sessions:[{id:'a',title:'Background list',backend:'code'}]});await first;
 const returning=ui.view.choose('claude');assert.match(ui.view.rowsRoot.textContent,/Background list/);pending[1].resolve({sessions:[{id:'a',title:'Background list',backend:'code'}]});await returning;
 const opening=ui.view.open('a'),history=pending[2];ui.setHandler(async()=>({sessions:[{id:'b',title:'DSH list'}]}));await ui.view.choose('deepseek');history.resolve({session:{id:'a',title:'Background list',status:'idle'},capabilities:{send:true},messages:[{id:'m',role:'assistant',text:'Background history'}]});await opening;
 assert.match(ui.view.rowsRoot.textContent,/DSH list/);assert.doesNotMatch(ui.view.messages.textContent,/Background history/);
 const fresh=[];ui.setHandler(url=>new Promise(resolve=>fresh.push({url,resolve})));const back=ui.view.choose('claude');assert.match(ui.view.messages.textContent,/Background history/);assert.equal(ui.view.send.disabled,true);
 for(const call of fresh)call.resolve(call.url.includes('/detail')?{session:{id:'a',title:'Fresh',status:'idle'},messages:[]}:{sessions:[]});await back;
});
test('cached history survives refresh failure and late errors cannot cross providers sharing an id',async()=>{
 const ui=await opened();ui.view.renderMessages([{id:'saved',role:'assistant',text:'saved'}]);let fail;ui.setHandler(()=>new Promise((_,reject)=>fail=reject));const old=ui.view.open('a');const rejectOld=fail;ui.setHandler(async url=>url.includes('/detail')?{session:{id:'a',title:'DSH chat',status:'idle'},messages:[{id:'new',role:'assistant',text:'DSH answer'}]}:{sessions:[]});await ui.view.choose('deepseek');await ui.view.open('a');rejectOld(Error('Claude late failure'));await old;assert.doesNotMatch(ui.view.error.textContent,/Claude late failure/);assert.match(ui.view.messages.textContent,/DSH answer/);
});


test('reopening cached history keeps its scroll and draft when the background connection fails',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/detail')?{session:{id:'a',title:'Saved title',status:'idle'},messages:[{id:'saved',role:'assistant',text:'saved history'}]}:{sessions:[{id:'a',title:'Saved title',backend:'code'}]});await ui.view.choose('claude');await ui.view.open('a');ui.view.input.value='saved draft';ui.view.messages.scrollTop=42;ui.view.backToList();ui.setHandler(async()=>{throw Error('offline');});const reopening=ui.view.open('a');assert.match(ui.view.messages.textContent,/saved history/);assert.equal(ui.view.messages.scrollTop,42);assert.equal(ui.view.input.value,'saved draft');await reopening;assert.match(ui.view.messages.textContent,/saved history/);assert.equal(ui.view.send.disabled,true);assert.match(ui.view.error.textContent,/offline/);
});
test('logout clears provider history and ignores detail responses arriving after clear',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/detail')?{session:{id:'a',title:'Private title',status:'idle'},messages:[{id:'saved',role:'assistant',text:'private history'}]}:{sessions:[{id:'a',title:'Private title',backend:'code'}]});await ui.view.choose('claude');await ui.view.open('a');let complete;ui.setHandler(()=>new Promise(resolve=>complete=resolve));const late=ui.view.detail(ui.view.generation);ui.view.clear();complete({session:{id:'a',title:'Late private title',status:'idle'},messages:[{id:'late',role:'assistant',text:'late private history'}]});await late;assert.equal(ui.view.providerViews.size,0);assert.equal(ui.view.detailCache.size,0);assert.equal(ui.view.messages.textContent,'');assert.equal(ui.view.rowsRoot.textContent,'');ui.setHandler(async()=>({sessions:[]}));await ui.view.choose('claude');assert.equal(ui.view.rows.length,0);assert.equal(ui.view.sid,null);
});
test('provider switching retains Workbench file tabs without mixing their session scope',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/workspace')?{entries:[],total:0,project:'/project'}:url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle'},messages:[]}:{sessions:[]});await ui.view.choose('claude');await ui.view.open('a');ui.view.workbench.files();await Promise.resolve();const claude=ui.view.workbench.current;await ui.view.choose('deepseek');await ui.view.open('a');assert.notEqual(ui.view.workbench.current.key,claude.key);assert.equal(ui.view.workbench.current.files.length,0);await ui.view.choose('claude');assert.equal(ui.view.workbench.current,claude);assert.ok(ui.view.workbench.current.files.some(tab=>tab.id==='files'));
});


test('cached permission cards stay hidden until refreshed even when language changes',async()=>{
 const ui=fixture();ui.setHandler(async url=>url.includes('/detail')?{session:{id:'a',title:'Chat',status:'idle',requests:[{id:'old',tool:'Write',input:{}}]},messages:[]}:{sessions:[]});await ui.view.choose('claude');await ui.view.open('a');ui.view.backToList();let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const opening=ui.view.open('a');ui.view.relabel();assert.equal(ui.view.requests.children.length,0);finish({session:{id:'a',title:'Chat',status:'idle',requests:[]},messages:[]});await opening;assert.equal(ui.view.requests.children.length,0);
});

test('desktop chat notification policies read and save within their provider and session',async()=>{
 const ui=await opened();ui.setHandler(async(url,body)=>({available:true,requests:'inherit',completion:'off'}));await ui.view.notifications();const dialog=ui.document.querySelector('dialog'),form=dialog.querySelector('form'),selects=form.querySelectorAll('select');assert.equal(selects[0].value,'inherit');assert.equal(selects[1].value,'off');selects[0].value='on';selects[1].value='inherit';await form.onsubmit({preventDefault(){}});const write=ui.calls.filter(c=>c.body).at(-1);assert.match(write.url,/desktop-sessions\/claude\/notifications\?sessionId=a/);assert.deepEqual(JSON.parse(JSON.stringify(write.body)),{requests:'on',completion:'inherit'});assert.equal(dialog.open,false);assert.match(ui.notices.at(-1),/聊天提醒设置已保存/);
});
test('notification policy dialogs cannot save into a different selected client',async()=>{
 const ui=await opened();ui.setHandler(async()=>({available:false,requests:'inherit',completion:'inherit'}));await ui.view.notifications();const dialog=ui.document.querySelector('dialog'),form=dialog.querySelector('form');await ui.view.choose('deepseek');const before=ui.calls.filter(c=>c.body).length;await form.onsubmit({preventDefault(){}});assert.equal(ui.calls.filter(c=>c.body).length,before);assert.equal(dialog.open,false);
});
test('late notification-policy reads do not populate a different chat',async()=>{
 const ui=await opened();let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const read=ui.view.notifications(),dialog=ui.document.querySelector('dialog');ui.view.backToList();finish({requests:'on'});await read;assert.equal(dialog.open,false);assert.equal(dialog.querySelector('form'),null);
});

test('account switch isolates drafts and clears only that client history, permissions, uploads and workbench',async()=>{
 const ui=await opened(),view=ui.view;view.input.value='old account draft';view.saveDraft();view.drafts.set('deepseek:same','other client draft');view.detailCache.set('["deepseek","same"]',{messages:[{text:'keep'}]});view.providerViews.set('deepseek',{sid:'same'});view.workbench.sessions.set('deepseek|local|same',{provider:'deepseek',files:[]});view.attachments.drafts.set('["deepseek","same"]',[{id:'keep-upload'}]);
 view.attachments.open('["claude","a"]');view.attachments.rows.push({id:'old-upload',status:'ready'});view.attachments.save(view.attachments.key,view.attachments.rows);
 await view.accountChanged('claude',{activeId:'first'},{activeId:'second'});assert.equal(view.sid,null);assert.equal(view.input.value,'');assert.equal(view.drafts.has('claude:a'),false);assert.equal(view.detailCache.has('["claude","a"]'),false);assert.equal(view.attachments.drafts.has('["claude","a"]'),false);assert.equal(view.workbench.sessions.has('claude|local|a'),false);
 assert.equal(view.drafts.get('deepseek:same'),'other client draft');assert.equal(view.detailCache.has('["deepseek","same"]'),true);assert.equal(view.workbench.sessions.has('deepseek|local|same'),true);assert.equal(view.attachments.drafts.has('["deepseek","same"]'),true);assert.equal(ui.run('sessionStorage.getItem(\'attachments:["claude","a"]\')'),undefined);
 assert.equal(view.accountDrafts.get('["claude",["first"]]').get('claude:a'),'old account draft');await view.accountChanged('claude',{activeId:'second'},{activeId:'first'});assert.equal(view.drafts.get('claude:a'),'old account draft');
});

test('permission label and context follow the selected session, including external changes',async()=>{
 const ui=await opened();ui.view.applyDetail({session:{id:'a',title:'Chat',permissionMode:'acceptEdits',contextUsage:{usedTokens:40000,contextWindow:200000}},capabilities:{permissions:true},messages:[]});
 assert.equal(ui.view.permissionsButton.textContent,'允许文件编辑');assert.match(ui.view.contextButton.title,/20%/);
 ui.view.applyDetail({session:{id:'a',title:'Chat',permissionMode:'plan',contextUsage:null},capabilities:{permissions:true},messages:[]});
 assert.equal(ui.view.permissionsButton.textContent,'计划模式');assert.doesNotMatch(ui.view.contextButton.title,/20%/);
});


test('accepted permission change updates label before polling and ignores an old session',async()=>{
 const ui=await opened();ui.view.refresh=()=>{};
 ui.setHandler(async()=>({status:'accepted',mode:'plan'}));
 await ui.view.mutate('access',{mode:'plan'});
 assert.equal(ui.view.permissionsButton.textContent,'计划模式');
 let finish;ui.view.freshDetail=true;ui.setHandler(()=>new Promise(resolve=>finish=resolve));
 const changing=ui.view.mutate('access',{mode:'acceptEdits'});
 ui.view.sid='b';ui.view.state={id:'b',permissionMode:'default'};
 finish({status:'accepted',mode:'acceptEdits'});await changing;
 assert.equal(ui.view.state.permissionMode,'default');
});

test('context monitor remains discoverable and distinguishes unsupported from missing readings',async()=>{
 for(const language of ['zh','en']){
  const ui=await opened();ui.run(`BridgeI18n.setLanguage('${language}')`);
  const apply=(usage,status)=>ui.view.applyDetail({session:{id:'a',title:'Chat',contextUsage:usage,contextUsageStatus:status},messages:[]});
  apply({usedTokens:40000,contextWindow:200000},'available');
  assert.equal(ui.view.contextButton.textContent,'');assert.equal(ui.view.contextButton.children.length,1);assert.equal(ui.view.contextButton.hidden,false);
  assert.equal(ui.view.contextRing.className,'context-usage-ring');assert.match(ui.view.contextButton.title,/20%/);
  assert.equal(ui.view.contextRing.getAttribute('aria-hidden'),'true');
  ui.view.contextDetails();let dialog=ui.document.querySelector('dialog');assert.match(dialog.textContent,/40,000/);assert.match(dialog.textContent,/20\.0%/);dialog.close();
  apply({usedTokens:600,contextWindow:null,measurement:'lastPrompt',model:'fixture-model',compacted:true},'available');
  assert.equal(ui.view.contextButton.textContent,'');assert.ok(ui.view.contextRing.classList.contains('unknown'));assert.doesNotMatch(ui.view.contextButton.title,/0%/);
  ui.view.contextDetails();dialog=ui.document.querySelector('dialog');assert.match(dialog.textContent,/600/);assert.match(dialog.textContent,/fixture-model/);assert.doesNotMatch(dialog.textContent,/3\.0%/);dialog.close();
  apply(null,'unsupported');assert.equal(ui.view.contextButton.textContent,'');assert.doesNotMatch(ui.view.contextButton.title,/0%|20%/);
  ui.view.contextDetails();dialog=ui.document.querySelector('dialog');assert.match(dialog.textContent,language==='en'?/does not expose context usage/:/未提供上下文用量接口/);dialog.close();
  apply(null,'unavailable');ui.view.contextDetails();dialog=ui.document.querySelector('dialog');assert.match(dialog.textContent,language==='en'?/update automatically when available/:/有可用数据时会自动更新/);assert.doesNotMatch(dialog.textContent,language==='en'?/does not expose/:/未提供上下文用量接口/);
 }
});

for(const provider of ['claude','deepseek'])test(`${provider} manual refresh joins polling and foreground reads and waits for the list result`,async()=>{
 const ui=fixture();await ui.view.choose(provider);let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const before=ui.calls.length;
 const polling=ui.view.refresh(),manual=ui.view.listSync.update(true);ui.document.dispatchEvent({type:'visibilitychange'});assert.equal(ui.calls.length-before,1);assert.match(ui.view.listHint.textContent,/正在刷新/);assert.equal(ui.view.listSync.busy,true);
 finish({sessions:[{id:'new',title:'New result',backend:'code'}]});await Promise.all([polling,manual]);await new Promise(setImmediate);assert.equal(ui.calls.length-before,1,'no redundant trailing list read');assert.match(ui.view.rowsRoot.textContent,/New result/);assert.match(ui.view.listHint.textContent,/已更新/);assert.equal(ui.calls.some(c=>c.body),false);
});
test('manual refresh failure and disconnected responses remain retryable without fetching a selected chat',async()=>{
 const ui=await opened(),before=ui.calls.length;
 ui.setHandler(async()=>{throw Error('offline');});await ui.view.listSync.update(true);assert.match(ui.view.listHint.textContent,/点击重试/);assert.equal(ui.view.sid,'a');
 ui.setHandler(async()=>({connected:false,sessions:[]}));await ui.view.listHint.click();assert.match(ui.view.listHint.textContent,/点击重试/);
 ui.setHandler(async()=>({sessions:[{id:'a',title:'Recovered',backend:'code'}]}));await ui.view.listHint.click();assert.match(ui.view.listHint.textContent,/已更新/);assert.match(ui.view.rowsRoot.textContent,/Recovered/);
 assert.ok(ui.calls.slice(before).every(c=>c.url.endsWith('/list')&&!c.body));
});
test('manual refresh retains current search, filters, selected chat, draft and list position',async()=>{
 const ui=await opened();ui.view.input.value='draft';ui.view.search.value='needle';ui.view.listMode.value='project';ui.view.archived.checked=true;ui.view.rowsRoot.scrollTop=80;
 let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const pending=ui.view.listSync.update(true);ui.view.search.value='changed';finish({sessions:[{id:'a',title:'changed result',backend:'code',cwd:'/project',archived:true},{id:'b',title:'needle old filter',backend:'cowork'}]});await pending;
 assert.equal(ui.view.search.value,'changed');assert.equal(ui.view.listMode.value,'project');assert.equal(ui.view.archived.checked,true);assert.equal(ui.view.sid,'a');assert.equal(ui.view.input.value,'draft');assert.equal(ui.view.rowsRoot.scrollTop,80);assert.match(ui.view.rowsRoot.textContent,/changed result/);assert.doesNotMatch(ui.view.rowsRoot.textContent,/old filter/);
});
for(const failure of [false,true])test(`a previous provider refresh ${failure?'failure':'success'} cannot affect a new provider refresh`,async()=>{
 const ui=fixture();await ui.view.choose('claude');let resolveOld,rejectOld,resolveNew;ui.setHandler(url=>url.includes('/claude/')?new Promise((resolve,reject)=>{resolveOld=resolve;rejectOld=reject;}):new Promise(resolve=>resolveNew=resolve));
 const old=ui.view.listSync.update(true),switching=ui.view.choose('deepseek');assert.equal(ui.view.listHint.hidden,true);const current=ui.view.listSync.update(true);assert.equal(ui.view.listSync.busy,true);
 if(failure)rejectOld(Error('old failure'));else resolveOld({sessions:[{id:'old',title:'Old provider'}]});await old;assert.equal(ui.view.listSync.busy,true);assert.match(ui.view.listHint.textContent,/正在刷新/);assert.doesNotMatch(ui.view.rowsRoot.textContent,/Old provider/);
 resolveNew({sessions:[{id:'new',title:'New provider'}]});await Promise.all([switching,current]);assert.equal(ui.view.provider,'deepseek');assert.match(ui.view.rowsRoot.textContent,/New provider/);assert.match(ui.view.listHint.textContent,/已更新/);
});
test('account invalidation cancels manual feedback and rejects old list contents',async()=>{
 const ui=fixture();await ui.view.choose('claude');let finish;ui.setHandler(()=>new Promise(resolve=>finish=resolve));const old=ui.view.listSync.update(true);ui.view.invalidateReads('claude');assert.equal(ui.view.listHint.hidden,true);
 finish({sessions:[{id:'old',title:'Old account',backend:'code'}]});await old;assert.equal(ui.view.listHint.hidden,true);assert.doesNotMatch(ui.view.rowsRoot.textContent,/Old account/);
});

function cliDetail(connectionState='closed'){
 const live=connectionState!=='closed';
 return {connected:true,session:{id:'cli-a',title:'CLI chat',backend:'cli',connectionState,status:connectionState==='active'||connectionState==='awaiting'?'active':'idle',cwd:'/cli-project',model:'claude-model',permissionMode:'default',requests:[]},messages:[{id:'old',role:'assistant',model:'older-model',text:'Saved CLI reply'}],capabilities:{resume:!live,send:live,models:live,permissions:live,stop:live,attachments:false,queue:false,steer:false}};
}
const cliClient={id:'claude',enabled:true,installed:true,connected:false,cliAvailable:true,setupStatus:'needs-initialization'};

test('Claude CLI history is readable without initializing Desktop and resumes only on explicit click',async()=>{
 const ui=fixture();let detail=cliDetail();
 ui.setHandler(async(url,body)=>{if(body){assert.match(url,/\/resume$/);assert.equal(body.sessionId,'cli-a');detail=cliDetail('ready');return {status:'ready'};}return url.includes('/detail')?detail:{connected:true,sessions:[detail.session]};});
 ui.view.setClientStates([cliClient]);await ui.view.choose('claude');await ui.view.open('cli-a');
 assert.match(ui.view.messages.textContent,/Saved CLI reply/);assert.equal(ui.calls.filter(c=>c.body).length,0);
 assert.equal(ui.view.send.disabled,true);assert.equal(ui.view.status.textContent,'历史记录');assert.equal(ui.view.resumeButton.hidden,false);
 // Unchanged lifecycle polling must retain the freshly read, closed CLI chat.
 ui.view.setClientStates([cliClient]);assert.equal(ui.view.canResume(),true);assert.equal(ui.view.resumeButton.hidden,false);
 await ui.view.resumeButton.click();await new Promise(setImmediate);
 assert.equal(ui.calls.filter(c=>c.body).length,1);assert.equal(ui.view.send.disabled,false);assert.equal(ui.view.resumeButton.hidden,true);
 assert.equal(ui.view.modelButton.disabled,false);assert.equal(ui.view.permissionsButton.disabled,false);
});

test('cached or disabled Claude CLI details never authorize resume or send',async()=>{
 const ui=fixture();ui.view.provider='claude';ui.view.sid='cli-a';ui.view.setClientStates([cliClient]);
 ui.view.applyDetail(cliDetail(),true);assert.equal(ui.view.canResume(),false);await ui.view.mutate('resume',{});
 ui.view.applyDetail(cliDetail('ready'),true);assert.equal(ui.view.canMutate(),false);await ui.view.mutate('send',{text:'blocked'});
 ui.view.setClientStates([{...cliClient,enabled:false}]);ui.view.applyDetail(cliDetail());await ui.view.mutate('resume',{});
 assert.equal(ui.calls.filter(c=>c.body).length,0);assert.equal(ui.view.send.disabled,true);
});

test('Desktop disconnect does not disable a separately connected Claude CLI chat',async()=>{
 const ui=fixture();let detail=cliDetail('ready');ui.setHandler(async url=>url.includes('/detail')?detail:{connected:true,sessions:[detail.session]});
 ui.view.setClientStates([{...cliClient,connected:true}]);await ui.view.choose('claude');await ui.view.open('cli-a');
 ui.view.setClientStates([cliClient]);assert.equal(ui.view.canMutate(),true);assert.equal(ui.view.send.disabled,false);
 detail={...detail,session:{...detail.session,backend:'code'}};ui.view.applyDetail(detail);assert.equal(ui.view.canMutate(),false);assert.equal(ui.view.send.disabled,true);
});

test('Claude list identifies Code, Cowork and CLI beside each title with metadata below',async()=>{
 const ui=fixture();ui.view.provider='claude';ui.view.rows=[{id:'a',backend:'code',title:'Desktop code',updatedAt:1},{id:'b',backend:'cowork',title:'Desktop cowork',updatedAt:3},{id:'c',backend:'cli',title:'Terminal session',updatedAt:2}];
 ui.view.renderList();const rows=ui.view.rowsRoot.querySelectorAll('.session');assert.deepEqual(rows.map(n=>n.dataset.id),['b','c','a']);assert.deepEqual(rows.map(n=>n.querySelector('.ds-session-type').textContent),['Cowork','CLI','Code']);for(const row of rows){assert.equal(row.children[0].tagName,'STRONG');assert.equal(row.children[1].className,'ds-session-type');assert.equal(row.children[2].tagName,'SMALL');assert.ok(row.children[2].querySelector('time'));}
 ui.run("BridgeI18n.setLanguage('en')");ui.view.sid='c';ui.view.applyDetail(cliDetail());assert.match(ui.view.notice.textContent,/Read the saved history/);assert.equal(ui.view.resumeButton.textContent,'Continue chat');
});

test('Claude CLI approval and stop use current native request and session despite Desktop being offline',async()=>{
 const ui=fixture();const detail=cliDetail('awaiting');detail.session.requests=[{id:'native-request-1',tool:'Bash',input:{command:'synthetic command'}}];
 ui.setHandler(async(url,body)=>body?{status:'accepted'}:url.includes('/detail')?detail:{connected:true,sessions:[detail.session]});
 ui.view.setClientStates([cliClient]);await ui.view.choose('claude');await ui.view.open('cli-a');
 assert.match(ui.view.requests.textContent,/synthetic command/);assert.equal(ui.view.stop.hidden,false);assert.equal(ui.view.stop.disabled,false);
 await ui.view.mutate('respond',{requestId:'native-request-1',decision:'decline'});await new Promise(setImmediate);
 await ui.view.stop.click();const writes=ui.calls.filter(c=>c.body);assert.equal(writes.length,2);assert.equal(writes[0].body.requestId,'native-request-1');assert.match(writes[1].url,/\/stop$/);assert.equal(writes[1].body.sessionId,'cli-a');
});


test('known preflight rejection permits a new explicit Claude CLI resume attempt',async()=>{
 const ui=fixture();let attempts=0,detail=cliDetail();
 ui.setHandler(async(url,body)=>{if(body){attempts++;if(attempts===1)return {status:'blocked',message:'Original terminal is open'};detail=cliDetail('ready');return {status:'ready'};}return url.includes('/detail')?detail:{connected:true,sessions:[detail.session]};});
 ui.view.setClientStates([cliClient]);await ui.view.choose('claude');await ui.view.open('cli-a');
 await ui.view.resumeButton.click();await new Promise(setImmediate);
 assert.equal(attempts,1);assert.equal(ui.view.canResume(),true);assert.equal(ui.view.send.disabled,true);
 await ui.view.resumeButton.click();await new Promise(setImmediate);
 const writes=ui.calls.filter(c=>c.body);assert.equal(writes.length,2);assert.notEqual(writes[0].body.id,writes[1].body.id);assert.equal(ui.view.canMutate(),true);
});

test('客户端聊天共享嵌套执行过程和按轮自动收起的文字进度',async()=>{
 const ui=await opened(),view=ui.view;
 const rows=[{id:'q',role:'user',text:'开始'},{id:'p',role:'assistant',phase:'commentary',text:'正在处理'},{id:'c',role:'activity',kind:'commandExecution',text:'command'}].map(message=>({...message,turnId:'turn',turnStatus:'inProgress'}));
 view.renderMessages(rows);
 const progress=()=>view.messageGroups.get('group:progress:turn'),process=()=>view.messageGroups.get('group:process:turn');
 assert.equal(progress().open,true);assert.equal(process().open,false);process().open=true;view.messageNodes.get('c').node.open=true;
 view.renderMessages(rows.map(message=>({...message,turnStatus:'completed'})));
 assert.equal(progress().open,false);assert.equal(process().open,true);assert.equal(view.messageNodes.get('c').node.open,true);
 progress().open=true;view.renderMessages(rows.map(message=>({...message,turnStatus:'completed'})));assert.equal(progress().open,true);
 view.sid='other-chat';view.renderMessages(rows);assert.equal(progress().open,true);assert.equal(process().open,false);
});
