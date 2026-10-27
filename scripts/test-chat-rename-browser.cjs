'use strict';
// Full production page, isolated synthetic chats; no real client or model calls.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json');
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const unavailableOnly=process.argv.includes('--unavailable-only');
let rows,deepseek,jobs,writes,mode='success',unavailableAt='preflight',titleReads=0;const errors=[],checks=[];
function reset(){rows=[1,2].map(n=>({id:id(n),host:'local',title:'原有标题 '+n,cwd:'/fixture',recency:10-n,projectKey:'local|independent',projectName:'独立聊天',access:{source:'desktop'}}));deepseek=[1,2].map(n=>({id:'deepseek-'+n,title:'原有标题 '+n,cwd:'/fixture',projectless:true,status:'idle',model:'fixture/chat'}));jobs=new Map();writes=[];}
function start(provider,sid,requestId){
  const key=provider+sid,collection=provider==='codex'?rows:deepseek;
  if(mode==='not-received')return {};
  jobs.set(key,{status:mode==='unknown'?'unknown':'running',requestId,title:collection.find(row=>row.id===sid).title});
  if(mode!=='unknown')setTimeout(()=>{if(jobs.get(key)?.status!=='running')return;collection.find(row=>row.id===sid).title='精炼后的会话主题';jobs.set(key,{status:'complete',requestId,title:'精炼后的会话主题'});},120);
  return jobs.get(key);
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');let body={},value={};
    if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw||'{}');if(p!=='/api/activity')writes.push({p,body});}
    if(unavailableOnly&&p.endsWith('/ai-rename')){
      if(req.method==='GET')titleReads++;
      const fail=unavailableAt==='preflight'||unavailableAt==='session'||unavailableAt==='submit'&&req.method==='POST'||unavailableAt==='poll'&&url.searchParams.has('requestId');
      if(fail){res.statusCode=404;res.end(JSON.stringify({error:unavailableAt==='session'?'找不到这个会话':'页面不存在'}));return;}
      if(unavailableAt==='close'&&req.method==='GET'){setTimeout(()=>res.end(JSON.stringify({status:'ready'})),350);return;}
    }
    if(p==='/api/auth')value={authenticated:true,csrf:'fixture',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'},uiLanguage:'zh'};
    else if(p==='/api/clients')value={clients:['codex','deepseek'].map(id=>({id,name:id,enabled:true,configured:true,connected:true,installed:true,running:true}))};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sidebar-preferences')value={revision:0,fields:{}};
    else if(p==='/api/sessions')value={sessions:rows,complete:true,sources:['desktop'],remoteHosts:[],sidebar:{sections:[],projects:[]}};
    else if(p==='/api/activity')value={sessions:[]};
    else if(p.startsWith('/api/sessions/')){
      const [,sid,action]=p.match(/^\/api\/sessions\/([^/]+)\/(.+)$/)||[];
      if(action==='auto-title')value={status:'unavailable',available:false};
      if(action==='rename'){rows.find(row=>row.id===sid).title=body.title;jobs.set('codex'+sid,{status:'manual',title:body.title});value={title:body.title};}
      if(action==='ai-rename')value=req.method==='POST'?start('codex',sid,body.id):jobs.get('codex'+sid)||{status:'ready'};
    }else if(p.startsWith('/api/desktop-sessions/deepseek/')){
      const action=p.split('/').at(-1),sid=req.method==='POST'?body.sessionId:url.searchParams.get('sessionId');
      if(action==='list')value={connected:true,sessions:deepseek,projects:[],sidebar:{sections:[],placements:{}},capabilities:{sidebar:true}};
      if(action==='manage'&&body.operation==='rename'){deepseek.find(row=>row.id===sid).title=body.title;jobs.set('deepseek'+sid,{status:'manual',title:body.title});value={status:'accepted'};}
      if(action==='manage'&&body.operation==='ai-rename')value=start('deepseek',sid,body.id);
      if(action==='title-status')value=jobs.get('deepseek'+sid)||{status:'ready'};
    }
    if(url.searchParams.get('requestId')&&value.requestId!==url.searchParams.get('requestId'))value={status:'unknown'};
    if(['lost','not-received'].includes(mode)&&req.method==='POST'&&(p.endsWith('/ai-rename')||body.operation==='ai-rename')){res.writeHead(200,{'Content-Length':1000});res.flushHeaders();res.write('{');setTimeout(()=>res.destroy(),5);return;}
    res.end(JSON.stringify(value));return;
  }
  if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(web,'index.html')));return;}
  let files=assets[p];if(!files&&(p.startsWith('/vendor/')||p.startsWith('/client-icons/'))&&!p.includes('..'))files=p.slice(1);
  if(!files){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream');
  res.end(Buffer.concat([].concat(files).map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
  try{
    browser=await chromium.launch({headless:true,...process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}});
    for(const failure of unavailableOnly?['preflight','submit','poll','session','close']:['none'])for(const width of unavailableOnly?[820]:[320,390,820,1280])for(const provider of unavailableOnly?['codex']:['codex','deepseek']){
      reset();mode='success';unavailableAt=failure;titleReads=0;const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<1000}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(()=>{localStorage.setItem('list-mode','recent');localStorage.setItem('navigation:sidebar','open');});
      await page.goto('http://127.0.0.1:'+server.address().port);
      await page.waitForFunction(()=>listReadFinished&&listRows.length===2);
      if(provider==='deepseek'){await page.locator('.client-navigation').getByRole('button',{name:'deepseek',exact:true}).click();await page.waitForFunction(()=>desktopSessions.provider==='deepseek'&&desktopSessions.rows.length===2);}
      const sid=provider==='codex'?id(2):'deepseek-2',selector=(provider==='codex'?'#sessions':'.ds-list')+' [data-id="'+sid+'"]',label=provider+' '+width;
      const menu=async()=>{
        const row=page.locator(selector);await row.scrollIntoViewIfNeeded();
        if(width>=1000)await row.click({button:'right'});
        else{const box=await row.boundingBox();await row.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:box.x+20,clientY:box.y+20});await page.waitForTimeout(650);await row.dispatchEvent('pointerup',{pointerType:'touch',isPrimary:true});}
        await page.locator('.chat-context-menu[open]').waitFor();
      };
      await menu();check(await page.getByRole('button',{name:'AI重命名',exact:true}).isVisible(),'菜单显示AI重命名 '+label);
      if(unavailableOnly){
        await page.getByRole('button',{name:'AI重命名',exact:true}).click();
        if(failure==='close'){
          await page.locator('.ai-rename-dialog button').click();await page.waitForTimeout(500);
          check(writes.length===0,'检查能力期间关闭窗口不会继续提交模型任务');await context.close();continue;
        }
        const expected=failure==='session'?'找不到这个会话':'当前网关尚未提供 AI重命名';
        await page.waitForFunction(text=>document.querySelector('.ai-rename-dialog [role=status]')?.textContent.includes(text),expected,{timeout:4000});
        const seen=titleReads;await page.waitForTimeout(1700);
        check(titleReads===seen,'明确的接口或会话错误停止轮询 '+failure);
        check(writes.filter(write=>write.p.endsWith('/ai-rename')).length===(['preflight','session'].includes(failure)?0:1),'失败后不重复提交模型任务 '+failure);
        await context.close();continue;
      }
      await page.getByRole('button',{name:'重命名',exact:true}).click();
      const dialog=provider==='codex'?page.locator('#rename-dialog'):page.locator('dialog[open]');await dialog.locator('input').fill('手工设置的标题');
      await dialog.locator('button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
      check((provider==='codex'?rows:deepseek)[1].title==='手工设置的标题','未打开的聊天可手工改名 '+label);
      check((provider==='codex'?rows:deepseek)[0].title==='原有标题 1','其他聊天标题保持正确 '+label);
      await menu();await page.getByRole('button',{name:'AI重命名',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('.ai-rename-dialog [role=status]')?.textContent.includes('已生成并保存'));
      check((provider==='codex'?rows:deepseek)[1].title==='精炼后的会话主题','AI标题自动写回 '+label);
      const bounds=await page.locator('.ai-rename-dialog').boundingBox();check(bounds.x>=0&&bounds.x+bounds.width<=width+1,'窗口适合屏幕 '+label);
      await page.locator('.ai-rename-dialog button').click();
      check(writes.filter(write=>write.p.endsWith('/ai-rename')||write.body.operation==='ai-rename').length===1,'一次点击只提交一次 '+label);
      check(!writes.some(write=>/\/(send|reconnect|open)$/.test(write.p)),'改名不激活或发送聊天 '+label);
      if(width===1280){
        mode='lost';await menu();await page.getByRole('button',{name:'AI重命名',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('.ai-rename-dialog [role=status]')?.textContent.includes('已生成并保存'));
        check(writes.filter(write=>write.p.endsWith('/ai-rename')||write.body.operation==='ai-rename').length===2,'丢失回执只查询不重发 '+provider);
        await page.locator('.ai-rename-dialog button').click();mode='not-received';
        await menu();await page.getByRole('button',{name:'AI重命名',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ai-rename-dialog [role=status]')?.textContent.includes('尚未确认'));
        check(true,'未收到本次提交不会误用上次成功结果 '+provider);
        await page.locator('.ai-rename-dialog button').click();mode='unknown';
        await menu();await page.getByRole('button',{name:'AI重命名',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.ai-rename-dialog [role=status]')?.textContent.includes('尚未确认'));
        check(true,'未知结果显示清楚 '+provider);
      }
      if(process.argv.includes('--screenshots')){fs.mkdirSync(path.resolve('.tmp/chat-rename'),{recursive:true});await page.screenshot({path:path.resolve('.tmp/chat-rename',provider+'-'+width+'.png')});}
      await context.close();
    }
    check(errors.length===0,'页面无脚本异常：'+errors.join('; '));console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);console.error(errors);process.exitCode=1;});
