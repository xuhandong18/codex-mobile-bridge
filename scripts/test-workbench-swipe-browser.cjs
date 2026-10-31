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
      else if(p.endsWith('/terminal'))value={mode:p.startsWith('/api/desktop-sessions/')?'command':'pty',shell:'/fixture/shell',host:'local',cwd:'/fixture',running:true,cursor:1,output:url.searchParams.has('id')?'':'Synthetic terminal output\r\n'.repeat(80)};
      else if(p.endsWith('/workspace'))value={root:'/fixture',project:'Fixture',entries:[{name:'fixture.txt',path:'fixture.txt',kind:'file',size:12}],nextOffset:null};
      else if(p.endsWith('/workspace/git-status'))value={available:true,branch:'fixture',commit:'a'.repeat(40),project:'/fixture',scope:'.',entries:[]};
      else if(p.endsWith('/workspace/git-history'))value={commits:[{id:'a'.repeat(40),parents:[],subject:'合成提交',author:'Fixture',date:'2026-10-20',refs:'fixture'}],hasMore:false};
      else if(p.endsWith('/workspace/git-branches'))value={branches:[{name:'fixture',id:'a'.repeat(40),current:true}]};
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
    const sizes=process.argv.includes('--sidebar-only')?[[390,844],[720,844],[721,844],[820,1180],[844,390],[1440,1000]]:[[390,844],[820,1180],[844,390],[1440,1000]];
    for(const [width,height] of sizes)for(const provider of ['codex','deepseek']){
      const context=await browser.newContext({viewport:{width,height},hasTouch:true}),page=await context.newPage();
      await context.addInitScript(()=>localStorage.setItem('navigation:sidebar','closed'));
      page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
      await page.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');await page.waitForFunction(()=>state?.connected);
      if(provider!=='codex'){
        await page.evaluate(hash=>BridgeNavigation.openChat(hash),'#'+id+'~desktop%3A'+provider);
        await page.waitForFunction(()=>desktopSessions.provider==='deepseek'&&desktopSessions.freshDetail);
      }
      await page.addScriptTag({path:path.join(root,'tests/browser/workbench-swipe.browser.js')});
      const tabs=await page.evaluate(provider=>prepareWorkbenchSwipeChecks(provider),provider),cdp=await context.newCDPSession(page),checks=[];
      await page.waitForFunction(()=>{const panel=swipeWorkbench.current.files.find(tab=>tab.id==='terminal')?.terminal;return panel?.running||panel?.fallback?.run?.disabled===false;});
      const check=(ok,label)=>{assert.ok(ok,provider+' '+width+': '+label);checks.push(label);};
      const active=()=>page.evaluate(()=>swipeWorkbench.current.active);
      const gitMode=()=>page.evaluate(()=>swipeWorkbench.current.files.find(tab=>tab.id==='git').git.mode);
      const waitGit=mode=>page.waitForFunction(mode=>{
        const git=swipeWorkbench.current.files.find(tab=>tab.id==='git').git;
        return git.mode===mode&&git.tab.body.querySelector(mode==='changes'?'.wb-git-clean':mode==='history'?'.wb-history-row':'.wb-branch-card');
      },mode);
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
      const timeline=provider==='codex'?'#timeline':'.ds-messages';
      const drawer=provider==='codex'?'#sidebar':'.ds-list';
      const toggle=provider==='codex'?'#chat>.chat-head>.sidebar-toggle':'.ds-conversation>.chat-head>.sidebar-toggle';
      const edgeSwipe=async(x=6,dy=0)=>{
        const y=Math.min(height-80,220);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let i=1;i<=6;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+100*i/6,y:y+dy*i/6}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      };
      await select(tabs.first);
      const savedDraft=await page.locator(main+' textarea').inputValue();
      await page.locator(toggle).tap();
      check(await page.locator(drawer).isVisible(),'导航按钮打开列表');
      await page.locator(drawer+' .list-heading').tap({position:{x:100,y:5}});
      check(await page.locator(drawer).isVisible(),'导航内部点击保持展开');
      await page.evaluate(()=>{window.sidebarOutsideClicks=0;swipeWorkbench.chat.addEventListener('click',()=>window.sidebarOutsideClicks++);});
      await page.touchscreen.tap(width-8,Math.min(height-80,220));
      if(width<=720){
        check(!await page.locator(drawer).isVisible(),'点击导航外侧收起抽屉');
        check(await page.evaluate(()=>sidebarOutsideClicks)===0,'收起点击不会穿透到聊天内容');
        await edgeSwipe();
        check(await page.locator(drawer).isVisible(),'屏幕左边缘右滑打开抽屉');
        check(await active()===tabs.first,'边缘右滑不会切换工作台标签');
        await page.evaluate(()=>document.querySelector('.sidebar-backdrop').click());
        check(await page.locator(drawer).isVisible(),'边缘滑动结束后的合成点击不会立即关闭');
        await page.waitForTimeout(420);await page.touchscreen.tap(width-8,220);
        check(!await page.locator(drawer).isVisible(),'滑动打开后点击外侧仍可收起');
        const guards=await page.evaluate(()=>{
          const checks=[],target=swipeWorkbench.chat.querySelector('.chat-head');
          const touch=(type,points,changed=points,node=target)=>{
            const make=point=>new Touch({identifier:point.id??1,target:node,clientX:point.x,clientY:point.y});
            node.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches:points.map(make),changedTouches:changed.map(make)}));
          };
          const start=(node=target,x=6)=>touch('touchstart',[{x,y:80}],undefined,node);
          const end=(node=target,x=110,y=80)=>touch('touchend',[],[{x,y}],node);
          const check=label=>{assertClosed();checks.push(label);};
          const assertClosed=()=>{if(sidebarNavigation.isOpen())throw Error('无关手势打开了导航');};
          start();touch('touchmove',[{x:10,y:130}]);end();check('纵向滚动不打开导航');
          start();touch('touchmove',[{x:60,y:80},{id:2,x:80,y:90}]);end();check('多指不打开导航');
          start();touch('touchcancel',[]);end();check('取消手势不打开导航');
          start();end(target,25);check('轻点和短滑不打开导航');
          start(target,40);end();check('非边缘右滑不打开导航');
          start();end(target,-60);check('左滑不打开导航');
          const input=swipeWorkbench.mainPane.querySelector('textarea');start(input);end(input);check('输入框编辑手势不打开导航');
          const text=document.createTextNode('选中的聊天文字');target.append(text);
          const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);
          start();end();check('选中文字时不打开导航');getSelection().removeAllRanges();text.remove();
          const dialog=document.createElement('dialog');document.body.append(dialog);dialog.showModal();start();end();check('对话框打开时不触发导航');dialog.close();dialog.remove();
          return checks;
        });
        checks.push(...guards);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:6,y:220}]});
        await page.waitForTimeout(650);
        await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:110,y:220}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        check(!await page.locator(drawer).isVisible(),'长按后拖动不打开导航');
      }else{
        check(await page.locator(drawer).isVisible()&&!await page.locator('.sidebar-backdrop').isVisible(),'宽屏外侧操作保留并排导航');
        await page.locator(drawer+' .sidebar-toggle').tap();
        check(await active()===tabs.first,'宽屏导航开合保留当前标签');
        await edgeSwipe();check(!await page.locator(drawer).isVisible(),'宽屏不启用抽屉边缘手势');
      }
      if(width<=720)check(await active()===tabs.first,'抽屉导航开合保留当前标签');
      check(await page.locator(main+' textarea').inputValue()===savedDraft,'导航开合保留聊天草稿');
      await select('chat');
      if(process.argv.includes('--sidebar-only')){
        results.push({width,height,provider,passed:checks.length});await context.close();continue;
      }
      for(const area of ['.wb-side-messages','.wb-side-head','.wb-side-content']){
        await select('chat');await swipe(timeline,-100);check(await active()===tabs.first,'主聊天消息区左滑');
        await swipe(area,100);check(await active()==='chat','侧边聊天 '+area+' 右滑返回');
      }
      await swipe(provider==='codex'?'#chat>.chat-head':'.ds-conversation>.chat-head',-100);check(await active()===tabs.first,'主聊天头部左滑同样切换标签');
      await swipe('.wb-side-head',100);check(await active()==='chat','侧边聊天头部右滑返回主聊天');
      for(const area of ['.composer-tools','textarea','.compose-bottom']){
        await select('chat');await swipe(main+' '+area,-100);check(await active()===tabs.first,'输入区 '+area+' 左滑');
        await swipe('.wb-side-composer textarea',100);check(await active()==='chat','侧边输入框右滑返回');
      }
      await swipe(main+' textarea',100);check(await active()==='chat','左边界不循环');
      await select(tabs.first);await swipe('.wb-side-composer .compose-bottom',-100);check(await active()==='git','侧边聊天到 Git');
      await waitGit('changes');await swipe('.wb-git-clean',100);
      check(await active()==='git'&&await gitMode()==='changes','变更内容区右滑在内部左边界停留');
      await swipe('.wb-git-clean',-100);await waitGit('history');
      check(await active()==='git'&&await gitMode()==='history','变更内容区左滑切换历史');
      await swipe('.wb-history-row',-100);await waitGit('branches');
      check(await active()==='git'&&await gitMode()==='branches','历史内容区左滑切换分支');
      check(!await page.locator('.wb-float').count(),'滑过历史提交不会点击打开详情');
      await swipe('.wb-branch-card',-100);
      check(await active()==='git'&&await gitMode()==='branches','分支内容区左滑在内部右边界停留');
      await swipe('.wb-branch-list',100);await waitGit('history');
      check(await active()==='git'&&await gitMode()==='history','分支内容区右滑切换历史');
      await swipe('.wb-history-list',100);await waitGit('changes');
      check(await active()==='git'&&await gitMode()==='changes','历史内容区右滑切换变更');
      await swipe('.wb-git-heading',-100);
      check(await active()==='agents','Git 标题栏左滑切换外层子智能体标签');
      await swipe('.wb-agents .wb-empty',-100);check(await active()===tabs.second,'子智能体整页到侧边聊天');
      await swipe('.wb-side-composer textarea',-100);check(await active()===tabs.file,'侧边聊天进入文件预览');
      await swipe('.wb-preview-content',-100);check(await active()===tabs.third,'文件整页左滑到侧边聊天');
      await swipe('.wb-side-composer textarea',100);check(await active()===tabs.file,'侧边聊天右滑进入文件预览');
      await swipe('.wb-preview-content',100);check(await active()===tabs.second,'文件整页右滑返回');
      await select(tabs.third);await swipe('.wb-side-composer textarea',-100);check(await active()===tabs.terminal,'侧边聊天进入终端');
      await swipe('.wb-terminal-screen .xterm-screen,.wb-terminal-output',-100);check(await active()===tabs.fourth,'真实终端输出区左滑到侧边聊天');
      await swipe('.wb-side-composer textarea',100);check(await active()===tabs.terminal,'侧边聊天右滑进入终端');
      await swipe('.wb-terminal-screen .xterm-screen,.wb-terminal-output',100);check(await active()===tabs.third,'真实终端输出区右滑返回');
      await select(tabs.fourth);
      await swipe('.wb-side-composer textarea',-100);check(await active()===tabs.fourth,'右边界不循环');
      checks.push(...await page.evaluate(()=>runWorkbenchSwipeEdgeChecks()));
      checks.push(...await page.evaluate(()=>runWorkbenchChatAreaChecks()));
      checks.push(...await page.evaluate(()=>runWorkbenchTransitionChecks()));
      await page.emulateMedia({reducedMotion:'reduce'});
      checks.push(...await page.evaluate(()=>runWorkbenchTransitionChecks(true)));
      await page.emulateMedia({reducedMotion:'no-preference'});
      await page.locator('.wb-tab[data-tab="'+tabs.first+'"] [role=tab]').tap();
      check(await active()===tabs.first&&await page.evaluate(()=>swipeWorkbench.current.files.find(tab=>tab.id===swipeWorkbench.current.active).body.getAnimations().some(animation=>animation.effect.getTiming().duration===180)),'直接点击标签同样播放切换动画');
      if(await page.evaluate(()=>swipeWorkbench.canSplit())){
        await page.evaluate(tab=>{swipeWorkbench.split(tab);swipeWorkbench.setRatio(.55);},tabs.first);
        await swipe(main+' textarea',-100);check(await active()===tabs.first,'分屏主输入区按自身标签切换');
        await swipe('.wb-side-composer textarea',-100);check(await active()==='git','分屏侧边输入区切换右侧标签');
        await waitGit('changes');await swipe('.wb-git-clean',-100);await waitGit('history');
        check(await active()==='git'&&await page.evaluate(()=>swipeWorkbench.current.splitTab==='git'),'分屏 Git 内容区只切换内部历史标签');
        await swipe('.wb-history-list',100);await waitGit('changes');
        await swipe('.wb-git-heading',100);check(await active()===tabs.first,'分屏 Git 标题栏返回侧边聊天');
        await swipe('.wb-side-composer textarea',100);
        check(await page.evaluate(tab=>swipeWorkbench.current.active==='chat'&&swipeWorkbench.current.splitTab===tab&&swipeWorkbench.current.splitRatio===.55,tabs.first),'返回主聊天保留分屏和比例');
        await page.evaluate(()=>{swipeWorkbench.unsplit();swipeWorkbench.select('chat');});
      }
      await page.evaluate(()=>swipeWorkbench.files());await page.waitForSelector('.wb-browser .wb-file-list');
      await swipe('.wb-browser .wb-file-list',-100);check(await active()===tabs.first,'文件目录整页左滑');
      await swipe('.wb-side-composer textarea',100);check(await active()==='files','侧边聊天右滑进入文件目录');
      await swipe('.wb-browser .wb-file-list',100);check(await active()==='chat','文件目录整页右滑返回主聊天');
      await swipe(main+' textarea',-100);check(await active()==='files','主聊天输入区左滑进入文件目录');
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
      check(!writes.some(write=>write.p.endsWith('/send')||write.p.includes('/workspace/git-')||['send','create','stop','close','stage','stage-all','commit','input','start'].includes(write.body.action)),'滑动没有发送消息、终端命令或 Git 写入');
      results.push({width,height,provider,passed:checks.length});await context.close();
    }
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.reduce((sum,result)=>sum+result.passed,0),results},null,2));
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.closeAllConnections();server.close();process.exitCode=1;});
