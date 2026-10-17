'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../web/features/chat/project-folder-browser.js'),'utf8');
const parent='/home/fixture/projects';
const directory=(name,base=parent)=>({name,path:base+'/'+name});
const roots=[{name:'Fixture home',path:'/home/fixture'},{name:'Data (D:)',path:'D:\\'}];
const flush=()=>new Promise(setImmediate);
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const buttons=node=>node.children.filter(child=>child.tagName==='BUTTON');
const rowPaths=browser=>buttons(browser.list).map(node=>node.dataset.path);

function fixture({inputValue=parent,target={key:'local|chat|1',cwd:parent},saved=new Map(),canCreate=()=>true,origin='https://gateway.test',translate=value=>value}={}){
  const requests=[],timers=new Map(),selected=[];let timerId=0,uuidId=0,handler,currentTarget=target;
  class Node {
    constructor(tag){
      this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};this.listeners=new Map();
      this.value='';this.disabled=false;this.hidden=false;this.open=false;this.className='';this.parentElement=null;this.text='';
    }
    get textContent(){return this.text+this.children.map(child=>child.textContent).join('');}
    set textContent(value){this.replaceChildren();this.text=String(value);}
    append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}}
    prepend(...children){for(const child of children)child.parentElement=this;this.children.unshift(...children);}
    replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.text='';this.append(...children);}
    setAttribute(name,value){this.attributes[name]=String(value);}
    getAttribute(name){return this.attributes[name]??null;}
    addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener);}
    dispatchEvent(event){event.target=this;this['on'+event.type]?.(event);for(const listener of this.listeners.get(event.type)||[])listener(event);return !event.defaultPrevented;}
    focus(){document.activeElement=this;}
    select(){this.selectionStart=0;this.selectionEnd=this.value.length;}
    showModal(){this.open=true;}
    close(){if(this.open){this.open=false;this.dispatchEvent({type:'close'});}}
  }
  const document={body:new Node('body'),activeElement:null,createElement:tag=>new Node(tag),
    createElementNS:(namespace,tag)=>Object.assign(new Node(tag),{namespaceURI:namespace})};
  const context=vm.createContext({document,BridgeI18n:{t:translate},AbortController,location:{origin},window:{},
    Event:class {constructor(type,options={}){this.type=type;Object.assign(this,options);}preventDefault(){this.defaultPrevented=true;}stopPropagation(){this.propagationStopped=true;}},
    sessionStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,String(value))},
    setTimeout(fn,delay){const id=++timerId;timers.set(id,{fn,delay});return id;}});
  // A fresh VM owns the class's static attempt map; only explicit reload tests share storage.
  vm.runInContext(source,context,{filename:'project-folder-browser.js'});
  const Browser=vm.runInContext('ProjectFolderBrowser',context);
  const listing=route=>{
    assert.match(route,/^\/api\/project-directories\?path=/,'Unexpected read request');
    const value=new URL(route,origin).searchParams.get('path');
    return {path:value,parent:!value||value==='/'||value==='D:\\'?null:value.slice(0,value.lastIndexOf('/'))||'/',
      directories:!value?roots:value===parent?[directory('Alpha'),directory('中文项目'),directory('Beta')]:[]};
  };
  const request=async(route,body,signal)=>{
    const entry={route,body,signal,method:body===undefined?'GET':'POST'};requests.push(entry);
    if(handler)return handler(entry,listing);
    assert.equal(body,undefined,'Writes must have an explicit receipt fixture');return listing(route);
  };
  const createBrowser=(options={})=>{
    const button=document.createElement('button'),input=document.createElement('input');input.value=options.inputValue??inputValue;
    document.body.append(button,input);
    return new Browser({button,input,request,context:()=>currentTarget,uuid:()=>`folder-${++uuidId}`,canCreate,onSelect:value=>selected.push(value),...options});
  };
  const browser=createBrowser();
  return {browser,createBrowser,document,requests,selected,saved,timers,Browser,
    handle(value){handler=value;},setContext(value){currentTarget=value;},
    writes:()=>requests.filter(entry=>entry.method==='POST'),operations:()=>requests.filter(entry=>entry.route.startsWith('/api/project-directory-operations?')),
    typeName(value,b=browser){b.folderName.value=value;b.folderName.oninput();},
    async tick(){await flush();assert.equal(timers.size,1,'One pending receipt should schedule one poll');const [id,timer]=timers.entries().next().value;assert.equal(timer.delay,1000);timers.delete(id);timer.fn();await flush();}};
}

