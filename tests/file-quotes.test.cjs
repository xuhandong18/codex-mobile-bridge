'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
  const saved=new Map();let id=0,changes=0;
  class Node{
    constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.value='';this.maxLength=20000;}
    before(){}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}
    setAttribute(){}addEventListener(name,run){this['on'+name]=run;}showModal(){this.open=true;}close(){this.open=false;this.onclose?.();}remove(){}
  }
  const document={createElement:tag=>new Node(tag),body:new Node('body')};
  const sessionStorage={get length(){return saved.size;},key:i=>[...saved.keys()][i],getItem:key=>saved.get(key)||null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
  const context=vm.createContext({document,sessionStorage,uuid:()=>String(++id),BridgeI18n:{t:text=>text}});
  vm.runInContext(fs.readFileSync('web/features/chat/file-quotes.js','utf8'),context);
  vm.runInContext(fs.readFileSync('web/features/chat/reference-picker.js','utf8'),context);
  vm.runInContext(fs.readFileSync('web/features/chat/selection-targets.js','utf8'),context);
  vm.runInContext(fs.readFileSync('web/features/workspace/file-selection.js','utf8'),context);
  const Drafts=vm.runInContext('FileQuoteDrafts',context),input=new Node('textarea'),quotes=new Drafts({input,onChange:()=>changes++});quotes.open('local|one');
  return {Drafts,input,quotes,saved,document,sessionStorage,context,changes:()=>changes};
}
const quote={name:'source.js',path:'D:\\project\\source.js',text:'const value = "<tag>";\r\n  next();\n'};

test('excerpt chips retain literal content outside the textarea and expand into the outgoing message',()=>{
  const {input,quotes}=fixture();input.value='请检查这里';quotes.add(quote);
  assert.equal(input.value,'请检查这里');assert.equal(quotes.root.children.length,1);
  assert.equal(quotes.text(),'请检查这里\n\n文件：D:\\project\\source.js\n> const value = "<tag>";\n>   next();\n> ');
  quotes.details(quotes.rows[0]);assert.equal(quotes.dialog.children[2].textContent,quote.text);
});

test('deleting from details removes exactly that excerpt and retains message text and other excerpts',()=>{
  const {input,quotes}=fixture();input.value='草稿';quotes.add(quote);quotes.add({...quote,text:'another'});
  const removed=quotes.rows[0].id;quotes.details(quotes.rows[0]);quotes.dialog.children.at(-1).onclick();
  assert.equal(quotes.dialog,null);assert.equal(input.value,'草稿');assert.equal(quotes.rows.length,1);assert.notEqual(quotes.rows[0].id,removed);
  assert.equal(quotes.rows[0].text,'another');
});

test('drafts persist independently for hosts and chats and acceptance clears only submitted ids',()=>{
  const {quotes,Drafts,input}=fixture();quotes.add(quote);const sent=quotes.rows[0].id;
  quotes.open('ssh|one');quotes.add({...quote,path:'/remote/source.js',host:'ssh'});assert.match(quotes.text(),/主机：ssh/);
  quotes.open('local|two');assert.equal(quotes.rows.length,0);quotes.open('local|one');quotes.add({...quote,text:'new draft'});
  quotes.clear('local|one',[sent]);assert.equal(quotes.rows[0].text,'new draft');
  const restored=new Drafts({input});restored.open('local|one');assert.equal(restored.rows.length,1);assert.equal(restored.rows[0].text,'new draft');
  quotes.forget(key=>key.startsWith('ssh|'));quotes.open('ssh|one');assert.equal(quotes.rows.length,0);
});

test('length validation counts expanded excerpts both on insertion and after editing the message',()=>{
  const {input,quotes}=fixture();input.maxLength=60;input.value='x'.repeat(40);
  assert.throws(()=>quotes.add(quote),/合计过长/);assert.equal(quotes.rows.length,0);assert.equal(input.value.length,40);
  input.maxLength=200;quotes.add(quote);input.value='x'.repeat(200);assert.throws(()=>quotes.validate(),/合计过长/);
});

