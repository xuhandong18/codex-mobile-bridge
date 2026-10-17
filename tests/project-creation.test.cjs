'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function fixture(responses){
  const nodes=[],timers=[],requests=[],toasts=[];
  const node=tag=>{
    const n={tagName:tag.toUpperCase(),children:[],textContent:'',value:'',disabled:false,open:false,
      append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},setAttribute(){},
      addEventListener(){},focus(){},showModal(){this.open=true;},close(){this.open=false;},
      querySelectorAll(){return nodes.filter(n=>['INPUT','SELECT','BUTTON'].includes(n.tagName));}};
    nodes.push(n);return n;
  };
  const dialog=node('dialog'),list={querySelectorAll:()=>[]},controls={'list-mode':node('select'),search:node('input'),archived:node('input'),sessions:list};
  const context=vm.createContext({desktopSessions:{dialog:()=>dialog},el:(tag,cls,text)=>Object.assign(node(tag),{textContent:text||''}),
    t:s=>s,Option:function(text,value){return {text,value};},sidebarData:{sections:[]},
    currentId:null,currentHost:'local',state:null,listSource:'all',uuid:()=> 'request-uuid',
    $:id=>controls[id],loadList:async()=>{},toast:s=>toasts.push(s),
    setTimeout:fn=>timers.push(fn),api:async(route,body)=>{
      requests.push({route,body});
      if(route.includes('metadata'))return {canCreateProject:true,sections:[]};
      const response=responses.shift();if(response instanceof Error)throw response;return response;
    }});
  const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
  const start=source.indexOf('function openNewProject(){'),end=source.indexOf('let applyingNewChat=',start);
  vm.runInContext(source.slice(start,end)+'\nopenNewProject();',context);
  const form=nodes.find(n=>n.tagName==='FORM'),inputs=nodes.filter(n=>n.tagName==='INPUT').slice(-2),submit=nodes.find(n=>n.textContent==='创建项目');
  inputs[0].value='Native';inputs[1].value='D:/workspace/child';
  const flush=()=>new Promise(setImmediate);
  return {dialog,form,submit,requests,toasts,timers,flush,
    async submitForm(){const pending=form.onsubmit({preventDefault(){}});await flush();return {pending};},
    async tick(){assert.ok(timers.length);timers.shift()();await flush();}};
}

test('native creation keeps the dialog pending and only reports success after verified completion',async()=>{
  const f=fixture([{id:'request-uuid',status:'creating',message:'Confirm on desktop'},
    {id:'request-uuid',status:'completed',project:{key:'local|native'}}]);
  await f.flush();const {pending}=await f.submitForm();
  assert.equal(f.dialog.open,true);assert.equal(f.submit.disabled,true);assert.equal(f.toasts.length,0);
  await f.tick();await pending;
  assert.equal(f.dialog.open,false);assert.deepEqual(f.toasts,['项目已创建']);
  assert.equal(f.requests.filter(x=>x.body).length,1);
  assert.ok(f.requests.some(x=>x.route==='/api/project-operations?id=request-uuid'));
});

test('unknown native outcome leaves creation disabled instead of offering an unsafe retry',async()=>{
  const f=fixture([{id:'request-uuid',status:'unknown',message:'Check desktop'}]);
  await f.flush();const {pending}=await f.submitForm();await pending;
  assert.equal(f.dialog.open,true);assert.equal(f.submit.disabled,true);assert.equal(f.toasts.length,0);
  await f.submitForm();assert.equal(f.requests.filter(x=>x.body).length,1);
});

test('polling failure does not submit the write again or announce success',async()=>{
  const f=fixture([{id:'request-uuid',status:'creating',message:'Waiting'},Error('Disconnected')]);
  await f.flush();const {pending}=await f.submitForm();await f.tick();await pending;
  assert.equal(f.submit.disabled,true);assert.equal(f.toasts.length,0);
  assert.equal(f.requests.filter(x=>x.body).length,1);
});
