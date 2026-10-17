'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web/features/chat/sidebar-management.js'),'utf8');

// A small DOM double: no browser, app bootstrap, storage or network is loaded.
class Element {
  constructor(tag){
    this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes={};
    this.className='';this.value='';this.disabled=false;this.open=false;this._text='';
  }
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
  setAttribute(key,value){this.attributes[key]=value;}
  showModal(){assert.equal(this.open,false);this.open=true;}
  close(){this.open=false;}
  focus(){this.focused=true;}
  matches(selector){
    if(selector==='summary[data-project-key]')return this.tagName==='SUMMARY'&&this.dataset.projectKey!==undefined;
    if(selector==='.sidebar-section > summary')return this.tagName==='SUMMARY'&&
      this.parentElement?.className.split(' ').includes('sidebar-section');
    return this.tagName===selector.toUpperCase();
  }
  closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
  all(tag){return this.children.flatMap(child=>[...(child.tagName===tag.toUpperCase()?[child]:[]),...child.all(tag)]);}
}

function sidebar(){
  return {sections:[
    {id:'a',name:'Alpha',itemKeys:['codex:project:p']},
    {id:'b',name:'Beta',itemKeys:[]},
    {id:'c',name:'Gamma',itemKeys:[]}
  ],projects:[
    {key:'local|p',host:'local',name:'Project',cwd:'D:/workspace'},
    {key:'remote|p',host:'remote',name:'Remote',cwd:'/work'}
  ],sectionOrder:['pinned','custom:c','custom:a','projects','custom:b','threads']};
}

function projectTarget(key='local|p'){
  const group=new Element('details'),summary=new Element('summary'),label=new Element('span');
  group.className='project-group';summary.dataset.projectKey=key;summary.append(label);group.append(summary);
  return label;
}
function sectionTarget(id='a'){
  const group=new Element('details'),summary=new Element('summary'),label=new Element('span');
  group.className='sidebar-section';group.dataset.section=id;summary.append(label);group.append(summary);
  return label;
}
const receipt=(status,message='',id='op-1')=>({id,status,message});
const plain=value=>JSON.parse(JSON.stringify(value));
const flush=()=>new Promise(setImmediate);

function fixture(responses=[],{data=sidebar(),contextId='desktop-context',translate,refreshError,id}={}){
  const calls=[],dialogs=[],notifications=[],refreshes=[],timers=[],events=[];
  let sequence=0,currentContext=contextId;
  const sandbox={document:{createElement:tag=>new Element(tag)},setTimeout:fn=>{timers.push(fn);return timers.length;}};
  if(translate)sandbox.BridgeI18n={t:translate};
  const context=vm.createContext(sandbox);vm.runInContext(source,context);
  const ui=new context.SidebarManagementUI({
    request:async(route,body)=>{
      calls.push({route,body:body===undefined?undefined:plain(body)});
      assert.ok(responses.length,'Unexpected request: '+route);
      const next=responses.shift();if(next instanceof Error)throw next;
      return typeof next==='function'?next(route,body):next;
    },
    dialog:title=>{
      const dialog=new Element('dialog'),close=new Element('button');dialog.title=title;
      close.type='button';close.textContent='×';close.onclick=()=>dialog.close();dialog.append(close);dialogs.push(dialog);
      return dialog;
    },
    refresh:async body=>{refreshes.push(plain(body));events.push('refresh');if(refreshError)throw refreshError;},
    snapshot:()=>data,context:()=>currentContext,uuid:()=>id||'op-'+(++sequence),
    notify:message=>{notifications.push(message);events.push('notify');}
  });
  const controls=dialog=>{
    assert.ok(dialog);const form=dialog.all('form')[0];
    return {dialog,form,input:form.all('input')[0],select:form.all('select')[0],
      submit:form.all('button').find(node=>node.type==='submit'),
      error:form.all('p').find(node=>node.className==='error')};
  };
  const open=(target,label)=>{
    const item=ui.items(target).find(row=>row.label===label);assert.ok(item,'Missing action: '+label);
    return controls(item.run());
  };
  return {ui,data,calls,dialogs,notifications,refreshes,timers,events,controls,open,
    setContext:value=>{currentContext=value;},
    create:()=>controls(ui.topActions(()=>{})[1].run()),
    submit:view=>view.form.onsubmit({preventDefault(){}}),
    async tick(){assert.ok(timers.length,'No poll scheduled');timers.shift()();await flush();}
  };
}