test('malformed stored data cannot become an excerpt and account cleanup closes its detail dialog',()=>{
  const {saved,quotes}=fixture();saved.set('file-quotes:bad','{"text":"not an array"}');quotes.open('bad');assert.equal(quotes.rows.length,0);
  quotes.add(quote);quotes.details(quotes.rows[0]);quotes.forget(()=>true);assert.equal(quotes.dialog,null);assert.equal(quotes.rows.length,0);assert.equal(saved.size,0);
});

test('a delayed workspace-root read cannot insert an excerpt after switching chats or closing its file',async()=>{
  for(const action of ['switch','close']){
    const {quotes,context}=fixture(),Selection=vm.runInContext('FileSelectionAction',context),selection=Object.create(Selection.prototype);
    const tab={name:'file.js',filePath:'src/file.js'},session={key:'local|one',files:[tab]},wb={current:session,sessions:new Map([[session.key,session]]),url:()=>'/read-only-workspace'};
    let finish;wb.request=()=>new Promise(resolve=>finish=resolve);selection.workbench=wb;selection.bar={};selection.targets=()=>[{id:'chat',quotes,available:()=>true,focus(){}}];
    const adding=selection.add({session,tab,text:'selected'});if(action==='switch')wb.current={};else session.files=[];
    finish({root:'/remote/project'});await adding;assert.equal(quotes.rows.length,0);
  }
});

test('remote excerpts retain the target host and POSIX path without using the gateway OS',async()=>{
  const {quotes,context}=fixture(),Selection=vm.runInContext('FileSelectionAction',context),selection=Object.create(Selection.prototype);
  const tab={name:'file.js',filePath:'src/file.js'},session={key:'ssh|one',host:'ssh',root:'/remote/project',files:[tab]};
  context.window={getSelection:()=>({removeAllRanges(){}})};quotes.input.focus=()=>{};
  selection.workbench={current:session,sessions:new Map([[session.key,session]]),closePreviewFullscreen(){}};selection.bar={};selection.menu={};selection.workbench.selectionTargets=new (vm.runInContext('ChatSelectionTargets',context))(selection.workbench);selection.workbench.selectionTargets.targets=()=>[{id:'chat',quotes,available:()=>true,focus(){}}];
  await selection.add({session,tab,text:'selected'});assert.equal(quotes.rows[0].path,'/remote/project/src/file.js');assert.equal(quotes.rows[0].host,'ssh');
});

test('file selection references use the current chat directory when an older gateway omits root',async()=>{
  for(const cwd of ['D:\\project','/srv/project']){
    const {quotes,context}=fixture(),Selection=vm.runInContext('FileSelectionAction',context),selection=Object.create(Selection.prototype);
    const tab={name:'file.js',filePath:'src/file.js'},session={key:'local|one',host:'local',cwd,files:[tab]},errors=[];
    context.window={getSelection:()=>({removeAllRanges(){}})};quotes.input.focus=()=>{};
    selection.workbench={current:session,sessions:new Map([[session.key,session]]),url:()=>'/workspace',request:async()=>({project:'basename',entries:[]}),closePreviewFullscreen(){},notify:message=>errors.push(message)};
    selection.bar={};selection.menu={};selection.workbench.selectionTargets=new (vm.runInContext('ChatSelectionTargets',context))(selection.workbench);selection.workbench.selectionTargets.targets=()=>[{id:'chat',quotes,available:()=>true,focus(){}}];
    await selection.add({session,tab,text:'selected'});assert.equal(errors.length,0);assert.equal(quotes.rows.length,1);
    assert.equal(quotes.rows[0].path,cwd.startsWith('/')?'/srv/project/src/file.js':'D:\\project\\src\\file.js');
  }
});
