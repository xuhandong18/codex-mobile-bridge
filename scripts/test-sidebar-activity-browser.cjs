'use strict';
// Full production page and synthetic API only; never opens real desktop chats.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const project='local|fixture-project',access={source:'desktop',canSend:false,canReconnect:true};
const rows=Array.from({length:36},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i+1).padStart(12,'0'),host:'local',title:'自动状态测试 '+(i+1),
  cwd:'/fixture',projectKey:project,projectName:'测试项目',projectId:'fixture-project',updatedAt:100-i,recency:100-i,access}));
const observations=[],writes=[],errors=[];
let coldMode='ready',coldStarted;
const coldWaiters=new Set();
function blockCold(){coldMode='wait';return new Promise(resolve=>coldStarted=resolve);}
function releaseCold(){coldMode='ready';for(const resolve of coldWaiters)resolve();coldWaiters.clear();}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    let value={};res.setHeader('Content-Type','application/json');
    if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}};
    else if(p==='/api/clients')value={clients:['codex','claude','deepseek'].map(id=>({id,name:id,enabled:true,configured:true,connected:true,installed:true,running:true}))};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions')value={sessions:rows,hosts:[],sources:['desktop'],hasMore:false,complete:true,
      sidebar:{projects:[{key:project,host:'local',name:'测试项目',cwd:'/fixture'}],sections:[]}};
    else if(p==='/api/activity'){
      let data='';for await(const part of req)data+=part;
      const hosts=JSON.parse(data).hosts;observations.push(hosts);
      if(coldMode==='wait'&&hosts.local?.includes(rows[1].id)){
        await new Promise(resolve=>{coldWaiters.add(resolve);coldStarted?.();});
      }
      value={sessions:Object.entries(hosts).flatMap(([host,ids])=>ids.map(id=>id===rows[1].id?
        {id,host,connected:false,activityConnected:coldMode!=='timeout',status:coldMode==='timeout'?'unknown':'notLoaded',activityError:coldMode==='timeout'?'timeout':null,turnId:id+'-turn',turnStatus:'completed'}:
        {id,host,connected:true,activityConnected:true,status:'active',turnId:id+'-turn',turnStatus:'inProgress'}))};
    }else if(p.endsWith('/reconnect')||p.endsWith('/send')||p.endsWith('/timeline')||p.endsWith('/updates'))writes.push(p);
    res.end(JSON.stringify(value));return;
  }
  if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(web,'index.html')));return;}
  let parts=assets[p];
  if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
  if(!parts){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const checks=[];
  const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280]){
      const initialRead=blockCold();
      const context=await browser.newContext({viewport:{width,height:720}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(id=>{localStorage.setItem('list-mode','recent');localStorage.setItem('navigation:sidebar','open');localStorage.setItem('bridge-session-activity',JSON.stringify({['local|'+id]:{offline:true}}));},rows[1].id);
      const start=observations.length;await page.goto('http://127.0.0.1:'+server.address().port+'/');
      await initialRead;
      check(await page.evaluate(()=>currentId===null&&activityBusy),'列表初次显示即查询并等待状态，无需打开聊天 '+width);
      const expected=await page.evaluate(()=>{
        const root=$('sessions'),bounds=root.getBoundingClientRect();
        return [...root.querySelectorAll('.session')].filter(node=>{const r=node.getBoundingClientRect();return node.getClientRects().length&&r.bottom>bounds.top&&r.top<bounds.bottom;}).map(node=>node.dataset.id);
      });
      const initial=observations.slice(start).at(-1)?.local||[];
      check(initial.length>0&&initial.length<rows.length&&initial.every(id=>expected.includes(id)),'首次只订阅可见条目 '+width);
      const coldSelector='#sessions .session[data-id="'+rows[1].id+'"]';
      check(await page.locator(coldSelector+' .session-indicator.unknown').count()===1,'未取得原生元数据前保留未知状态 '+width);
      const waitingCount=observations.length;await page.waitForTimeout(350);
      check(observations.length===waitingCount&&await page.evaluate(()=>activityBusy),'桌面结果未返回时保持同一个请求，不发起补查 '+width);
      await page.locator('#sessions').evaluate(node=>{node.scrollTop=node.scrollHeight;});
      await page.waitForFunction(id=>sessionActivity.rows['local|'+id]?.status==='active',rows.at(-1).id,{timeout:1500});
      check(coldWaiters.size===1&&await page.evaluate(()=>activityBusy),'旧请求仍在等待时，新出现的聊天已取得状态 '+width);
      check(observations.slice(start+1).some(hosts=>hosts.local?.includes(rows.at(-1).id))&&
        observations.slice(start+1).every(hosts=>!hosts.local?.includes(rows[1].id)),'新条目立即查询，已有请求中的聊天不重复读取 '+width);
      await page.locator('#sessions').evaluate(node=>{node.scrollTop=0;});
      releaseCold();const readyAt=Date.now();
      await page.waitForFunction(id=>sessionActivity.rows['local|'+id]?.status==='notLoaded',rows[1].id,{timeout:1500});
      check(await page.locator(coldSelector+' .session-indicator').count()===0&&await page.evaluate(()=>currentId===null),'未加载且已完成的聊天自动消除灰点，无需打开 '+width);
      check(Date.now()-readyAt<1500,'同一个请求拿到结果后立即消除灰点 '+width);
      await page.waitForTimeout(250);const newGrayRead=blockCold();
      const grayAt=observations.length;
      await page.evaluate(id=>{sessionActivity.rows['local|'+id].offline=true;renderActivity();},rows[1].id);
      await newGrayRead;await page.waitForTimeout(350);
      check(observations.length===grayAt+1,'灰点新出现时立即查询，等待期间不重复发送 '+width);
      releaseCold();
      await page.waitForFunction(id=>!sessionActivity.rows['local|'+id]?.offline,rows[1].id,{timeout:1500});
      check(observations.length>grayAt&&await page.locator(coldSelector+' .session-indicator').count()===0,'已有条目新出现灰点时立即触发查询 '+width);
      const scrollStart=observations.length;
      const scrolledRead=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/activity'&&request.postDataJSON()?.hosts?.local?.includes(rows.at(-1).id));
      await page.locator('#sessions').evaluate(node=>{node.scrollTop=node.scrollHeight;});
      await scrolledRead;
      await page.waitForFunction(id=>!!document.querySelector('#sessions .session[data-id="'+id+'"] .session-indicator.running'),rows.at(-1).id);
      check(observations.slice(scrollStart).some(hosts=>hosts.local?.includes(rows.at(-1).id)),'滚动后自动连接新出现的聊天 '+width);
      check(observations.slice(scrollStart).every(hosts=>!hosts.local?.includes(rows[0].id)),'移出屏幕的聊天停止轮询 '+width);
      await page.locator('#list-mode').selectOption('project');
      await page.waitForSelector('#sessions .project-group');
      await page.locator('#sessions').evaluate(node=>{node.scrollTop=0;});
      await page.locator('#sessions .project-group').evaluate(node=>{node.open=false;});
      await page.waitForTimeout(250);const closed=observations.length;
      await page.evaluate(()=>refreshActivity());await page.waitForTimeout(150);
      check(observations.length===closed,'折叠项目后不再观察隐藏聊天 '+width);
      const reopenedRead=blockCold();
      await page.evaluate(id=>{sessionActivity.rows['local|'+id].offline=true;renderActivity();},rows[1].id);
      await page.locator('#sessions .project-group').evaluate(node=>{node.open=true;});
      await reopenedRead;
      check(observations.length>closed,'展开项目后自动恢复状态同步 '+width);
      await page.waitForSelector(coldSelector+' .session-indicator.unknown');releaseCold();
      await page.waitForFunction(id=>sessionActivity.rows['local|'+id]?.status==='notLoaded'&&!sessionActivity.rows['local|'+id]?.offline,rows[1].id,{timeout:1500});
      check(await page.locator(coldSelector+' .session-indicator').count()===0,'再次展开项目也在同一查询响应中确认状态 '+width);
      await page.waitForTimeout(250);coldMode='timeout';await page.evaluate(()=>refreshActivity());
      check(await page.locator(coldSelector+' .session-indicator.unknown').getAttribute('title')==='读取运行状态超时','超时响应保持灰点并说明原因 '+width);
      const timeoutAt=observations.length;await page.waitForTimeout(450);
      check(observations.slice(timeoutAt).every(hosts=>hosts.local?.length!==1),'超时后不再对未知聊天快速轮询 '+width);
      coldMode='ready';await page.evaluate(()=>refreshActivity());
      // Exercise the chat layout without opening or executing a fixture chat.
      await page.evaluate(()=>$('app').classList.add('chat-open'));await page.waitForTimeout(200);
      const beforeHide=observations.length;
      await page.locator('#sidebar .sidebar-toggle').click();await page.waitForTimeout(250);
      await page.evaluate(()=>refreshActivity());await page.waitForTimeout(150);
      check(observations.length===beforeHide,'导航栏收起时停止观察 '+width);
      await page.evaluate(()=>document.querySelector('#sidebar .sidebar-toggle').click());
      await page.waitForFunction(()=>document.querySelector('#app').classList.contains('sidebar-open'));
      await page.waitForTimeout(250);
      check(observations.length>beforeHide,'导航栏重新显示后自动同步 '+width);
      await context.close();
    }
    check(writes.length===0,'自动状态同步没有打开聊天、发送消息或读取聊天正文');
    check(errors.length===0,'浏览器无脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{releaseCold();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