test('loading and constructing the global class need no DOM or app globals',()=>{
  const context=vm.createContext({});vm.runInContext(source,context);
  assert.equal(typeof context.SidebarManagementUI,'function');
  const ui=new context.SidebarManagementUI({snapshot:()=>({})});
  const openNewProject=()=>{};
  assert.deepEqual(plain(ui.topActions(openNewProject).map(row=>row.label)),['新建项目','新建分区']);
  assert.equal(ui.topActions(openNewProject)[0].run,openNewProject);
});

test('top actions open the supplied dialog without submitting or creating toolbar buttons',()=>{
  const f=fixture(),v=f.create();
  assert.equal(v.dialog.title,'新建分区');assert.equal(v.dialog.open,true);
  assert.equal(v.input.maxLength,120);assert.equal(v.input.required,true);
  assert.equal(f.calls.length,0);assert.equal(v.dialog.children[0].textContent,'×');
});

test('ordinary chats, buttons and summaries inside chat content return null',()=>{
  const f=fixture(),section=sectionTarget();
  const chat=new Element('button'),body=new Element('div'),details=new Element('details'),summary=new Element('summary');
  chat.className='session';details.append(summary);body.append(details);chat.append(body);
  section.parentElement.parentElement.append(chat);
  assert.equal(f.ui.items(chat),null);assert.equal(f.ui.items(summary),null);
  const nonButtonChat=new Element('article'),other=new Element('summary');nonButtonChat.append(other);
  section.parentElement.parentElement.append(nonButtonChat);
  assert.equal(f.ui.items(other),null);
  const createButton=new Element('button'),icon=new Element('span');createButton.append(icon);
  projectTarget().parentElement.append(createButton);
  assert.equal(f.ui.items(icon),null);assert.equal(f.ui.items(null),null);
});

test('only a section direct summary receives section actions',()=>{
  const f=fixture();
  assert.deepEqual(plain(f.ui.items(sectionTarget()).map(row=>row.label)),['修改名称','移动顺序…','删除分区']);
  const nested=new Element('details'),summary=new Element('summary');nested.append(summary);
  sectionTarget().parentElement.parentElement.append(nested);
  assert.equal(f.ui.items(summary),null);
});

test('menus use the latest snapshot and never resurrect missing targets from DOM metadata',()=>{
  const f=fixture(),target=projectTarget();target.parentElement.dataset.projectName='Old DOM name';
  f.data.projects[0].name='Fresh name';
  const v=f.open(target,'修改名称');assert.equal(v.input.value,'Fresh name');
  f.data.projects=[];f.data.sections=[];
  assert.deepEqual(plain(f.ui.items(target)),[]);assert.deepEqual(plain(f.ui.items(sectionTarget())),[]);
});

test('project rename submits only its name and passes the completed body to refresh',async()=>{
  const f=fixture([receipt('completed')]),v=f.open(projectTarget(),'修改名称');
  assert.equal(v.form.all('input').length,1);assert.match(v.form.textContent,/关联目录保持不变/);
  v.input.value='  Renamed  ';f.setContext('fresh-desktop-context');await f.submit(v);
  const expected={id:'op-1',kind:'project',action:'rename',targetId:'local|p',name:'Renamed',contextId:'fresh-desktop-context'};
  assert.deepEqual(f.calls,[{route:'/api/sidebar-management',body:expected}]);
  assert.deepEqual(f.refreshes,[expected]);assert.deepEqual(f.events,['refresh','notify']);
  assert.equal(v.dialog.open,false);assert.deepEqual(f.notifications,['名称已修改']);
  assert.equal(f.data.projects[0].cwd,'D:/workspace');
});

