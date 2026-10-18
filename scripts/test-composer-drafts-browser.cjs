'use strict';
// Full production page with synthetic API responses; never attaches to a real client.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),assets=require('../web/assets.json'),web=path.join(root,'web');
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const access={source:'cli',canSend:true,canConfigure:false,canReconnect:false};
const rows=[first,second].map((id,i)=>({id,host:'local',title:'测试会话 '+(i+1),cwd:'/fixture',status:'idle',updatedAt:100-i,access}));
let pendingDiscovery=false,acceptSend=true,writes=0,holdDiscovery=false,releaseDiscovery;
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
  else if(p==='/api/activity'||p==='/api/sessions')value={sessions:rows,hosts:[],sources:[],hasMore:false,complete:true};
  else if(p.endsWith('/timeline')||p.endsWith('/updates')){
   if(p.endsWith('/updates'))await new Promise(resolve=>setTimeout(resolve,250));
   const id=p.split('/')[3];value={epoch:'fixture',sequence:1,rows:[],files:[],hasMore:false,meta:{id,title:rows.find(r=>r.id===id)?.title||id,connected:true,status:'idle',requests:[],queue:[],turns:[],access}};
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
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
