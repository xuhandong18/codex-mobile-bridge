// Synthetic API only; scripts/test-deepseek-browser.cjs loads production UI assets.
async function createDeepSeekBrowserFixture(){
  globalThis.uuid=()=>crypto.randomUUID();
  const calls=[],rows=Array.from({length:27},(_,i)=>({id:'chat-'+i,title:'项目讨论 '+i,cwd:'/fixture',model:'fixture/chat',status:'idle',updatedAt:27-i}));
  const projects=[{key:'/fixture',cwd:'/fixture',name:'共享项目',sessionIds:rows.map(r=>r.id)}],sidebar={sections:[{id:'planning',title:'规划'}],placements:{'project:/fixture':'planning'}},sides=new Map();
  const caps={sideChat:true,sidebar:true,subagents:true,models:true,effort:true,permissions:true,skills:true,attachments:true,queue:true,steer:true,send:true,workModes:true,goal:true};
  const goalChange=(state,body)=>{if(body.goalAction==='clear')state.goal=null;else if(state.goal)state.goal={...state.goal,status:body.goalAction,revision:state.goal.revision+1};};
  const workMode=(state,body)=>{if(body.workMode==='goal')state.goal={goalId:uuid(),revision:1,objective:body.text,status:'active',createdAt:Date.now(),roundsStarted:0,maxGoalRounds:256};else if(body.workMode)state.collaborationMode=body.workMode;};
  const catalog={models:[{id:'fixture/chat',name:'Fixture',efforts:['low','high'],defaultEffort:'low'}],currentModel:'fixture/chat',currentEffort:'low'};
  const request=async(url,body)=>{
    calls.push({url,body});const parsed=new URL(url,location.href),sid=parsed.searchParams.get('sessionId'),slot=parsed.searchParams.get('slot')||'',key=JSON.stringify([sid,slot]),action=parsed.pathname.split('/').at(-1);let result;
    if(action==='list')result={sessions:rows,projects,sidebar,capabilities:caps};
    else if(action==='detail')result={session:rows.find(r=>r.id===sid)||{id:sid,title:'新会话',cwd:'/fixture',status:'idle',model:'fixture/chat'},turns:rows.find(r=>r.id===sid)?.testTurns||[],capabilities:caps,connected:true,messages:[{id:'m1',role:'assistant',text:'解释共享聊天的行为',model:'fixture/chat'}]};
    else if(action==='projects')result={projects,sidebar,canCreateProjectless:true};
    else if(action==='account')result={models:catalog.models};
    else if(action==='catalog')result={...catalog,skills:[{id:'review',name:'review',description:'审查'}],capabilities:caps};
    else if(action==='workspace')result={root:'/fixture',path:'',entries:[{name:'sample.js',path:'sample.js',fullPath:'/fixture/sample.js',kind:'file'}]};
    else if(action==='side-chat'){
      let child=sides.get(key);
      if(body&&body.action!=='create'&&body.id!==child?.id)throw Error('synthetic child identity mismatch');
      if(!body)result={...(child||{id:null,connected:false,turns:[],requests:[]}),slots:[...sides].filter(([k])=>JSON.parse(k)[0]===sid).map(([k,s])=>({slot:JSON.parse(k)[1],id:s.id,title:s.title,titleRevision:s.titleRevision}))};
      else if(body.action==='create'){child={id:'side-'+uuid(),title:body.title||'',titleRevision:1,connected:true,status:'idle',cwd:'/fixture',model:'fixture/chat',effort:'low',turns:[],requests:[],submissions:[],capabilities:caps};sides.set(key,child);result=child;}
      else if(body.action==='rename'){child.title=body.title;child.titleRevision++;result=child;}
      else if(body.action==='send'){workMode(child,body);child.turns.push({turnId:'turn-'+child.turns.length,status:'completed',messages:[{role:'user',text:body.text},{role:'assistant',text:'合成回复'}]});result={status:'accepted'};}
      else if(body.action==='settings'){goalChange(child,body);result=child;}
      else if(body.action==='catalog')result=catalog;
      else if(body.action==='skills')result={skills:Array.from({length:3},(_,i)=>({name:'review-'+i,id:'review-'+i,description:'侧边技能'}))};
      else if(body.action==='close'){sides.delete(key);result={status:'accepted'};}
      else result=child;
    }else if(action==='create'){const id='created-'+uuid();rows.push({id,title:body.title||'新会话',cwd:body.projectKey||'/private/projectless',projectless:!body.projectKey,status:'idle'});result={status:'ready',result:{id}};}
    else if(action==='manage'){
      if(body.operation==='rename')rows.find(r=>r.id===body.sessionId).title=body.title;
      if(body.operation==='section-create')sidebar.sections.push({id:body.id,title:body.title});
      result={status:'accepted'};
    }else if(action==='send'){result={status:globalThis.__dsh?.unknownNextSend?'unknown':'accepted'};if(result.status==='accepted')workMode(rows.find(row=>row.id===body.sessionId),body);if(globalThis.__dsh)globalThis.__dsh.unknownNextSend=false;}
    else if(action==='settings'){goalChange(rows.find(row=>row.id===body.sessionId),body);result={status:'accepted'};}
    else if(action==='access')result={mode:'ask',options:[{value:'ask',label:'请求批准'},{value:'full-access',label:'完全访问'}]};
    else if(action==='project-directories')result={path:'/fixture',parent:'/',selectionId:'a'.repeat(64),canCreateDirectory:true,directories:[{name:'子项目',path:'/fixture/sub'}]};
    else result={status:'accepted'};
    await Promise.resolve();return JSON.parse(JSON.stringify(result));
  };
  const root=document.getElementById('app');root.hidden=false;document.getElementById('login').hidden=true;document.getElementById('bootstrap-status').hidden=true;
  const view=new DesktopSessionsView({root,select:document.getElementById('desktop-backend'),request,notify:text=>{globalThis.__lastNotice=text;},onSelect(){},csrf:()=>'',onUnauthorized(){throw Error('unexpected authentication');}});
  await view.choose('deepseek');globalThis.__dsh={view,calls,request,sides,rows,projects,sidebar};return true;
}

