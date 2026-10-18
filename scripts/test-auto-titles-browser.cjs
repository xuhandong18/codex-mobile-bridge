'use strict';
// Synthetic chats only; no installed client, credentials or model requests.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
const dialog=html.match(/<dialog id="rename-dialog"[\s\S]*?<\/dialog>/)[0];
const source=fs.readFileSync(path.join(root,'web/shell/app.js'),'utf8');
const bindings=source.slice(source.indexOf('let renameTarget=null'),source.indexOf('let notificationChannelBusy='));
const assets=require('../web/assets.json'),first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
let mode='success',writes=0,reads=0,delayRead=false;
const states=new Map(),name='程序化编排与上下文管理';
function reset(next){mode=next;writes=reads=0;states.clear();delayRead=false;}
function state(id){return states.get(id)||{status:'ready',available:true,title:'首条消息的临时预览'};}
const setup=`const $=id=>document.getElementById(id),t=x=>x;
let currentId='${first}',currentHost='local',state={title:'首条消息的临时预览'};
const currentAccess=()=>({canConfigure:true}),loadList=async()=>{},toast=()=>{};
const sessionUrl=(id,action)=>'/api/sessions/'+id+'/'+action;
const api=async(url,body)=>{const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw Error(result.error);return result;};
`;
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const match=req.url.match(/^\/api\/sessions\/([^/]+)\/(auto-title|rename)$/);
  if(match){
    const [,id,action]=match;res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){
      reads++;const result=state(id);
      if(delayRead&&id===first){delayRead=false;setTimeout(()=>res.end(JSON.stringify({status:'complete',available:false,title:'过期的旧名称'})),350);return;}
      return res.end(JSON.stringify(result));
    }
    let raw='';for await(const chunk of req)raw+=chunk;
    if(action==='rename'){const title=JSON.parse(raw).title;states.set(id,{status:'manual',available:false,title});return res.end(JSON.stringify({title}));}
    writes++;states.set(id,{status:mode==='unknown'?'unknown':'running',available:false,title:'首条消息的临时预览'});
    if(mode==='unknown')return res.end(JSON.stringify(state(id)));
    const result={status:'complete',available:false,title:name};
    setTimeout(()=>states.set(id,result),100);
    if(mode==='lost'){res.writeHead(200,{'Content-Length':1000});res.flushHeaders();res.write('{');setTimeout(()=>res.destroy(),5);return;}
    return res.end(JSON.stringify(state(id)));
  }
  if(req.url==='/controller.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,'web/features/chat/message-actions.js'),'utf8')+'\n'+setup+bindings);}
  if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');return res.end([].concat(assets['/style.css']).map(file=>fs.readFileSync(path.join(root,'web',file),'utf8')).join('\n'));}
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><button id="rename-chat">修改名称</button><span id="chat-title"></span><span id="details-title"></span><dialog id="chat-details-dialog"></dialog>'+dialog+'<script src="/controller.js"></script>');}
  res.statusCode=404;res.end();
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const checks=[],errors=[];
  const check=(value,label)=>{assert.ok(value,label);checks.push(label);};
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const origin='http://127.0.0.1:'+server.address().port;
    for(const width of [1280,390,820]){
      reset('success');const page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
      await page.goto(origin);await page.click('#rename-chat');await page.waitForFunction(()=>!document.querySelector('#rename-summary').disabled&&!document.querySelector('#rename-summary').hidden);
      check(writes===0,'打开窗口只读状态 '+width);
      await page.evaluate(()=>{document.querySelector('#rename-summary').click();document.querySelector('#rename-summary').click();});
      await page.waitForFunction(()=>document.querySelector('#rename-title').value==='程序化编排与上下文管理');
      check(writes===1&&reads>=2,'一次提交后只读轮询 '+width);
      check(await page.locator('#chat-title').textContent()===name,'生成名称同步聊天头部 '+width);
      check(await page.locator('#rename-summary').isHidden(),'完成后隐藏生成按钮 '+width);
      await page.close();
    }
    reset('lost');const page=await browser.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.click('#rename-chat');await page.waitForFunction(()=>!document.querySelector('#rename-summary').hidden);await page.click('#rename-summary');
    await page.locator('#rename-title').fill('我手动输入的名称');
    await page.waitForFunction(()=>document.querySelector('#rename-summary-status').textContent.includes('已生成'));
    check(writes===1,'提交回执丢失不会重发');check(await page.locator('#rename-title').inputValue()==='我手动输入的名称','迟到的摘要保留手动输入');
    await page.click('#rename-save');await page.waitForFunction(()=>document.querySelector('#chat-title').textContent==='我手动输入的名称');check(true,'仍可保存自己的名称');
    reset('unknown');await page.reload();await page.click('#rename-chat');await page.waitForFunction(()=>!document.querySelector('#rename-summary').hidden);await page.click('#rename-summary');
    await page.waitForFunction(()=>document.querySelector('#rename-summary-status').textContent.includes('尚未确认'));
    check(await page.locator('#rename-summary').isDisabled()&&writes===1,'未知结果不能重复生成');
    await page.evaluate(()=>document.querySelector('#rename-dialog').close());
    reset('success');delayRead=true;await page.click('#rename-chat');await page.waitForFunction(()=>document.querySelector('#rename-dialog').open);
    await page.evaluate(()=>{document.querySelector('#rename-dialog').close();currentId='22222222-2222-4222-8222-222222222222';state={title:'第二个聊天'};document.querySelector('#rename-chat').click();});
    await page.waitForFunction(()=>!document.querySelector('#rename-summary').hidden);await page.waitForTimeout(450);
    check(await page.locator('#rename-title').inputValue()==='第二个聊天','旧聊天回包不会覆盖新聊天窗口');
    check(writes===0,'切换和读取不会启动摘要');check(errors.length===0,'浏览器没有脚本错误');await page.close();
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
