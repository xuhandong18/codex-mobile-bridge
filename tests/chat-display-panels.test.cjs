'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
  constructor(tag='div',classes='',text=''){Object.assign(this,{tagName:tag,className:classes,textContent:text,dataset:{},children:[],hidden:false,scrollTop:0,scrollHeight:100,clientHeight:100,classList:{toggle(){}}});}
  append(...nodes){for(const node of nodes){node.remove();node.parentElement=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of [...this.children])node.remove();this.append(...nodes);}
  get firstChild(){return this.children[0]||null;}
  get nextSibling(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1]||null;}
  remove(){if(this.parentElement){const children=this.parentElement.children;children.splice(children.indexOf(this),1);this.parentElement=null;}}
  insertBefore(node,before){node.remove();node.parentElement=this;const at=this.children.indexOf(before);this.children.splice(at<0?this.children.length:at,0,node);}
  querySelector(tag){for(const node of this.children){if(node.tagName===tag)return node;const found=node.querySelector(tag);if(found)return found;}return null;}
}
function fixture(provider='codex'){
  const document={documentElement:{dataset:{showProcess:'false',showReasoning:'true'}}};
  const context=vm.createContext({document,AbortController,BridgeI18n:{t:text=>text},renderMarkdown:(node,text)=>node.textContent=text});
  vm.runInContext(fs.readFileSync('web/features/chat/message-groups.js','utf8'),context);
  for(const file of ['side-chat','agents-panel'])vm.runInContext(fs.readFileSync('web/features/workspace/'+file+'.js','utf8'),context);
  const Panel=vm.runInContext('SideChatPanel',context),panel=Object.create(Panel.prototype);
  const messages=[{role:'user',text:'question'},{role:'assistant',phase:'commentary',text:'progress'},
    {role:'activity',kind:'commandExecution',title:'command',text:'output'},
    {role:'activity',kind:'fileChange',title:'changes',text:'diff'},
    {role:'activity',kind:'reasoning',title:'reasoning',text:'summary'},
    {role:'assistant',phase:'final_answer',text:'answer'},{role:'error',text:'failure'}];
  Object.assign(panel,{session:{provider},tab:{body:new Element()},workbench:{node:(...args)=>new Element(...args),setSideChatTitle:()=>false},
    contextUsage:{update(){}},attachments:{key:'child'},modelButton:new Element(),permissionsButton:new Element(),workMode:{},status:new Element(),messages:new Element(),
    updateCaption(){},renderApprovals(rows){this.requests=rows;},renderQueue(){},controls(){}});
  return {panel,Panel,context,document,messages};
}
test('文字进度在关闭工具详情后仍可阅读',()=>{
  const {Panel}=fixture();
  assert.equal(Panel.messageVisible({role:'assistant',phase:'commentary',text:'正在核对运行状态'}),true);
});
test('交替的文字进度和工具段严格保留实际时序',()=>{
  const {panel,document}=fixture();document.documentElement.dataset.showProcess='true';
  const messages=[{id:'q',role:'user',text:'开始'},
    {id:'p1',role:'assistant',phase:'commentary',text:'第一段进度'},
    {id:'c1',role:'activity',kind:'commandExecution',text:'第一条命令'},
    {id:'f1',role:'activity',kind:'fileChange',text:'第一次变更'},
    {id:'p2',role:'assistant',phase:'commentary',text:'第二段进度'},
    {id:'t1',role:'activity',kind:'mcpToolCall',text:'工具调用'},
    {id:'r',role:'activity',kind:'reasoning',text:'摘要'},
    {id:'c2',role:'activity',kind:'commandExecution',text:'第二条命令'},
    {id:'p3',role:'assistant',phase:'commentary',text:'第三段进度'}];
  panel.apply({id:'child',connected:true,turns:[{id:'turn',status:'inProgress',messages}],requests:[]});
  const order=[],rows=new Map(panel.messageNodes.map(({node,message})=>[node,message.id]));
  const walk=node=>{if(rows.has(node))order.push(rows.get(node));else for(const child of node.children)walk(child);};walk(panel.messages);
  assert.deepEqual(order,messages.map(message=>message.id));
  assert.equal(panel.messages.children.filter(node=>node.className.includes('chat-progress-group')).length,3);
  assert.equal(panel.messages.children.filter(node=>node.className.includes('chat-process-group')).length,2);
});
test('文字进度以首条正文作为折叠点击行，不额外渲染文字进度标题或复制正文',()=>{
  const {panel}=fixture(),messages=[{id:'p1',role:'assistant',phase:'commentary',text:'正在检查第一步\n这是后续正文'},
    {id:'p2',role:'assistant',phase:'commentary',text:'第二条相邻进度'}];
  panel.apply({id:'child',connected:true,turns:[{id:'turn',status:'inProgress',messages}],requests:[]});
  const group=panel.messageGroups.get('group:progress:turn'),summary=group.querySelector('summary');
  assert.equal(summary.children[0],panel.messageNodes[0].node);
  assert.equal(summary.textContent,'');assert.equal(summary.dataset.i18n,undefined);
  assert.equal(group.children[1].children[0],panel.messageNodes[1].node);
});
test('本轮中断失败时即使已有最终消息也保留展开的文字进度',()=>{
  for(const status of [undefined,'inProgress','interrupted','failed','cancelled','stopped']){
    const {panel,messages}=fixture();
    panel.apply({id:'child',connected:true,turns:[{id:'turn',status,messages}],requests:[]});
    assert.equal(panel.messageGroups.get('group:progress:turn').open,true,status);
  }
});
test('补读同一段更早的进度时保留原折叠状态和节点',()=>{
  const {panel}=fixture(),p1={id:'p1',role:'assistant',phase:'commentary',text:'更早进展'},p2={id:'p2',role:'assistant',phase:'commentary',text:'当前进展'};
  const state={id:'child',connected:true,turns:[{id:'turn',status:'inProgress',messages:[p2]}],requests:[]};
  panel.apply(state);const progress=panel.messageGroups.get('group:progress:turn');progress.open=false;
  panel.apply({...state,turns:[{id:'turn',status:'inProgress',messages:[p1,p2]}]});
  assert.equal(panel.messageGroups.get('group:progress:turn'),progress);assert.equal(progress.open,false);
});
test('Codex and Harness side chats honor process and reasoning independently through live updates',()=>{
  for(const provider of ['codex','deepseek']){
    const {panel,document,messages}=fixture(provider),state={id:'child',connected:true,turns:[{messages}],requests:[{id:'approval'}]};
    panel.apply(state);
    const visible=()=>Array.from(panel.messageNodes.filter(({node})=>!node.hidden),({message})=>message.text);
    assert.deepEqual(visible(),['question','progress','answer','failure']);assert.equal(panel.requests.length,1);
    document.documentElement.dataset.showReasoning='false';panel.applyVisibility();
    assert.deepEqual(visible(),['question','progress','answer','failure']);
    panel.apply({...state,turns:[{messages:[...messages,{role:'activity',kind:'commandExecution',text:'streaming'}]}]});
    assert.deepEqual(visible(),['question','progress','answer','failure']);
    document.documentElement.dataset.showProcess='true';panel.applyVisibility();
    assert.equal(visible().length,7);assert.ok(visible().includes('streaming'));
  }
});
test('saved subagent records obey the same filter without reloading or suppressing errors',async()=>{
  const {Panel,context,document,messages}=fixture(),Agents=vm.runInContext('AgentsPanel',context),agent=Object.create(Agents.prototype);
  Object.assign(agent,{selected:{id:'child'},detail:new Element(),node:(...args)=>new Element(...args),url:()=>'/fixture',
    workbench:{request:async()=>({turns:[{messages,status:'completed'}],historyComplete:true})}});
  await agent.readDetail();assert.equal(agent.messageNodes.filter(({node})=>!node.hidden).length,4);
  document.documentElement.dataset.showReasoning='false';agent.applyVisibility();
  assert.deepEqual(Array.from(agent.messageNodes.filter(({node})=>!node.hidden),({message})=>message.role),['user','assistant','assistant','error']);
  assert.equal(Panel.messageVisible({role:'activity',kind:'reasoning',text:''}),false);
});
test('侧边聊天按轮分组，结束时只自动收起文字进度，刷新保留手动展开',()=>{
  const {panel,document,messages}=fixture();document.documentElement.dataset.showProcess='true';
  const active=messages.filter(message=>message.phase!=='final_answer'),state={id:'child',connected:true,turns:[{id:'turn',status:'inProgress',messages:active}],requests:[]};
  panel.apply(state);
  const progress=()=>panel.messageGroups.get('group:progress:turn'),process=()=>panel.messageGroups.get('group:process:turn');
  assert.equal(progress().open,true);assert.equal(process().open,false);
  process().open=true;const command=panel.messageNodes.find(({message})=>message.kind==='commandExecution');command.node.querySelector('details').open=true;
  panel.apply({...state,turns:[{id:'turn',status:'inProgress',messages:[...active,{role:'assistant',phase:'commentary',text:'新进展'}]}]});
  assert.equal(progress().open,true);assert.equal(process().open,true);
  assert.equal(panel.messageNodes.find(({message})=>message.kind==='commandExecution').node.querySelector('details').open,true);
  panel.apply({...state,turns:[{id:'turn',status:'completed',messages}]});
  assert.equal(progress().open,false);assert.equal(process().open,true);
  progress().open=true;panel.apply({...state,connected:false,turns:[{id:'turn',status:'completed',messages}]});assert.equal(progress().open,true);
  panel.apply({...state,turns:[{id:'next',status:'inProgress',messages:active}]});
  assert.equal(panel.messageGroups.get('group:progress:next').open,true);
  assert.equal(panel.messageGroups.get('group:process:next').open,false);
});
test('子任务记录刷新时收起已结束的进度并保留工具详情，空历史不残留旧记录',async()=>{
  const {context,document,messages}=fixture();document.documentElement.dataset.showProcess='true';
  const Agents=vm.runInContext('AgentsPanel',context),agent=Object.create(Agents.prototype);
  let result={turns:[{id:'turn',status:'inProgress',messages:messages.filter(message=>message.phase!=='final_answer')}],historyComplete:true};
  Object.assign(agent,{selected:{id:'child'},detail:new Element(),node:(...args)=>new Element(...args),url:()=>'/fixture',workbench:{request:async()=>result}});
  await agent.readDetail();const progress=()=>agent.messageGroups.get('group:progress:turn'),process=()=>agent.messageGroups.get('group:process:turn');
  assert.equal(progress().open,true);assert.equal(process().open,false);process().open=true;
  agent.messageNodes.find(({message})=>message.kind==='commandExecution').node.querySelector('details').open=true;
  result={...result,turns:[{id:'turn',status:'completed',messages}]};await agent.readDetail();
  assert.equal(progress().open,false);assert.equal(process().open,true);
  assert.equal(agent.messageNodes.find(({message})=>message.kind==='commandExecution').node.querySelector('details').open,true);
  result={turns:[],historyComplete:true};await agent.readDetail();assert.equal(agent.recordBody.children.length,0);
});