function receipt(entry,status='completed',extra={}){
  const body=entry.body;return {id:body.id,status,...(status==='completed'?{directory:{parent:body.parent,name:body.name,path:body.parent+'/'+body.name}}:{}),...extra};
}
function visible(browser){return {path:browser.currentPath,address:browser.address.value,rows:rowPaths(browser),
  breadcrumbs:browser.breadcrumbs.textContent,shortcuts:buttons(browser.shortcuts).map(node=>node.dataset.path),
  status:browser.status.textContent,error:browser.error.textContent,createStatus:browser.createStatus.textContent,
  createHidden:browser.createPanel.hidden,writing:browser.writing,selectDisabled:browser.selectButton.disabled};}

test('construction is lazy; opening reads the input path and root shortcuts without selecting it',async()=>{
  const f=fixture(),b=f.browser;let inputEvents=0;b.input.addEventListener('input',()=>inputEvents++);
  assert.equal(b.dialog,undefined);assert.equal(f.requests.length,0);assert.equal(f.document.body.children.length,2);
  await b.button.onclick();
  assert.equal(b.dialog.open,true);assert.equal(b.currentPath,parent);assert.equal(b.address.value,parent);
  assert.deepEqual(rowPaths(b),[parent+'/Alpha',parent+'/中文项目',parent+'/Beta']);
  assert.deepEqual(buttons(b.shortcuts).map(node=>node.dataset.path),['',...roots.map(row=>row.path),parent]);
  assert.equal(b.dialog.getAttribute('aria-labelledby'),b.dialog.id+'-title');
  assert.equal(f.writes().length,0);assert.equal(inputEvents,0);assert.deepEqual(f.selected,[]);
});

test('empty input starts at context cwd, or the root chooser when no cwd exists',async()=>{
  const withCwd=fixture({inputValue:''});await withCwd.browser.open();assert.equal(withCwd.browser.currentPath,parent);
  const f=fixture({inputValue:'',target:{key:'no-chat'}}),b=f.browser;await b.open();
  assert.equal(f.requests.length,1);assert.equal(b.currentPath,'');assert.equal(b.selectButton.disabled,true);assert.equal(b.newFolderButton.disabled,true);
  assert.deepEqual(rowPaths(b),roots.map(row=>row.path));assert.equal(b.upButton.disabled,true);
  await buttons(b.list)[0].onclick();assert.equal(b.currentPath,roots[0].path);assert.equal(b.selectButton.disabled,false);
});

test('folder rows, parent navigation, root shortcuts and breadcrumb buttons navigate through GET requests',async()=>{
  const f=fixture(),b=f.browser;await b.open();
  await buttons(b.list)[0].onclick();assert.equal(b.currentPath,parent+'/Alpha');
  assert.deepEqual(buttons(b.breadcrumbs).map(node=>node.textContent),['此电脑','/','home','fixture','projects','Alpha']);
  await buttons(b.breadcrumbs).find(node=>node.textContent==='projects').onclick();assert.equal(b.currentPath,parent);
  await b.upButton.onclick();assert.equal(b.currentPath,'/home/fixture');
  await buttons(b.shortcuts).find(node=>node.dataset.path==='D:\\').onclick();assert.equal(b.currentPath,'D:\\');
  assert.equal(b.upButton.disabled,true);assert.equal(b.address.value,'D:\\');
  await buttons(b.shortcuts).find(node=>node.dataset.path==='').onclick();assert.equal(b.currentPath,'');
  assert.equal(b.selectButton.disabled,true);assert.equal(f.writes().length,0);assert.equal(b.input.value,parent);
});