test('section creation trims the name and omits targetId and null context',async()=>{
  const f=fixture([receipt('completed')],{contextId:null}),v=f.create();v.input.value='  New section  ';
  await f.submit(v);
  assert.deepEqual(f.calls[0].body,{id:'op-1',kind:'section',action:'create',name:'New section'});
  assert.equal(v.dialog.open,false);assert.deepEqual(f.refreshes,[f.calls[0].body]);
});

for(const action of ['create','rename']){
  test('section '+action+' rejects blank and oversized names before making a request',async()=>{
    const f=fixture(),v=action==='create'?f.create():f.open(sectionTarget(),'修改名称');
    for(const name of ['   ','x'.repeat(121)]){
      v.input.value=name;await f.submit(v);assert.match(v.error.textContent,/120/);
      assert.equal(v.submit.disabled,false);assert.equal(f.calls.length,0);
    }
  });
}

test('section rename accepts 120 characters and keeps its native ID',async()=>{
  const f=fixture([receipt('completed')]),v=f.open(sectionTarget(),'修改名称');v.input.value='名'.repeat(120);
  await f.submit(v);
  assert.deepEqual(f.calls[0].body,{id:'op-1',kind:'section',action:'rename',targetId:'a',name:'名'.repeat(120),contextId:'desktop-context'});
});

for(const destination of ['b','','pinned']){
  test('project move sends exactly one section destination: '+(destination||'none'),async()=>{
    const f=fixture([receipt('completed')]),v=f.open(projectTarget(),'移动到分区…');
    assert.deepEqual(v.select.children.map(option=>option.value),['','pinned','c','a','b']);
    assert.equal(v.select.value,'a');v.select.value=destination;await f.submit(v);
    assert.deepEqual(f.calls[0].body,{id:'op-1',kind:'project',action:'move',targetId:'local|p',
      sectionId:destination||null,contextId:'desktop-context'});
    assert.deepEqual(f.refreshes,[f.calls[0].body]);
  });
}

test('remote rename, move and delete are disabled and guarded even if run is invoked directly',()=>{
  const f=fixture(),rows=f.ui.items(projectTarget('remote|p'));
  assert.equal(rows.every(row=>row.disabled===true),true);
  assert.ok(rows.some(row=>row.label==='远程项目暂不支持侧栏管理。'));
  for(const row of rows.slice(0,3))assert.equal(row.run(),null);
  assert.equal(f.dialogs.length,0);assert.equal(f.calls.length,0);
  assert.equal(f.notifications.every(message=>message.includes('远程项目暂不支持')),true);
});

for(const before of ['c','']){
  test('section move chooses a custom section before which to move or the end: '+(before||'end'),async()=>{
    const f=fixture([receipt('completed')]),v=f.open(sectionTarget(),'移动顺序…');
    assert.deepEqual(v.select.children.map(option=>option.value),['c','b','']);
    assert.equal(v.select.value,'b');v.select.value=before;await f.submit(v);
    assert.deepEqual(f.calls[0].body,{id:'op-1',kind:'section',action:'move',targetId:'a',beforeId:before||null,contextId:'desktop-context'});
    assert.equal('sectionId' in f.calls[0].body,false);
  });
}

