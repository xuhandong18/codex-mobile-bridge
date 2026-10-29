'use strict';
// Production UI with synthetic APIs only; never starts a client or sends a model request.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const id='11111111-1111-4111-8111-111111111111';
const row={id,host:'local',title:'侧边聊天创建测试',cwd:'/fixture',projectKey:'local|/fixture',projectName:'Fixture',recency:1,status:'idle',access:{source:'cli',canSend:true,canApprove:true,canUseSideChat:true}};
const states=new Map(),writes=[],errors=[];let mode='success',serial=0,createGate=null,questionFixture=false;
const questions=[{id:'choice',question:'希望先解释哪个处理方案？',options:[{label:'先解释',description:'说明各个步骤'},{label:'直接处理',description:'执行已确认的方案'}]},{id:'free',question:'需要进一步说明的细节是什么？'}];
const questionRequests=()=>questionFixture?[{id:'fixture-question',supported:true,method:'item/tool/requestUserInput',params:{questions},needsInput:true,tool:'AskUserQuestion',input:{questions}}]:[];
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
    const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(p.startsWith('/api/')){
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):undefined;
      if(body)writes.push({p,body,slot:url.searchParams.get('slot')||''});
      if(p.endsWith('/side-chat')){
        const provider=p.includes('/desktop-sessions/')?'deepseek':'codex',slot=url.searchParams.get('slot')||'',key=provider+'|'+slot;
        if(body?.action==='create'){
          const resultMode=mode;await createGate;
          if(resultMode==='fail')return json({error:'创建失败，请重试'},503);
          if(!states.has(key))states.set(key,{id:'child-'+(++serial),connected:true,status:'idle',model:'fixture',turns:[],requests:[],submissions:[]});
          if(resultMode==='lost'){
            if(provider==='deepseek')return json({status:'unknown',message:'创建结果待核对'});
            res.writeHead(200,{'Content-Type':'application/json','Content-Length':1000});res.flushHeaders();res.write('{');
            setTimeout(()=>res.destroy(),5);return;
          }
        }
        const state=states.get(key);
        if(body?.action==='send'){
          assert.equal(body.id,state?.id);
          if(body.mode==='send'&&state.status==='active')return json({error:'请先等待回复完成，或选择完成后发送／补充当前任务'},400);
          if(body.mode==='queue'){
            state.submissions.push({id:body.submissionId,text:body.text,status:'queued'});return json({status:'queued'});
          }
          if(body.mode==='steer'){
            assert.equal(state.status,'active');state.turns.at(-1).messages.push({role:'user',text:body.text});return json({status:'accepted'});
          }
          state.turns.push({messages:[{role:'user',text:body.text},{role:'assistant',text:'可以直接聊天'}]});
          return json({status:'accepted'});
        }
        if(body?.action==='cancel-queued')state.submissions.find(row=>row.id===body.submissionId).status='cancelled';
        const slots=[...states].filter(([k])=>k.startsWith(provider+'|')).map(([k,v])=>({slot:k.slice(provider.length+1),id:v.id}));
        return json({...state||{id:null,connected:false,turns:[]},requests:questionRequests(),slots});
      }
      if(p==='/api/auth')return json({authenticated:true,csrf:'fixture',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}});
      if(p==='/api/clients')return json({clients:['codex','deepseek'].map(id=>({id,name:id,enabled:true,connected:true,configured:true,installed:true,running:true}))});
      if(p==='/api/accounts')return json({accounts:[],current:{kind:'api'}});
      if(p==='/api/sessions'||p==='/api/activity')return json({sessions:[row],complete:true});
      if(p.endsWith('/workspace/preview'))return json({name:'demo.js',kind:'text',size:24,text:'const selected = true;\n'});
      if(p.endsWith('/workspace'))return json({root:'/fixture',entries:[]});
      if(p.endsWith('/timeline')||p.endsWith('/updates')){
        if(p.endsWith('/updates'))await new Promise(resolve=>setTimeout(resolve,100));
        return json({epoch:'fixture',sequence:1,rows:[],files:[],hasMore:false,meta:{...row,connected:true,requests:questionRequests(),turns:[],queue:[]}});
      }
      if(p.startsWith('/api/desktop-sessions/')){
        if(p.endsWith('/list'))return json({connected:true,sessions:[row]});
        if(p.endsWith('/detail'))return json({connected:true,session:{...row,requests:questionRequests()},capabilities:{send:true,sideChat:true},messages:[]});
      }
      return json({});
    }
    let parts=assets[p];
    if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|deepseek|claude)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
    if(!parts){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p==='/'?'text/html; charset=utf-8':'application/octet-stream');
    res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
  }catch(error){errors.push(error.message);res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const results=[];
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const [width,height] of [[390,844],[820,1180],[844,390],[1440,1000]])for(const provider of ['codex','deepseek']){
      states.clear();writes.length=0;mode='success';
      const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));
      const checks=[],check=(value,label)=>{assert.ok(value,provider+' '+width+': '+label);checks.push(label);};
      const createWrites=()=>writes.filter(write=>write.body.action==='create');
      const bind=()=>page.evaluate(provider=>{
        window.creationWorkbench=provider==='codex'?workbench:desktopSessions.workbench;
        window.creationPanel=()=>creationWorkbench.current.files.find(tab=>tab.id===creationWorkbench.current.active)?.sideChat;
      },provider);
      const openDeepSeek=async()=>{
        await page.waitForFunction(()=>!document.querySelector('#app').hidden&&!entering);
        await page.evaluate(hash=>BridgeNavigation.openChat(hash),'#'+id+'~desktop%3Adeepseek');
        await page.waitForFunction(()=>desktopSessions.provider==='deepseek'&&desktopSessions.freshDetail);
      };
      await page.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');await page.waitForFunction(()=>state?.connected);
      if(provider==='deepseek')await openDeepSeek();
      await bind();
      const open=async()=>{
        await page.locator('.wb-add:visible').click();
        await page.locator('.wb-new-tab .wb-tab-choices button').filter({hasText:'侧边聊天'}).click();
      };
      const ready=()=>page.waitForFunction(()=>creationPanel()?.state?.connected&&!creationPanel().busy);
      let releaseCreate;createGate=new Promise(resolve=>releaseCreate=resolve);
      await open();await page.waitForFunction(()=>creationPanel()?.busy);
      check(await page.evaluate(()=>creationPanel().landing.hidden&&!creationPanel().status.hidden),'创建时显示进度，跳过创建按钮页面');
      createGate=null;releaseCreate();
      await ready();
      check(createWrites().length===1,'选择侧边聊天只创建一次');
      check(await page.evaluate(()=>!creationPanel().form.hidden&&creationPanel().landing.hidden),'创建成功直接显示输入区');
      check(!writes.some(write=>write.body.action==='send'),'创建不会自动发送消息');
      await page.locator('.wb-side-composer:visible textarea').fill('创建后直接聊天');
      await page.locator('.wb-side-composer:visible button[type=submit]').click();
      await page.waitForFunction(()=>creationPanel().messages.textContent.includes('可以直接聊天'));
      check(writes.filter(write=>write.body.action==='send').length===1,'无需再点创建就能发送消息');
      const sideInput=page.locator('.wb-side-composer:visible textarea');
      for(const platform of ['MacIntel','Win32']){
        await page.evaluate(platform=>{Object.defineProperty(navigator,'platform',{value:platform,configurable:true});Object.defineProperty(navigator,'userAgentData',{value:{platform:platform==='MacIntel'?'macOS':'Windows'},configurable:true});},platform);
        const before=writes.filter(write=>write.body.action==='send').length;
        await sideInput.fill('侧边聊天快捷键 '+platform);await sideInput.press('Enter');await sideInput.press('Shift+Enter');
        await sideInput.press(platform==='MacIntel'?'Control+Enter':'Meta+Enter');
        check(writes.filter(write=>write.body.action==='send').length===before,'侧边聊天普通回车和其他平台组合键不发送 '+platform);
        await sideInput.press(platform==='MacIntel'?'Meta+Enter':'Control+Enter');await page.waitForFunction(()=>!creationPanel().input.value&&!creationPanel().busy);
        check(writes.filter(write=>write.body.action==='send').length===before+1,'侧边聊天按平台快捷键只发送一次 '+platform);
      }
      const runningState=states.get(provider+'|'+await page.evaluate(()=>creationPanel().tab.slot||''));
      const sendWrites=()=>writes.filter(write=>write.body.action==='send');
      const choice=page.locator('.running-send-dialog[open]');
      runningState.status='active';await page.evaluate(()=>creationPanel().load());
      await sideInput.fill('运行中的下一条消息');
      check(await page.locator('.wb-side-composer:visible button[type=submit]').isEnabled(),'运行中默认发送按钮仍可使用');
      let beforeRunning=sendWrites().length;
      await sideInput.press('Control+Enter');await choice.waitFor();
      check(sendWrites().length===beforeRunning,'运行中快捷键先选择发送方式，不提前发送');
      check(await choice.getByRole('button',{name:'排队发送',exact:true}).isVisible()&&await choice.getByRole('button',{name:'补充当前任务',exact:true}).isVisible(),'运行中明确展示排队和补充两个入口');
      if(process.argv.includes('--screenshots')&&width===390){const dir=path.join(root,'.tmp/side-running-send');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,provider+'-choice.png')});}
      await page.keyboard.press('Escape');await choice.waitFor({state:'hidden'});
      check(sendWrites().length===beforeRunning&&await sideInput.inputValue()==='运行中的下一条消息','取消选择不发送并保留草稿');
      await page.locator('.wb-side-composer:visible button[type=submit]').click();await choice.waitFor();
      await choice.getByRole('button',{name:'排队发送',exact:true}).click();await page.waitForFunction(()=>!creationPanel().busy&&!creationPanel().input.value);
      check(sendWrites().length===beforeRunning+1&&sendWrites().at(-1).body.mode==='queue','选择排队只提交一次排队消息');
      check(await page.locator('.wb-side-queue:visible .queue-card').count()===1,'待发送消息显示在侧边队列');
      await page.locator('.wb-side-queue:visible').getByRole('button',{name:'取消',exact:true}).click();await page.waitForFunction(()=>!creationPanel().busy&&!creationPanel().queued.children.length);
      check(runningState.submissions.at(-1).status==='cancelled','待发送消息可以撤回');
      await sideInput.fill('纠正当前任务方向');await page.locator('.wb-side-composer:visible button[type=submit]').click();await choice.waitFor();
      await choice.getByRole('button',{name:'补充当前任务',exact:true}).click();await page.waitForFunction(()=>!creationPanel().busy&&!creationPanel().input.value);
      check(sendWrites().at(-1).body.mode==='steer'&&sendWrites().at(-1).body.workMode===null&&sendWrites().at(-1).body.id===runningState.id,'补充发给当前侧边聊天，并沿用任务模式');
      check(runningState.turns.at(-1).messages.at(-1).text==='纠正当前任务方向','补充保留在当前轮次');
      if(provider==='codex'){
        runningState.status='idle';await page.evaluate(()=>creationPanel().load());runningState.status='active';
        await sideInput.fill('发送前才开始运行');const beforeRace=sendWrites().length;await page.locator('.wb-side-composer:visible button[type=submit]').click();await choice.waitFor();
        check(sendWrites().length===beforeRace+1&&await choice.getByRole('button',{name:'补充当前任务',exact:true}).isEnabled(),'状态变化导致明确拒绝后刷新状态，再允许用户选择');
        await choice.getByRole('button',{name:'补充当前任务',exact:true}).click();await page.waitForFunction(()=>!creationPanel().busy&&!creationPanel().input.value);
        check(sendWrites().length===beforeRace+2&&sendWrites().at(-1).body.mode==='steer','竞态后的补充仅在用户选择后发送');
      }
      runningState.status='idle';await page.evaluate(()=>creationPanel().load());
      if(process.argv.includes('--running-send-only')){results.push({width,height,provider,passed:checks.length});await context.close();continue;}
      const first=await page.evaluate(()=>creationPanel().state.id);
      await page.getByRole('button',{name:'新建侧边聊天',exact:true}).click();await ready();
      check(createWrites().length===2&&await page.evaluate(()=>creationPanel().state.id)!==first,'新建侧边聊天按钮同样直接创建独立聊天');
      check(new Set(createWrites().map(write=>write.slot)).size===2,'独立标签使用不同槽位');
      const count=createWrites().length;await page.reload();
      if(provider==='deepseek')await openDeepSeek();
      await page.waitForFunction(provider=>(provider==='codex'?workbench:desktopSessions.workbench).current?.files.length===2,provider);
      await bind();
      check(createWrites().length===count,'刷新恢复已有聊天只读取，不重复创建');
      if(width===390){
        mode='fail';await open();await page.waitForFunction(()=>!creationPanel().busy&&creationPanel().status.textContent==='创建失败，请重试');
        check(await page.evaluate(()=>!creationPanel().landing.hidden&&!creationPanel().createButton.disabled),'创建失败后保留可用的重试入口');
        const failed=createWrites().at(-1);await page.evaluate(()=>creationPanel().load());
        check(createWrites().length===count+1,'失败后的读取不会重放创建');
        mode='success';await page.getByRole('button',{name:'创建侧边聊天',exact:true}).click();await ready();
        check(createWrites().at(-1).body.creationId===failed.body.creationId,'显式重试沿用创建标识');
        mode='lost';await open();await page.waitForFunction(()=>!creationPanel().busy);
        await page.evaluate(()=>creationPanel().load());await ready();
        check(createWrites().length===count+3,'回执丢失通过读取恢复，不自动重发');
      }
      mode='success';
      const beforeQuote=createWrites().length,beforeSend=writes.filter(write=>write.body.action==='send').length;
      await page.evaluate(()=>{
        const wb=creationWorkbench;wb.select('chat');wb.fileQuotes.input.value='保留主聊天草稿';
        const body=document.createElement('div');body.className='message-body';body.style.whiteSpace='pre-wrap';body.textContent='选区中的第一行\n选区中的第二行';
        const messages=wb===workbench?$('messages'):desktopSessions.messages;messages.append(body);
        const range=document.createRange();range.selectNodeContents(body);getSelection().removeAllRanges();getSelection().addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        (wb===workbench?selectedTextAction:desktopSessions.selectionAction).update();
      });
      await page.getByRole('button',{name:'选区操作',exact:true}).filter({visible:true}).click();
      await page.locator('.file-quote-target[open] [data-quote-target="new-sidechat"]').click();
      check(await page.evaluate(()=>creationPanel()?.busy||!!creationPanel()?.state?.id),'选区操作选择新建后立即创建聊天');
      await ready();
      check(createWrites().length===beforeQuote+1,'选区操作只创建一次独立侧边聊天');
      check(await page.evaluate(()=>creationPanel().landing.hidden&&!creationPanel().form.hidden&&!creationPanel().sendButton.disabled),'选区操作直接显示可以发送的输入区');
      check(await page.evaluate(()=>creationPanel().input.value==='> 选区中的第一行\n> 选区中的第二行\n\n'),'直接创建后完整保留选中的多行文字');
      check(await page.evaluate(()=>creationWorkbench.fileQuotes.input.value==='保留主聊天草稿'),'选区操作保留主聊天草稿');
      check(writes.filter(write=>write.body.action==='send').length===beforeSend,'选区新建不会自动发送文字');
      const expiredSlot=await page.evaluate(()=>{
        const wb=creationWorkbench,session=wb.current;
        window.expirationSource=creationPanel();
        window.expirationTab=session.files.find(tab=>tab.sideChat?.state?.turns?.some(turn=>turn.messages?.some(message=>message.text==='创建后直接聊天')));
        window.expirationPanel=expirationTab.sideChat;clearTimeout(expirationPanel.timer);
        expirationPanel.input.value='失效前的未发送草稿';expirationPanel.input.dispatchEvent(new Event('input'));
        wb.select('chat');wb.selectionTargets.addText('选择窗口打开后目标才失效');
        return expirationTab.slot||'';
      });
      const expirationWrites=writes.length;
      states.delete(provider+'|'+expiredSlot);
      await page.evaluate(()=>creationWorkbench.refreshSideChats());
      await page.waitForFunction(()=>expirationPanel.state.expired);
      check(await page.evaluate(()=>!expirationPanel.state.connected&&expirationPanel.messages.textContent.includes('可以直接聊天')),'停留主聊天时也能发现侧边聊天失效并保留消息');
      await page.evaluate(()=>document.querySelector('.file-quote-target[open] [data-quote-target="'+expirationTab.id+'"]').click());
      check(await page.evaluate(()=>expirationPanel.input.value==='失效前的未发送草稿'),'选择窗口打开后目标失效也不能写入旧草稿');
      await page.evaluate(()=>creationWorkbench.selectionTargets.close());
      for(const source of ['main','side']){
        await page.evaluate(source=>{
          const wb=creationWorkbench;
          const sourcePanel=source==='side'?expirationSource:null;
          if(sourcePanel)wb.select(sourcePanel.tab.id);else wb.select('chat');
          const body=document.createElement('div');body.className='message-body';body.textContent='不能投递到失效聊天的选中文字';
          (sourcePanel?.messages||(wb===workbench?$('messages'):desktopSessions.messages)).append(body);
          const range=document.createRange();range.selectNodeContents(body);getSelection().removeAllRanges();getSelection().addRange(range);
          const action=sourcePanel?.selectionAction||(wb===workbench?selectedTextAction:desktopSessions.selectionAction);
          action.update();
          if(action.trigger.disabled)throw Error('合成文字选区没有启用真实选区入口');
          action.trigger.click();
          if(!wb.selectionTargets.dialog?.open)throw Error('真实选区入口没有打开目标选择窗口');
        },source);
        check(await page.evaluate(()=>document.querySelector('.file-quote-target[open] [data-quote-target="'+expirationTab.id+'"]').disabled),source==='main'?'主聊天选区不能选择失效侧边聊天':'其他侧边聊天选区不能选择失效侧边聊天');
        await page.evaluate(()=>creationWorkbench.selectionTargets.close());
      }
      await page.evaluate(()=>creationWorkbench.select(expirationTab.id));
      check(await page.evaluate(()=>expirationPanel.landing.hidden&&!expirationPanel.messageArea.hidden&&expirationPanel.input.readOnly&&expirationPanel.sendButton.disabled&&expirationPanel.status.textContent.includes('已失效')),'打开失效标签显示记录、只读提示并禁用输入和发送');
      await page.locator('.wb-side-composer:visible textarea').press('End');await page.keyboard.insertText('不应写入');
      check(await page.evaluate(()=>expirationPanel.input.value==='失效前的未发送草稿'),'真实键盘输入不能修改失效聊天');
      await page.evaluate(async()=>{await expirationPanel.send();await expirationPanel.create();});
      check(writes.length===expirationWrites,'失效检测、选区和发送尝试均不产生写入请求');
      await page.evaluate(async()=>{
        const wb=creationWorkbench,active=wb.current.files.find(tab=>tab.sideChat&&tab!==expirationTab&&!tab.sideChat.state?.expired&&tab.sideChat.state?.connected);
        await wb.close(expirationTab.id);wb.select(active.id);
      });
      check(writes.length===expirationWrites,'关闭失效标签不会误操作服务端其他聊天');
      results.push({width,height,provider,passed:checks.length});
      await page.addScriptTag({path:path.join(root,'tests/browser/side-message-navigation.browser.js')});
      const navigationWrites=writes.length,navigationChecks=await page.evaluate(provider=>runSideMessageNavigationBrowserTests(provider),provider);
      assert.ok(navigationChecks.length>0);assert.ok(!writes.slice(navigationWrites).some(write=>['create','send','respond'].includes(write.body.action)),'侧边历史导航不创建聊天或发送消息');
      results.push({width,height,provider,fixture:'side-message-navigation',passed:navigationChecks.length+1});await context.close();
      if(provider==='codex'){
        states.clear();writes.length=0;
        const quoteContext=await browser.newContext({viewport:{width,height}}),quotePage=await quoteContext.newPage();
        quotePage.on('pageerror',error=>errors.push(error.message));
        await quotePage.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');await quotePage.waitForFunction(()=>state?.connected);
        await quotePage.addScriptTag({path:path.join(root,'tests/browser/selection-targets.browser.js')});
        const quoteChecks=await quotePage.evaluate(()=>runSelectionTargetsBrowserTests());
        assert.ok(quoteChecks.length>0);assert.equal(createWrites().length,3,'主聊天和文件选区各自只创建对应的新聊天');
        results.push({width,height,provider,fixture:'selection-targets',passed:quoteChecks.length+1});await quoteContext.close();
      }
      states.clear();writes.length=0;
      const popupContext=await browser.newContext({viewport:{width,height},hasTouch:width!==1440}),popupPage=await popupContext.newPage();
      popupPage.on('pageerror',error=>errors.push(error.message));
      await popupPage.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');await popupPage.waitForFunction(()=>state?.connected);
      if(provider==='deepseek'){
        await popupPage.evaluate(hash=>BridgeNavigation.openChat(hash),'#'+id+'~desktop%3Adeepseek');
        await popupPage.waitForFunction(()=>desktopSessions.provider==='deepseek'&&desktopSessions.freshDetail);
      }
      await popupPage.addScriptTag({path:path.join(root,'tests/browser/selection-popup.browser.js')});
      const popupChecks=await popupPage.evaluate(({gesture,provider})=>runUnifiedSelectionPopupBrowserTests(gesture,provider),{gesture:width===1440?'mouse':'touch',provider});
      if(width===1440){
        const code=popupPage.locator('.wb-source-code code:visible'),selected=await code.textContent();
        await code.click({button:'right'});
        assert.equal(await popupPage.locator('dialog[open]').count(),0,'真实鼠标右键不会打开选区引用框');
        assert.equal(await popupPage.evaluate(()=>getSelection().toString()),selected,'真实右键保留文件完整选区');
        await popupPage.keyboard.press('Escape');await popupPage.locator('.wb-preview-quote:visible').click();
        await popupPage.locator('.file-quote-target[open] [data-quote-target="chat"]').click();
        assert.equal(await popupPage.evaluate(provider=>(provider==='codex'?workbench:desktopSessions.workbench).fileQuotes.rows[0].text,provider),selected,'实际点击引用选区保留完整文件文字');
        popupChecks.push('真实鼠标右键不弹框且选区保留','实际点击文件栏按钮完整引用');
      }
      assert.ok(popupChecks.length>0);assert.ok(!writes.some(write=>['send','respond'].includes(write.body.action)),'右键和选区入口不会发送消息或提交问题答案');
      results.push({width,height,provider,fixture:'selection-popup',passed:popupChecks.length+1});await popupContext.close();
      states.clear();writes.length=0;questionFixture=true;
      const questionContext=await browser.newContext({viewport:{width,height},hasTouch:width!==1440}),questionPage=await questionContext.newPage();
      questionPage.on('pageerror',error=>errors.push(error.message));
      await questionPage.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');await questionPage.waitForFunction(()=>state?.connected);
      if(provider==='deepseek'){
        await questionPage.evaluate(hash=>BridgeNavigation.openChat(hash),'#'+id+'~desktop%3Adeepseek');
        await questionPage.waitForFunction(()=>desktopSessions.provider==='deepseek'&&desktopSessions.freshDetail);
      }
      await questionPage.addScriptTag({path:path.join(root,'tests/browser/question-selection.browser.js')});
      const questionChecks=await questionPage.evaluate(provider=>runQuestionSelectionBrowserTests(provider),provider);
      assert.ok(questionChecks.length>0);assert.ok(!writes.some(write=>['send','respond'].includes(write.body.action)||/\/(send|respond)$/.test(write.p)),'选区引用不发送消息或提交问题答案');
      results.push({width,height,provider,fixture:'question-selection',passed:questionChecks.length+1});await questionContext.close();questionFixture=false;
    }
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.reduce((sum,result)=>sum+result.passed,0),results},null,2));
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.closeAllConnections();server.close();process.exitCode=1;});
