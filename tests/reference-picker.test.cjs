'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/features/chat/reference-picker.js','utf8');
const plain=value=>JSON.parse(JSON.stringify(value)),flush=()=>new Promise(setImmediate);
function fixture(handler=async()=>({items:[],nextOffset:null})){
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
  }
  const document={body:new Element('body'),createElement:tag=>new Element(tag)},button=new Element('button'),input=new Element('textarea');
  input.maxLength=100000;
  const context=vm.createContext({document,BridgeI18n:{t:text=>text},AbortController,Event:class{constructor(type){this.type=type;}},
    setTimeout:run=>{timers.set(++timer,run);return timer;},clearTimeout:id=>timers.delete(id)});
  vm.runInContext(source,context);
  const Picker=context.ChatReferencePicker,picker=new Picker({button,input,context:()=>target,
    load:async(kind,options)=>{calls.push({kind,...options});return handler(kind,options);}});
  return {Picker,picker,button,input,document,calls,events,timers,setTarget:value=>target=value,
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