test('Windows drive and UNC breadcrumbs preserve navigable absolute paths',async()=>{
  for(const [value,expected] of [
    ['C:\\Users\\测试\\work',['C:\\','C:\\Users','C:\\Users\\测试','C:\\Users\\测试\\work']],
    ['D:/workspace/child',['D:/','D:/workspace','D:/workspace/child']],
    ['\\\\server\\share\\工作\\child',['\\\\server\\share\\','\\\\server\\share\\工作','\\\\server\\share\\工作\\child']]
  ]){
    const f=fixture({inputValue:value}),b=f.browser;await b.open();
    assert.deepEqual(buttons(b.breadcrumbs).slice(1).map(node=>Array.from(f.Browser.trail(value)).find(crumb=>crumb.name===node.textContent)?.path),expected);
    await buttons(b.breadcrumbs)[1].onclick();assert.equal(b.currentPath,expected[0]);assert.equal(f.writes().length,0);
  }
});

test('search filters names and paths locally, supports Chinese, and clearing restores rows',async()=>{
  const f=fixture(),b=f.browser;await b.open();const readCount=f.requests.length;
  b.search.value=' ALPHA ';b.search.oninput();assert.deepEqual(rowPaths(b),[parent+'/Alpha']);
  b.search.value='中文';b.search.oninput();assert.deepEqual(rowPaths(b),[parent+'/中文项目']);
  b.search.value='/HOME/FIXTURE';b.search.oninput();assert.equal(rowPaths(b).length,3);
  b.search.value='missing';b.search.oninput();assert.equal(rowPaths(b).length,0);assert.match(b.list.textContent,/没有匹配的文件夹/);
  b.search.value='';b.search.oninput();assert.equal(rowPaths(b).length,3);assert.equal(f.requests.length,readCount);
  await b.navigate(parent+'/Alpha');assert.match(b.list.textContent,/这个文件夹还是空的/);assert.equal(b.selectButton.disabled,false);assert.equal(b.newFolderButton.disabled,false);
});

test('breadcrumb folder names retain raw Workspace text and have no translation markers',async()=>{
  const f=fixture({inputValue:parent+'/Workspace',translate:value=>value==='Workspace'?'工作台':value}),b=f.browser;await b.open();
  const crumb=buttons(b.breadcrumbs).find(node=>node.textContent==='Workspace');assert.ok(crumb,'The folder name must not pass through UI translation');
  assert.equal(b.breadcrumbs.textContent.includes('工作台'),false);assert.equal(crumb.title,'Workspace');assert.equal(crumb.getAttribute('aria-label'),'Workspace');
  assert.equal(Object.hasOwn(crumb.dataset,'i18nAriaLabel'),false);assert.equal(Object.hasOwn(crumb.dataset,'i18nTitle'),false);
  assert.equal(Object.hasOwn(crumb.children[0].dataset,'i18n'),false);assert.equal(crumb.children[0].getAttribute('data-i18n'),null);
  await crumb.onclick();assert.equal(b.currentPath,parent+'/Workspace');
});

test('address editing trims and encodes a path, while Escape leaves the selected path unchanged',async()=>{
  const f=fixture(),b=f.browser;await b.open();await b.editButton.onclick();
  assert.equal(b.addressRow.hidden,false);assert.equal(f.document.activeElement,b.address);assert.equal(b.address.selectionEnd,parent.length);
  b.address.value='/discarded';const escape={key:'Escape',preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};
  b.address.onkeydown(escape);assert.equal(escape.prevented,true);assert.equal(escape.stopped,true);assert.equal(b.addressRow.hidden,true);assert.equal(b.currentPath,parent);
  await b.editButton.onclick();const value=parent+'/space & #项目';b.address.value=' '+value+' ';await b.goButton.onclick();
  assert.equal(b.currentPath,value);assert.equal(f.requests.at(-1).route,'/api/project-directories?path='+encodeURIComponent(value));assert.equal(b.addressRow.hidden,true);
  assert.equal(b.input.value,parent);
});