async function runDeepSeekPersonalBrowserTests(){
  const {view,calls,sides,rows}=globalThis.__dsh,checks=[],check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('browser state timed out');};
  check(view.listMode.value==='native','Harness defaults to native project view');
  check(view.rowsRoot.textContent.includes('规划')&&view.rowsRoot.textContent.includes('共享项目'),'shared sections contain native projects');
  check(view.rowsRoot.querySelectorAll('.session').length===5,'project begins with five chats');
  const more=()=>[...view.rowsRoot.querySelectorAll('button')].find(b=>b.textContent==='显示更多');
  more().click();check(view.rowsRoot.querySelectorAll('.session').length===15,'first expansion adds ten chats');more().click();more().click();check(view.rowsRoot.querySelectorAll('.session').length===27,'all project pages remain available');
  await view.refreshList();check(view.rowsRoot.querySelectorAll('.session').length===27,'refresh preserves expanded pages');
  view.collapseGroups();check([...view.rowsRoot.querySelectorAll('details')].every(d=>!d.open),'collapse all includes sections and projects');
  view.listStamp='';view.renderList();check([...view.rowsRoot.querySelectorAll('details')].every(d=>!d.open),'collapsed preferences survive repaint');
  await view.open('chat-0');check(view.workbench.current.access.canUseSideChat,'fresh Harness capability enables native forks');
  const readCalls=()=>calls.filter(call=>call.url.includes('/read-state')),readRow=rows.find(row=>row.id==='chat-0');
  readRow.status='active';readRow.testTurns=[{turnId:'read-one',status:'inProgress'}];await view.detail(view.generation);check(readCalls().length===0,'running chat never sends a desktop read acknowledgement');
  readRow.status='idle';readRow.testTurns=[{turnId:'read-one',status:'completed'}];await view.detail(view.generation);await wait(()=>readCalls().length===1);check(readCalls()[0].body.sessionId==='chat-0'&&readCalls()[0].body.turnId==='read-one','completion while reading synchronizes the exact native chat and turn');
  await view.detail(view.generation);check(readCalls().length===1,'repeated detail polling does not replay desktop read writes');
  view.workbench.files();readRow.testTurns=[{turnId:'read-two',status:'completed'}];await view.detail(view.generation);check(readCalls().length===1,'file browsing does not consume a new chat completion');
  view.workbench.select('chat');await view.detail(view.generation);await wait(()=>readCalls().length===2);check(readCalls()[1].body.turnId==='read-two','returning to the conversation acknowledges the newly viewed completion');
  delete readRow.testTurns;
  const workMode=view.form.querySelector('select[aria-label="工作模式"]');
  check(!!workMode&&['default','plan','goal'].every(value=>workMode.querySelector('option[value="'+value+'"]')),'Harness composer exposes normal, plan and goal work modes');
  check(workMode.getBoundingClientRect().width>0&&!workMode.disabled&&[...workMode.options].every(option=>!option.disabled),'all native work modes are visible and selectable');
  workMode.value='plan';workMode.onchange();view.input.value='先制定计划';await view.submit();await wait(()=>view.freshDetail&&!view.busy);
  check(calls.filter(call=>call.url.endsWith('/send')).at(-1).body.workMode==='plan'&&view.state.collaborationMode==='plan','plan choice is delivered to the native session');
  await view.open('chat-1');check(workMode.value==='default','another chat keeps its own work mode');await view.open('chat-0');check(workMode.value==='plan','returning to a chat restores its chosen work mode');
  workMode.value='default';workMode.onchange();view.input.value='按普通模式执行';await view.submit();await wait(()=>view.freshDetail&&!view.busy);check(view.state.collaborationMode==='default','normal mode leaves native planning');
  workMode.value='goal';workMode.onchange();view.input.value='完成原生目标验证';await view.submit();await wait(()=>view.freshDetail&&!view.busy);
  check(view.state.goal?.objective==='完成原生目标验证'&&!view.goalRoot.hidden&&workMode.value==='default'&&workMode.querySelector('[value=goal]').disabled,'accepted goal resets the selector and shows native progress');
  const composerBox=view.form.getBoundingClientRect(),modeBox=workMode.getBoundingClientRect(),sendBox=view.send.getBoundingClientRect();check(modeBox.top===sendBox.top&&modeBox.left>=composerBox.left&&sendBox.right<=composerBox.right,'work mode and send button fit on one composer row');
  await view.workModes.setStatus('paused');await wait(()=>view.freshDetail&&!view.busy);check(view.state.goal.status==='paused','goal pause goes through native settings');
  const goalWrite=calls.filter(call=>call.body?.goalAction==='paused').at(-1);check(goalWrite.body.expected.goalId===view.state.goal.goalId&&goalWrite.body.expected.revision===1,'goal controls carry native identity and revision');
  await view.workModes.setStatus('active');await wait(()=>view.freshDetail&&!view.busy);check(view.state.goal.status==='active','native goal can be resumed');
  await view.workModes.cancel();await wait(()=>view.freshDetail&&!view.busy);check(!view.state.goal&&view.goalRoot.hidden,'native goal can be cleared');
  workMode.value='plan';workMode.onchange();view.input.value='核对未知计划请求';globalThis.__dsh.unknownNextSend=true;await view.submit();await wait(()=>view.freshDetail&&!view.busy);const unknownPlan=calls.filter(call=>call.url.endsWith('/send')).at(-1).body;
  workMode.value='default';workMode.onchange();await view.submit();await wait(()=>view.freshDetail&&!view.busy);const retriedPlan=calls.filter(call=>call.url.endsWith('/send')).at(-1).body;
  check(unknownPlan.id===retriedPlan.id&&retriedPlan.workMode==='plan','unknown work-mode submissions preserve the original mode and receipt on explicit retry');
  const nativeCaps={...view.state.capabilities};view.state.capabilities={...nativeCaps,workModes:false,goal:false};view.updateComposer();check(!workMode.hidden&&workMode.querySelector('[value=plan]').disabled&&workMode.querySelector('[value=goal]').disabled,'older connectors show an explicit mode limitation');view.state.capabilities=nativeCaps;view.updateComposer();
  const first=view.workbench.createSideChat(view.workbench.current,uuid());view.workbench.select(first.id);await first.sideChat.create();check(!!first.sideChat.state.id,'first side panel creates a Harness child');
  const second=view.workbench.createSideChat(view.workbench.current,uuid());view.workbench.select(second.id);await second.sideChat.create();check(first.sideChat.state.id!==second.sideChat.state.id,'second panel owns an independent child');
  check(calls.filter(c=>c.body?.action==='create').every(c=>c.url.includes('/desktop-sessions/deepseek/side-chat')),'side creation stays on the DeepSeek route');
  const panel=first.sideChat;view.workbench.select(first.id);check(!panel.workMode.hidden&&panel.workMode.options.length===3,'side composer exposes the same three native work modes');panel.workMode.value='plan';panel.workMode.onchange();panel.input.value='侧边独立消息';panel.controls();await panel.send();check(!panel.input.value&&sides.size===2,'accepted side send clears only its draft');check(panel.state.collaborationMode==='plan','side planning is applied to its native child');
  const sent=calls.find(c=>c.body?.action==='send');check(sent.body.id===panel.state.id&&sent.body.submissionId,'side send binds native child and submission id');
  panel.workMode.value='goal';panel.workMode.onchange();panel.input.value='侧边目标';panel.controls();await panel.send();check(panel.state.goal?.objective==='侧边目标'&&!panel.goalRoot.hidden,'side goal uses native state and exposes progress');await panel.nativeModes.cancel();check(!panel.state.goal&&panel.goalRoot.hidden,'side goal controls stay on the native child');
  check(!view.state.goal,'side goal changes do not alter the parent goal');
  view.workbench.select('chat');view.input.value='主聊天草稿';view.input.oninput();
  view.workbench.selectionTargets.addText('跨会话选区');await wait(()=>document.querySelector('.file-quote-target[open]'));
  document.querySelector('.file-quote-target[open] [data-quote-target="'+second.id+'"]').click();
  check(second.sideChat.input.value.includes('> 跨会话选区')&&view.input.value==='主聊天草稿','unified selection targets isolate main and side drafts');
  view.workbench.select(first.id);const skills=await panel.loadReferences('skills',{target:panel.referenceContext(),query:'',offset:0});check(skills.items.length===3,'side reference picker uses native skill catalog');
  check(calls.at(-1).body.id===panel.state.id,'side skills stay bound to the child');
  await panel.loadReferences('files',{target:panel.referenceContext(),query:'',offset:0,path:'',hidden:false});check(calls.at(-1).url.includes('sessionId='+encodeURIComponent(panel.state.id)),'side file references use the child workspace');
  view.workbench.select('chat');view.state.status='active';view.mode.value='send';view.input.value='等当前任务结束';view.input.oninput();const before=calls.filter(c=>c.url.includes('/send')).length,pending=view.submit();
  await wait(()=>view.sendChoice?.open);check(document.activeElement.textContent==='取消','running send dialog focuses cancel');view.sendChoice.close();await pending;check(calls.filter(c=>c.url.includes('/send')).length===before&&view.input.value==='等当前任务结束','cancelling running send preserves draft and sends nothing');
  const queued=view.submit();await wait(()=>view.sendChoice?.open);[...view.sendChoice.querySelectorAll('button')].find(b=>b.textContent==='完成后发送').click();await queued;
  check(calls.filter(c=>c.url.includes('/send')).at(-1).body.mode==='queue','explicit choice queues exactly one main prompt');
  check(!calls.filter(c=>c.url.includes('/send')).at(-1).body.workMode,'queued messages inherit the running task without switching modes');
  await wait(()=>view.freshDetail&&!view.busy);view.state.status='active';view.mode.value='send';view.input.value='保留未知发送方式';view.input.oninput();globalThis.__dsh.unknownNextSend=true;const unknown=view.submit();await wait(()=>view.sendChoice?.open);[...view.sendChoice.querySelectorAll('button')].find(b=>b.textContent==='补充当前任务').click();await unknown;
  const unknownBody=calls.filter(c=>c.url.includes('/send')).at(-1).body;view.mode.value='queue';await wait(()=>view.freshDetail&&!view.busy);await view.submit();const retried=calls.filter(c=>c.url.includes('/send')).at(-1).body;
  check(unknownBody.id===retried.id&&retried.mode==='steer'&&!view.sendChoice,'an explicit retry keeps the original unknown submission id and send mode');
  const rowTarget=view.rowsRoot.querySelector('.session');const actions=view.harnessActions(rowTarget);check(actions.some(a=>a.label==='重命名聊天')&&actions.some(a=>a.label==='移动到分区'),'thread menu exposes management');
  await view.manageHarness({operation:'rename',title:'列表改名'},'chat-1');check(calls.some(c=>c.body?.operation==='rename'&&c.body.sessionId==='chat-1'),'list action can rename another row without opening it');
  view.newHarnessProject();let projectDialog=[...document.querySelectorAll('dialog[open]')].at(-1);projectDialog.querySelector('[aria-label="项目名称"]').value='浏览器项目';[...projectDialog.querySelectorAll('button')].find(b=>b.textContent==='选择文件夹').click();await wait(()=>document.querySelector('.project-folder-picker[open] .pf-footer .primary:not(:disabled)'));document.querySelector('.project-folder-picker[open] .pf-footer .primary').click();
  check(projectDialog.querySelector('[aria-label="文件夹完整路径"]').value==='/fixture','project creation reuses the shared directory picker with the DeepSeek route');projectDialog.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(()=>!projectDialog.open);
  check(calls.some(c=>c.body?.operation==='project-create'&&c.body.title==='浏览器项目'&&c.body.cwd==='/fixture'),'project submission preserves the explicitly selected directory');
  await view.createHarness();const dialog=[...document.querySelectorAll('dialog[open]')].at(-1),form=dialog.querySelector('form');check(!!form&&form.querySelector('input').value==='','new chat accepts an automatic title');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(()=>view.sid.startsWith('created-'));
  const creation=calls.find(c=>c.url.endsWith('/create'));check(creation.body.projectKey===''&&creation.body.title==='','projectless creation preserves the empty project choice');
  check(rows.find(r=>r.id===view.sid).projectless,'created projectless chat remains independent');
  await view.open('chat-0');await view.workbench.refreshSideChats();check(view.workbench.current.files.filter(t=>t.sideChat).length===2,'parent rediscovery restores all side panels');
  const frame=document.createElement('div');document.body.append(frame);const select=document.createElement('select');const other=new DesktopSessionsView({root:frame,select,request:globalThis.__dsh.request,notify(){},onSelect(){},csrf:()=>'',onUnauthorized(){}});await other.choose('deepseek');await other.open('chat-0');await other.workbench.refreshSideChats();check(other.workbench.current.files.filter(t=>t.sideChat).length===2,'a second device view discovers both shared children');const disposedSide=other.workbench.current.files.find(t=>t.sideChat).sideChat;other.clear();frame.remove();
  const beforeDisposed=calls.length;let refused=false;try{await disposedSide.request({action:'stop',id:disposedSide.state.id});}catch{refused=true;}check(refused&&calls.length===beforeDisposed,'a disposed view cannot mutate the child after logout or account changes');
  return {passed:checks.length,checks};
}
