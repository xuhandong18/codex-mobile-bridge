'use strict';
// Production UI with synthetic APIs only; never starts a client or sends a model request.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const id='11111111-1111-4111-8111-111111111111';
const row={id,host:'local',title:'侧边聊天创建测试',cwd:'/fixture',status:'idle',access:{source:'cli',canSend:true,canUseSideChat:true}};
const states=new Map(),writes=[],errors=[];let mode='success',serial=0,createGate=null;
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
          assert.equal(body.id,state?.id);state.turns.push({messages:[{role:'user',text:body.text},{role:'assistant',text:'可以直接聊天'}]});
          return json({status:'accepted'});
        }
        const slots=[...states].filter(([k])=>k.startsWith(provider+'|')).map(([k,v])=>({slot:k.slice(provider.length+1),id:v.id}));
        return json({...state||{id:null,connected:false,turns:[],requests:[]},slots});
      }
      if(p==='/api/auth')return json({authenticated:true,csrf:'fixture',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}});
      if(p==='/api/clients')return json({clients:['codex','deepseek'].map(id=>({id,name:id,enabled:true,connected:true,configured:true,installed:true,running:true}))});
      if(p==='/api/accounts')return json({accounts:[],current:{kind:'api'}});
      if(p==='/api/sessions'||p==='/api/activity')return json({sessions:[row],complete:true});
      if(p.endsWith('/workspace/preview'))return json({name:'demo.js',kind:'text',size:24,text:'const selected = true;\n'});
      if(p.endsWith('/workspace'))return json({root:'/fixture',entries:[]});
      if(p.endsWith('/timeline')||p.endsWith('/updates')){
        if(p.endsWith('/updates'))await new Promise(resolve=>setTimeout(resolve,100));
        return json({epoch:'fixture',sequence:1,rows:[],files:[],hasMore:false,meta:{...row,connected:true,requests:[],turns:[],queue:[]}});
      }
      if(p.startsWith('/api/desktop-sessions/')){
        if(p.endsWith('/list'))return json({connected:true,sessions:[row]});
        if(p.endsWith('/detail'))return json({connected:true,session:row,capabilities:{send:true,sideChat:true},messages:[]});
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
      results.push({width,height,provider,passed:checks.length});await context.close();
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
    }
    assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:results.reduce((sum,result)=>sum+result.passed,0),results},null,2));
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.closeAllConnections();server.close();process.exitCode=1;});
