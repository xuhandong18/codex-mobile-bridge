'use strict';
// Production page, isolated HTTP and synthetic status only. No desktop access.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),crypto=require('node:crypto');
const web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json');
const rows=Array.from({length:36},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i+1).padStart(12,'0'),host:'local',title:'增量通知 '+i,recency:100-i,cwd:'/fixture',projectKey:'local|p',projectName:'Project',access:{source:'desktop'}}));
const reads=[],notifications=[],writes=[],errors=[],checks=[],waiters=new Set(),states=new Map();
let streamId='a'.repeat(32),cursor=0,events=[],supported=true,notifyFailure=false,display={revision:0,settings:{showProcess:true}};
const versions=[];
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
    if(p==='/api/auth')value={authenticated:true,csrf:'fixture-csrf',listCacheIdentity:'b'.repeat(64),computer:{name:'Fixture'}};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions')value={sessions:rows,complete:true,sidebar:{sections:[],projects:[{key:'local|p',host:'local',name:'Project',cwd:'/fixture'}]}};
    else if(p==='/api/chat-display')value=display;
    else if(p==='/api/activity'){
      reads.push(body);
      value={sessions:Object.entries(body.hosts).flatMap(([host,ids])=>ids.map(id=>({id,host,connected:true,activityConnected:true,status:'active',turnId:'one',turnStatus:'inProgress',waitingForUser:false,activityRealtime:id!==rows[1].id,activityStreamId:streamId,...states.get(id)})))};
    }else if(p==='/api/activity/changes'){
      notifications.push(body);
      if(notifyFailure){res.writeHead(503);res.end(JSON.stringify({error:'fixture offline'}));return;}
      if(!supported){res.writeHead(404);res.end(JSON.stringify({error:'接口不存在'}));return;}
      value=eventResult(body);
      if(!value.reset&&!Object.keys(value.hosts).length){
        const waiter={body};
        waiter.finish=()=>{if(!waiters.delete(waiter))return;clearTimeout(waiter.timer);if(!res.destroyed){if(notifyFailure)res.writeHead(503);res.end(JSON.stringify(notifyFailure?{error:'offline'}:eventResult(body)));}};
        waiter.timer=setTimeout(waiter.finish,8000);waiters.add(waiter);
        res.on('close',()=>{waiters.delete(waiter);clearTimeout(waiter.timer);});return;
      }
    }
    if(['/api/sessions','/api/chat-display'].includes(p)&&url.searchParams.get('versioned')==='1'){
      const version=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
      value=url.searchParams.get('knownVersion')===version?{version,unchanged:true}:{...value,version};
      versions.push({path:p,unchanged:value.unchanged===true,bytes:JSON.stringify(value).length});
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
      states.clear();cursor=0;events=[];notifyFailure=false;display={revision:0,settings:{showProcess:true}};
      const context=await browser.newContext({viewport:{width,height:720}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(()=>{localStorage.setItem('list-mode','project');localStorage.setItem('navigation:sidebar','open');});
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      await page.waitForFunction(()=>listReadFinished&&!activityBusy&&activityChanges?.healthy&&activityPolling?.confirmed.size>0);
      await page.waitForTimeout(300);
      await page.evaluate(()=>{window.previousGroup=document.querySelector('.project-group');window.previousRow=document.querySelector('.session');});
      const full=versions.filter(row=>row.path==='/api/sessions'&&!row.unchanged).at(-1);
      await page.evaluate(()=>loadList(true));
      check(await page.evaluate(()=>previousGroup===document.querySelector('.project-group')&&previousRow===document.querySelector('.session')),'未变化刷新保留项目与聊天节点 '+width);
      const same=versions.filter(row=>row.path==='/api/sessions').at(-1);
      check(same.unchanged&&same.bytes<full.bytes/5,'未变化只返回小版本确认 '+width);
      rows[0].title='已更新的标题 '+width;await page.evaluate(()=>loadList(true));
      check((await page.locator('#sessions .session').first().innerText()).includes(rows[0].title),'标题变化后返回完整内容并更新页面 '+width);
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForTimeout(150);
      check(versions.filter(row=>row.path==='/api/chat-display').at(-1).unchanged,'显示设置未变时使用版本确认 '+width);
      display={revision:1,settings:{showProcess:false}};
      await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(()=>document.documentElement.dataset.showProcess==='false');
      check(true,'远端显示设置变化正常同步 '+width);
      await page.waitForFunction(()=>!activityBusy&&activityChanges.healthy);
      await page.evaluate(()=>{
        window.pollingClock=0;activityPolling.now=()=>pollingClock;activityChanges.now=()=>pollingClock;activityChanges.confirmedAt=0;
        for(const value of activityPolling.confirmed.values())value.at=0;
      });
      const start=reads.length;
      await page.evaluate(async()=>{pollingClock=5000;activityChanges.confirmedAt=pollingClock;await refreshActivity('poll');});
      check(reads.slice(start).length>0&&reads.slice(start).every(body=>body.hosts.local.every(id=>id===rows[1].id)),'五秒周期只补读无实时来源的聊天 '+width);
      const thirty=reads.length;
      await page.evaluate(async()=>{pollingClock=30000;activityChanges.confirmedAt=pollingClock;await refreshActivity('poll');});
      check(reads.slice(thirty).some(body=>body.hosts.local.includes(rows[0].id)),'可靠实时聊天三十秒进行确认补查 '+width);
      notifyFailure=true;for(const waiter of [...waiters])waiter.finish();
      await page.waitForFunction(()=>!activityChanges.healthy);
      const failed=reads.length;
      await page.evaluate(async()=>{pollingClock=35000;await refreshActivity('poll');});
      check(reads.slice(failed).some(body=>body.hosts.local.includes(rows[0].id)),'通知故障后恢复五秒补查 '+width);
      await context.close();
    }
    check(writes.length===0,'版本检查与补查没有业务写入');check(errors.length===0,'无页面脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{for(const waiter of [...waiters])waiter.finish();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
