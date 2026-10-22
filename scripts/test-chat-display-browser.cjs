'use strict';
// Production scripts, isolated device caches, synthetic APIs; no real client operations.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web');
const read=file=>fs.readFileSync(path.join(web,file));
const assets=JSON.parse(read('assets.json')),id='11111111-1111-4111-8111-111111111111';
let display={revision:0,settings:{}},writes=0;
const row={id,host:'local',title:'Display fixture',cwd:'/fixture',status:'idle',access:{source:'desktop',canSend:true,canUseSideChat:true}};
const messages=[{key:'user',role:'user',kind:'userMessage',text:'Question'},
  {key:'command',role:'activity',kind:'commandExecution',title:'Command',text:'command output'},
  {key:'files',role:'activity',kind:'fileChange',title:'Changes',text:'file diff'},
  {key:'progress',role:'assistant',kind:'agentMessage',phase:'commentary',text:'Progress'},
  {key:'reason',role:'activity',kind:'reasoning',title:'Reasoning',text:'Public summary'},
  {key:'answer',role:'assistant',kind:'agentMessage',phase:'final_answer',text:'Final answer'}].map((message,order)=>({...message,turnId:'display-turn',turnStatus:'completed',order,version:'v1'}));
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost'),p=url.pathname;res.setHeader('Cache-Control','no-store');
    const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(p.startsWith('/api/')){
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;
      if(p==='/api/chat-display'){
        if(body){assert.equal(body.revision,display.revision);writes++;display={revision:display.revision+1,settings:{...display.settings,...body.changes}};}
        return json(display);
      }
      if(p==='/api/auth')return json({authenticated:true,csrf:'fixture',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'},chatDisplay:display});
      if(p==='/api/clients')return json({clients:[{id:'codex',enabled:true,connected:true,installed:true,running:true,configured:true}]});
      if(p==='/api/accounts')return json({accounts:[],current:{kind:'api'}});
      if(p==='/api/sidebar-preferences')return json({revision:0,fields:{}});
      if(p==='/api/sessions'||p==='/api/activity')return json({sessions:[row],complete:true,sidebar:{sections:[],projects:[]}});
      if(p.endsWith('/side-chat'))return json({id:'fixture-side',connected:true,turns:[{id:'display-turn',status:'completed',messages}],requests:[],submissions:[],slots:[{slot:'',id:'fixture-side'}]});
      if(p.endsWith('/timeline')||p.endsWith('/changes'))return json({epoch:'fixture',sequence:1,rows:messages,files:[],hasMore:false,meta:{...row,connected:true,requests:[],turns:[],queue:[]}});
      if(p.endsWith('/updates')){await new Promise(resolve=>setTimeout(resolve,100));return json({epoch:'fixture',sequence:1,rows:[],files:[],hasMore:false,meta:{...row,connected:true,requests:[],turns:[],queue:[]}});}
      if(p.endsWith('/message-index'))return json({revision:'fixture',status:'ready',complete:true,total:1,entries:[],nextCursor:null});
      return json({});
    }
    let sources=assets[p];if(!sources&&p.startsWith('/vendor/')&&!p.includes('..'))sources=p.slice(1);
    if(!sources){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p==='/'?'text/html; charset=utf-8':'application/octet-stream');
    res.end(Buffer.concat([].concat(sources).map(read)));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const checks=[],errors=[];
  const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const computer=await browser.newContext({viewport:{width:1440,height:900}});
    await computer.addInitScript(()=>localStorage.setItem('bridge-appearance',JSON.stringify({showProcess:false,showReasoning:false,theme:'dark'})));
    const desktop=await computer.newPage();desktop.on('pageerror',error=>errors.push(error.message));
    const address='http://127.0.0.1:'+server.address().port+'/#'+id+'~local';
    await desktop.goto(address);await desktop.waitForSelector('#messages [data-key="answer"]');
    for(const width of [390,820,844]){
      const phone=await browser.newContext({viewport:{width,height:width===844?390:844},hasTouch:true});
      const page=await phone.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(address);
      await page.waitForSelector('#messages [data-key="answer"]');
      await page.waitForFunction(()=>document.documentElement.dataset.showProcess==='false'&&document.documentElement.dataset.showReasoning==='false',null,{timeout:10000});
      check(await page.locator('#messages [data-key="command"]').isHidden(),'手机隐藏主聊天的命令 '+width);
      check(await page.locator('#messages [data-key="files"]').isHidden(),'手机隐藏文件变更 '+width);
      check(await page.locator('#messages .chat-progress-group').isVisible(),'手机保留独立的进度折叠框 '+width);
      check(!await page.locator('#messages .chat-progress-group').evaluate(node=>node.open),'已有最终结果时进度默认收起 '+width);
      check(await page.locator('#messages [data-key="reason"]').isHidden(),'手机独立同步思考摘要 '+width);
      check(await page.locator('#messages [data-key="answer"]').isVisible(),'手机保留最终回复 '+width);
      check(await page.evaluate(()=>document.documentElement.dataset.theme==='light'),'电脑主题不覆盖手机外观 '+width);
      await page.waitForFunction(()=>window.BridgeWorkbench?.current?.files.some(tab=>tab.sideChat?.state?.id));
      await page.evaluate(()=>{const wb=window.BridgeWorkbench;wb.select(wb.current.files.find(tab=>tab.sideChat?.state?.id).id);});
      check(await page.locator('.wb-side-message.activity').count()===3,'侧边聊天加载真实过程分类 '+width);
      check(await page.locator('.wb-side-message.activity:visible').count()===0,'侧边聊天遵守共享开关 '+width);
      if(width===390){
        await desktop.locator('[data-open-appearance]:visible').first().click();await desktop.locator('#appearance-process').check();
        await page.waitForFunction(()=>document.documentElement.dataset.showProcess==='true',null,{timeout:10000});
        check(await page.locator('.wb-side-messages .chat-process-group:visible').count()===1,'电脑切换后手机显示统一执行过程框');
        check(await page.locator('.wb-side-message.activity:visible').count()===0,'执行过程默认收起');
        await page.locator('.wb-side-messages .chat-process-group > summary').click();
        check(await page.locator('.wb-side-message.activity:visible').count()===2,'展开总框后分别显示命令和文件详情');
        check(await page.locator('#messages [data-key="reason"]').isHidden(),'开启过程不改变思考摘要开关');
        await desktop.locator('#appearance-process').uncheck();
        await page.waitForFunction(()=>document.documentElement.dataset.showProcess==='false',null,{timeout:10000});
        check(await page.locator('.wb-side-message.activity:visible').count()===0,'再次关闭后流式面板继续隐藏过程');
      }
      await phone.close();
    }
    check(display.settings.showProcess===false&&display.settings.showReasoning===false&&writes===3,'仅迁移已有关闭选择及两次显式切换');
    check(errors.length===0,'浏览器无脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