for(const kind of ['project','section']){
  test(kind+' deletion explains preservation and only submits confirmed when Delete is clicked',async()=>{
    const f=fixture([receipt('completed')]),v=f.open(kind==='project'?projectTarget():sectionTarget(),kind==='project'?'删除项目':'删除分区');
    assert.equal(f.calls.length,0);assert.equal(v.submit.textContent,'删除');
    assert.match(v.form.textContent,kind==='project'?/仅移除项目记录，保留关联目录、所有文件和聊天/:/保留其中的项目和聊天，它们将回到普通列表/);
    await f.submit(v);
    assert.deepEqual(f.calls[0].body,{id:'op-1',kind,action:'delete',targetId:kind==='project'?'local|p':'a',confirmed:true,contextId:'desktop-context'});
    assert.deepEqual(f.refreshes,[f.calls[0].body]);assert.equal(v.dialog.open,false);
  });
}

test('cancel and the supplied close button leave the backend untouched',()=>{
  const f=fixture(),v=f.open(projectTarget(),'删除项目');
  v.form.all('button').find(node=>node.textContent==='取消').onclick();assert.equal(v.dialog.open,false);
  const other=f.create();other.dialog.children[0].onclick();assert.equal(other.dialog.open,false);
  assert.equal(f.calls.length,0);
});

test('only a matching completed receipt closes, refreshes and notifies; pending submissions are not duplicated',async()=>{
  const operationId='id /?&';
  const f=fixture([receipt('pending','Waiting',operationId),receipt('verifying','Checking',operationId),receipt('completed','Done',operationId)],{id:operationId});
  const v=f.open(projectTarget(),'修改名称');v.input.value='New';
  const pending=f.submit(v);await flush();
  assert.equal(v.dialog.open,true);assert.equal(v.submit.disabled,true);assert.equal(v.input.disabled,true);
  assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.notifications,[]);
  await f.submit(v);assert.equal(f.calls.length,1);
  await f.tick();assert.equal(v.error.textContent,'Checking');assert.equal(v.dialog.open,true);
  assert.deepEqual(f.notifications,[]);await f.tick();await pending;
  assert.deepEqual(f.calls.map(call=>call.route),['/api/sidebar-management',
    '/api/sidebar-operations?id='+encodeURIComponent(operationId),'/api/sidebar-operations?id='+encodeURIComponent(operationId)]);
  assert.equal(f.calls.filter(call=>call.body!==undefined).length,1);
  assert.equal(v.dialog.open,false);assert.deepEqual(f.notifications,['Done']);assert.equal(f.refreshes.length,1);
});

for(const polling of [false,true]){
  test('unknown '+(polling?'poll':'receipt')+' locks submission without retry, refresh or success notification',async()=>{
    const responses=polling?[receipt('pending'),receipt('unknown','Check desktop')]:[receipt('unknown','Check desktop')];
    const f=fixture(responses),v=f.create();v.input.value='New';const pending=f.submit(v);await flush();
    if(polling)await f.tick();await pending;
    assert.equal(v.submit.disabled,true);assert.equal(v.dialog.open,true);assert.match(v.error.textContent,/Check desktop/);
    assert.match(v.error.textContent,/结果未知/);await f.submit(v);
    assert.equal(f.calls.filter(call=>call.body).length,1);assert.equal(f.timers.length,0);
    assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.notifications,[]);
    v.dialog.close();const reopened=f.create();reopened.input.value='New';await f.submit(reopened);
    assert.equal(reopened.submit.disabled,true);assert.match(reopened.error.textContent,/结果未知/);
    assert.equal(f.calls.filter(call=>call.body).length,1);
  });
}

for(const polling of [false,true]){
  test((polling?'poll':'POST')+' disconnection is unknown and never replays the write',async()=>{
    const responses=polling?[receipt('pending'),Error('Disconnected')]:[Error('Disconnected')];
    const f=fixture(responses),v=f.open(projectTarget(),'删除项目'),pending=f.submit(v);await flush();
    if(polling)await f.tick();await pending;
    assert.equal(v.submit.disabled,true);assert.equal(v.dialog.open,true);assert.match(v.error.textContent,/Disconnected/);
    assert.match(v.error.textContent,/结果未知/);await f.submit(v);
    assert.equal(f.calls.filter(call=>call.body).length,1);assert.equal(f.timers.length,0);
    assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.notifications,[]);
  });
}

