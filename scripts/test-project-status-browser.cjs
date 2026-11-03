'use strict';
// 使用生产页面与合成只读接口，不连接真实客户端或聊天。
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json');
const rows=Array.from({length:40},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i+1).padStart(12,'0'),host:'local',title:'项目聊天 '+i,
  cwd:'/fixture',projectKey:'local|fixture',projectName:'状态项目',recency:100-i,access:{source:'desktop'}}));
rows.push(...Array.from({length:7},(_,i)=>({...rows[i],id:'22222222-2222-4222-8222-'+String(i+1).padStart(12,'0'),projectKey:'local|other',projectName:'其他项目'})));
let states=new Map(),activityGate=null,releaseActivity,createdRow=null,listGate=null,releaseList,listFailure=false,listReads=0;const writes=[],errors=[],checks=[],reads=[];
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks.push(label);};
const setState=(index,value)=>states.set(rows[index].id,value);
const reset=()=>{states=new Map();createdRow=null;setState(25,{status:'active'});setState(26,{waitingForUser:true});setState(27,{completionToken:'blue:completed'});setState(28,{completionToken:'orange:failed'});setState(29,{connected:false,status:'unknown'});setState(30,{sideChats:[{id:'side',connected:true,status:'active'}]});};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):null;
    if(req.method!=='GET'&&!['/api/activity','/api/activity/changes'].includes(p))writes.push(p);
    let value={};
    if(p==='/api/auth')value={authenticated:true,csrf:'fixture',listCacheIdentity:'d'.repeat(64),computer:{name:'Fixture'},uiLanguage:'zh'};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sidebar-preferences')value={revision:0,fields:{}};
    else if(p==='/api/sessions'){
      listReads++;if(listGate)await listGate;
      if(listFailure){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'合成读取失败'}));return;}
      value={sessions:createdRow?[createdRow,...rows]:rows,complete:true,remoteHosts:[],availableSources:['desktop'],sidebar:{sections:[{id:'work',name:'工作',itemKeys:['codex:project:fixture','codex:project:other']}],projects:[{key:'local|fixture',host:'local',name:'状态项目',cwd:'/fixture'},{key:'local|other',host:'local',name:'这是一个用于检查手机窄屏按钮空间的很长项目名称',cwd:'/other'},{key:'local|empty',host:'local',name:'空项目',cwd:'/empty'}]}};
    }
    else if(p==='/api/activity'){
      reads.push(body.hosts);
      if(activityGate)await activityGate;
      value={sessions:(body.hosts.local||[]).map(id=>({id,host:'local',connected:true,status:'idle',...states.get(id)}))};
    }
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
  }
  const files=assets[p]||((p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..')?p.slice(1):null);
  if(!files){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p==='/'?'text/html; charset=utf-8':'application/octet-stream');
  res.end(Buffer.concat([].concat(files).map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280]){
      reset();const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(rows=>{
        localStorage.setItem('list-mode','codex');localStorage.setItem('navigation:sidebar','open');
        if(!localStorage.getItem('bridge-session-activity'))localStorage.setItem('bridge-session-activity',JSON.stringify(Object.fromEntries(rows.map(row=>['local|'+row.id,{offline:true,status:'unknown'}]))));
      },rows);
      activityGate=new Promise(resolve=>releaseActivity=resolve);
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      const group=page.locator('#sessions .project-group[data-project-key="local|fixture"]'),other=page.locator('#sessions .project-group[data-project-key="local|other"]');
      const ids=()=>group.locator(':scope > .session').evaluateAll(nodes=>nodes.map(node=>node.dataset.id));
      await page.waitForFunction(()=>listReadFinished&&activityBusy);
      check(await ids(),[],'缓存全是灰点且状态读取尚未返回时不批量展开 '+width);
      releaseActivity();activityGate=null;
      await page.waitForFunction(()=>document.querySelectorAll('[data-project-key="local|fixture"] > .session').length===5);
      check(await ids(),[...rows.slice(25,29),rows[30]].map(row=>row.id),'默认只显示明确的红绿蓝橙及侧边状态 '+width);
      check(await group.locator('.session-indicator').evaluateAll(nodes=>nodes.map(node=>node.className.split(' ').at(-1))),['running','awaiting','completed','ended','running'],'初始未知灰点不使隐藏聊天出现 '+width);
      const toggle=group.locator(':scope > summary .project-chat-toggle'),otherToggle=other.locator(':scope > summary .project-chat-toggle');
      const empty=page.locator('.project-group[data-project-key="local|empty"]');
      check(await other.locator(':scope > .session').count(),0,'无状态项目只占标题行 '+width);
      check(await group.locator('.project-load-more').count(),0,'默认不出现独占一行的加载更多 '+width);
      check(await toggle.getAttribute('aria-expanded'),'false','标题箭头说明初始收起状态 '+width);
      check(await toggle.textContent(),'','标题箭头没有可见文字 '+width);
      check(await empty.locator('.project-chat-toggle').count(),0,'已确认没有其他聊天的项目隐藏箭头 '+width);
      const controls=await other.locator(':scope > summary').evaluate(node=>{
        const arrow=node.querySelector('.project-chat-toggle').getBoundingClientRect(),create=node.querySelector('.project-create').getBoundingClientRect(),root=node.getBoundingClientRect();
        return {touch:arrow.width>=40&&arrow.height>=40,separate:arrow.right<=create.left,inside:create.right<=root.right};
      });
      check(controls,{touch:true,separate:true,inside:true},'长项目名保留独立箭头和新建点击区域 '+width);
      if(process.argv.includes('--screenshots')){fs.mkdirSync('.tmp/project-arrows',{recursive:true});await page.screenshot({path:'.tmp/project-arrows/default-'+width+'.png'});}
      setState(4,{status:'active'});await page.evaluate(()=>refreshActivity());
      await page.waitForFunction(id=>!!document.querySelector('.session[data-id="'+id+'"] .running'),rows[4].id);
      check((await ids())[0],rows[4].id,'隐藏聊天开始运行后自动出现 '+width);
      setState(4,{status:'idle'});await page.evaluate(()=>refreshActivity());
      check((await ids())[0],rows[4].id,'运行状态消失后仍保留原位置 '+width);
      await page.evaluate(id=>{sessionActivity.read('local|'+id,{explicit:true});renderActivity();},rows[27].id);
      check((await ids()).includes(rows[27].id),true,'蓝点已读且没有其他状态时聊天仍留在原处 '+width);
      check(await group.locator('.session[data-id="'+rows[27].id+'"] .session-indicator').count(),0,'保留聊天但不保留已经读完的蓝点 '+width);
      await toggle.click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-project-key="local|fixture"] > .session').length===16);
      check(await ids(),[...rows.slice(0,11),...rows.slice(25,29),rows[30]].map(row=>row.id),'首次点击另增十条普通聊天，保留聊天不占名额 '+width);
      check(await other.locator(':scope > .session').count(),0,'项目加载进度独立 '+width);
      check(await toggle.getAttribute('aria-expanded'),'true','展开后标题箭头变为收起 '+width);
      check(await toggle.getAttribute('title'),'收起其他聊天','标题箭头有动态悬停说明 '+width);
      check(await group.locator('.project-load-more').textContent(),'','底部分页箭头没有可见文字 '+width);
      if(process.argv.includes('--screenshots'))await page.screenshot({path:'.tmp/project-arrows/expanded-'+width+'.png'});
      await group.locator(':scope > summary .project-name').click();
      await page.waitForFunction(()=>!document.querySelector('.project-group[data-project-key="local|fixture"]').open);
      await group.locator(':scope > summary .project-name').click();
      await page.waitForFunction(()=>document.querySelector('.project-group[data-project-key="local|fixture"]').open);
      check(await group.locator(':scope > .session').count(),16,'折叠再展开保留已读聊天和已加载条数 '+width);
      await page.evaluate(()=>loadList(true));
      check(await group.locator(':scope > .session').count(),16,'自动列表刷新保留已读聊天和已加载条数 '+width);
      for(const count of [26,36,40]){
        await group.locator('.project-load-more').click();
        await page.waitForFunction(count=>document.querySelectorAll('[data-project-key="local|fixture"] > .session').length===count,count);
      }
      check(await group.locator('.project-load-more').count(),0,'加载完毕移除加载更多 '+width);
      check(await toggle.isVisible(),true,'全部加载后标题仍能收起 '+width);
      await page.locator('#list-mode').evaluate(node=>{node.value='project';node.dispatchEvent(new Event('change'));});
      check(await group.locator(':scope > .session').count(),5,'按项目视图仍默认五条 '+width);
      await page.locator('#list-mode').evaluate(node=>{node.value='codex';node.dispatchEvent(new Event('change'));});
      check(await group.locator(':scope > .session').count(),40,'切回分区保留该视图加载进度 '+width);
      await otherToggle.click();
      check(await other.locator(':scope > .session').count(),7,'其他项目可独立展开普通聊天 '+width);
      await otherToggle.click();
      check(await other.locator(':scope > .session').count(),0,'再次点击标题箭头恢复默认展示 '+width);
      check(await group.locator(':scope > .session').count(),40,'标题收起不影响其他项目 '+width);
      await other.locator(':scope > summary .project-name').click();
      check(await other.evaluate(node=>node.open),false,'项目名称仍能折叠整个项目 '+width);
      await otherToggle.click();
      check(await other.evaluate(node=>node.open),true,'折叠项目的向下箭头同时打开项目 '+width);
      check(await other.locator(':scope > .session').count(),7,'打开项目时同时展开其他聊天 '+width);
      const projectName=group.locator(':scope > summary .project-name');await projectName.scrollIntoViewIfNeeded();
      await page.evaluate(async()=>{await refreshActivity();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      if(width===1280)await projectName.click({button:'right'});
      else{
        const rect=await projectName.boundingBox(),event={pointerId:7,pointerType:'touch',isPrimary:true,clientX:rect.x+10,clientY:rect.y+10,bubbles:true};
        await projectName.dispatchEvent('pointerdown',event);
        await page.getByRole('dialog',{name:'侧栏操作',exact:true}).waitFor();
        await projectName.dispatchEvent('pointerup',event);
      }
      await page.getByRole('dialog',{name:'侧栏操作',exact:true}).getByRole('button',{name:'隐藏无状态聊天',exact:true}).click();
      check(await ids(),[rows[25],rows[26],rows[28],rows[30]].map(row=>row.id),'项目右键或长按隐藏加载出的普通聊天和已读保留聊天 '+width);
      check(await other.locator(':scope > .session').count(),7,'隐藏操作不影响其他项目 '+width);
      await page.evaluate(()=>loadList(true));
      check(await group.locator(':scope > .session').count(),4,'刷新不会重新展开刚隐藏的聊天 '+width);
      // 等待触屏长按后的防穿透保护结束，再进行下一次独立点击。
      if(width!==1280)await page.waitForTimeout(950);
      await toggle.click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-project-key="local|fixture"] > .session').length===14);
      check(await group.locator(':scope > .session').count(),14,'隐藏后仍可重新加载十条普通聊天 '+width);
      const createdId='33333333-3333-4333-8333-333333333333';
      await page.evaluate(id=>{newChatProjects=sidebarData.projects;rememberCreatedChat({id,host:'local'},{project:'local|fixture',kind:'desktop',title:'新建保留聊天',autoTitle:false});},createdId);
      const created=group.locator('.session[data-id="'+createdId+'"]');
      check(await created.isVisible(),true,'合成创建回执到达后无状态新聊天立即显示 '+width);
      check(await created.locator('.session-indicator').count(),0,'新聊天保留显示不制造状态圆点 '+width);
      await page.evaluate(()=>loadList(true));
      check(await created.count(),1,'后台列表尚未发现新聊天时仍保留 '+width);
      createdRow={...rows[0],id:createdId,title:'新建保留聊天',recency:200};
      await page.evaluate(()=>loadList(true));
      check(await page.evaluate(id=>createdChats.has('local|'+id),createdId),false,'权威列表已经接管新聊天元数据 '+width);
      await projectName.click({button:'right'});
      await page.getByRole('dialog',{name:'侧栏操作',exact:true}).getByRole('button',{name:'隐藏无状态聊天',exact:true}).click();
      check(await created.isVisible(),true,'隐藏无状态聊天仍保留本页面新建聊天 '+width);
      check(await group.locator(':scope > .session').count(),5,'只保留四条状态聊天及一条新聊天 '+width);
      await page.evaluate(()=>loadList(true));
      check(await created.isVisible(),true,'列表接管和重复刷新不会移除新聊天 '+width);
      await toggle.click();
      await page.waitForFunction(()=>document.querySelectorAll('[data-project-key="local|fixture"] > .session').length===15);
      check(await group.locator(':scope > .session').count(),15,'新聊天不占加载更多的十条名额 '+width);
      activityGate=new Promise(resolve=>releaseActivity=resolve);
      await page.reload();await page.waitForFunction(()=>listReadFinished&&activityBusy);
      check(await ids(),[rows[25],rows[26],rows[28],rows[30]].map(row=>row.id),'刷新页面后只恢复明确状态，灰点和已读保留均不展开 '+width);
      check(await created.count(),0,'重新加载页面结束新聊天的本页面显示保留 '+width);
      releaseActivity();activityGate=null;
      await page.evaluate(()=>refreshActivity());
      check(await group.locator(':scope > .session').count(),4,'重新读取状态后没有大批聊天消失 '+width);
      await otherToggle.focus();await otherToggle.press('Enter');
      check(await otherToggle.getAttribute('aria-expanded'),'true','键盘回车可展开其他聊天 '+width);
      await otherToggle.focus();
      check(await otherToggle.evaluate(node=>getComputedStyle(node).outlineStyle),'solid','键盘焦点有清晰轮廓 '+width);
      await otherToggle.press('Space');
      check(await otherToggle.getAttribute('aria-expanded'),'false','键盘空格可收起其他聊天 '+width);
      check(await other.evaluate(node=>node.open),true,'键盘操作箭头不折叠整个项目 '+width);
      const requestCount=listReads;
      listGate=new Promise(resolve=>releaseList=resolve);
      await page.evaluate(()=>{listHasMore=true;listRenderStamp='';renderList();});
      await otherToggle.click();
      await page.waitForFunction(()=>listLoading>0);
      check(await otherToggle.getAttribute('aria-busy'),'true','标题展开请求期间在原位置显示加载状态 '+width);
      check(await otherToggle.locator('.loading').count(),1,'标题展开请求显示小型转圈 '+width);
      check(await otherToggle.isEnabled(),true,'读取期间标题箭头仍可收起 '+width);
      await otherToggle.click();
      check(await other.locator(':scope > .session').count(),0,'读取未结束也能立即收起 '+width);
      releaseList();listGate=null;await page.waitForFunction(()=>!listLoading&&!projectPage('local|other').loading);
      check(await other.locator(':scope > .session').count(),0,'旧请求返回不会重新展开 '+width);
      check(listReads-requestCount,1,'慢请求期间没有重复提交加载 '+width);
      await otherToggle.click();
      check(await other.locator(':scope > .session').count(),7,'慢请求结束后可以重新展开 '+width);
      // 强制保留全局下一页，验证底部分页失败及显式重试。
      await page.evaluate(()=>{listHasMore=true;listRenderStamp='';renderList();});
      listGate=new Promise(resolve=>releaseList=resolve);
      const more=other.locator(':scope > .project-load-more');
      await more.click();await page.waitForFunction(()=>listLoading>0);
      check(await more.getAttribute('aria-busy'),'true','底部分页在对应箭头显示加载状态 '+width);
      check(await more.isDisabled(),true,'底部读取期间阻止重复请求 '+width);
      check(await otherToggle.getAttribute('aria-busy'),'false','底部加载不替换标题收起箭头 '+width);
      listFailure=true;releaseList();listGate=null;
      await page.waitForFunction(()=>!listLoading&&!projectPage('local|other').loading);
      listFailure=false;
      check(await other.locator(':scope > .session').count(),7,'分页失败保留已经显示的聊天 '+width);
      check(await more.isEnabled(),true,'分页失败后可主动重试 '+width);
      await more.click();await page.waitForFunction(()=>!listLoading&&!projectPage('local|other').loading);
      check(await more.count(),0,'重试成功确认到底后移除底部箭头 '+width);
      await otherToggle.click();
      // 同一事件内建立未知分页并探查，避免滚动触发已有全局预读先确认空项目。
      const canProbe=await page.evaluate(()=>{
        listHasMore=true;listRenderStamp='';renderList();
        const button=document.querySelector('.project-group[data-project-key="local|empty"] .project-chat-toggle');
        button?.click();return !!button;
      });
      check(canProbe,true,'未知是否有更多时允许通过箭头探查 '+width);
      await page.waitForFunction(()=>!listLoading&&!projectPage('local|empty').loading);
      check(await empty.locator('.project-chat-toggle').count(),0,'探查确认项目为空后隐藏入口 '+width);
      await context.close();
    }
    check(writes,[],'所有操作均未创建、激活聊天或提交业务写入');check(errors,[],'浏览器无脚本异常');
    check(reads.every(hosts=>(hosts.local||[]).length<=64),true,'状态发现遵守单主机批量上限');
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{releaseActivity?.();activityGate=null;releaseList?.();listGate=null;await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