test('failed reads disable selection and retry the requested path before recovering',async()=>{
  const f=fixture(),b=f.browser;await b.open();let fail=true;
  f.handle((entry,listing)=>{if(fail){fail=false;throw Error('目录读取失败');}return listing(entry.route);});
  await b.navigate('/unavailable');assert.match(b.error.textContent,/目录读取失败/);assert.match(b.list.textContent,/文件夹暂不可用/);
  assert.equal(b.selectButton.disabled,true);assert.equal(b.newFolderButton.disabled,true);assert.equal(b.input.value,parent);
  await buttons(b.list.children[0]).find(node=>node.textContent==='重试').onclick();
  assert.equal(b.currentPath,'/unavailable');assert.equal(b.error.textContent,'');assert.equal(b.selectButton.disabled,false);
  assert.deepEqual(f.requests.slice(-2).map(entry=>entry.route),Array(2).fill('/api/project-directories?path=%2Funavailable'));
});

test('invalid directory lists show an error and an explicit refresh can recover',async()=>{
  const f=fixture(),b=f.browser;await b.open();f.handle(()=>({path:'/broken',directories:null}));
  await b.navigate('/broken');assert.match(b.error.textContent,/文件夹列表返回无效/);assert.equal(b.selectButton.disabled,true);
  f.handle((entry,listing)=>listing(entry.route));await b.refreshButton.onclick();assert.equal(b.currentPath,parent);assert.equal(b.error.textContent,'');
});

test('a missing folder creation route explains that the running gateway needs a restart',async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('New folder');
  f.handle((entry,listing)=>{if(entry.method==='POST')throw Object.assign(Error('页面不存在'),{status:404});return listing(entry.route);});
  await b.createDirectory();assert.match(b.createStatus.textContent,/重启.*手机网关/);
  assert.doesNotMatch(b.createStatus.textContent,/页面不存在/);assert.equal(f.writes().length,1);assert.equal(f.timers.size,0);assert.equal(b.writing,false);
});

test('an unavailable creation capability explains the restart inside the folder dialog while browsing remains usable',async()=>{
  const f=fixture({canCreate:()=>false}),b=f.browser;b.creationHint=()=> '请重启电脑上的手机网关';await b.open();
  assert.equal(b.newFolderButton.disabled,true);assert.match(b.status.textContent,/重启.*手机网关/);
  assert.equal(b.selectButton.disabled,false);assert.ok(rowPaths(b).length);assert.equal(f.writes().length,0);
});

test('a missing receipt route keeps a submitted creation unknown and only allows GET verification',async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('New folder');
  f.handle((entry,listing)=>{
    if(entry.method==='POST')return receipt(entry,'pending');
    if(entry.route.startsWith('/api/project-directory-operations?'))throw Object.assign(Error('页面不存在'),{status:404});
    return listing(entry.route);
  });
  const pending=b.createDirectory();await f.tick();await pending;assert.match(b.createStatus.textContent,/重启.*手机网关/);
  assert.match(b.createStatus.textContent,/尚未确认/);assert.equal(b.folderCreate.disabled,true);assert.equal(b.checkButton.hidden,false);
  await b.checkAttempt();assert.equal(f.writes().length,1);assert.equal(f.operations().length,2);assert.equal(JSON.parse([...f.saved.values()][0]).status,'unknown');
});

test('only confirmation writes the parent input, dispatches input and calls onSelect; cancel changes nothing',async()=>{
  const f=fixture(),b=f.browser,events=[];b.input.addEventListener('input',event=>events.push(event));await b.open();
  await b.navigate(parent+'/Alpha');b.cancelButton.onclick();assert.equal(b.dialog.open,false);assert.equal(b.input.value,parent);assert.deepEqual(f.selected,[]);assert.equal(events.length,0);
  await b.open();await b.navigate(parent+'/中文项目');b.selectButton.onclick();
  assert.equal(b.input.value,parent+'/中文项目');assert.deepEqual(f.selected,[parent+'/中文项目']);assert.equal(events.length,1);assert.equal(events[0].bubbles,true);
  assert.equal(b.dialog.open,false);assert.equal(f.document.activeElement,b.button);
});

