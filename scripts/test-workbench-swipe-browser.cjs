'use strict';
// Full production UI with isolated synthetic APIs; no native client or terminal process is used.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const id='11111111-1111-4111-8111-111111111111';
const access={source:'cli',canSend:true,canConfigure:false,canReconnect:false,canUseSideChat:true};
const row={id,host:'local',title:'滑动测试',cwd:'/fixture',projectKey:'local|fixture',projectName:'Fixture',status:'idle',access};
const writes=[],errors=[];
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
    if(p.startsWith('/api/')){
      let body='';for await(const chunk of req)body+=chunk;
      if(body)writes.push({p,body:JSON.parse(body)});
      let value={};res.setHeader('Content-Type','application/json');
      if(p==='/api/auth')value={authenticated:true,csrf:'fixture',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}};
      else if(p==='/api/clients')value={clients:['codex','deepseek'].map(id=>({id,name:id,enabled:true,connected:true,configured:true,installed:true,running:true}))};
      else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
      else if(p==='/api/sessions'||p==='/api/activity')value={sessions:[row],complete:true};
      else if(p.endsWith('/side-chat')){
        const slot=url.searchParams.get('slot')||'';
        value={id:'child-'+(slot||'default'),connected:true,status:'idle',model:'fixture',effort:'medium',turns:[],requests:[],submissions:[],slots:[{slot:'',id:'child-default'}]};
      }else if(p.endsWith('/subagents'))value={agents:[]};
      else if(p.endsWith('/workspace/git-status'))value={available:true,branch:'fixture',commit:'a'.repeat(40),project:'/fixture',scope:'.',entries:[]};
      else if(p.endsWith('/workspace/preview'))value={kind:'text',name:'fixture.txt',path:'fixture.txt',text:'文件预览',size:12};
      else if(p.endsWith('/timeline')||p.endsWith('/updates')){
        if(p.endsWith('/updates'))await new Promise(resolve=>setTimeout(resolve,100));
        value={epoch:'fixture',sequence:1,rows:[],files:[],hasMore:false,meta:{...row,connected:true,requests:[],turns:[],queue:[]}};
      }else if(p.startsWith('/api/desktop-sessions/')){
        if(p.endsWith('/list'))value={connected:true,sessions:[row]};
        else if(p.endsWith('/detail'))value={connected:true,session:row,capabilities:{send:true,sideChat:true},messages:[]};
      }
      return res.end(JSON.stringify(value));
    }
    let parts=assets[p];
    if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|deepseek|claude)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
    if(!parts){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p==='/'?'text/html; charset=utf-8':'application/octet-stream');
    res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
  }catch(error){errors.push(error.message);res.statusCode=500;res.end();}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const results=[];
    for(const [width,height] of [[390,844],[820,1180],[844,390],[1440,1000]])for(const provider of ['codex','deepseek']){
      const context=await browser.newContext({viewport:{width,height},hasTouch:true}),page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
      await page.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');await page.waitForFunction(()=>state?.connected);
      if(provider!=='codex'){
        await page.evaluate(hash=>BridgeNavigation.openChat(hash),'#'+id+'~desktop%3A'+provider);
        await page.waitForFunction(()=>desktopSessions.provider==='deepseek'&&desktopSessions.freshDetail);
      }
      await page.addScriptTag({path:path.join(root,'tests/browser/workbench-swipe.browser.js')});
      const tabs=await page.evaluate(provider=>prepareWorkbenchSwipeChecks(provider),provider),cdp=await context.newCDPSession(page),checks=[];
      const check=(ok,label)=>{assert.ok(ok,provider+' '+width+': '+label);checks.push(label);};
      const active=()=>page.evaluate(()=>swipeWorkbench.current.active);
      const select=tab=>page.evaluate(tab=>swipeWorkbench.select(tab),tab);
      const swipe=async(selector,dx)=>{
        await page.locator(selector).scrollIntoViewIfNeeded();
        const bounds=await page.locator(selector).boundingBox();assert.ok(bounds,'visible swipe source '+selector);
        const x=bounds.x+Math.min(bounds.width-8,Math.max(8,dx<0?bounds.width*.8:bounds.width*.2)),y=Math.max(8,Math.min(height-8,bounds.y+bounds.height/2));
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let i=1;i<=6;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/6,y}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      };
      const main=provider==='codex'?'#composer':'.ds-composer';
      for(const area of ['.composer-tools','textarea','.compose-bottom']){
        await select('chat');await swipe(main+' '+area,-100);check(await active()===tabs.first,'输入区 '+area+' 左滑');
        await swipe('.wb-side-composer textarea',100);check(await active()==='chat','侧边输入框右滑返回');
      }
      await swipe(main+' textarea',100);check(await active()==='chat','左边界不循环');
      await select(tabs.first);await swipe('.wb-side-composer .compose-bottom',-100);check(await active()==='git','侧边聊天到 Git');
      await swipe('.wb-git-clean',-100);
      if(await active()!=='agents'){
        fs.mkdirSync(path.join(root,'.tmp'),{recursive:true});await page.screenshot({path:path.join(root,'.tmp','workbench-swipe-failure.png')});
        console.error(await page.evaluate(()=>({active:swipeWorkbench.current.active,files:swipeWorkbench.current.files.map(tab=>tab.id),selection:window.getSelection().toString(),clean:document.querySelector('.wb-git-clean')?.getBoundingClientRect().toJSON()})));
      }
      check(await active()==='agents','Git 整页到子智能体');
      await swipe('.wb-agents .wb-empty',-100);check(await active()===tabs.second,'子智能体整页到侧边聊天');
      await swipe('.wb-side-composer textarea',-100);check(await active()===tabs.second,'文件标签阻断且不跳过');
      await select(tabs.third);await swipe('.wb-side-composer textarea',100);check(await active()===tabs.third,'文件另一侧也阻断');
      await swipe('.wb-side-composer textarea',-100);check(await active()===tabs.third,'终端阻断且不跳过');
      await select(tabs.fourth);await swipe('.wb-side-composer textarea',100);check(await active()===tabs.fourth,'终端另一侧也阻断');
      await swipe('.wb-side-composer textarea',-100);check(await active()===tabs.fourth,'右边界不循环');
      await select(tabs.file);await swipe('.wb-preview-content',100);check(await active()===tabs.file,'文件页面不响应');
      await select(tabs.terminal);await swipe('.wb-terminal textarea',100);check(await active()===tabs.terminal,'终端页面不响应');
      checks.push(...await page.evaluate(()=>runWorkbenchSwipeEdgeChecks()));
      if(await page.evaluate(()=>swipeWorkbench.canSplit())){
        await page.evaluate(tab=>{swipeWorkbench.split(tab);swipeWorkbench.setRatio(.55);},tabs.first);
        await swipe(main+' textarea',-100);check(await active()===tabs.first,'分屏主输入区按自身标签切换');
        await swipe('.wb-side-composer textarea',-100);check(await active()==='git','分屏侧边输入区切换右侧标签');
        await swipe('.wb-git-clean',100);check(await active()===tabs.first,'分屏 Git 整页返回侧边聊天');
        await swipe('.wb-side-composer textarea',100);
        check(await page.evaluate(tab=>swipeWorkbench.current.active==='chat'&&swipeWorkbench.current.splitTab===tab&&swipeWorkbench.current.splitRatio===.55,tabs.first),'返回主聊天保留分屏和比例');
        await page.evaluate(()=>{swipeWorkbench.unsplit();swipeWorkbench.select('chat');});
      }
      // A held touch must leave native long-press handling and the current tab intact.
      await select('chat');const point=await page.locator(main+' textarea').boundingBox(),x=point.x+point.width*.8,y=point.y+point.height/2;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
      await new Promise(resolve=>setTimeout(resolve,650));
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-100,y}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});check(await active()==='chat','长按后拖动不切换');
      await page.locator(main+' .composer-toggle').tap();
      check(await page.locator(main).evaluate(form=>form.classList.contains('is-collapsed')),'普通轻点仍可收起输入区');
      await page.locator(main+' .composer-toggle').tap();
      check(await page.locator(main).evaluate(form=>!form.classList.contains('is-collapsed')),'普通轻点仍可展开输入区');
      check(!writes.some(write=>write.p.endsWith('/send')||['send','create','stop','close','stage','stage-all','commit'].includes(write.body.action)),'滑动没有发送或 Git 写入');
      results.push({width,height,provider,passed:checks.length});await context.close();
    }
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.reduce((sum,result)=>sum+result.passed,0),results},null,2));
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.closeAllConnections();server.close();process.exitCode=1;});
