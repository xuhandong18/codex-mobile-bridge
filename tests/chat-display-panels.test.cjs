'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
  constructor(tag='div',classes='',text=''){Object.assign(this,{tagName:tag,className:classes,textContent:text,dataset:{},children:[],hidden:false,scrollTop:0,scrollHeight:100,clientHeight:100,classList:{toggle(){}}});}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
}
function fixture(provider='codex'){
  const document={documentElement:{dataset:{showProcess:'false',showReasoning:'true'}}};
  const context=vm.createContext({document,AbortController,BridgeI18n:{t:text=>text},renderMarkdown:(node,text)=>node.textContent=text});
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
test('Codex and Harness side chats honor process and reasoning independently through live updates',()=>{
  for(const provider of ['codex','deepseek']){
    const {panel,document,messages}=fixture(provider),state={id:'child',connected:true,turns:[{messages}],requests:[{id:'approval'}]};
    panel.apply(state);
    const visible=()=>Array.from(panel.messageNodes.filter(({node})=>!node.hidden),({message})=>message.text);
    assert.deepEqual(visible(),['question','summary','answer','failure']);assert.equal(panel.requests.length,1);
    document.documentElement.dataset.showReasoning='false';panel.applyVisibility();
    assert.deepEqual(visible(),['question','answer','failure']);
    panel.apply({...state,turns:[{messages:[...messages,{role:'activity',kind:'commandExecution',text:'streaming'}]}]});
    assert.deepEqual(visible(),['question','answer','failure']);
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
  assert.deepEqual(Array.from(agent.messageNodes.filter(({node})=>!node.hidden),({message})=>message.role),['user','assistant','error']);
  assert.equal(Panel.messageVisible({role:'activity',kind:'reasoning',text:''}),false);
});