test('creation permissions and locking prevent writes and locked browsers cannot reopen',async()=>{
  const f=fixture({canCreate:()=>false}),b=f.browser;await b.open();assert.equal(b.newFolderButton.disabled,true);
  b.showCreateForm();assert.equal(b.createPanel.hidden,true);f.typeName('denied');await b.createDirectory();assert.equal(f.writes().length,0);
  b.setLocked(true);assert.equal(b.dialog.open,false);assert.equal(b.button.disabled,true);await b.open();assert.equal(b.dialog.open,false);
  b.setLocked(false);await b.open();assert.equal(b.dialog.open,true);assert.equal(b.button.disabled,false);
});

test('create form rejects invalid single directory names locally and cancel makes no request',async()=>{
  const f=fixture(),b=f.browser;await b.open();b.newFolderButton.onclick();assert.equal(b.createPanel.hidden,false);assert.equal(f.document.activeElement,b.folderName);
  assert.equal(b.folderCreate.disabled,true);
  for(const name of ['.','..','nested/path','nested\\path','bad:name','bad*name','control\x01','trailing.','x'.repeat(121)]){
    f.typeName(name);await b.createDirectory();assert.match(b.createStatus.textContent,/有效的单层文件夹名称/);
  }
  assert.equal(f.writes().length,0);b.folderCancel.onclick();assert.equal(b.createPanel.hidden,true);assert.equal(f.document.activeElement,b.newFolderButton);
});

test('creating POSTs once, polls pending and creating with GET, then enters the new directory without selecting it',async()=>{
  const f=fixture({target:{key:'local|desktop|1',cwd:parent,contextId:'desktop-chat'}}),b=f.browser;await b.open();b.showCreateForm();f.typeName(' 新目录 ');
  const post=deferred();let submitted,polls=0;
  f.handle((entry,listing)=>{
    if(entry.method==='POST'){submitted=entry;return post.promise;}
    if(entry.route.startsWith('/api/project-directory-operations?'))return receipt(submitted,++polls===1?'creating':'completed');
    return listing(entry.route);
  });
  const pending=b.createDirectory();assert.equal(b.writing,true);assert.equal(b.folderCreate.disabled,true);assert.equal(b.folderCancel.disabled,true);assert.equal(b.selectButton.disabled,true);assert.equal(b.search.disabled,true);
  await b.createDirectory();await b.navigate('/blocked');assert.equal(f.writes().length,1);assert.equal(b.currentPath,parent);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.body)),{id:'folder-1',parent,name:'新目录',contextId:'desktop-chat'});
  post.resolve(receipt(submitted,'pending',{message:'等待桌面'}));await f.tick();assert.equal(f.operations().length,1);assert.equal(b.writing,true);
  await f.tick();await pending;assert.equal(f.operations().length,2);assert.ok(f.operations().every(entry=>entry.method==='GET'&&entry.body===undefined&&entry.route.endsWith('id=folder-1')));
  assert.equal(f.writes().length,1);assert.equal(b.currentPath,parent+'/新目录');assert.equal(b.createPanel.hidden,true);assert.equal(b.writing,false);
  assert.match(b.status.textContent,/文件夹已创建/);assert.equal(b.input.value,parent);assert.deepEqual(f.selected,[]);assert.equal(f.document.activeElement,b.selectButton);
});

test('foldercollision failure text survives rendering and permits a corrected name',async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('existing');
  f.handle(entry=>receipt(entry,'failed',{code:'foldercollision',message:'foldercollision: 已有同名文件夹'}));await b.createDirectory();
  assert.match(b.createStatus.textContent,/foldercollision: 已有同名文件夹/);assert.equal(b.createPanel.hidden,false);assert.equal(b.folderName.value,'existing');
  assert.equal(b.folderCreate.disabled,false);assert.equal(b.checkButton.hidden,true);assert.equal(b.writing,false);assert.equal(b.currentPath,parent);
  f.typeName('corrected');f.handle((entry,listing)=>entry.method==='POST'?receipt(entry):listing(entry.route));await b.createDirectory();
  assert.equal(f.writes().length,2);assert.notEqual(f.writes()[0].body.id,f.writes()[1].body.id);assert.equal(b.currentPath,parent+'/corrected');
});

