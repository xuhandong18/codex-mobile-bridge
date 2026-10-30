'use strict';
// Production page with synthetic goals and API only; no real Codex client.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const id='11111111-1111-4111-8111-111111111111',checks=[],errors=[],writes=[];
const access={source:'desktop',runtime:'desktop',canSend:true,canReconnect:true,canUseGoal:true};
const row={id,host:'local',title:'目标编辑测试',cwd:'/fixture',projectKey:'local|independent',projectName:'独立聊天',recency:1,updatedAt:1,access};
let goal,failEdit=false;
const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
const readBody=async req=>{let text='';for await(const part of req)text+=part;return JSON.parse(text||'{}');};
function page(){return {epoch:'fixture',sequence:1,rows:[],files:[],hasMore:false,meta:{...row,
  connected:true,loadingHistory:false,historyComplete:true,status:'active',goal,goalRuntimeAvailable:true,
  requests:[],submissions:[],collaborationMode:'default',model:'fixture-model'}};}
const server=http.createServer(async(req,res)=>{
  const p=new URL(req.url,'http://127.0.0.1').pathname;
  res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');let value={};
    if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/projects')value={projects:[]};
    else if(p==='/api/sessions')value={sessions:[row],hosts:[],sources:['desktop'],hasMore:false,complete:true};
    else if(p==='/api/activity')value={sessions:[]};
    else if(p.endsWith('/goal/edit')){
      const body=await readBody(req);writes.push({p,body});
      if(failEdit){failEdit=false;res.statusCode=409;return res.end(JSON.stringify({error:'保存失败，请重试'}));}
      if(body.expected.objective!==goal.objective||body.expected.status!==goal.status){
        res.statusCode=409;return res.end(JSON.stringify({error:'目标已发生变化，请刷新后重试'}));
      }
      await new Promise(resolve=>setTimeout(resolve,120));
      goal={...goal,objective:body.objective,tokensUsed:0};value={confirmed:true,status:goal.status,result:goal};
    }else if(p.endsWith('/send')||p.endsWith('/stop')||p.endsWith('/goal/status')){
      writes.push({p,body:await readBody(req)});res.statusCode=500;value={error:'编辑目标不应触发此操作'};
    }else if(p.endsWith('/reconnect')){req.resume();value={ok:true,connected:true};}
    else if(p.endsWith('/catalog'))value={kind:'models',models:[],currentModel:'fixture-model'};
    else if(p.endsWith('/timeline')||p.endsWith('/changes')){
      if(p.endsWith('/changes'))await new Promise(resolve=>setTimeout(resolve,100));value=page();
    }else if(p.endsWith('/message-index'))value={revision:'fixture',items:[],complete:true,total:0};
    else if(p.endsWith('/notifications'))value={available:false};
    return res.end(JSON.stringify(value));
  }
  if(p==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(fs.readFileSync(path.join(web,'index.html')));}
  let parts=assets[p];
  if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
  if(!parts){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280])for(const language of ['zh','en']){
      const label=width+' '+language;writes.length=0;goal={objective:'原目标',status:'active',createdAt:1,tokensUsed:553245,tokenBudget:800000};
      const context=await browser.newContext({viewport:{width,height:900}}),tab=await context.newPage();tab.setDefaultTimeout(10000);
      tab.on('pageerror',error=>errors.push(error.message));
      await tab.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');
      await tab.waitForFunction(()=>state?.goal?.status==='active'&&document.querySelector('.goal-edit'));
      await tab.evaluate(language=>{chatTimeline?.dispose();BridgeI18n.setLanguage(language);BridgeI18n.apply();workModes.render();},language);
      check(!/Cannot read|undefined|TypeError/.test(await tab.locator('#toast').textContent()),'页面初始化没有异常提示 '+label);
      check(await tab.locator('.goal-edit').isVisible(),'运行中显示修改入口 '+label);
      await tab.locator('.goal-edit').click();await tab.locator('.goal-editor').fill('修改后的目标');
      await tab.evaluate(()=>{document.querySelector('.goal-editor').setSelectionRange(2,4);workModes.render({...state,goal:{...state.goal,tokensUsed:553246}});});
      check(await tab.locator('.goal-editor').inputValue()==='修改后的目标','实时刷新保留编辑草稿 '+label);
      check(await tab.locator('.goal-editor').evaluate(el=>document.activeElement===el&&el.selectionStart===2&&el.selectionEnd===4),'实时刷新保留编辑焦点和选区 '+label);
      check(await tab.locator('.goal-editor').getAttribute('maxlength')==='4000','编辑保留字数上限 '+label);
      check(await tab.locator('#goal-state').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'编辑栏适应当前窗口 '+label);
      check((await tab.locator('#goal-state').textContent()).includes(language==='en'?'continues running':'保存后继续执行'),'运行中保存说明正确 '+label);
      if(process.argv.includes('--screenshots')&&language==='zh'){
        const directory=path.join(root,'.tmp','goal-edit');fs.mkdirSync(directory,{recursive:true});
        await tab.screenshot({path:path.join(directory,'goal-edit-'+width+'.png'),fullPage:true});
      }
      failEdit=true;await tab.locator('.goal-save').click();
      await tab.waitForFunction(()=>!workModes.busy()&&!!workModes.actionError);
      check(await tab.locator('.goal-editor').inputValue()==='修改后的目标','保存失败保留草稿 '+label);
      await tab.evaluate(()=>{document.querySelector('.goal-save').click();document.querySelector('.goal-save').click();});
      await tab.waitForFunction(()=>!workModes.busy()&&!workModes.editing&&state.goal.objective==='修改后的目标');
      check(writes.length===2&&writes[0].body.id===writes[1].body.id,'双击和失败重试沿用同一保存标识 '+label);
      check(goal.status==='active'&&goal.tokenBudget===800000,'保存后继续运行并保留预算 '+label);
      check(writes.every(w=>w.p.endsWith('/goal/edit')&&w.body.expected.status==='active'),'保存只修改目标，无暂停、停止或额外发言 '+label);
      check(!(await tab.locator('#toast').textContent()).includes(language==='en'?'paused':'暂停'),'成功提示不会误报暂停 '+label);
      goal={...goal,status:'paused'};await tab.evaluate(goal=>renderState({...state,goal}),goal);
      await tab.locator('.goal-edit').click();await tab.locator('.goal-editor').fill('暂停后修改');await tab.locator('.goal-save').click();
      await tab.waitForFunction(()=>!workModes.busy()&&!workModes.editing&&state.goal.objective==='暂停后修改');
      check(goal.status==='paused'&&writes.at(-1).body.expected.status==='paused','暂停目标保存后保持暂停 '+label);
      await context.close();
    }
    check(errors.length===0,'浏览器没有脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
