'use strict';
// Full production page with synthetic API responses; never attaches to a real client.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),assets=require('../web/assets.json'),web=path.join(root,'web');
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const created='33333333-3333-4333-8333-333333333333';
const access={source:'cli',canSend:true,canConfigure:false,canReconnect:false};
const rows=[first,second].map((id,i)=>({id,host:'local',title:'测试会话 '+(i+1),cwd:'/fixture',projectKey:'local|independent',projectName:'独立聊天',recency:100-i,status:'idle',updatedAt:100-i,access}));
let pendingDiscovery=false,acceptSend=true,writes=0,holdDiscovery=false,releaseDiscovery;
let holdModels=false,releaseModels;const newChatAttempts=[];
let creationFixture=null;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;
 res.setHeader('Cache-Control','no-store');
 if(p.startsWith('/api/')){
  let value={};res.setHeader('Content-Type','application/json');
  if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}};
  else if(p==='/api/clients'){
   if(holdDiscovery){holdDiscovery=false;await new Promise(resolve=>releaseDiscovery=resolve);}
   value=pendingDiscovery?{pending:true,clients:[]}:{clients:['codex','claude','deepseek'].map(id=>({id,name:id,enabled:true,configured:true,connected:true,installed:true,running:true}))};
  }
  else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
  else if(p==='/api/projects')value={projects:[]};
  else if(p==='/api/new-chat-models'){
   if(holdModels)await new Promise(resolve=>releaseModels=resolve);
   value={models:[{id:'fixture-model',name:'Fixture',efforts:['low','high'],defaultEffort:'low'}]};
  }
  else if(p==='/api/sessions'&&req.method==='POST'){
   let raw='';for await(const chunk of req)raw+=chunk;newChatAttempts.push(JSON.parse(raw));
   if(creationFixture){creationFixture.exists=true;return res.end(JSON.stringify({id:created,host:'local',message:'合成创建成功'}));}
   res.writeHead(503);return res.end(JSON.stringify({error:'合成创建失败'}));
  }
  else if(p==='/api/activity'||p==='/api/sessions')value={sessions:[...rows,...(creationFixture?.exists?[{id:created,host:'local',title:'新聊天',projectKey:'local|independent',projectName:'独立聊天',recency:200,access:{source:'desktop'}}]:[])],hosts:[],sources:[],hasMore:false,complete:true};
  else if(creationFixture&&p==='/api/sessions/'+created&&url.searchParams.get('metadata')==='1'){
   const fixture=creationFixture;
   if(++fixture.discoveryReads<=2){res.writeHead(404);return res.end(JSON.stringify({error:'找不到这个会话'}));}
   await new Promise(resolve=>{fixture.releaseVisibility=resolve;fixture.waitingVisibility();});
   fixture.visible=true;value={id:created,host:'local'};
  }
  else if(creationFixture&&p.startsWith('/api/sessions/'+created+'/')&&(p.endsWith('/settings')||p.endsWith('/permissions'))){
   const fixture=creationFixture,action=p.split('/').at(-1);let raw='';for await(const chunk of req)raw+=chunk;
   if(!fixture.visible){fixture.earlyRequests.push(action);res.writeHead(404);return res.end(JSON.stringify({error:'找不到这个会话'}));}
   const body=JSON.parse(raw);fixture.writes.push({action,body});fixture.checkReady();
   if(action==='settings'){
    await new Promise(resolve=>fixture.releaseSettings=resolve);
    if(fixture.outcome==='failed'){res.writeHead(503);return res.end(JSON.stringify({error:'合成模型设置失败'}));}
    if(fixture.outcome==='confirmed'){fixture.model=body.model;fixture.effort=body.effort;}
   }else fixture.permissionMode=body.preset;
   value={confirmed:action==='permissions'||fixture.outcome==='confirmed'};
  }
  else if(p.endsWith('/timeline')||p.endsWith('/updates')||p.endsWith('/changes')){
   if(p.endsWith('/updates'))await new Promise(resolve=>setTimeout(resolve,250));
   const id=p.split('/')[3],fixture=id===created?creationFixture:null;
   if(fixture&&!fixture.visible){fixture.earlyRequests.push('history');res.writeHead(404);return res.end(JSON.stringify({error:'找不到这个会话'}));}
   if(fixture&&p.endsWith('/timeline'))await new Promise(resolve=>{fixture.releaseHistory=resolve;fixture.checkReady();});
   if(p.endsWith('/changes'))await new Promise(resolve=>setTimeout(resolve,100));
   value={epoch:'fixture',sequence:fixture?++fixture.sequence:1,rows:[],files:[],hasMore:false,meta:{id,host:'local',title:rows.find(r=>r.id===id)?.title||id,connected:true,status:'idle',requests:[],queue:[],turns:[],access:fixture?{source:'desktop'}:access,
    ...(fixture?{model:fixture.model,effort:fixture.effort,permissionMode:fixture.permissionMode}:{})}};
  }else if(creationFixture&&p==='/api/sessions/'+created+'/reconnect'){
   if(!creationFixture.visible){creationFixture.earlyRequests.push('reconnect');res.writeHead(404);return res.end(JSON.stringify({error:'找不到这个会话'}));}
   value={connected:true};
  }else if(p.startsWith('/api/desktop-sessions/')){
   const action=p.split('/').at(-1),id=url.searchParams.get('sessionId');
   if(action==='list')value={connected:true,sessions:rows,capabilities:{send:true}};
   else if(action==='detail')value={connected:true,session:{id,title:rows.find(r=>r.id===id)?.title||id,status:'idle'},capabilities:{send:true},messages:[]};
   else if(action==='send'){writes++;value={status:acceptSend?'accepted':'unknown'};}
   else if(action==='account')value={accounts:[],models:[]};
  }else if(p.endsWith('/send')){writes++;value={status:acceptSend?'accepted':'unknown'};}
  return res.end(JSON.stringify(value));
 }
 if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(fs.readFileSync(path.join(web,'index.html')));}
 let parts=assets[p];
 if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
 if(!parts){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
 res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const checks=[],errors=[];
 const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
 try{
  browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  const base='http://127.0.0.1:'+server.address().port;
  for(const width of [390,820,1280]){
   holdModels=true;releaseModels=null;
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
   if(width===820)await context.addInitScript(()=>localStorage.setItem('new-chat-defaults:'+location.origin+'|local|desktop',JSON.stringify({model:'fixture-model',effort:'high',permission:'ask'})));
   await page.goto(base);await page.locator('#new-chat').click();
   await page.waitForFunction(()=>newChatSettings.loading&&!document.querySelector('#new-chat-model').disabled);
   check(await page.locator('#new-chat-permission').isEnabled(),'首次模型目录未返回时权限可选 '+width);
   if(width===820)check(await page.evaluate(()=>JSON.stringify(newChatSettings.value()))===JSON.stringify({model:'fixture-model',effort:'high',permission:'ask'}),'已保存设置不等待模型目录即可恢复 '+width);
   else check(await page.locator('#new-chat-model').inputValue()==='','首次打开立即提供默认设置 '+width);
   const defaultAttempts=newChatAttempts.length;await page.locator('#new-chat-submit').click();
   await page.waitForFunction(()=>document.querySelector('#new-chat-error').textContent.includes('合成创建失败')&&!creatingChat);
   check(newChatAttempts.length===defaultAttempts+1,'默认或记住的设置无需等待目录即可创建 '+width);
   await page.locator('#new-chat-model').selectOption('__custom__');await page.locator('#new-chat-custom-model').fill('custom-model');
   await page.locator('#new-chat-effort').selectOption('high');await page.locator('#new-chat-permission').selectOption('ask');
   const attempts=newChatAttempts.length;await page.locator('#new-chat-submit').click();
   await page.waitForFunction(()=>document.querySelector('#new-chat-error').textContent.includes('合成创建失败')&&!creatingChat);
   check(newChatAttempts.length===attempts+1,'模型目录仍在加载时可以提交创建且只提交一次 '+width);
   assert.ok(releaseModels);holdModels=false;releaseModels();await page.waitForFunction(()=>!newChatSettings.loading);
   check(await page.evaluate(()=>JSON.stringify(newChatSettings.value()))===JSON.stringify({model:'custom-model',effort:'high',permission:'ask'}),'晚到的模型列表保留用户选择 '+width);
   await context.close();
  }
  for(const [width,outcome] of [[390,'confirmed'],[820,'confirmed'],[1280,'confirmed'],[390,'unconfirmed'],[390,'failed']]){
   const fixture=creationFixture={outcome,exists:false,visible:false,discoveryReads:0,earlyRequests:[],writes:[],model:'native-model',effort:'low',permissionMode:'auto-review',sequence:0};
   let ready;const requested=new Promise(resolve=>ready=resolve);fixture.checkReady=()=>{if(fixture.writes.length===2&&fixture.releaseHistory)ready();};
   const waitingVisibility=new Promise(resolve=>fixture.waitingVisibility=resolve);
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base);await page.locator('#new-chat').click();
   await page.waitForFunction(()=>!newChatSettings.loading);
   await page.locator('#new-chat-model').selectOption('__custom__');await page.locator('#new-chat-custom-model').fill('selected-model');
   await page.locator('#new-chat-effort').selectOption('high');await page.locator('#new-chat-permission').selectOption('ask');
   await page.locator('#new-chat-submit').click();
   await page.waitForFunction(()=>currentId==='33333333-3333-4333-8333-333333333333').catch(async error=>{
    throw Error('新聊天未打开：'+JSON.stringify({errors,ui:await page.evaluate(()=>({error:$('new-chat-error').textContent,toast:$('toast').textContent,creatingChat,currentId}))}),{cause:error});
   });
   check(await page.locator('#model-name').textContent()==='selected-model · 正在应用…','历史未返回时立即显示所选模型 '+width+' '+outcome);
   check(await page.locator('#model-effort').textContent()==='· high'&&await page.locator('#permissions-button').textContent()==='请求批准 · 正在应用…','思考程度和权限立即沿用创建表单 '+width+' '+outcome);
   let visibilityDeadline;try{await Promise.race([waitingVisibility,new Promise((_,reject)=>visibilityDeadline=setTimeout(()=>reject(Error('未等待新会话可见性')),3000))]);}finally{clearTimeout(visibilityDeadline);}
   check(fixture.discoveryReads===3&&fixture.writes.length===0&&fixture.earlyRequests.length===0,'会话连续两次不存在时只重试轻量读取，不提前连接或写设置 '+width+' '+outcome);
   check(!(await page.locator('#toast').textContent()).includes('找不到这个会话'),'暂时不可见不会弹出会话不存在 '+width+' '+outcome);
   fixture.releaseVisibility();
   let deadline;try{await Promise.race([requested,new Promise((_,reject)=>deadline=setTimeout(()=>reject(Error('设置请求被历史读取或模型确认阻塞')),3000))]);}finally{clearTimeout(deadline);}
   await page.waitForFunction(()=>applyingNewChat!==null&&state?.loadingHistory);
   check(fixture.writes.some(row=>row.action==='settings')&&fixture.writes.some(row=>row.action==='permissions'),'历史和模型确认均被阻塞时，两类设置已分别提交 '+width+' '+outcome);
   check(await page.locator('#send').isDisabled()&&await page.locator('#model-button').isDisabled()&&await page.locator('#permissions-button').isDisabled(),'等待实际确认时禁止发送和重复修改 '+width+' '+outcome);
   assert.ok(fixture.releaseHistory);fixture.releaseHistory();await page.waitForFunction(()=>state?.connected);
   check(await page.locator('#model-name').textContent()==='selected-model · 正在应用…'&&await page.evaluate(()=>state.model)==='native-model','晚到原生快照不覆盖待应用选择，也不伪造已生效状态 '+width+' '+outcome);
   assert.ok(fixture.releaseSettings);fixture.releaseSettings();await page.waitForFunction(()=>!creatingChat);
   if(outcome==='confirmed'){
    await page.waitForFunction(()=>state?.model==='selected-model'&&document.querySelector('#model-name').textContent==='selected-model');
    check(await page.locator('#model-effort').textContent()==='· high'&&await page.locator('#permissions-button').textContent()==='请求批准','确认后使用实际模型、思考程度和权限 '+width);
   }else{
    check(await page.locator('#model-name').textContent()==='native-model'&&await page.locator('#model-effort').textContent()==='· low','失败或未确认后恢复实际设置 '+outcome);
    check((await page.locator('#toast').textContent()).includes('模型和推理强度：'),'单独报告模型设置问题 '+outcome);
   }
   check(fixture.writes.filter(row=>row.action==='settings').length===1&&fixture.writes.filter(row=>row.action==='permissions').length===1,'设置写入均只提交一次 '+width+' '+outcome);
   await context.close();creationFixture=null;
  }
  for(const platform of ['MacIntel','Win32'])for(const width of [390,1280]){
   const context=await browser.newContext({viewport:{width,height:900}});
   await context.addInitScript(platform=>{Object.defineProperty(navigator,'platform',{value:platform});Object.defineProperty(navigator,'userAgentData',{value:{platform:platform==='MacIntel'?'macOS':'Windows'}});},platform);
   const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
   await page.goto(base+'/#'+first+'~local');await page.waitForFunction(()=>state?.connected);
   for(const provider of ['codex','claude','deepseek']){
    if(provider!=='codex'){
     await page.evaluate(hash=>BridgeNavigation.openChat(hash),'#'+first+'~desktop%3A'+provider);
     await page.waitForFunction(provider=>desktopSessions.provider===provider&&desktopSessions.freshDetail,provider);
    }
    const input=page.locator(provider==='codex'?'#message':'.ds-composer textarea');await input.fill('键盘发送测试');const before=writes;
    await input.press('Enter');await input.press('Shift+Enter');await input.press(platform==='MacIntel'?'Control+Enter':'Meta+Enter');
    await input.dispatchEvent('keydown',{key:'Enter',ctrlKey:platform==='Win32',metaKey:platform==='MacIntel',isComposing:true});
    check(writes===before,'普通回车、换行、其他平台组合键和输入法不发送 '+platform+' '+provider+' '+width);
    await input.press(platform==='MacIntel'?'Meta+Enter':'Control+Enter');await page.waitForFunction(provider=>provider==='codex'?!document.querySelector('#message').value:!desktopSessions.input.value,provider);
    check(writes===before+1,'平台发送快捷键只提交一次 '+platform+' '+provider+' '+width);
   }
   await context.close();
  }
  for(const width of [390,820]){
   const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
   const open=async(id,provider='codex',host='local')=>{
    await page.evaluate(hash=>window.BridgeNavigation.openChat(hash),'#'+id+'~'+encodeURIComponent(provider==='codex'?host:'desktop:'+provider));
    await page.waitForFunction(([id,provider])=>provider==='codex'?currentId===id&&state?.connected:desktopSessions.sid===id&&desktopSessions.provider===provider&&desktopSessions.freshDetail,[id,provider]);
   };
   await page.goto(base+'/#'+first+'~local');await page.waitForFunction(()=>state?.connected);
   await page.locator('#message').fill('Codex 尚未发送的草稿');
   await page.evaluate(()=>{window.__timeline=chatTimeline;document.querySelector('#message').setSelectionRange(2,5);});await open(first);
   check(await page.evaluate(()=>window.__timeline===chatTimeline&&document.querySelector('#message').selectionStart===2),'重复点当前会话通知保持输入位置 '+width);
   const marker=await page.evaluate(()=>window.__pageMarker=crypto.randomUUID());
   await open(second);await open(first);
   check(await page.locator('#message').inputValue()==='Codex 尚未发送的草稿','通知切换会话后保留 Codex 草稿 '+width);
   check(await page.evaluate(()=>window.__pageMarker)===marker,'通知跳转复用当前页面 '+width);
   await page.reload();await page.waitForFunction(()=>state?.connected);
   check(await page.locator('#message').inputValue()==='Codex 尚未发送的草稿','页面重新加载后恢复 Codex 草稿 '+width);
   await page.evaluate(()=>sessionStorage.clear());await page.close();
   const rebuilt=await context.newPage();rebuilt.on('pageerror',e=>errors.push(e.message));await rebuilt.goto(base+'/#'+first+'~local');await rebuilt.waitForFunction(()=>state?.connected);
   check(await rebuilt.locator('#message').inputValue()==='Codex 尚未发送的草稿','新页面无 sessionStorage 时恢复本机草稿 '+width);
   // Continue through the newly created page, as Android does after process recreation.
   for(const provider of ['claude','deepseek']){
    const hash='#'+first+'~desktop%3A'+provider;
    await rebuilt.evaluate(hash=>window.BridgeNavigation.openChat(hash),hash);
    await rebuilt.waitForFunction(([provider,id])=>desktopSessions.provider===provider&&desktopSessions.sid===id&&desktopSessions.freshDetail,[provider,first]);
    const input=rebuilt.locator('.ds-composer textarea');await input.fill(provider+' 未发送');
    await rebuilt.reload();await rebuilt.evaluate(hash=>window.BridgeNavigation.openChat(hash),hash);
    await rebuilt.waitForFunction(([provider,id])=>desktopSessions.provider===provider&&desktopSessions.sid===id&&desktopSessions.freshDetail,[provider,first]);
    check(await input.inputValue()===provider+' 未发送','页面重建恢复 '+provider+' 草稿 '+width);
    acceptSend=false;await rebuilt.evaluate(()=>desktopSessions.submit());check(await input.inputValue()===provider+' 未发送','发送结果未知时保留 '+provider+' 草稿 '+width);
    acceptSend=true;await rebuilt.evaluate(()=>desktopSessions.submit());check(await input.inputValue()==='','确认发送后清除 '+provider+' 草稿 '+width);
    await rebuilt.reload();await rebuilt.evaluate(hash=>window.BridgeNavigation.openChat(hash),hash);await rebuilt.waitForFunction(()=>desktopSessions.freshDetail);
    check(await input.inputValue()==='','重新打开不会恢复已发送的 '+provider+' 草稿 '+width);
   }
   await rebuilt.evaluate(hash=>window.BridgeNavigation.openChat(hash),'#'+first+'~local');await rebuilt.waitForFunction(()=>state?.connected&&currentId==='11111111-1111-4111-8111-111111111111');
   check(await rebuilt.locator('#message').inputValue()==='Codex 尚未发送的草稿','切换客户端后恢复原 Codex 草稿 '+width);
   acceptSend=false;await rebuilt.evaluate(()=>$('composer').onsubmit({preventDefault(){}}));check(await rebuilt.locator('#message').inputValue()==='Codex 尚未发送的草稿','Codex 发送结果未知时保留草稿 '+width);
   acceptSend=true;await rebuilt.evaluate(()=>$('composer').onsubmit({preventDefault(){}}));check(await rebuilt.locator('#message').inputValue()==='','Codex 确认发送后清除草稿 '+width);
   await rebuilt.locator('#message').fill('退出前的草稿');await rebuilt.evaluate(()=>$('logout').onclick());
   check(await rebuilt.evaluate(()=>composerDrafts.size===0&&!Object.keys(localStorage).some(key=>key.startsWith('bridge-composer-drafts:'))),'退出登录清除当前身份的草稿 '+width);
   await rebuilt.reload();await rebuilt.waitForFunction(()=>state?.connected);check(await rebuilt.locator('#message').inputValue()==='','重新登录不恢复已清除的草稿 '+width);
   await context.close();
  }
  pendingDiscovery=true;const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/#'+first+'~local');await page.waitForFunction(()=>clientNavigation.pendingChatLink);
  check(!(await page.locator('#toast').textContent()).includes('尚未启用'),'冷启动应用列表读取中不误报未启用');pendingDiscovery=false;await page.evaluate(()=>clientNavigation.refresh());await page.waitForFunction(()=>state?.connected);check(await page.evaluate(()=>currentId)===first,'应用发现完成后继续打开通知会话');
  await page.close();holdDiscovery=true;const starting=await browser.newPage();starting.on('pageerror',e=>errors.push(e.message));await starting.goto(base+'/#'+first+'~local');await starting.waitForFunction(()=>entering&&!document.querySelector('#app').hidden);
  await starting.evaluate(hash=>window.BridgeNavigation.openChat(hash),'#'+second+'~local');assert.ok(releaseDiscovery);releaseDiscovery();await starting.waitForFunction(()=>!entering&&state?.connected);
  check(await starting.evaluate(()=>currentId)===second,'初次进入期间的新通知优先于启动时的旧链接');
  check(errors.length===0,'浏览器无脚本异常：'+errors.join('; '));console.log(JSON.stringify({passed:checks.length,writes,checks},null,2));
 }finally{releaseModels?.();creationFixture?.releaseVisibility?.();creationFixture?.releaseHistory?.();creationFixture?.releaseSettings?.();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