for(const failure of ['unknown','disconnect','poll-disconnect'])test(`${failure} keeps the attempt blocked; explicit result checks use GET only`,async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('unconfirmed');let submitted,checking=false;
  f.handle((entry,listing)=>{
    if(entry.method==='POST'){
      submitted=entry;if(failure==='disconnect')throw Error('网络断线');
      return receipt(entry,failure==='poll-disconnect'?'pending':'unknown',{message:'桌面结果未知'});
    }
    if(entry.route.startsWith('/api/project-directory-operations?')){if(!checking)throw Error('轮询断线');return receipt(submitted,'unknown',{message:'仍需核对'});}
    return listing(entry.route);
  });
  const pending=b.createDirectory();if(failure==='poll-disconnect')await f.tick();await pending;
  assert.equal(b.folderCreate.disabled,true);assert.equal(b.checkButton.hidden,false);assert.equal(b.checkButton.disabled,false);assert.equal(b.writing,false);
  assert.match(b.createStatus.textContent,/未知|断线|尚未确认/);assert.equal(b.input.value,parent);
  const before=f.requests.length;checking=true;await b.checkButton.onclick();await b.createDirectory();
  assert.equal(f.writes().length,1);assert.equal(f.requests.length,before+2);assert.ok(f.requests.slice(before).every(entry=>entry.method==='GET'&&entry.route.startsWith('/api/project-directory-operations?id=folder-1')));
  assert.equal(b.folderCreate.disabled,true);assert.equal(b.currentPath,parent);assert.deepEqual(f.selected,[]);
});

test('a GET result check can confirm completion and enter the directory without a second POST',async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('eventual');let submitted;
  f.handle((entry,listing)=>{
    if(entry.method==='POST'){submitted=entry;return receipt(entry,'unknown');}
    return entry.route.startsWith('/api/project-directory-operations?')?receipt(submitted):listing(entry.route);
  });
  await b.createDirectory();await b.checkAttempt();assert.equal(f.writes().length,1);assert.equal(f.operations().length,1);assert.equal(b.currentPath,parent+'/eventual');
});

test('close during POST marks the stored attempt unknown; reopening only checks it with GET',async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('in-flight');const post=deferred();let submitted;
  f.handle((entry,listing)=>{
    if(entry.method==='POST'){submitted=entry;return post.promise;}
    if(entry.route.startsWith('/api/project-directory-operations?'))return receipt(submitted,'unknown');return listing(entry.route);
  });
  const pending=b.createDirectory();b.close();assert.equal(b.dialog.open,false);assert.equal(b.writing,false);assert.equal(JSON.parse([...f.saved.values()][0]).status,'unknown');
  await b.open();assert.equal(f.writes().length,1);b.showCreateForm();f.typeName('in-flight');assert.equal(b.folderCreate.disabled,true);assert.equal(b.checkButton.hidden,false);
  const before=f.requests.length;await b.createDirectory();assert.equal(f.requests.length,before+1);assert.equal(f.requests.at(-1).method,'GET');assert.equal(f.writes().length,1);
  const snapshot=visible(b);post.resolve(receipt(submitted,'pending'));await pending;assert.deepEqual(visible(b),snapshot);assert.equal(f.timers.size,0);
});

