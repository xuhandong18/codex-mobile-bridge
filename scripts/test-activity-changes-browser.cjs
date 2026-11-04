'use strict';
// Production page, isolated HTTP and synthetic status only. No desktop access.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json');
const rows=Array.from({length:36},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i+1).padStart(12,'0'),host:'local',title:'增量通知 '+i,recency:100-i,access:{source:'desktop'}}));
const reads=[],notifications=[],writes=[],errors=[],checks=[],waiters=new Set(),states=new Map();
let streamId='a'.repeat(32),cursor=0,events=[],supported=true;
const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
function eventResult(body){
  const reset=body.streamId!==streamId||body.after>cursor;
  const hosts={};
  if(!reset)for(const event of events)if(event.cursor>body.after&&body.hosts[event.host]?.includes(event.id)){
    const ids=hosts[event.host]??=[];if(!ids.includes(event.id))ids.push(event.id);
  }
  return {streamId,cursor,reset,hosts,closed:false};
}
function publish(id,changes){
  states.set(id,{...states.get(id),...changes});events.push({cursor:++cursor,host:'local',id});
  for(const waiter of [...waiters])if(Object.keys(eventResult(waiter.body).hosts).length)waiter.finish();
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    let raw='';for await(const part of req)raw+=part;const body=raw?JSON.parse(raw):null;
    res.setHeader('Content-Type','application/json');let value={};
    if(req.method==='POST'&&!['/api/activity','/api/activity/changes'].includes(p))writes.push(p);
    if(p==='/api/auth')value={authenticated:true,csrf:'fixture-csrf',listCacheIdentity:'b'.repeat(64),computer:{name:'Fixture'},...(supported?{activityChanges:true}:{})};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions')value={sessions:rows,complete:true,sidebar:{sections:[],projects:[]}};
    else if(p==='/api/activity'){
      reads.push(body);
      value={sessions:Object.entries(body.hosts).flatMap(([host,ids])=>ids.map(id=>({id,host,connected:true,activityConnected:true,status:'active',turnId:'one',turnStatus:'inProgress',waitingForUser:false,...states.get(id)})))};
    }else if(p==='/api/activity/changes'){
      notifications.push(body);
      if(!supported){res.writeHead(404);res.end(JSON.stringify({error:'接口不存在'}));return;}
      value=eventResult(body);
      if(!value.reset&&!Object.keys(value.hosts).length){
        const waiter={body};
        waiter.finish=()=>{if(!waiters.delete(waiter))return;clearTimeout(waiter.timer);if(!res.destroyed)res.end(JSON.stringify(eventResult(body)));};
        waiter.timer=setTimeout(waiter.finish,8000);waiters.add(waiter);
        res.on('close',()=>{waiters.delete(waiter);clearTimeout(waiter.timer);});return;
      }
    }
    res.end(JSON.stringify(value));return;
  }
  if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(web,'index.html')));return;}
  let parts=assets[p];if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
  if(!parts){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280]){
      states.clear();cursor=0;events=[];
      const context=await browser.newContext({viewport:{width,height:720}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(()=>{localStorage.setItem('list-mode','recent');localStorage.setItem('navigation:sidebar','open');});
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      await page.waitForFunction(()=>!activityBusy&&activityChanges?.cursor===0);
      const id=rows[0].id,selector='#sessions .session[data-id="'+id+'"]';
      await page.waitForSelector(selector+' .running');
      await page.waitForFunction(()=>activityChanges.task?.controller&&!activityChanges.task.controller.signal.aborted);
      const start=reads.length,at=Date.now();publish(id,{status:'idle',turnStatus:'completed'});
      await page.waitForSelector(selector+' .completed',{timeout:1500});
      check(Date.now()-at<1500,'结束通知在下一次五秒轮询前更新圆点 '+width);
      check(reads.slice(start).some(body=>body.hosts.local?.length===1&&body.hosts.local[0]===id),'增量只查询改变的聊天 '+width);
      await page.evaluate(id=>{sessionActivity.read('local|'+id,{sync:false});renderActivity();},id);
      const next=Date.now();publish(id,{status:'active',turnId:'two',turnStatus:'inProgress',waitingForUser:true});
      await page.waitForSelector(selector+' .awaiting',{timeout:1500});
      check(Date.now()-next<1500,'等待回答的红点通过同一通道及时刷新 '+width);
      publish(id,{waitingForUser:false});await page.waitForSelector(selector+' .running',{timeout:1500});
      check(true,'解除等待后恢复运行圆点 '+width);
      const hidden=rows.at(-1).id,before=reads.length;publish(hidden,{status:'idle',turnStatus:'completed'});
      await page.waitForTimeout(350);
      check(reads.slice(before).every(body=>!body.hosts.local?.includes(hidden)),'屏外聊天通知不触发额外补读 '+width);
      await page.locator('#sessions').evaluate(node=>{node.scrollTop=node.scrollHeight;});
      await page.waitForFunction(id=>sessionActivity.rows['local|'+id]?.turnStatus==='completed',hidden);
      const scrollAt=Date.now();publish(hidden,{status:'active',turnId:'after-scroll',turnStatus:'inProgress'});
      await page.waitForFunction(id=>sessionActivity.rows['local|'+id]?.turnId==='after-scroll',hidden,{timeout:1500});
      check(Date.now()-scrollAt<1500,'滚动后的聊天沿用通知连接及时更新 '+width);
      const count=notifications.length;
      await page.evaluate(()=>$('app').classList.add('chat-open'));
      await page.locator('#sidebar .sidebar-toggle').click();
      await page.waitForFunction(()=>activityChanges.task===null);
      check(await page.evaluate(()=>!activityChanges.task),'收起导航栏立即停止通知连接 '+width);
      await page.waitForTimeout(250);check(notifications.length<=count+1,'隐藏导航不持续发起通知请求 '+width);
      await context.close();
    }
    // Exercise old gateways with the actual unchanged five-second fallback.
    supported=false;states.clear();const context=await browser.newContext({viewport:{width:820,height:720}}),page=await context.newPage();
    await context.addInitScript(()=>{localStorage.setItem('list-mode','recent');localStorage.setItem('navigation:sidebar','open');});
    const legacyNotifications=notifications.length;
    await page.goto('http://127.0.0.1:'+server.address().port+'/');
    await page.waitForFunction(()=>!activityChangesEnabled&&!activityBusy&&listReadFinished);
    states.set(rows[0].id,{status:'idle',turnStatus:'completed'});
    await page.waitForFunction(id=>sessionActivity.rows['local|'+id]?.turnStatus==='completed',rows[0].id,{timeout:6500});
    check(notifications.length===legacyNotifications,'旧网关不探测不支持的 POST，五秒轮询继续更新状态');
    await context.close();
    check(writes.length===0,'通知及定向刷新没有提交业务写操作');check(errors.length===0,'无页面脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{for(const waiter of [...waiters])waiter.finish();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
