'use strict';
// 真实生产页面、独立浏览器存储和合成 API；不会读取聊天数据或连接真实客户端。
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json');
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const label='继续明确市场需求标准',prompt='预设内容';
const escapedPrompt='请检查 "中文引号"、C:\\fixture\\file.txt\n并保留第二行。';
const longLabel='检查中文、引号与路径，并在手机平板和电脑上继续明确市场需求标准'.repeat(3);
const action=(title,text)=>'- :codex-followup['+title+']{prompt='+JSON.stringify(text)+'}';
const single=action(label,prompt),multiple=action('检查中文与路径',escapedPrompt)+'\n'+action(longLabel,'长标题对应内容');
const writingContent='请帮我实现一个独立的研究工具。\n\n**工作方式**\n\n1. 保持原系统独立\n2. 由 AI 完成探测与回测\n\n工作区：D:\\fixture\\研究工具';
const writing='把下面整段复制到新聊天即可：\n\n:::writing{variant="standard" id="91846"}\n'+writingContent+'\n:::\n\n文稿之后的说明。';
const examples=[
  '> '+single,
  '```markdown\n'+single+'\n```',
  '`'+single+'`',
  '    '+single,
  '正文中的 :codex-followup[不是独立列表项]{prompt="不能填入"}',
  '- :codex-followup[未完成]{prompt="尚未闭合',
  '- :codex-followup[空提示]{prompt=""}',
  '- :codex-followup[坏转义]{prompt="\\q"}',
  '- :codex-followup[缺少参数]{}',
  '- :codex-followup[不独立]{prompt="不能填入"} 后面还有文字'
].join('\n\n');
const messages=[
  {key:'user',role:'user',kind:'userMessage',text:single},
  {key:'single',role:'assistant',kind:'agentMessage',text:single},
  {key:'multiple',role:'assistant',kind:'agentMessage',text:multiple},
  {key:'examples',role:'assistant',kind:'agentMessage',text:examples},
  {key:'writing',role:'assistant',kind:'agentMessage',text:writing},
  {key:'user-writing',role:'user',kind:'userMessage',text:writing}
].map((message,order)=>({...message,id:message.key,phase:'final_answer',turnId:'fixture-history',turnStatus:'completed',order,version:'v1',timestamp:Date.parse('2026-10-23T01:02:03Z')+order*1000}));
const longSession='33333333-3333-4333-8333-333333333333';
const longPrefix='长消息合成正文，用于验证截断边界，必须由完整正文决定快捷操作是否有效。'.repeat(80)+'\n\n';
const longCases=[
  {key:'truncated-example',title:'完整项后仍有说明',label:'不可误转的长消息示例',prompt:'这个示例不能填入',suffix:' 该列表项后面还有说明，因此它不是独立的快捷操作。'},
  {key:'truncated-legal',title:'完整正文以合法操作结尾',label:'完整加载后继续讨论',prompt:'合法长消息的预设内容',suffix:'\n\n'}
].map((value,order)=>({...value,preview:longPrefix+action(value.label,value.prompt),order}));
const longMessages=longCases.map(value=>({...messages[1],id:value.key,key:value.key,text:value.preview,order:value.order,truncated:true,turnId:'fixture-long-history'}));
const detailReads=[];
const access={source:'cli',canSend:true,canConfigure:false,canReconnect:false,canApprove:true,canUseSideChat:true};
const row=(id,host='local')=>({id,host,title:'快捷按钮合成聊天 '+(id===first?'一':'二'),cwd:'/fixture',status:'idle',access,recency:id===first?2:1,projectKey:host+'|fixture',projectName:'合成项目'});
const rows=[row(first),row(second),row(first,'fixture-remote'),{...row(longSession),title:'长消息截断合成聊天'}];
const sideState=()=>({id:'fixture-side',connected:true,status:'idle',turns:[{id:'fixture-history',status:'completed',messages}],requests:[],submissions:[],slots:[{slot:'',id:'fixture-side'}]});
const writes=[],readWrites=[],unexpected=[],serverErrors=[];let display={revision:0,settings:{}};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;
    res.setHeader('Cache-Control','no-store');
    const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(p.startsWith('/api/')){
      let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;
      // activity 的 POST 是只读查询；既有阅读记账另计，业务写入仍必须为零。
      if(p==='/api/activity/changes')return json({error:'夹具使用普通状态查询'},501);
      const mutation=!['GET','HEAD'].includes(req.method)&&p!=='/api/activity';
      if(mutation&&p.endsWith('/read-state')){readWrites.push({method:req.method,path:p,body});return json({status:'accepted',readCompletions:[body.turnId+':'+body.turnStatus]});}
      if(mutation)writes.push({method:req.method,path:p,body});
      if(p==='/api/chat-display'){
        if(mutation)display={revision:display.revision+1,settings:{...display.settings,...body?.changes}};
        return json(display);
      }
      if(mutation){unexpected.push({method:req.method,path:p,body});return json({error:'夹具禁止发送、创建、审批或其他写入'},409);}
      if(p==='/api/auth')return json({authenticated:true,csrf:'fixture-csrf',listCacheIdentity:'f'.repeat(64),computer:{name:'Synthetic fixture'},chatDisplay:display});
      if(p==='/api/clients')return json({clients:['codex','claude','deepseek'].map(id=>({id,name:id,enabled:true,configured:true,connected:true,installed:true,running:true}))});
      if(p==='/api/accounts')return json({accounts:[],current:{kind:'api'}});
      if(p==='/api/sidebar-preferences')return json({revision:0,fields:{}});
      if(p==='/api/projects')return json({projects:[]});
      if(p==='/api/sessions'||p==='/api/activity')return json({sessions:rows,complete:true,hasMore:false,hosts:[{id:'local',name:'合成本机'},{id:'fixture-remote',name:'合成远端'}],sidebar:{sections:[],projects:[]}});
      if(p.endsWith('/side-chat'))return json(sideState());
      if(p.startsWith('/api/desktop-sessions/')){
        const operation=p.split('/').at(-1),id=url.searchParams.get('sessionId')||first;
        if(operation==='list')return json({connected:true,sessions:[row(first),row(second)],capabilities:{send:true,sideChat:false}});
        if(operation==='detail')return json({connected:true,session:{...row(id),backend:'desktop',requests:[]},capabilities:{send:true,sideChat:false},messages,files:[]});
        if(operation==='account')return json({accounts:[],models:[]});
      }
      if(p==='/api/sessions/'+longSession+'/detail'){
        const key=url.searchParams.get('key')?.split('.').at(-1),offset=Number(url.searchParams.get('offset')||0),version=url.searchParams.get('version');
        const value=longCases.find(value=>value.key===key);detailReads.push({key,offset,version});
        if(!value||version!=='v1'||![0,value.preview.length].includes(offset))return json({error:'无效的合成长消息详情请求'},400);
        // 第一次读取仍恰好截到右花括号；next 不为空时仍不能确认末尾列表项。
        return json({key,version,offset,text:offset===0?value.preview:value.suffix,next:offset===0?value.preview.length:null,files:[]});
      }
      if(p.endsWith('/timeline')||p.endsWith('/changes')||p.endsWith('/updates')){
        if(p.endsWith('/updates'))await new Promise(resolve=>setTimeout(resolve,150));
        const session=p.split('/')[3];
        return json({epoch:'followups-fixture',sequence:1,rows:p.endsWith('/updates')?[]:session===longSession?longMessages:messages,files:[],hasMore:false,meta:{...row(session,url.searchParams.get('host')||'local'),connected:true,requests:[],turns:[],queue:[]}});
      }
      if(p.endsWith('/message-index'))return json({revision:'fixture',status:'ready',complete:true,total:1,entries:[],nextCursor:null});
      return json({});
    }
    const sources=assets[p]||((p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..')?p.slice(1):null);
    if(!sources){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.html')||p==='/'?'text/html; charset=utf-8':p.endsWith('.png')?'image/png':'application/octet-stream');
    res.end(Buffer.concat([].concat(sources).map(file=>fs.readFileSync(path.join(web,file)))));
  }catch(error){serverErrors.push(error.message);if(!res.headersSent)res.writeHead(500);res.end(JSON.stringify({error:error.message}));}
});