for(const closeBy of ['cancel','close'])for(const phase of ['post','delay','poll'])test(`native ${closeBy} during ${phase} releases writing, remembers unknown and never resumes the write on reopen`,async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('native-close');const late=deferred();let submitted;
  f.handle((entry,listing)=>{
    if(entry.method==='POST'){submitted=entry;return phase==='post'?late.promise:receipt(entry,'pending');}
    return entry.route.startsWith('/api/project-directory-operations?')?late.promise:listing(entry.route);
  });
  const pending=b.createDirectory();await flush();if(phase==='poll')await f.tick();assert.equal(b.writing,true);
  if(closeBy==='cancel'){
    const event={type:'cancel',defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
    assert.equal(b.dialog.dispatchEvent(event),false,'Escape must be handled through close() rather than the native default');assert.equal(event.defaultPrevented,true);
  }else b.dialog.close();
  assert.equal(b.dialog.open,false);assert.equal(b.writing,false);assert.equal(b.activeAttempt,null);assert.equal(JSON.parse([...f.saved.values()][0]).status,'unknown');
  const readsBefore=f.operations().length;await b.open();assert.equal(b.currentPath,parent);assert.equal(b.selectButton.disabled,false);b.showCreateForm();f.typeName('native-close');
  assert.equal(b.folderCreate.disabled,true);assert.equal(b.checkButton.hidden,false);assert.equal(f.writes().length,1);assert.equal(f.operations().length,readsBefore);
  const snapshot=visible(b);if(phase==='delay')await f.tick();else late.resolve(receipt(submitted));await pending;
  assert.deepEqual(visible(b),snapshot);assert.equal(f.writes().length,1);assert.equal(f.operations().length,readsBefore);assert.equal(b.input.value,parent);assert.deepEqual(f.selected,[]);
});

test('unconfirmed attempts survive a new instance and a reload through static state and sessionStorage',async()=>{
  const saved=new Map(),f=fixture({saved}),b=f.browser;await b.open();b.showCreateForm();f.typeName('remembered');
  f.handle((entry,listing)=>entry.method==='POST'?receipt(entry,'unknown'):listing(entry.route));await b.createDirectory();b.close();
  const second=f.createBrowser();await second.open();second.showCreateForm();f.typeName('remembered',second);assert.equal(second.folderCreate.disabled,true);assert.equal(second.checkButton.hidden,false);
  assert.equal(f.writes().length,1);second.close();
  const reload=fixture({saved}),other=reload.browser;await other.open();other.showCreateForm();reload.typeName('remembered');
  assert.equal(other.folderCreate.disabled,true);assert.equal(other.checkButton.hidden,false);assert.equal(reload.writes().length,0);
  reload.handle(entry=>{assert.equal(entry.method,'GET');return {id:'folder-1',status:'unknown',message:'未确认'};});
  await other.createDirectory();assert.equal(reload.operations().length,1);assert.equal(reload.writes().length,0);
});

test('unknown operation identities are scoped by gateway, parent and folder name',async()=>{
  const saved=new Map(),f=fixture({saved}),b=f.browser;await b.open();b.showCreateForm();f.typeName('same-name');f.handle((entry,listing)=>entry.method==='POST'?receipt(entry,'unknown'):listing(entry.route));await b.createDirectory();
  const other=fixture({saved,origin:'https://other-gateway.test'});await other.browser.open();other.browser.showCreateForm();other.typeName('same-name');assert.equal(other.browser.folderCreate.disabled,false);
  await b.navigate('/another-parent');b.showCreateForm();f.typeName('same-name');assert.equal(b.folderCreate.disabled,false);
  await b.navigate(parent);b.showCreateForm();f.typeName('different-name');assert.equal(b.folderCreate.disabled,false);assert.equal(f.writes().length,1);
});

test('stale navigation success and failure cannot overwrite a later directory or clear its loading state',async()=>{
  for(const fail of [false,true]){
    const f=fixture(),b=f.browser;await b.open();const stale=deferred(),latest=deferred();
    f.handle((entry,listing)=>entry.route.endsWith('%2Fold')?stale.promise:entry.route.endsWith('%2Fnew')?latest.promise:listing(entry.route));
    const old=b.navigate('/old'),oldSignal=f.requests.at(-1).signal,newer=b.navigate('/new');assert.equal(oldSignal.aborted,true);
    if(fail)stale.reject(Error('旧目录失败'));else stale.resolve({path:'/old',parent:'/',directories:[{name:'stale',path:'/old/stale'}]});
    await old;assert.equal(b.loading,true);assert.equal(b.list.getAttribute('aria-busy'),'true');assert.equal(b.selectButton.disabled,true);assert.equal(b.error.textContent,'');
    latest.resolve({path:'/new',parent:'/',directories:[]});await newer;assert.equal(b.currentPath,'/new');assert.equal(b.loading,false);assert.equal(b.error.textContent,'');
  }
});