test('failed receipt displays the error and permits only an explicit new attempt with a new ID',async()=>{
  const f=fixture([receipt('failed','Native rejected'),receipt('completed','','op-2')]),v=f.create();v.input.value='New';
  await f.submit(v);await flush();
  assert.equal(v.dialog.open,true);assert.equal(v.submit.disabled,false);assert.equal(v.error.textContent,'Native rejected');
  assert.equal(f.calls.length,1);assert.equal(f.timers.length,0);assert.deepEqual(f.notifications,[]);
  await f.submit(v);assert.equal(f.calls.length,2);assert.equal(f.calls[1].body.id,'op-2');
  assert.equal(v.dialog.open,false);assert.equal(f.refreshes.length,1);
});

for(const invalid of [null,{},receipt('completed','','wrong-id'),{id:'op-1'}]){
  test('invalid or mismatched receipt stays unknown: '+JSON.stringify(invalid),async()=>{
    const f=fixture([invalid]),v=f.create();v.input.value='New';await f.submit(v);await f.submit(v);
    assert.equal(v.submit.disabled,true);assert.equal(v.dialog.open,true);assert.match(v.error.textContent,/回执无效/);
    assert.equal(f.calls.length,1);assert.deepEqual(f.refreshes,[]);assert.deepEqual(f.notifications,[]);
  });
}

test('a refresh failure after completed cannot be mistaken for an unknown write or submitted again',async()=>{
  const f=fixture([receipt('completed')],{refreshError:Error('List offline')}),v=f.create();v.input.value='New';
  await f.submit(v);await f.submit(v);
  assert.equal(v.dialog.open,false);assert.equal(f.calls.length,1);assert.equal(f.refreshes.length,1);
  assert.match(f.notifications[0],/操作已完成，但列表刷新失败：List offline/);
});

test('a second dialog cannot submit the same operation while the first one is pending',async()=>{
  const f=fixture([receipt('pending'),receipt('completed')]),v=f.open(projectTarget(),'修改名称');
  v.input.value='New';const pending=f.submit(v);await flush();v.dialog.close();
  const other=f.open(projectTarget(),'修改名称');other.input.value='Duplicate';await f.submit(other);
  assert.equal(other.submit.disabled,true);assert.equal(f.calls.length,1);
  await f.tick();await pending;assert.equal(f.refreshes.length,1);assert.equal(f.calls.filter(call=>call.body).length,1);
});

for(const kind of ['project','section']){
  test('a '+kind+' removed after menu creation is refused when its action runs',()=>{
    const f=fixture(),target=kind==='project'?projectTarget():sectionTarget(),rows=f.ui.items(target);
    f.data[kind==='project'?'projects':'sections']=[];
    assert.equal(rows[0].run(),null);assert.equal(f.dialogs.length,0);assert.equal(f.calls.length,0);
    assert.match(f.notifications[0],/已被删除/);
  });
  for(const [label,action] of [['修改名称','rename'],[kind==='project'?'移动到分区…':'移动顺序…','move'],[kind==='project'?'删除项目':'删除分区','delete']]){
    test('a '+kind+' removed while the '+action+' form is open is refused before POST',async()=>{
      const f=fixture(),v=f.open(kind==='project'?projectTarget():sectionTarget(),label);
      if(v.input)v.input.value='Changed';f.data[kind==='project'?'projects':'sections']=[];await f.submit(v);
      assert.equal(f.calls.length,0);assert.equal(v.dialog.open,true);assert.match(v.error.textContent,/已被删除/);
    });
  }
}

