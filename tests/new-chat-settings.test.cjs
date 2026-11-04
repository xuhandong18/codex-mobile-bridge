'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

class Element{
  constructor(tag='div'){this.tag=tag;this.children=[];this.dataset={};this.disabled=false;this._value='';}
  append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}if(this.tag==='select'&&!this.children.some(n=>n.value===this._value))this._value=this.children[0]?.value||'';}
  replaceChildren(...nodes){this.children=[];this._value='';this.append(...nodes);}
  before(){}
  setAttribute(name,value){this[name]=value;}
  get value(){return this._value;}
  set value(value){this._value=this.tag==='select'&&!this.children.some(n=>n.value===value)?'':value;}
}
function fixture(saved={}){
  const pending=[],values=new Map([['new-chat-defaults:local|desktop',JSON.stringify(saved)]]);
  const context=vm.createContext({AbortController,setTimeout,clearTimeout,BridgeI18n:{t:x=>x},localStorage:{getItem:key=>values.get(key)||null},
    document:{createElement:tag=>new Element(tag)},Option:function(label,value){const node=new Element('option');node.textContent=label;node.value=value;return node;}});
  vm.runInContext(fs.readFileSync('web/features/chat/context-menu.js','utf8'),context);
  const Settings=vm.runInContext('NewChatSettings',context),settings=new Settings({querySelector:()=>new Element()},{
    scope:(project,kind)=>project.split('|')[0]+'|'+kind,request:(url,_body,signal)=>new Promise((resolve,reject)=>pending.push({url,resolve,reject,signal}))});
  return {settings,pending};
}
const catalog={models:[{id:'fast',name:'Fast',efforts:['low','high'],defaultEffort:'low'}]};

test('首次模型请求未返回时，默认设置、权限和自定义模型可直接使用',async()=>{
  const {settings:s,pending}=fixture(),load=s.load('local|p','desktop');
  assert.equal(s.model.disabled,false);assert.equal(s.permission.disabled,false);
  assert.deepEqual({...s.value()},{model:'',effort:'',permission:''});
  s.model.value='__custom__';s.model.onchange();s.custom.value='my-model';s.effort.value='high';s.permission.value='ask';
  pending[0].resolve(catalog);await load;
  assert.deepEqual({...s.value()},{model:'my-model',effort:'high',permission:'ask'});
  assert.equal(s.model.children.some(n=>n.value==='fast'),true);
});

test('记住的模型、思考程度和权限立即恢复，后台补齐目录后保持选择',async()=>{
  const saved={model:'fast',effort:'high',permission:'auto-review'},{settings:s,pending}=fixture(saved);
  const load=s.load('local|p','desktop');assert.deepEqual({...s.value()},saved);assert.equal(s.effort.disabled,false);
  pending[0].resolve(catalog);await load;assert.deepEqual({...s.value()},saved);assert.equal(s.model.value,'fast');
});

test('模型目录失败仍可用默认设置和自定义模型，切换项目忽略旧回包',async()=>{
  const {settings:s,pending}=fixture();const first=s.load('local|p','desktop'),second=s.load('remote|p','cli');
  pending[1].reject(Error('offline'));await second;
  assert.equal(s.model.disabled,false);assert.equal(s.permission.disabled,false);
  s.model.value='__custom__';s.model.onchange();s.custom.value='remote-model';s.permission.value='full-access';
  pending[0].resolve(catalog);await first;
  assert.deepEqual({...s.value()},{model:'remote-model',effort:'medium',permission:'full-access'});
  assert.equal(s.model.children.some(n=>n.value==='fast'),false);
});

for(const failure of ['network','catalog','empty'])test('模型目录失败可见且能重试补齐全部模型：'+failure,async()=>{
  const saved={model:'saved',effort:'high',permission:'auto-review'},{settings:s,pending}=fixture(saved);
  const load=s.load('local|p','desktop');
  if(failure==='network')pending[0].reject(Error('连接失败'));
  else pending[0].resolve({models:[],...failure==='catalog'?{modelError:'上游暂时不可用'}:{}});
  await load;
  assert.match(s.catalogStatus?.textContent||'',/失败|不可用/,'不能静默留下一个默认模型');
  assert.equal(s.retry?.hidden,false,'提供读取目录的重试入口');
  const retry=s.retry.onclick();assert.equal(pending.length,2);
  pending[1].resolve({models:[...catalog.models,{id:'saved',name:'Saved',efforts:['high']}]});await retry;
  assert.deepEqual(Array.from(s.model.children,node=>node.value),['','fast','saved','__custom__']);
  assert.deepEqual({...s.value()},saved,'重试保留模型、推理强度和权限');
  assert.equal(s.retry.hidden,true);
});

for(const status of [400,401,403])test('模型目录的校验和认证错误不自动重试：'+status,async()=>{
  const {settings:s,pending}=fixture(),load=s.load('local|p','desktop');
  pending[0].reject(Object.assign(Error('拒绝访问'),{status}));await load;
  assert.equal(pending.length,1);assert.equal(s.loading,false);
});

test('目录临时失败自动只读重试一次，成功后补齐列表',async()=>{
  const {settings:s,pending}=fixture({model:'saved'}),load=s.load('local|p','desktop');
  assert.match(s.catalogStatus.textContent,/正在加载/);
  pending[0].reject(Object.assign(Error('workspace routing discovery failed'),{status:409}));await new Promise(setImmediate);
  assert.equal(pending.length,2);assert.match(s.catalogStatus.textContent,/正在重试/);
  pending[1].resolve(catalog);await load;
  assert.equal(s.model.children.some(node=>node.value==='fast'),true);assert.equal(s.value().model,'saved');
});

test('自动重试有上限，关闭窗口后丢弃迟到目录',async()=>{
  const {settings:s,pending}=fixture(),load=s.load('local|p','desktop');
  pending[0].reject(Object.assign(Error('offline'),{status:503}));await new Promise(setImmediate);
  pending[1].reject(Object.assign(Error('offline'),{status:503}));await load;
  assert.equal(pending.length,2);assert.equal(s.retry.hidden,false);
  const retry=s.retry.onclick();s.cancel();assert.equal(pending[2].signal.aborted,true);
  pending[2].resolve(catalog);await retry;
  assert.equal(s.model.children.some(node=>node.value==='fast'),false);
});