test('navigation responses arriving after close or a context change cannot update the visible selection',async()=>{
  for(const change of ['close','context']){
    const f=fixture(),b=f.browser;await b.open();const late=deferred();f.handle(()=>late.promise);const pending=b.navigate('/old-context');
    if(change==='close')b.close();else f.setContext({key:'other-chat',cwd:'/other'});
    const snapshot=visible(b);late.resolve({path:'/old-context',parent:'/',directories:[{name:'wrong',path:'/wrong'}]});await pending;
    assert.deepEqual(visible(b),snapshot);assert.equal(b.input.value,parent);assert.deepEqual(f.selected,[]);
  }
});

for(const outcome of ['completed','failed','disconnect'])test(`stale ${outcome} write cannot mutate a reopened browser or another context`,async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('old-folder');const old=deferred();let submitted;
  f.handle((entry,listing)=>{if(entry.method==='POST'){submitted=entry;return old.promise;}return listing(entry.route);});
  const pending=b.createDirectory();b.close();f.setContext({key:'other-context',cwd:'/new-context',contextId:'other-chat'});b.input.value='/new-context';await b.open();
  const snapshot=visible(b),requestCount=f.requests.length;
  if(outcome==='disconnect')old.reject(Error('旧请求断线'));else old.resolve(receipt(submitted,outcome,{message:'旧请求消息'}));await pending;
  assert.deepEqual(visible(b),snapshot);assert.equal(f.requests.length,requestCount);assert.equal(b.input.value,'/new-context');assert.deepEqual(f.selected,[]);
});

test('finally from an old write cannot clear the busy state of a new write',async()=>{
  const f=fixture(),b=f.browser;await b.open();const old=deferred(),current=deferred();let oldEntry,currentEntry;
  f.handle((entry,listing)=>{
    if(entry.method==='POST'){if(!oldEntry){oldEntry=entry;return old.promise;}currentEntry=entry;return current.promise;}return listing(entry.route);
  });
  b.showCreateForm();f.typeName('old-write');const pendingOld=b.createDirectory();b.close();await b.open();b.showCreateForm();f.typeName('new-write');const pendingNew=b.createDirectory();
  old.resolve(receipt(oldEntry,'completed'));await pendingOld;assert.equal(b.writing,true);assert.equal(b.activeAttempt.id,currentEntry.body.id);assert.equal(b.folderCreate.disabled,true);assert.equal(b.selectButton.disabled,true);
  current.resolve(receipt(currentEntry,'completed'));await pendingNew;assert.equal(b.writing,false);assert.equal(b.currentPath,parent+'/new-write');assert.equal(f.writes().length,2);
});

test('a late root listing cannot replace shortcuts from a newly opened context',async()=>{
  const f=fixture(),b=f.browser,oldRoots=deferred(),newRoots=deferred();let rootRequests=0;
  f.handle((entry,listing)=>entry.route==='/api/project-directories?path='?(++rootRequests===1?oldRoots.promise:newRoots.promise):listing(entry.route));
  await b.open();b.close();f.setContext({key:'new-context',cwd:'/other-context'});b.input.value='/other-context';await b.open();
  newRoots.resolve({path:'',parent:null,directories:[{name:'New home',path:'/new-home'},{name:'New disk',path:'E:\\'}]});await flush();
  const snapshot=visible(b);oldRoots.resolve({path:'',parent:null,directories:roots});await flush();assert.deepEqual(visible(b),snapshot);
});

test('creation completion waiting on a directory read cannot set success text in a reopened context',async()=>{
  const f=fixture(),b=f.browser;await b.open();b.showCreateForm();f.typeName('old-created');const late=deferred();
  f.handle((entry,listing)=>entry.method==='POST'?receipt(entry):entry.route.endsWith('%2Fold-created')?late.promise:listing(entry.route));
  const pending=b.createDirectory();await flush();assert.equal(b.loading,true);b.close();f.setContext({key:'new-context',cwd:'/new-context'});b.input.value='/new-context';await b.open();
  const snapshot=visible(b);late.resolve({path:parent+'/old-created',parent,directories:[]});await pending;assert.deepEqual(visible(b),snapshot);
});