for(const kind of ['project','section']){
  test('a removed move destination is refused for '+kind,async()=>{
    const f=fixture(),v=f.open(kind==='project'?projectTarget():sectionTarget(),kind==='project'?'移动到分区…':'移动顺序…');
    v.select.value='b';f.data.sections=f.data.sections.filter(row=>row.id!=='b');await f.submit(v);
    assert.equal(f.calls.length,0);assert.match(v.error.textContent,/目标分区已被删除/);
  });
}

const builtins=['pinned','projects','threads','orbit','agents','chats','builtin:custom'];
for(const id of builtins){
  test('builtin '+id+' exposes no section management and is excluded from ordering and project destinations',async()=>{
    const f=fixture();f.data.sections.push({id,name:'Builtin',itemKeys:[]});
    assert.deepEqual(plain(f.ui.items(sectionTarget(id))),[]);
    const section=f.open(sectionTarget(),'移动顺序…');
    assert.equal(section.select.children.some(option=>option.value===id),false);
    section.select.value=id;await f.submit(section);assert.equal(f.calls.length,0);
    const project=f.open(projectTarget(),'移动到分区…');
    assert.equal(project.select.children.filter(option=>option.value===id).length,id==='pinned'?1:0);
    if(id!=='pinned'){project.select.value=id;await f.submit(project);assert.equal(f.calls.length,0);}
  });
}

test('a section changing to builtin after opening is refused; a section cannot move before itself',async()=>{
  const f=fixture(),v=f.open(sectionTarget(),'删除分区');f.data.sections[0].builtin=true;await f.submit(v);
  assert.equal(f.calls.length,0);assert.match(v.error.textContent,/内置分区/);
  f.data.sections[0].builtin=false;const move=f.open(sectionTarget(),'移动顺序…');move.select.value='a';await f.submit(move);
  assert.equal(f.calls.length,0);assert.match(move.error.textContent,/目标分区/);
});

test('changed project host is refused before writing',async()=>{
  const f=fixture(),v=f.open(projectTarget(),'移动到分区…');f.data.projects[0].host='remote';await f.submit(v);
  assert.equal(f.calls.length,0);assert.match(v.error.textContent,/已变化/);
});

test('static UI uses optional BridgeI18n while names, paths and backend messages remain literal',async()=>{
  const translated=[];
  const f=fixture([receipt('failed','Native error')],{translate:text=>{translated.push(text);return '['+text+']';}});
  const rows=f.ui.items(projectTarget());assert.equal(rows[0].label,'[修改名称]');
  assert.deepEqual(plain(f.ui.topActions(()=>{}).map(row=>row.label)),['[新建项目]','[新建分区]']);
  const v=f.controls(rows[0].run());assert.equal(v.dialog.title,'[修改项目名称]');
  assert.equal(v.input.attributes['aria-label'],'[项目名称]');assert.equal(v.submit.textContent,'[保存]');
  assert.equal(v.form.all('button').find(node=>node.type==='button').textContent,'[取消]');
  assert.equal(v.input.value,'Project');assert.match(v.form.textContent,/\[关联目录：D:\/workspace\]/);
  assert.equal(translated.includes('Project'),false);assert.equal(translated.includes('D:/workspace'),false);
  v.input.value='Raw input';await f.submit(v);
  assert.equal(f.calls[0].body.name,'Raw input');assert.equal(v.error.textContent,'Native error');
  assert.equal(translated.includes('Native error'),false);
});

test('translated deletion confirmation substitutes a literal name without HTML or replacement expansion',()=>{
  const name='<b>$& {name}</b>',data=sidebar();data.projects[0].name=name;
  const f=fixture([],{data,translate:text=>text==='确认删除项目“{name}”？仅移除项目记录，保留关联目录、所有文件和聊天。'?
    'Remove {name}? Keep files and chats.':text});
  const v=f.open(projectTarget(),'删除项目');
  assert.ok(v.form.all('p').some(node=>node.textContent==='Remove '+name+'? Keep files and chats.'));
  assert.equal(v.form.all('b').length,0);
});
