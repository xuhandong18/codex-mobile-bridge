'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/features/chat/reference-picker.js','utf8');
const plain=value=>JSON.parse(JSON.stringify(value)),flush=()=>new Promise(setImmediate);
function fixture(handler=async()=>({items:[],nextOffset:null}),{storage=new Map(),origin='http://gateway',relayBase=''}={}){
  const timers=new Map(),calls=[],events=[];let timer=0,target={key:'local|one',id:'one',host:'local',canSkills:true};
  class Element{
    constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.value='';this.disabled=false;this.scrollTop=0;this.listeners={};this._text='';}
    get isConnected(){return this===document.body||!!this.parentElement?.isConnected;}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){this._text=String(value);this.replaceChildren();}
    append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
    replaceChildren(...nodes){for(const child of this.children)child.parentElement=null;this.children=[];this.append(...nodes);}
    setAttribute(name,value){this.attributes[name]=value;}
    addEventListener(name,run){(this.listeners[name]??=[]).push(run);}
    dispatchEvent(event){events.push(event.type);for(const run of this.listeners[event.type]||[])run(event);}
    showModal(){this.open=true;}close(){this.open=false;this.dispatchEvent({type:'close'});}
    focus(){document.activeElement=this;}setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}
  }
  const document={body:new Element('body'),createElement:tag=>new Element(tag)},button=new Element('button'),input=new Element('textarea');
  input.maxLength=100000;
  const context=vm.createContext({document,BridgeI18n:{t:text=>text},AbortController,Event:class{constructor(type){this.type=type;}},
    location:{origin},BridgeRelayBase:relayBase,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    setTimeout:run=>{timers.set(++timer,run);return timer;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  const Picker=context.ChatReferencePicker,picker=new Picker({button,input,context:()=>target,
    load:async(kind,options)=>{calls.push({kind,...options});return handler(kind,options);}});
  return {Picker,picker,button,input,document,calls,events,timers,storage,setTarget:value=>target=value,
    run:(code,globals={})=>{Object.assign(context,globals);return vm.runInContext(code,context);},
    async search(query){picker.search.value=query;picker.search.oninput();const run=[...timers.values()].at(-1);timers.clear();await run();},
    nodes:root=>[root,...root.children.flatMap(function all(node){return [node,...node.children.flatMap(all)];})]};
}

test('skill references insert editable text at the caret and leave no selected-skill payload',async()=>{
  const ui=fixture(async()=>({items:[{id:'skill',title:'Review',description:'Use this skill',value:'$code-review'}],nextOffset:null}));
  ui.input.value='BeforeAfter';ui.input.setSelectionRange(6,6);await ui.picker.open();
  const row=ui.picker.list.children[0];row.onclick();
  assert.equal(ui.input.value,'Before\n$code-review\nAfter');assert.equal(ui.picker.dialog.open,false);
  assert.equal(ui.document.activeElement,ui.input);assert.ok(ui.events.includes('input'));
  assert.equal(ui.picker.selectedSkills,undefined);
});

const skills=['a','b','c','d'].map(id=>({id,title:'Skill '+id,value:'$'+id}));
const skillOrder=ui=>ui.picker.list.children.map(node=>node.dataset.referenceId);
async function chooseSkill(ui,id){
  await ui.picker.open();ui.nodes(ui.picker.list).find(node=>node.dataset.referenceId===id).onclick();
}

test('successful skill insertions rank by frequency, keep ties stable and survive a page rebuild',async()=>{
  const load=async()=>({items:skills,nextOffset:null}),ui=fixture(load);
  await chooseSkill(ui,'c');await chooseSkill(ui,'b');await chooseSkill(ui,'b');await chooseSkill(ui,'d');await ui.picker.open();
  assert.deepEqual(skillOrder(ui),['b','c','d','a']);
  assert.deepEqual(ui.picker.list.children.map(node=>node.children[0].textContent),['Skill b','Skill c','Skill d','Skill a']);
  assert.deepEqual(plain(ui.picker.active.items.map(item=>item.id)),['a','b','c','d'],'Sorting must not mutate the catalog order');
  const rebuilt=fixture(load,{storage:ui.storage});await rebuilt.picker.open();
  assert.deepEqual(skillOrder(rebuilt),['b','c','d','a']);
});

test('usage never alters skill search filtering, order or pagination and clearing search restores frequency order',async()=>{
  const ui=fixture(async(_kind,{query,offset})=>({items:query?(offset?[skills[3]]:[skills[0],skills[2]]):skills,nextOffset:query&&!offset?2:null}));
  await chooseSkill(ui,'c');await chooseSkill(ui,'b');await chooseSkill(ui,'b');await ui.picker.open();
  await ui.search('match');assert.deepEqual(skillOrder(ui),['a','c']);assert.equal(ui.picker.active.nextOffset,2);
  assert.equal(ui.calls.filter(call=>call.query==='match').length,1);
  await ui.picker.more.onclick();assert.deepEqual(skillOrder(ui),['a','c','d']);assert.equal(ui.calls.at(-1).offset,2);
  await ui.search('');assert.deepEqual(skillOrder(ui),['b','c','a','d']);
});

test('previously referenced skills beyond page one move to the front without inserting cached catalog rows',async()=>{
  const storage=new Map(),initial=fixture(async()=>({items:skills,nextOffset:null}),{storage});
  await chooseSkill(initial,'d');
  const ui=fixture(async(_kind,{offset})=>({items:offset?skills.slice(2):skills.slice(0,2),nextOffset:offset?null:2}),{storage});
  await ui.picker.open();assert.deepEqual(skillOrder(ui),['d','a','b','c']);assert.deepEqual(ui.calls.map(call=>call.offset),[0,2]);
  await ui.picker.refresh.onclick();assert.deepEqual(ui.calls.slice(-2).map(call=>call.refresh),[true,false]);
  const removed=fixture(async()=>({items:skills.slice(0,2),nextOffset:null}),{storage});await removed.picker.open();
  assert.deepEqual(skillOrder(removed),['a','b'],'A removed skill must not be restored from usage history');
});

test('reopening a cached picker finds a later-page skill used by another composer',async()=>{
  const ui=fixture(async(_kind,{offset})=>({items:offset?skills.slice(2):skills.slice(0,2),nextOffset:offset?null:2}));
  await ui.picker.open();assert.equal(ui.calls.length,1);ui.picker.close();
  const peer=fixture(async()=>({items:skills,nextOffset:null}),{storage:ui.storage});await chooseSkill(peer,'d');
  await ui.picker.open();assert.deepEqual(skillOrder(ui),['d','a','b','c']);assert.equal(ui.calls.at(-1).offset,2);
});

test('only successful skill references count while blocked, cancelled, stale and oversized selections do not',async()=>{
  const ui=fixture(async()=>({items:[...skills,{id:'blocked',title:'Blocked',value:'$blocked',disabled:true}],nextOffset:null}));
  await ui.picker.open();ui.picker.close();await ui.picker.open();
  ui.picker.insert({id:'blocked',value:'$blocked',disabled:true});ui.input.maxLength=1;ui.picker.insert(skills[0]);
  ui.input.maxLength=100000;ui.setTarget({key:'ssh|another',host:'ssh'});ui.picker.insert(skills[0]);assert.equal(ui.storage.size,0);
  await ui.picker.open();await ui.picker.setTab('files');ui.picker.insert(skills[0]);
  await ui.picker.open();await ui.picker.setTab('sessions');ui.picker.insert(skills[0]);assert.equal(ui.storage.size,0);
  await ui.picker.open();await ui.picker.setTab('skills');ui.picker.insert(skills[1]);assert.equal(ui.storage.size,1);
});

test('frequency is shared across chats in one client and host while other hosts, clients and relay gateways stay independent',async()=>{
  const load=async()=>({items:skills,nextOffset:null}),ui=fixture(load,{relayBase:'/relay/one'});await chooseSkill(ui,'d');
  ui.setTarget({key:'local|two',host:'local'});await ui.picker.open();assert.deepEqual(skillOrder(ui),['d','a','b','c']);
  for(const target of [{key:'ssh|one',host:'ssh'},{key:'deepseek|one',provider:'deepseek',host:'local'}]){
    ui.setTarget(target);await ui.picker.open();assert.deepEqual(skillOrder(ui),['a','b','c','d']);
  }
  const otherGateway=fixture(load,{storage:ui.storage,relayBase:'/relay/two'});await otherGateway.picker.open();
  assert.deepEqual(skillOrder(otherGateway),['a','b','c','d']);
});

test('unavailable, corrupt or full local storage does not block insertion or in-memory ranking',async()=>{
  for(const failure of ['unavailable','corrupt','full','stale']){
    const storage={get(){if(failure==='unavailable')throw Error('Denied');return failure==='corrupt'?'broken JSON':failure==='stale'?'[["a",1]]':null;},set(){throw Error('Storage full');}};
    const ui=fixture(async()=>({items:skills,nextOffset:null}),{storage});await chooseSkill(ui,'d');await chooseSkill(ui,'d');await ui.picker.open();
    assert.equal(ui.input.value,'$d\n$d\n');assert.deepEqual(skillOrder(ui),['d','a','b','c']);
  }
});

test('a search cancels automatic page reads for previously used skills and rejects their late response',async()=>{
  const storage=new Map(),initial=fixture(async()=>({items:skills,nextOffset:null}),{storage});await chooseSkill(initial,'d');
  let release;const ui=fixture(async(_kind,{offset,query})=>query?{items:[skills[1]],nextOffset:null}:offset?new Promise(resolve=>release=resolve):{items:skills.slice(0,2),nextOffset:2},{storage});
  const opening=ui.picker.open();await flush();assert.ok(release);await ui.search('b');
  release({items:skills.slice(2),nextOffset:null});await opening;
  assert.deepEqual(skillOrder(ui),['b']);assert.equal(ui.calls.find(call=>call.offset===2).signal.aborted,true);
});

test('files preserve a lazy directory tree and insert native Windows absolute paths',async()=>{
  const ui=fixture(async(kind,{path})=>ui.Picker.fileItems({root:'D:\\project',entries:path==='src'?
    [{name:'index.js',path:'src/index.js',kind:'file'}]:[{name:'src',path:'src',kind:'directory'}],nextOffset:null}));
  await ui.picker.open();await ui.picker.setTab('files');
  assert.equal(ui.picker.list.children[0].tagName,'DETAILS');assert.equal(ui.calls.filter(call=>call.path==='src').length,0);
  const directory=ui.picker.list.children[0];directory.open=true;directory.ontoggle();await flush();
  const item=ui.nodes(ui.picker.list).find(node=>node.dataset.referenceId==='directory:src/index.js');
  assert.ok(item);assert.equal(ui.picker.list.children[0].dataset.referenceGroup,'directory:src');item.onclick();
  assert.equal(ui.input.value,'D:\\project\\src\\index.js\n');assert.equal(ui.calls.at(-1).target.host,'local');
});

test('project file references remain clickable with a running gateway that omits the root field',async()=>{
  const reads=[],app=fs.readFileSync('web/shell/app.js','utf8');
  const start=app.indexOf('async function loadComposerReferences('),end=app.indexOf('const composerReferences=',start);
  let ui;ui=fixture((kind,options)=>ui.run('loadComposerReferences(kind,options)',{kind,options}));
  ui.run(app.slice(start,end),{t:text=>text,sessionUrl:()=>'/api/sessions/one/workspace?host=local',api:async url=>{
    reads.push(url);return {project:'project',entries:[{name:'README.md',path:'README.md',kind:'file'}],nextOffset:null};
  }});
  ui.setTarget({key:'local|one',id:'one',host:'local',cwd:'D:\\project',canSkills:false});
  await ui.picker.open();const file=ui.nodes(ui.picker.list).find(node=>node.dataset.referenceId==='directory:README.md');
  assert.ok(file);assert.equal(file.disabled,false,'A regular project file must not be greyed out when the chat already supplies its full directory');
  file.onclick();assert.equal(ui.input.value,'D:\\project\\README.md\n');assert.equal(ui.picker.dialog.open,false);
  assert.equal(reads.length,1);
});

test('file references prefer the reported root and only accept absolute fallback directories',()=>{
  const {Picker}=fixture(),entries=[{name:'README.md',path:'README.md',kind:'file'},{name:'link',path:'link',kind:'blocked'}];
  const actual=Picker.fileItems({root:'D:\\actual',entries},'C:\\old');assert.equal(actual.items[0].value,'D:\\actual\\README.md');
  for(const root of ['/srv/project','C:\\项目','C:/project','\\\\server\\share']){
    const result=Picker.fileItems({entries},root);assert.equal(result.items[0].disabled,false);assert.equal(result.error,'');assert.equal(result.items[1].disabled,true);
  }
  for(const root of ['',null,'project','C:relative']){
    const result=Picker.fileItems({project:'basename',entries},root);assert.equal(result.items[0].disabled,true);assert.equal(result.items[0].value,'');assert.match(result.error,/完整目录/);
  }
});

test('POSIX roots containing literal backslashes stay POSIX while UNC and drive roots retain Windows paths',()=>{
  const {Picker}=fixture(),entries=[{name:'a.js',path:'src/a.js',kind:'file'}];
  for(const [root,value] of [['/srv/team\\demo','/srv/team\\demo/src/a.js'],['/srv/team\\','/srv/team\\/src/a.js'],['/','/src/a.js'],['C:\\work','C:\\work\\src\\a.js'],['C:/work','C:/work/src/a.js'],['\\\\server\\share','\\\\server\\share\\src\\a.js']]){
    assert.equal(Picker.fileItems({root,entries}).items[0].value,value);
  }
});

test('full-project file search retains the ancestor folders of a deep match',async()=>{
  const ui=fixture(async()=>ui.Picker.fileItems({root:'/remote/project',entries:[{name:'needle.txt',path:'src/deep/needle.txt',kind:'file'}],nextOffset:null}));
  await ui.picker.open();await ui.picker.setTab('files');await ui.search('needle');
  const groups=ui.nodes(ui.picker.list).filter(node=>node.tagName==='DETAILS');
  assert.deepEqual(groups.map(node=>node.dataset.referenceGroup),['directory:src','directory:src/deep']);
  assert.ok(groups.every(node=>node.open));assert.equal(ui.calls.at(-1).query,'needle');
  ui.nodes(ui.picker.list).find(node=>node.dataset.referenceId).onclick();assert.equal(ui.input.value,'/remote/project/src/deep/needle.txt\n');
});

test('session references retain section/project/chat structure and group expansion',async()=>{
  const ui=fixture(async()=>({items:[{id:'chat',title:'Chat title',value:'codex://threads/chat',groups:[{id:'section:work',title:'Work'},{id:'project:p',title:'Project'}]}],nextOffset:null}));
  await ui.picker.open();await ui.picker.setTab('sessions');
  const groups=ui.nodes(ui.picker.list).filter(node=>node.tagName==='DETAILS');
  assert.deepEqual(groups.map(node=>node.dataset.referenceGroup),['section:work','project:p']);
  groups[1].open=false;groups[1].ontoggle();ui.picker.render();
  assert.equal(ui.nodes(ui.picker.list).find(node=>node.dataset.referenceGroup==='project:p').open,false);
  ui.nodes(ui.picker.list).find(node=>node.dataset.referenceId==='chat').onclick();assert.equal(ui.input.value,'codex://threads/chat\n');
});

test('late requests and rows cannot insert into another host or conversation',async()=>{
  let release;const ui=fixture(()=>new Promise(resolve=>release=resolve));
  const opening=ui.picker.open();ui.setTarget({key:'ssh|two',id:'two',host:'ssh'});ui.input.value='Other draft';
  release({items:[{id:'stale',title:'Stale',value:'$stale'}],nextOffset:null});await opening;
  ui.picker.insert({value:'$stale'});assert.equal(ui.input.value,'Other draft');assert.equal(ui.picker.list.children.length,0);
});

test('a delayed native close event cannot cancel a newly reopened picker',async()=>{
  const ui=fixture(async()=>({items:[{id:'skill',title:'Skill',value:'$skill'}],nextOffset:null}));
  await ui.picker.open();ui.picker.close();await ui.picker.open();
  const revision=ui.picker.revision;ui.picker.dialog.dispatchEvent({type:'close'});
  assert.equal(ui.picker.revision,revision);assert.equal(ui.picker.current(),true);
});

test('a search supersedes an append without mixing older results',async()=>{
  let release;const ui=fixture(async(_kind,{query,offset})=>offset?new Promise(resolve=>release=resolve):
    {items:[{id:query||'first',title:query||'First',value:'$'+(query||'first')}],nextOffset:query?null:200});
  await ui.picker.open();const append=ui.picker.loadPage({append:true});await ui.search('new');
  release({items:[{id:'old',title:'Old',value:'$old'}],nextOffset:null});await append;
  assert.deepEqual(plain(ui.picker.active.items.map(item=>item.id)),['new']);assert.equal(ui.picker.active.nextOffset,null);
});

test('disabled skills still permit project files and failed reads can be explicitly retried',async()=>{
  let fail=true;const ui=fixture(async()=>{if(fail)throw Error('Offline');return {items:[{id:'file',title:'File',value:'/file'}],nextOffset:null};});
  ui.setTarget({key:'cli|one',canSkills:false});await ui.picker.open();
  assert.equal(ui.picker.tab,'files');assert.equal(ui.picker.tabButtons.get('skills').disabled,true);assert.equal(ui.picker.error.textContent,'Offline');
  fail=false;await ui.picker.refresh.onclick();assert.equal(ui.picker.error.textContent,'');assert.equal(ui.picker.active.items.length,1);
});

test('hidden-file changes discard directory caches and blocked entries remain unavailable',async()=>{
  const ui=fixture(async()=>ui.Picker.fileItems({root:'/project',entries:[{name:'unsafe',path:'unsafe',kind:'blocked'}],nextOffset:null}));
  await ui.picker.open();await ui.picker.setTab('files');ui.picker.active.directories.set('old',{items:[]});
  ui.picker.hiddenFiles.checked=true;await ui.picker.hiddenFiles.onchange();assert.equal(ui.calls.at(-1).hidden,true);
  assert.equal(ui.picker.active.directories.size,0);const row=ui.picker.list.children[0];assert.equal(row.disabled,true);row.onclick();assert.equal(ui.input.value,'');
});

test('a failed expanded directory waits for explicit retry instead of toggling into a request loop',async()=>{
  let fail=true;const ui=fixture(async(_kind,{path})=>{
    if(path==='src'){if(fail)throw Error('Directory unavailable');return {items:[{id:'file',title:'File',value:'/project/src/file',groups:[{id:'directory:src',title:'src',path:'src',kind:'directory'}]}],nextOffset:null};}
    return {items:[{id:'directory:src',title:'src',kind:'directory',path:'src'}],nextOffset:null};
  });
  await ui.picker.open();await ui.picker.setTab('files');
  const folder=()=>ui.picker.list.children[0];folder().open=true;folder().ontoggle();await flush();
  const count=ui.calls.length;
  for(let i=0;i<3;i++){folder().ontoggle();await flush();}
  assert.equal(ui.calls.length,count,'Rendering an open details element must not repeat failed reads');
  fail=false;ui.nodes(ui.picker.list).find(node=>node.textContent==='重试'&&node.tagName==='BUTTON').onclick();await flush();
  assert.equal(ui.calls.length,count+1);assert.ok(ui.nodes(ui.picker.list).some(node=>node.dataset.referenceId==='file'));
});

test('selection cannot exceed the composer limit or overwrite text changed during lookup',async()=>{
  const ui=fixture(async()=>({items:[{id:'file',title:'File',value:'/long/path'}],nextOffset:null}));
  ui.input.value='Draft';ui.input.maxLength=7;await ui.picker.open();ui.picker.list.children[0].onclick();
  assert.equal(ui.input.value,'Draft');assert.match(ui.picker.error.textContent,/长度限制/);
  ui.input.maxLength=100;ui.input.value='Edited';ui.picker.list.children[0].onclick();assert.equal(ui.input.value,'Edited\n/long/path\n');
});

function sideFixture(handler,options){
  const ui=fixture(undefined,options),reads=[];let visible=true;
  const Panel=ui.run(fs.readFileSync('web/features/workspace/side-chat.js','utf8')+'\nSideChatPanel;'),panel=Object.create(Panel.prototype);
  panel.session={id:'parent',host:'local',key:'local|parent',cwd:'D:\\parent'};panel.tab={id:'sidechat:slot',slot:'slot'};
  panel.state={id:'child',connected:true,cwd:'D:\\child'};
  panel.workbench={isVisible:()=>visible,request:async(url,body,signal)=>{reads.push({url,body,signal});return handler(url,body,signal);},
    loadReferences:async(kind,options)=>{reads.push({kind,options});return {items:[{id:kind,title:kind,value:kind==='files'?options.target.cwd+'\\file.js':'codex://threads/linked'}]};}};
  ui.picker.context=()=>panel.referenceContext();ui.picker.load=(kind,options)=>panel.loadReferences(kind,options);
  return {...ui,panel,reads,setVisible:value=>visible=value};
}

test('the main and actual side composer share skill frequency while keeping their drafts independent',async()=>{
  const catalog=[{id:'first',name:'first'},{id:'review',name:'review'}];
  const main=fixture(async()=>main.Picker.skillItems({skills:catalog,total:2}));
  await chooseSkill(main,'review');await chooseSkill(main,'review');
  const side=sideFixture(async()=>({skills:catalog,total:2}),{storage:main.storage});await side.picker.open();
  assert.deepEqual(skillOrder(side),['review','first']);
  await chooseSkill(side,'first');await chooseSkill(side,'first');await chooseSkill(side,'first');await main.picker.open();
  assert.deepEqual(skillOrder(main),['first','review']);assert.equal(main.input.value,'$review\n$review\n');assert.equal(side.input.value,'$first\n$first\n$first\n');
});

test('a side plus picker reads its own child skills and inserts the same editable reference text as main',async()=>{
  const ui=sideFixture(async()=>({skills:[{id:'review',name:'review',displayName:'Review',description:'child skill'}],total:201,cache:{state:'stale'}}));
  ui.input.value='side draft';await ui.picker.open();
  assert.equal(ui.reads[0].body.id,'child');assert.equal(ui.reads[0].body.action,'skills');assert.match(ui.reads[0].url,/slot=slot/);
  assert.equal(ui.picker.active.nextOffset,1);assert.match(ui.picker.notice.textContent,/缓存/);
  ui.picker.list.children[0].onclick();assert.equal(ui.input.value,'side draft\n$review\n');assert.equal(ui.panel.selectedSkills,undefined);
});

test('side file and session references share the parent catalog with a side-specific context and draft',async()=>{
  const ui=sideFixture(async()=>({skills:[],total:0}));await ui.picker.open();await ui.picker.setTab('files');ui.picker.list.children[0].onclick();
  await ui.picker.open();await ui.picker.setTab('sessions');ui.picker.list.children[0].onclick();
  const file=ui.reads.find(read=>read.kind==='files');assert.equal(file.options.target.id,'parent');assert.equal(file.options.target.cwd,'D:\\child');assert.match(file.options.target.key,/sidechat:slot/);
  assert.equal(ui.input.value,'D:\\child\\file.js\ncodex://threads/linked\n');
});

test('new side drafts allow file references without creating a runtime while skills wait for a child',async()=>{
  const ui=sideFixture(()=>{throw Error('Skills must wait for creation');});ui.panel.state={id:null,connected:false};await ui.picker.open();
  assert.equal(ui.picker.tab,'files');assert.equal(ui.picker.tabButtons.get('skills').disabled,true);assert.equal(ui.reads[0].kind,'files');
  ui.picker.list.children[0].onclick();assert.equal(ui.input.value,'D:\\parent\\file.js\n');
  ui.panel.busy=true;assert.equal(ui.panel.referenceContext(),null);ui.panel.busy=false;ui.setVisible(false);assert.equal(ui.panel.referenceContext(),null);
});

test('a replaced side child and a disposed picker discard old reads and cannot insert stale skill rows',async()=>{
  let finish;const ui=sideFixture(()=>new Promise(resolve=>finish=resolve));const opening=ui.picker.open();ui.panel.state.id='replacement';
  finish({skills:[{id:'old',name:'old'}],total:1});await opening;ui.picker.insert({value:'$old'});assert.equal(ui.input.value,'');
  const reopening=ui.picker.open();const dialog=ui.picker.dialog;ui.picker.dispose();finish({skills:[{id:'old',name:'old'}],total:1});await reopening;
  assert.equal(ui.picker.dialog,null);assert.equal(dialog.isConnected,false);assert.equal(ui.picker.states.size,0);assert.equal(ui.input.value,'');
});
