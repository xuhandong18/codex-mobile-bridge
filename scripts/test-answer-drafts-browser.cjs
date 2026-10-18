'use strict';
// Synthetic questions only; never connects to an installed client or model.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'web/shell/app.js'),'utf8');
const render=source.slice(source.indexOf('function renderApprovals('),source.indexOf('\nfunction ',source.indexOf('function renderApprovals(')+1));
const draftFile=path.join(root,'web/features/chat/answer-drafts.js');
const assets=require('../web/assets.json');
const draftScripts=[...fs.readFileSync(path.join(root,'web/index.html'),'utf8').matchAll(/<script src="([^"]+)"[^>]*><\/script>/g)]
  .map(match=>match[1].split('?')[0]).filter(url=>['/answer-drafts.js','/app.js'].includes(url));
const providers=['web/features/workspace/side-chat.js','web/features/clients/desktop-sessions.js'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n');
const setup=`const $=id=>document.getElementById(id),t=x=>x;
const el=(tag,cls,text)=>{const n=document.createElement(tag);n.className=cls||'';if(text!==undefined)n.textContent=text;return n;};
let currentId='chat-a',currentHost='local',approvalStamp='',approvalBusy=0;
const submittedRequestIds=new Set(),setLanguageBusy=()=>{},bumpRecency=()=>{},toast=()=>{},jsonPretty=JSON.stringify;
window.BridgeI18n={t};
const api=async(path,body)=>{const r=await fetch(path,{method:body===undefined?'GET':'POST',keepalive:body!==undefined,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error),{status:r.status});return data;};
const sessionUrl=(id,action,host)=>'/respond';
const questions=[{id:'q1',question:'选择一个答案',options:[{label:'选项一'},{label:'选项二'}]},{id:'q2',question:'自行回复'},{id:'q3',question:'尚未回答'}];
const fixture=[{id:7,supported:true,method:'item/tool/requestUserInput',params:{questions}}];
function show(){approvalStamp='';renderApprovals(fixture);}
function showSide(){
  const button=(text,onclick)=>{const node=el('button','',text);node.type='button';node.onclick=onclick;return node;};
  const view=Object.assign(Object.create(SideChatPanel.prototype),{workbench:{node:el,button,request:api},session:{provider:'codex',host:'local'},state:{id:'side-a'},approvals:$('approvals'),approvalStamp:''});
  view.renderApprovals(fixture);
}
function showDesktop(){
  const view=Object.assign(Object.create(DesktopSessionsView.prototype),{provider:'claude',sid:'chat-a',generation:1,requests:$('approvals'),request:api,node:el,label(){},button:(text,onclick)=>{const node=el('button','',text);node.onclick=onclick;return node;}});
  view.renderRequests([{id:7,tool:'AskUserQuestion',needsInput:true,input:{questions:[{id:'many',question:'选择多项',multiSelect:true,options:[{label:'甲'},{label:'乙'}]},{id:'single',question:'选择一项',options:[{label:'一'},{label:'二'}]}]}}]);
}
`;
const drafts=new Map(),writeLog=[];let writes=0,responses=0,failWrite=false,loseReceipt=false;
function cutReceipt(res){res.writeHead(200,{'Content-Length':1000});res.flushHeaders();res.write('{');setTimeout(()=>res.destroy(),10);}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');res.setHeader('Cache-Control','no-store');
  if(url.pathname==='/api/answer-drafts'){
    res.setHeader('Content-Type','application/json');
    if(req.headers.referer?.includes('legacy=1')){res.statusCode=404;return res.end(JSON.stringify({error:'Old gateway: draft API unavailable'}));}
    if(req.method==='GET')return res.end(JSON.stringify({fields:drafts.get(url.searchParams.get('scope'))||{}}));
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),fields=drafts.get(body.scope)||{},old=fields[body.field];writes++;
    writeLog.push({field:JSON.parse(body.field)[0],version:body.version,value:body.value});
    if(failWrite){cutReceipt(res);return;}
    if((old?.version||0)!==body.version){res.statusCode=409;return res.end(JSON.stringify({error:'conflict',field:old}));}
    fields[body.field]={value:body.value,version:(old?.version||0)+1};drafts.set(body.scope,fields);if(loseReceipt){loseReceipt=false;cutReceipt(res);return;}return res.end(JSON.stringify(fields[body.field]));
  }
  if(url.pathname==='/respond'){responses++;return res.end('{}');}
  if(url.pathname==='/'){
    const legacy=url.searchParams.get('legacy')==='1';
    res.setHeader('Content-Type','text/html');return res.end('<!doctype html><meta charset="utf-8"><div id="approvals"></div>'+draftScripts.map(src=>'<script src="'+src+(legacy?'?legacy=1':'')+'"></script>').join(''));
  }
  if(url.pathname==='/answer-drafts.js'){
    if(url.searchParams.get('legacy')==='1'){res.statusCode=401;return res.end('{}');}
    res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(draftFile,'utf8'));
  }
  if(url.pathname==='/app.js'){
    const draftBundle=[].concat(assets['/app.js']).filter(file=>file==='features/chat/answer-drafts.js').map(file=>fs.readFileSync(path.join(root,'web',file),'utf8')).join('\n');
    res.setHeader('Content-Type','text/javascript');return res.end(setup+'\n'+draftBundle+'\n'+providers+'\n'+render+'\nshow();');
  }
  res.writeHead(404);res.end();
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const phone=await browser.newContext({viewport:{width:390,height:844}}),page=await phone.newPage(),errors=[],checks=[];
    const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
    page.on('pageerror',e=>errors.push(e.message));
    const saved=p=>p.waitForFunction(()=>document.querySelector('[data-draft-status]')?.dataset.draftStatus==='saved');
    const origin='http://127.0.0.1:'+server.address().port;
    const legacy=await phone.newPage(),legacyErrors=[];legacy.on('pageerror',error=>legacyErrors.push(error.message));
    await legacy.goto(origin+'/?legacy=1');
    check(await legacy.locator('#approvals textarea').count()===3,'旧网关未开放草稿脚本时仍显示提问框');
    await legacy.locator('textarea').nth(1).fill('旧网关上的本机答案');await legacy.reload();
    check(await legacy.locator('textarea').nth(1).inputValue()==='旧网关上的本机答案','旧网关不支持草稿接口时仍保留本机输入');
    check(legacyErrors.length===0,'旧网关缺少草稿接口不产生页面脚本异常');await legacy.close();
    await page.goto(origin);await page.selectOption('select','选项二');await page.locator('textarea').nth(1).fill('手机写下的第二条回复');
    const moduleIdentity=await page.evaluate(()=>{window.originalDraftModule=window.AnswerDrafts;return !!window.AnswerDrafts;});
    await page.addScriptTag({url:origin+'/answer-drafts.js'});
    check(moduleIdentity&&await page.evaluate(()=>window.originalDraftModule===window.AnswerDrafts),'旧页面重复加载独立脚本不会重定义或丢失草稿模块');
    await page.evaluate(()=>show());
    check(await page.locator('select').inputValue()==='选项二','离开再回来后保留已选答案');
    check(await page.locator('textarea').nth(1).inputValue()==='手机写下的第二条回复','离开再回来后保留自由回复');
    await saved(page);
    const tablet=await browser.newContext({viewport:{width:820,height:1180}}),other=await tablet.newPage();other.on('pageerror',error=>errors.push(error.message));await other.goto(origin);
    await other.waitForFunction(()=>document.querySelector('select').value==='选项二');
    check(await other.locator('textarea').nth(1).inputValue()==='手机写下的第二条回复','新设备恢复已填的两条答案');
    check(await other.locator('textarea').nth(2).inputValue()==='','未填写的问题保持空白');
    await page.selectOption('select','__custom__');await page.locator('textarea').first().fill('自定义选项回复');await saved(page);
    await other.waitForFunction(()=>document.querySelector('textarea').value==='自定义选项回复');
    check(await other.locator('textarea').first().isVisible(),'其他设备实时恢复自行填写及其可见状态');
    await page.reload();await saved(page);
    check(await page.locator('textarea').first().inputValue()==='自定义选项回复','刷新页面后恢复自定义回复');
    await page.evaluate(()=>{currentId='chat-b';show();});await saved(page);
    check(await page.locator('textarea').nth(1).inputValue()==='','不同聊天的答案相互隔离');
    await page.evaluate(()=>{currentId='chat-a';currentHost='ssh-host';show();});await saved(page);
    check(await page.locator('textarea').nth(1).inputValue()==='','不同主机的答案相互隔离');
    await page.evaluate(()=>{currentHost='local';fixture[0].params.questions=questions.slice(1);show();});await saved(page);
    check(await page.locator('textarea').first().inputValue()==='手机写下的第二条回复','问题列表减少时其余答案仍能恢复');
    await page.evaluate(()=>{fixture[0].params.questions=[{...questions[1],question:'新的问题内容'}];show();});await saved(page);
    check(await page.locator('textarea').inputValue()==='','问题内容改变不会套用旧答案');
    await page.evaluate(()=>{fixture[0].params.questions=questions;show();});await saved(page);
    await page.evaluate(()=>{fixture[0].params.turnId='new-turn';show();});await saved(page);
    check(await page.locator('textarea').nth(1).inputValue()==='','新一轮即使复用请求编号也不会显示旧答案');
    await page.evaluate(()=>{delete fixture[0].params.turnId;show();});await saved(page);
    // Hold tablet reads so its version is deliberately stale.
    await other.evaluate(()=>{for(const entry of AnswerDrafts.entries.values())entry.reading=true;});
    await page.locator('textarea').nth(1).fill('手机的新答案');await saved(page);
    const beforeConflict=writes;await other.locator('textarea').nth(1).fill('平板的过期答案');
    await other.waitForFunction(()=>document.querySelector('[data-draft-status]').dataset.draftStatus==='error');
    check(writes===beforeConflict+1,'过期设备的冲突保存只尝试一次');
    await page.evaluate(()=>{show();});await saved(page);
    check(await page.locator('textarea').nth(1).inputValue()==='手机的新答案','过期设备不能覆盖已保存的新答案');
    check(await other.locator('textarea').nth(1).inputValue()==='平板的过期答案','冲突时保留本机输入并提示用户');
    await other.evaluate(()=>{for(const entry of AnswerDrafts.entries.values())entry.reading=false;});
    // A lost receipt is resolved by reading, without a second write.
    loseReceipt=true;const beforeUnknown=writes;await page.locator('textarea').nth(2).fill('已写入但回执断开');await saved(page);
    assert.equal(writes,beforeUnknown+1,'丢失保存回执后只读核对，不重放写入 '+JSON.stringify(writeLog.slice(beforeUnknown)));checks.push('丢失保存回执后只读核对，不重放写入');
    failWrite=true;const beforeFailure=writes;await page.locator('textarea').nth(2).fill('断网时的本机草稿');
    await page.waitForFunction(()=>document.querySelector('[data-draft-status]').dataset.draftStatus==='error');
    await page.reload();await page.waitForFunction(()=>document.querySelector('[data-draft-status]').dataset.draftStatus==='error');
    check(await page.locator('textarea').nth(2).inputValue()==='断网时的本机草稿','同步失败后刷新仍恢复本机输入');
    check(writes===beforeFailure+1,'未确认的保存不会因刷新而自动重放');failWrite=false;
    await page.locator('textarea').nth(2).fill('联网后重新编辑');await saved(page);
    await page.evaluate(()=>{fixture[0].method='bridge/requestUserInputAsync';show();});await saved(page);
    await page.selectOption('select','选项一');await page.locator('textarea').nth(1).fill('异步交互框的第二条回复');await saved(page);
    await other.evaluate(()=>{fixture[0].method='bridge/requestUserInputAsync';show();});await saved(other);
    check(await other.locator('select').inputValue()==='选项一'&&await other.locator('textarea').nth(1).inputValue()==='异步交互框的第二条回复','异步交互框的两条部分答案跨设备恢复');
    await page.evaluate(()=>{fixture[0].method='item/tool/requestUserInput';});
    await other.evaluate(()=>{fixture[0].method='item/tool/requestUserInput';});
    await page.evaluate(()=>showSide());await saved(page);
    check(await page.locator('textarea').nth(1).inputValue()==='','侧边聊天与主聊天相互隔离');
    await page.selectOption('select','选项一');await page.locator('textarea').nth(1).fill('侧边自由回复');await saved(page);
    await page.evaluate(()=>showSide());await saved(page);
    check(await page.locator('select').inputValue()==='选项一'&&await page.locator('textarea').nth(1).inputValue()==='侧边自由回复','侧边重建保留选择及自由回复');
    await other.evaluate(()=>showSide());await saved(other);
    check(await other.locator('textarea').nth(1).inputValue()==='侧边自由回复','侧边答案也能跨设备恢复');
    await page.evaluate(()=>showDesktop());await saved(page);
    await page.locator('input[type=checkbox]').first().check();await page.locator('input[type=checkbox]').nth(1).check();
    await page.locator('fieldset').first().locator('input:not([type])').fill('多选补充文字');await page.locator('input[type=radio]').nth(1).check();await saved(page);
    await other.evaluate(()=>showDesktop());await saved(other);
    check(await other.locator('input:checked').count()===3,'其他客户端的多选和单选都恢复');
    check(await other.locator('fieldset').first().locator('input:not([type])').inputValue()==='多选补充文字','多选的补充文字同时恢复');
    await page.evaluate(()=>{
      approvalStamp='';renderApprovals([{id:'mcp',supported:true,method:'mcpServer/elicitation/request',params:{requestedSchema:{type:'object',properties:{name:{type:'string'},count:{type:'integer'},enabled:{type:'boolean'},choice:{type:'string',enum:['甲','乙']}}}}}]);
    });await saved(page);
    await page.locator('input[type=text]').fill('表单文字');await page.locator('input[type=number]').fill('12');await page.locator('input[type=checkbox]').check();await page.selectOption('select','乙');await saved(page);
    await other.evaluate(()=>{
      approvalStamp='';renderApprovals([{id:'mcp',supported:true,method:'mcpServer/elicitation/request',params:{requestedSchema:{type:'object',properties:{name:{type:'string'},count:{type:'integer'},enabled:{type:'boolean'},choice:{type:'string',enum:['甲','乙']}}}}}]);
    });await saved(other);
    check(await other.locator('input[type=text]').inputValue()==='表单文字'&&await other.locator('input[type=number]').inputValue()==='12','MCP 文字和数字跨设备恢复');
    check(await other.locator('input[type=checkbox]').isChecked()&&await other.locator('select').inputValue()==='乙','MCP 勾选和枚举跨设备恢复');
    // Blur-time change events and pagehide must also preserve the final edit.
    await page.locator('input[type=text]').fill('快速跳转前的最后输入');await page.reload();
    await saved(page);
    await page.evaluate(()=>{approvalStamp='';renderApprovals([{id:'mcp',supported:true,method:'mcpServer/elicitation/request',params:{requestedSchema:{type:'object',properties:{name:{type:'string'},count:{type:'integer'},enabled:{type:'boolean'},choice:{type:'string',enum:['甲','乙']}}}}}]);});await saved(page);
    check(await page.locator('input[type=text]').inputValue()==='快速跳转前的最后输入','立即跳转也保留最后一次输入');
    await page.evaluate(()=>{document.dispatchEvent(new Event('bridge-logged-out'));});
    check(await page.evaluate(()=>AnswerDrafts.entries.size===0&&!Object.keys(localStorage).some(k=>k.startsWith(AnswerDrafts.prefix))),'退出登录清除本机答案缓存');
    check(responses===0,'保存草稿没有提交回复');check(writes>=2,'执行了真实草稿写请求');
    check(errors.length===0,'浏览器无页面脚本错误');console.log(JSON.stringify({passed:checks.length,checks},null,2));
    await phone.close();await tablet.close();
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