const checks=[],failures=[],screenshots=process.argv.includes('--screenshots')?path.resolve(__dirname,'../.tmp/chat-followups'):null;
async function test(name,fn){
  const baseline=writes.length;
  try{await fn();assert.deepEqual(writes.slice(baseline),[],'操作期间业务写入增量必须为零（阅读记账另计）');checks.push(name);console.log('通过：'+name);}
  catch(error){failures.push({name,error:error.message});console.error('失败：'+name+'\n'+error.message);}
}
async function open(page,id=first,provider='codex',host='local'){
  await page.evaluate(hash=>window.BridgeNavigation.openChat(hash),'#'+id+'~'+encodeURIComponent(provider==='codex'?host:'desktop:'+provider));
  await page.waitForFunction(({id,provider,host})=>provider==='codex'?currentId===id&&currentHost===host&&state?.connected&&!state.loadingHistory:desktopSessions.provider===provider&&desktopSessions.sid===id&&desktopSessions.freshDetail,{id,provider,host});
}
async function selectMain(page,kind){
  await page.evaluate(kind=>{const wb=kind==='desktop'?desktopSessions.workbench:window.BridgeWorkbench;wb.select('chat');},kind);
}
async function selectSide(page){
  await page.waitForFunction(()=>window.BridgeWorkbench?.current?.files.some(tab=>tab.sideChat?.state?.id));
  await page.evaluate(()=>{const wb=window.BridgeWorkbench,tab=wb.current.files.find(tab=>tab.sideChat?.state?.id);window.__fixtureSide=tab.sideChat;wb.select(tab.id);});
}
const inputSelector=kind=>kind==='main'?'#message':kind==='side'?'.wb-side-composer:visible textarea':'.ds-composer textarea';
const messageSelector=kind=>kind==='main'?'#messages':kind==='side'?'.wb-side-messages:visible':'.ds-messages';
async function installHelpers(page){
  await page.evaluate(()=>{
    // 仅适配夹具数据与生产入口，不替换解析器、按钮事件或填入实现。
    window.__followupFixture={
      view(kind){
        if(kind==='main')return {input:$('message'),quotes:workbench.fileQuotes,attachments,form:$('composer'),collapse:value=>{const toggle=$('composer-toggle');if((toggle.getAttribute('aria-expanded')==='false')!==value)toggle.click();},messages:$('messages')};
        if(kind==='side'){const panel=window.__fixtureSide;return {input:panel.input,quotes:panel.fileQuotes,attachments:panel.attachments,form:panel.form,collapse:value=>panel.collapse(value),messages:panel.messages};}
        const view=desktopSessions;return {input:view.input,quotes:view.workbench.fileQuotes,attachments:view.attachments,form:view.form,collapse:value=>view.collapseComposer(value),messages:view.messages};
      },
      capture(kind){
        if(kind==='main'){const id=currentId,host=currentHost,timeline=chatTimeline;return text=>fillMainFollowup(id,host,timeline,text);}
        if(kind==='side'){const panel=window.__fixtureSide,child=panel.state.id;return text=>panel.fillFollowup(child,text);}
        const view=desktopSessions,provider=view.provider,sid=view.sid,workspace=view.workbench.current;return text=>view.fillFollowup(provider,sid,workspace,text);
      },
      snapshot(kind){const {input,quotes,attachments}=this.view(kind);return {text:input.value,quotes:JSON.stringify(quotes.rows),attachments:JSON.stringify(attachments.rows)};},
      draftValues(){return Object.keys(localStorage).filter(key=>key.startsWith('bridge-composer-drafts:')).flatMap(key=>JSON.parse(localStorage.getItem(key)||'[]').map(row=>row[1]));}
    };
  });
}
async function resetDraft(page,kind,text=''){
  await page.evaluate(({kind,text})=>{const v=window.__followupFixture.view(kind);v.input.value=text;v.input.dispatchEvent(new Event('input',{bubbles:true}));}, {kind,text});
}
async function checkRendering(page,kind){
  const root=page.locator(messageSelector(kind)),buttons=root.locator('button.chat-followup');
  assert.equal(await buttons.count(),3,'历史助手正文应显示三个按钮；原文直出、按钮为零不能算通过');
  assert.deepEqual(await buttons.allTextContents(),[label,'检查中文与路径',longLabel]);
  assert.equal(await root.locator('.user button.chat-followup').count(),0,'用户消息不得转按钮');
  const actual=await buttons.first().evaluate(button=>({type:button.type,text:button.parentElement.textContent}));
  assert.equal(actual.type,'button','按钮不能提交表单');
  assert.ok(!actual.text.includes('codex-followup')&&!actual.text.includes('prompt=')&&!actual.text.includes('预设内容'),'有效操作正文不能暴露标记和预设内容');
  assert.ok((await root.innerText()).includes(':codex-followup'),'代码、引用和无效示例仍可阅读');
}
async function checkWriting(page,kind){
  const root=page.locator(messageSelector(kind)),cards=root.locator('.writing-block');
  assert.equal(await cards.count(),1,'助手文稿应识别为独立区域，用户原文不转换');
  const card=cards.first();
  assert.equal(await card.locator('ol li').count(),2,'文稿正文仍使用 Markdown 排版');
  assert.ok(!(await card.innerText()).includes(':::writing'));
  const bounds=await card.boundingBox(),container=await root.boundingBox();
  assert.ok(bounds.width>0&&bounds.x>=container.x-1&&bounds.x+bounds.width<=container.x+container.width+1,'手机与分屏文稿不能超出聊天区域');
  await card.locator('button.writing-copy').click();
  const copied=await page.evaluate(()=>navigator.clipboard.readText());
  assert.equal(copied.replace(/\r\n/g,'\n'),writingContent,'实际复制只包含完整文稿正文，不含容器标记和前后说明（兼容 Windows 剪贴板换行）');
  assert.ok((await root.locator('.user').allTextContents()).some(text=>text.includes(':::writing')),'用户粘贴的原文仍可阅读');
  if(screenshots&&kind==='side')await card.screenshot({path:path.join(screenshots,'writing-side-'+page.viewportSize().width+'.png')});
}
async function checkClick(page,kind){
  const root=page.locator(messageSelector(kind)),input=page.locator(inputSelector(kind));
  await resetDraft(page,kind);
  await page.evaluate(kind=>window.__followupFixture.view(kind).collapse(true),kind);
  await root.getByRole('button',{name:label,exact:true}).click();
  assert.equal(await input.inputValue(),prompt,'空输入框仅填入预设正文');
  const result=await input.evaluate(input=>({focused:document.activeElement===input,start:input.selectionStart,end:input.selectionEnd,height:input.getBoundingClientRect().height,collapsed:input.closest('form').classList.contains('is-collapsed')}));
  assert.equal(result.focused,true);assert.equal(result.start,prompt.length);assert.equal(result.end,prompt.length);
  assert.ok(!result.collapsed&&result.height>0,'点击后展开并更新输入框尺寸');
  if(kind!=='side')assert.ok(await page.evaluate(text=>window.__followupFixture.draftValues().includes(text),prompt),'输入事件应保存草稿到本机存储');
  await root.getByRole('button',{name:'检查中文与路径',exact:true}).focus();
  await root.getByRole('button',{name:'检查中文与路径',exact:true}).press('Enter');
  const expected=prompt+'\n\n'+escapedPrompt;
  assert.equal(await input.inputValue(),expected,'键盘操作追加一个空行，完整保留引号、反斜杠与换行');
  const end=await input.evaluate(node=>[node.selectionStart,node.selectionEnd]);assert.deepEqual(end,[expected.length,expected.length]);
}
async function checkPreservation(page,kind){
  await resetDraft(page,kind,'原草稿  \n');
  const before=await page.evaluate(kind=>{
    const f=window.__followupFixture,v=f.view(kind);
    if(!v.quotes.rows.length)v.quotes.add({path:'/fixture/quoted.txt',name:'quoted.txt',host:'local',text:'文件引用内容'});
    if(!v.attachments.rows.length){v.attachments.rows.push({id:'synthetic-attachment',name:'fixture.txt',size:12,status:'ready'});v.attachments.save(v.attachments.key,v.attachments.rows);v.attachments.render();}
    return f.snapshot(kind);
  },kind);
  await page.locator(messageSelector(kind)).getByRole('button',{name:label,exact:true}).click();
  const after=await page.evaluate(kind=>window.__followupFixture.snapshot(kind),kind);
  assert.equal(after.text,before.text+'\n\n'+prompt);assert.equal(after.quotes,before.quotes);assert.equal(after.attachments,before.attachments);
  await resetDraft(page,kind,'长度边界原草稿');
  const retained=await page.evaluate(kind=>{
    const f=window.__followupFixture,v=f.view(kind);window.__fixtureOldLimit=v.input.maxLength;
    v.input.maxLength=v.quotes.text(v.input.value).length;return f.snapshot(kind);
  },kind);
  try{
    await page.locator(messageSelector(kind)).getByRole('button',{name:label,exact:true}).click();
    assert.deepEqual(await page.evaluate(kind=>window.__followupFixture.snapshot(kind),kind),retained,'正文加文件引用超限时保留原草稿、附件和引用');
    const feedback=await page.locator('#toast').textContent();
    assert.ok(/过长|超|length|long/i.test(feedback||''),'超限应提供可见提示');
  }finally{await page.evaluate(kind=>{window.__followupFixture.view(kind).input.maxLength=window.__fixtureOldLimit;},kind);}
}
async function checkReadonly(page,kind){
  // 同一轮 evaluate 内修改并恢复状态，避免后台合成轮询与限制测试竞争。
  const results=await page.evaluate(kind=>{
    const f=window.__followupFixture,v=f.view(kind),invoke=f.capture(kind),results=[];
    const blocked=(name,object,changes)=>{const previous=Object.keys(changes).map(key=>({key,value:object[key],exists:key in object})),before=f.snapshot(kind);try{Object.assign(object,changes);invoke('禁止填入');results.push({name,unchanged:JSON.stringify(before)===JSON.stringify(f.snapshot(kind))});}finally{for(const {key,value,exists} of previous)if(exists)object[key]=value;else delete object[key];}};
    if(kind==='main'){
      blocked('只读',state,{access:{...state.access,readOnly:true,canSend:false}});
      blocked('断开',state,{connected:false});blocked('加载中',state,{loadingHistory:true});
    }else if(kind==='side'){
      blocked('只读',window.__fixtureSide.state,{readOnly:true});blocked('过期',window.__fixtureSide.state,{expired:true});blocked('断开',window.__fixtureSide.state,{connected:false});
    }else{
      blocked('旧缓存',desktopSessions,{freshDetail:false});blocked('禁止发送',desktopSessions.state,{capabilities:{...desktopSessions.state.capabilities,send:false}});
    }
    for(const property of ['readOnly','disabled'])blocked('输入框 '+property,v.input,{[property]:true});
    return results;
  },kind);
  for(const result of results)assert.ok(result.unchanged,result.name+'时旧回调不能填入');
}
async function checkStaleMain(page){
  await selectMain(page,'main');await resetDraft(page,'main','本机草稿');
  await page.evaluate(()=>{window.__oldMain=window.__followupFixture.capture('main');window.__oldButton=document.querySelector('#messages button.chat-followup');});
  await open(page,second);await resetDraft(page,'main','另一聊天草稿');
  await page.evaluate(()=>{window.__oldMain('跨聊天错误填入');window.__oldButton.click();});
  assert.equal(await page.locator('#message').inputValue(),'另一聊天草稿');
  await open(page,first);assert.equal(await page.locator('#message').inputValue(),'本机草稿','切回原聊天恢复草稿');
  // 相同 id/host、不同 timeline 也要拒绝原回调。
  await page.evaluate(()=>window.__oldMain('旧时间线错误填入'));
  assert.equal(await page.locator('#message').inputValue(),'本机草稿');
  await page.evaluate(()=>window.__localMain=window.__followupFixture.capture('main'));
  await open(page,first,'codex','fixture-remote');await resetDraft(page,'main','远端草稿');
  await page.evaluate(()=>window.__localMain('跨主机错误填入'));
  assert.equal(await page.locator('#message').inputValue(),'远端草稿');
  await open(page,first);assert.equal(await page.locator('#message').inputValue(),'本机草稿');
}
async function checkStaleSide(page){
  await selectSide(page);await resetDraft(page,'side','侧边草稿');
  await page.evaluate(()=>{window.__oldSide=window.__followupFixture.capture('side');window.__oldSideButton=window.__fixtureSide.messages.querySelector('button.chat-followup');});
  await selectMain(page,'main');
  await page.evaluate(()=>{window.__oldSide('隐藏侧边错误填入');window.__oldSideButton.click();});
  assert.equal(await page.evaluate(()=>window.__fixtureSide.input.value),'侧边草稿','侧边隐藏时拒绝旧按钮');
  await selectSide(page);assert.equal(await page.locator(inputSelector('side')).inputValue(),'侧边草稿','切换视图保留侧边草稿');
  await open(page,second);await resetDraft(page,'main','另一聊天正文');
  await page.evaluate(()=>window.__oldSide('跨聊天侧边错误填入'));
  assert.equal(await page.evaluate(()=>window.__fixtureSide.input.value),'侧边草稿');
  assert.equal(await page.locator('#message').inputValue(),'另一聊天正文');
  await open(page,first);await selectSide(page);
  await page.evaluate(async()=>{const panel=window.__fixtureSide;await panel.workbench.close(panel.tab.id);window.__oldSide('关闭侧边错误填入');window.__oldSideButton.click();});
  assert.equal(await page.evaluate(()=>window.__fixtureSide.disposed),true);
  assert.equal(await page.evaluate(()=>window.__fixtureSide.input.value),'','关闭侧边后旧回调不能恢复输入');
}
async function checkParserAndFill(page){
  const result=await page.evaluate(({single,examples,escapedPrompt})=>{
    const callbacks=[],node=document.createElement('div');document.body.append(node);
    const count=text=>{node.replaceChildren();renderMarkdown(node,text,[],undefined,{onFollowup:prompt=>callbacks.push(prompt)});return node.querySelectorAll('button.chat-followup').length;};
    try{
      const invalid=count(examples);node.replaceChildren();renderMarkdown(node,single);const withoutCallback=node.querySelectorAll('button.chat-followup').length;
      const stream=[];for(const source of ['- :codex-followup[继续]{prompt="预设',single,single])stream.push(count(source));
      const before=callbacks.length;node.querySelector('button.chat-followup')?.click();
      const input=document.createElement('textarea');input.maxLength=5;input.value='保留';node.append(input);
      let error='';try{window.ChatFollowups.fill(input,escapedPrompt);}catch(e){error=e.message;}
      return {invalid,withoutCallback,stream,before,callbacks,text:input.value,error};
    }finally{node.remove();}
  },{single,examples,escapedPrompt});
  assert.equal(result.invalid,0);assert.equal(result.withoutCallback,0,'文件预览等不提供回调的入口保留原文');
  assert.deepEqual(result.stream,[0,1,1],'流式刷新不重复生成按钮');assert.equal(result.before,0,'渲染不能自行填入');
  assert.deepEqual(result.callbacks,[prompt],'完整按钮点击只回调一次');assert.equal(result.text,'保留');assert.ok(result.error,'无文件引用时仍检查正文长度');
}
async function checkTruncatedMain(page){
  const baseline=detailReads.length;
  await open(page,longSession);await selectMain(page,'main');
  await resetDraft(page,'main','长消息原草稿');
  assert.equal(await page.locator('#messages button.chat-followup').count(),0,'预览恰好截到右花括号时，末尾候选不能变成按钮');
  assert.equal(detailReads.length,baseline,'仅显示截断预览不能预读完整正文');
  for(const value of longCases){
    const message=page.locator('#messages [data-key="'+value.key+'"]'),more=message.locator('button.detail-more');
    assert.equal(await message.locator('button.chat-followup').count(),0,value.title+'：预览不能生成按钮');
    assert.equal(await more.textContent(),'展开完整内容');
    await more.click();
    await page.waitForFunction(key=>{const node=document.querySelector('#messages [data-key="'+key+'"] button.detail-more');return node&&!node.disabled&&node.textContent==='继续加载正文';},value.key);
    assert.equal(await message.locator('button.chat-followup').count(),0,value.title+'：detail.next 未结束时仍不能确认末尾候选');
    assert.equal(await page.locator('#message').inputValue(),'长消息原草稿','展开详情不会自行填入预设内容');
    await more.click();await more.waitFor({state:'hidden'});
    const buttons=message.locator('button.chat-followup');
    if(value.key==='truncated-example'){
      assert.equal(await buttons.count(),0,'完整正文补上同一列表项的说明后，必须保持原文');
      assert.ok((await message.locator('.message-body').innerText()).includes(value.suffix.trim()),'实际补回了预览中缺少的说明');
    }else{
      assert.equal(await buttons.count(),1,'完整加载后，合法的长消息末尾操作必须恢复为按钮');
      assert.equal(await buttons.textContent(),value.label);
      await buttons.click();assert.equal(await page.locator('#message').inputValue(),'长消息原草稿\n\n'+value.prompt,'完整长消息按钮仍只追加本聊天草稿');
    }
  }
  assert.deepEqual(detailReads.slice(baseline),longCases.flatMap(value=>[{key:value.key,offset:0,version:'v1'},{key:value.key,offset:value.preview.length,version:'v1'}]),'完整内容必须由真实展开按钮逐页读取');
}
async function checkLiveCompletion(page,kind){
  const result=await page.evaluate(kind=>{
    const f=window.__followupFixture,before=f.snapshot(kind);let pending,completed,sameText;
    if(kind==='main'){
      const timeline=chatTimeline,original=timeline.rows.get('single').row;
      const apply=row=>timeline.apply({epoch:timeline.epoch,sequence:timeline.sequence+1,rows:[row],files:[],hasMore:false,meta:timeline.meta});
      const count=()=>timeline.nodes.get(original.key).node.querySelectorAll('button.chat-followup').length;
      try{
        apply({...original,turnStatus:'inProgress'});pending=count();
        apply({...original,turnStatus:'completed'});completed=count();
        sameText=timeline.rows.get(original.key).row.text===original.text;
      }finally{apply(original);}
    }else if(kind==='side'){
      const panel=window.__fixtureSide,original=panel.state;
      const apply=status=>panel.apply({...original,turns:original.turns.map(turn=>({...turn,status}))});
      const count=()=>panel.messageNodes.find(row=>row.message.id==='single').node.querySelectorAll('button.chat-followup').length;
      try{
        apply('inProgress');pending=count();apply('completed');completed=count();
        sameText=panel.messageNodes.find(row=>row.message.id==='single').message.text===original.turns[0].messages.find(message=>message.id==='single').text;
      }finally{panel.apply(original);}
    }else{
      const view=desktopSessions,originalMessages=view.lastMessages,originalStatus=view.state.status;
      const message=originalMessages.find(message=>message.id==='single'),identicalMessages=[message];
      try{
        view.state.status='active';view.renderMessages(identicalMessages);pending=view.messages.querySelectorAll('button.chat-followup').length;
        view.state.status='idle';view.renderMessages(identicalMessages);completed=view.messages.querySelectorAll('button.chat-followup').length;
        sameText=view.lastMessages[0]===message;
      }finally{view.state.status=originalStatus;view.renderMessages(originalMessages);}
    }
    return {pending,completed,sameText,unchanged:JSON.stringify(before)===JSON.stringify(f.snapshot(kind))};
  },kind);
  assert.equal(result.pending,0,'仍在回复时，末尾合法标记也不能提前生成按钮');
  assert.equal(result.completed,1,'只改变结束状态、正文不变时，必须重绘并恢复末尾按钮');
  assert.equal(result.sameText,true,'状态变化测试不得用正文变化强迫重绘');
  assert.equal(result.unchanged,true,'回复结束与重绘不得自行填入或改动草稿、附件和引用');
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    if(screenshots)fs.mkdirSync(screenshots,{recursive:true});
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const base='http://127.0.0.1:'+server.address().port;
    for(const [width,theme] of [[390,'light'],[820,'dark'],[1280,'light']]){
      const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<1280,timezoneId:'Asia/Hong_Kong',serviceWorkers:'block'});
      await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:base});
      const page=await context.newPage(),errors=[],external=[];page.setDefaultTimeout(7000);
      // 禁止任何非夹具流量，即使生产页面意外增加外部请求也不会接触真实服务。
      await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===base||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.origin);return route.abort();});
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(theme=>localStorage.setItem('bridge-appearance',JSON.stringify({theme})),theme);
      const suffix=width+' / '+theme;
      try{
        // 先完成目录读取，避免缺少 access 的冷启动链接触发既有自动重连。
        await page.goto(base);await page.waitForFunction(()=>listReadFinished&&clientNavigation.provider==='codex');
        await open(page);await page.waitForFunction(()=>window.BridgeWorkbench?.current);
        await installHelpers(page);await selectMain(page,'main');
        await test('合成页面初始化与主题 '+suffix,async()=>{assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);});
        await test('解析边界、流式刷新与填入长度 '+suffix,()=>checkParserAndFill(page));
        await test('主聊天历史正文与角色隔离 '+suffix,()=>checkRendering(page,'main'));
        await test('主聊天文稿识别、布局与真实复制 '+suffix,()=>checkWriting(page,'main'));
        await test('主聊天真实点击、键盘、展开、焦点和草稿 '+suffix,()=>checkClick(page,'main'));
        await test('主聊天附件引用保留与合计长度限制 '+suffix,()=>checkPreservation(page,'main'));
        await test('主聊天只读、断开及输入区限制 '+suffix,()=>checkReadonly(page,'main'));
        await test('主聊天仅轮次结束时恢复末尾按钮 '+suffix,()=>checkLiveCompletion(page,'main'));
        if(screenshots&&width===390)await page.screenshot({path:path.join(screenshots,'main-390-'+theme+'.png')});
        await test('主聊天切换、旧时间线和主机隔离 '+suffix,()=>checkStaleMain(page));
        await selectSide(page);
        await test('侧边聊天历史正文与角色隔离 '+suffix,()=>checkRendering(page,'side'));
        await test('侧边聊天文稿识别、布局与真实复制 '+suffix,()=>checkWriting(page,'side'));
        await test('侧边聊天真实点击、键盘、展开和焦点 '+suffix,()=>checkClick(page,'side'));
        await test('侧边聊天附件引用保留与长度限制 '+suffix,()=>checkPreservation(page,'side'));
        await test('侧边聊天只读、过期及断开 '+suffix,()=>checkReadonly(page,'side'));
        await test('侧边聊天仅轮次结束时恢复末尾按钮 '+suffix,()=>checkLiveCompletion(page,'side'));
        if(screenshots&&width===390)await page.screenshot({path:path.join(screenshots,'side-390-'+theme+'.png')});
        await test('侧边聊天隐藏、切换与关闭后旧回调隔离 '+suffix,()=>checkStaleSide(page));
        await open(page,first);await page.evaluate(()=>window.__codexCallback=window.__followupFixture.capture('main'));
        for(const provider of ['claude','deepseek']){
          await open(page,first,provider);await selectMain(page,'desktop');
          await test(provider+' 历史主消息与角色隔离 '+suffix,()=>checkRendering(page,'desktop'));
          await test(provider+' 文稿识别、布局与真实复制 '+suffix,()=>checkWriting(page,'desktop'));
          await test(provider+' 真实点击、键盘、展开、焦点和草稿 '+suffix,()=>checkClick(page,'desktop'));
          await test(provider+' 附件引用保留与长度限制 '+suffix,()=>checkPreservation(page,'desktop'));
          await test(provider+' 旧缓存与禁止发送限制 '+suffix,()=>checkReadonly(page,'desktop'));
          await test(provider+' 相同正文仅状态结束时重绘恢复按钮 '+suffix,()=>checkLiveCompletion(page,'desktop'));
          await test(provider+' 聊天和客户端上下文隔离 '+suffix,async()=>{
            await page.evaluate(()=>window.__desktopCallback=window.__followupFixture.capture('desktop'));
            await open(page,second,provider);await resetDraft(page,'desktop','当前客户端草稿');
            await page.evaluate(()=>{window.__desktopCallback('跨聊天错误填入');window.__codexCallback('Codex 跨客户端错误填入');});
            assert.equal(await page.locator(inputSelector('desktop')).inputValue(),'当前客户端草稿');
            const other=provider==='claude'?'deepseek':'claude';await open(page,first,other);await resetDraft(page,'desktop','其他客户端草稿');
            await page.evaluate(()=>window.__desktopCallback('跨客户端错误填入'));
            assert.equal(await page.locator(inputSelector('desktop')).inputValue(),'其他客户端草稿');
          });
        }
        await test('主聊天截断预览、逐页展开与完整正文按钮判定 '+suffix,()=>checkTruncatedMain(page));
        await test('页面无脚本异常、外部访问与业务写入 '+suffix,async()=>{assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);});
      }catch(error){failures.push({name:'页面流程 '+suffix,error:error.message});console.error('失败：页面流程 '+suffix+'\n'+error.message);}
      finally{await context.close();}
    }
    assert.deepEqual(serverErrors,[],'合成服务不得静默报错');
    console.log(JSON.stringify({passed:checks.length,failed:failures.length,failures,writes,readWrites,unexpected,screenshots},null,2));
    if(failures.length)process.exitCode=1;
  }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.closeAllConnections();server.close();process.exitCode=1;});
