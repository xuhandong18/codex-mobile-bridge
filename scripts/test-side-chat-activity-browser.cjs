'use strict';
// Production page with isolated synthetic APIs; never connects a real client.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json');
const parent='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',project='local|fixture',firstSlot='33333333-3333-4333-8333-333333333333';
const access={source:'cli',canSend:true,canApprove:true,canUseSideChat:true};
let sides,mainStatus,mainTurn,recency,sequence,mainWaiting,mainCompletion;const errors=[],writes=[],receipts=new Map();
const screenshots=process.argv.includes('--screenshots')?path.resolve(__dirname,'../.tmp/side-chat-activity'):null;
const reset=()=>{receipts.clear();sides=['one','two'].map((id,index)=>({id:'side-'+id,slot:index?'44444444-4444-4444-8444-444444444444':firstSlot,connected:true,status:'active',turns:[{id,status:'inProgress',messages:[]}],requests:[],submissions:[]}));mainStatus='idle';mainTurn='main';recency=1;sequence=1;mainWaiting=false;mainCompletion=null;};
const summary=()=>({id:parent,host:'local',connected:true,activityConnected:true,parentStatus:mainStatus,status:mainStatus==='active'||sides.some(s=>s.status==='active')?'active':'idle',turnId:mainTurn,turnStatus:mainStatus==='active'?'inProgress':'completed',completionToken:mainCompletion,readCompletions:receipts.get('main')||[],waitingForUser:mainWaiting,sideChats:sides.map(({id,connected,status,turns,requests})=>({id,connected,status,waitingForUser:!!requests?.length,turnId:turns.at(-1)?.id,turnStatus:turns.at(-1)?.status,readCompletions:receipts.get(id)||[]})),recency});
const rows=()=>[{id:other,host:'local',title:'较新的主聊天',recency:100},{id:parent,host:'local',title:'侧边状态测试',recency}].map(row=>({...row,cwd:'/fixture',projectKey:project,projectName:'测试项目',access}));
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):null;
    const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(body&&!['/api/activity','/api/sidebar-preferences'].includes(p))writes.push({p,body});
    if(p==='/api/auth')return json({authenticated:true,csrf:'fixture',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}});
    if(p==='/api/clients')return json({clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]});
    if(p==='/api/accounts')return json({accounts:[],current:{kind:'api'}});
    if(p==='/api/sessions')return json({sessions:rows(),complete:true,sidebar:{sections:[{id:'daily',name:'测试分区',hostSectionIds:{local:'native-daily'},itemKeys:['codex:project:fixture']}],projects:[{key:project,host:'local',name:'测试项目',cwd:'/fixture'}]}});
    if(p==='/api/activity')return json({sessions:(body.hosts.local||[]).map(id=>id===parent?summary():{id,host:'local',connected:true,status:'idle',recency:100})});
    if(p.endsWith('/read-state')){
      const key=url.searchParams.get('side')||'main',tokens=[...new Set([...(receipts.get(key)||[]),body.turnId+':'+body.turnStatus])];
      receipts.set(key,tokens);return json({status:'accepted',readCompletions:tokens});
    }
    if(p.endsWith('/side-chat')){
      const side=sides.find(s=>s.slot===(url.searchParams.get('slot')||''));
      if(body?.action==='send'){
        assert.equal(body.id,side.id);recency=200;sequence++;
        Object.assign(side,{status:'active',recency,turns:[{id:'next',status:'inProgress',messages:[{role:'user',text:body.text}]}]});
        return json({status:'accepted'});
      }
      return json({...side||{id:null,connected:false,turns:[]},slots:sides.map(s=>({id:s.id,slot:s.slot}))});
    }
    if(p.endsWith('/timeline')||p.endsWith('/updates')){
      if(p.endsWith('/updates'))await new Promise(resolve=>setTimeout(resolve,50));
      return json({epoch:'fixture',sequence,rows:[],files:[],hasMore:false,meta:{...rows()[1],connected:true,status:mainStatus,turnId:mainTurn,turnStatus:mainStatus==='active'?'inProgress':'completed',requests:[],turns:[],queue:[]}});
    }
    return json({});
  }
  const parts=assets[p]||((p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..')?p.slice(1):null);
  if(!parts){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p==='/'?'text/html; charset=utf-8':'application/octet-stream');
  res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const checks=[];
  try{
    if(screenshots)fs.mkdirSync(screenshots,{recursive:true});
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280])for(const mode of ['recent','codex']){
      reset();writes.length=0;
      const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',e=>errors.push(e.message));
      page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
      await context.addInitScript(mode=>{localStorage.setItem('list-mode',mode);localStorage.setItem('navigation:sidebar','open');},mode);
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      const indicator=kind=>page.waitForFunction(({parent,kind})=>sessionActivity.indicator('local|'+parent)?.kind===kind,{parent,kind});
      const refresh=()=>page.evaluate(async()=>{sidebarNavigation.set(true);await refreshActivity();});
      const label=mode+' '+width,check=(ok,text)=>{assert.ok(ok,label+': '+text);checks.push(label+': '+text);};
      await indicator('running');
      check(await page.locator('#sessions .session[data-id="'+parent+'"] .session-indicator.running').count()===1,'主聊天已结束而侧边仍工作显示绿点');
      if(screenshots&&mode==='codex'&&width===390)await page.screenshot({path:path.join(screenshots,'green-390.png')});
      sides[0].requests=[{id:'waiting',method:'item/tool/requestUserInput',params:{questions:[{id:'q',question:'Choose'}]}}];
      await refresh();await indicator('awaiting');
      const red=page.locator('#sessions .session[data-id="'+parent+'"] .session-indicator.awaiting');
      check(await red.evaluate(node=>getComputedStyle(node).backgroundColor)==='rgb(239, 68, 68)','未打开的侧边等待问题显示红色');
      check(await red.getAttribute('aria-label')==='等待你回复或处理','红色提供无障碍状态说明');
      sides[0].requests=[];mainWaiting=true;await refresh();await indicator('awaiting');
      check(recency===1,'主侧等待状态不推进聊天排序时间');
      mainWaiting=false;await refresh();await indicator('running');

      sides[0].status='idle';sides[0].turns[0].status='completed';await refresh();await indicator('completed');
      check(await page.locator('#sessions .session[data-id="'+parent+'"] .session-indicator.completed').count()===1,'任一侧边完成优先显示蓝点');
      if(screenshots&&mode==='codex'&&width===390)await page.screenshot({path:path.join(screenshots,'blue-390.png')});
      await page.locator('#sessions .session[data-id="'+parent+'"]').click();
      await page.waitForFunction(()=>workbench.current?.files.length===2&&state?.connected);
      await indicator('completed');check(true,'打开主聊天仍保留侧边未读');
      await page.locator('#sidebar .sidebar-toggle').click();
      await page.locator('#chat .wb-tab[data-tab="sidechat:'+firstSlot+'"] [role=tab]').click();
      await indicator('running');check(true,'阅读完成的侧边后恢复绿点');
      await refresh();await indicator('running');check(true,'真实详情轮次结构已读后再次查询不复活蓝点');
      await page.locator('#sidebar .sidebar-toggle').click();
      await page.locator('.wb-side-composer:visible textarea').fill('更新侧边交互时间');
      await page.locator('.wb-side-composer:visible button[type=submit]').click();
      await page.waitForFunction(()=>listRows.find(row=>row.id===currentId)?.recency===200);
      await refresh();
      check(await page.locator('#sessions .session').first().getAttribute('data-id')===parent,'侧边发送更新最近交互和分区项目排序');
      await page.evaluate(()=>loadList(true));
      check(await page.locator('#sessions .session').first().getAttribute('data-id')===parent,'列表刷新保留侧边交互排序');
      recency=250;sides[0].recency=250;
      sides[0].turns[0].messages.push({id:'progress',role:'assistant',phase:'commentary',text:'有新的文字进度'});
      await page.evaluate(slot=>workbench.current.files.find(tab=>tab.slot===slot).sideChat.load(),firstSlot);
      check(await page.evaluate(()=>listRows.find(row=>row.id===currentId).recency)===250,'没有新发送时，侧边新回复也更新父聊天排序时间');
      sides[0].turns[0].messages.push({id:'tool',role:'tool',type:'commandExecution',command:'pwd',output:'updated output'});
      sides[0].turns[0].messages.push({id:'thought',role:'reasoning',type:'reasoning',text:'thinking summary'});
      await page.evaluate(slot=>workbench.current.files.find(tab=>tab.slot===slot).sideChat.load(),firstSlot);
      await refresh();
      check(await page.evaluate(()=>listRows.find(row=>row.id===currentId).recency)===250,'侧边工具与思考更新不推进排序时间');
      mainStatus='active';mainTurn='next-main';sequence++;await refresh();mainStatus='idle';sequence++;await refresh();await indicator('completed');
      check(true,'主聊天完成时侧边仍在工作也显示蓝点');
      check(await page.evaluate(()=>listRows.find(row=>row.id===currentId).recency)===250,'完成蓝点独立更新且不推进排序时间');
      await page.locator('#sidebar .sidebar-toggle').click();
      await page.locator('#chat .wb-tab[data-tab="chat"] [role=tab]').click();
      await indicator('running');check(true,'读完主聊天后继续显示侧边运行绿点');
      const before=recency;await page.reload();await page.waitForFunction(()=>listReadFinished&&state?.connected);
      check(recency===before,'阅读与刷新不更新交互时间');
      check(writes.filter(w=>w.body.action==='send').length===1,'仅用户的一次侧边发送产生写入');
      await context.close();
    }
    reset();mainStatus='active';sides=[];
    const devices=[];
    for(const width of [820,390]){
      if(width===390){mainStatus='idle';mainCompletion=mainTurn+':completed';sequence++;}
      const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',e=>errors.push(e.message));
      page.on('console',message=>{if(['error','warning'].includes(message.type()))errors.push(message.text());});
      await context.addInitScript(()=>{localStorage.setItem('list-mode','recent');localStorage.setItem('navigation:sidebar','open');});
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      devices.push({context,page});
      await page.locator('#sessions .session[data-id="'+parent+'"] .session-indicator.'+(width===820?'running':'completed')).waitFor();
    }
    const [tablet,phone]=devices.map(device=>device.page);
    const refresh=page=>page.evaluate(async()=>{sidebarNavigation.set(true);await refreshActivity();});
    const dot=(page,kind)=>page.locator('#sessions .session[data-id="'+parent+'"] .session-indicator'+(kind?'.'+kind:''));
    for(const page of [tablet,phone]){await refresh(page);await dot(page,'completed').waitFor();}
    checks.push('手机在平板任务结束后才首次打开，仍显示未读蓝点');
    await phone.reload();await phone.waitForFunction(()=>listReadFinished);await refresh(phone);await dot(phone,'completed').waitFor();
    checks.push('手机未阅读结果时重载页面，蓝点继续保留');
    if(screenshots)await phone.screenshot({path:path.join(screenshots,'cross-device-before.png')});
    const acknowledged=tablet.waitForResponse(response=>response.url().includes('/read-state')&&response.request().method()==='POST');
    await tablet.locator('#sessions .session[data-id="'+parent+'"]').click();
    await tablet.waitForFunction(()=>state?.turnStatus==='completed');
    await tablet.waitForFunction(()=>sessionActivity.readTokens.size>0);
    assert.equal((await acknowledged).status(),200);
    await refresh(phone);await dot(phone).waitFor({state:'detached'});
    checks.push('平板实际打开主聊天后，手机独立存储中的蓝点消失');
    if(screenshots)await phone.screenshot({path:path.join(screenshots,'cross-device-after.png')});
    await phone.reload();await phone.waitForFunction(()=>listReadFinished);await refresh(phone);assert.equal(await dot(phone).count(),0);
    checks.push('手机重新打开页面后已读结果仍保留');
    await tablet.context().close();
    mainStatus='active';mainTurn='next-device-turn';sequence++;await refresh(phone);
    mainStatus='idle';mainCompletion=mainTurn+':completed';sequence++;await refresh(phone);await dot(phone,'completed').waitFor();
    checks.push('平板已读不会吞掉下一轮完成提醒');
    await phone.context().close();
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
