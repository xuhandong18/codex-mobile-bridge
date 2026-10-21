'use strict';
// Production page, isolated HTTP fixture and synthetic chats only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const id='11111111-1111-4111-8111-111111111111';
const access={source:'desktop',canSend:true,canReconnect:true,canChangeModel:true};
const row={id,host:'local',title:'历史连接测试',cwd:'/fixture',updatedAt:1,access};
let connected=false,releaseConnection,releaseCatalog,catalogRequests=0,reconnectRequests=0;
const errors=[],checks=[];
const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
function page(){
  return {epoch:'fixture',sequence:connected?2:1,rows:[{key:'saved',order:0,role:'assistant',kind:'agentMessage',text:'已经保存的历史正文',version:'v1',turnId:'turn',turnStatus:'completed'}],
    files:[],hasMore:false,meta:{...row,sequence:connected?2:1,connected,activating:!connected,loadingHistory:false,status:'idle',historyComplete:true,requests:[],submissions:[]}};
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;
  res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');let value={};
    if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions')value={sessions:[row],hosts:[],sources:['desktop'],hasMore:false,complete:true};
    else if(p==='/api/activity')value={sessions:[]};
    else if(p.endsWith('/reconnect')){
      reconnectRequests++;req.resume();await new Promise(resolve=>releaseConnection=resolve);
      connected=true;value={ok:true,connected:true};
    }else if(p.endsWith('/catalog')){
      catalogRequests++;await new Promise(resolve=>releaseCatalog=resolve);
      value={kind:'models',models:[],currentModel:'fixture-model'};
    }else if(p.endsWith('/timeline')||p.endsWith('/changes')){
      if(p.endsWith('/changes'))await new Promise(resolve=>setTimeout(resolve,100));
      value=page();
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
    for(const width of [390,820,1280]){
      connected=false;catalogRequests=0;reconnectRequests=0;releaseConnection=null;releaseCatalog=null;
      const context=await browser.newContext({viewport:{width,height:900}}),tab=await context.newPage();
      tab.setDefaultTimeout(10000);tab.on('pageerror',error=>errors.push(error.message));
      await tab.goto('http://127.0.0.1:'+server.address().port+'/#'+id+'~local');
      await tab.waitForFunction(()=>state?.activating&&document.querySelector('#messages').textContent.includes('已经保存的历史正文'));
      check(reconnectRequests===1,'自动连接只发起一次 '+width);
      check(catalogRequests===0,'连接等待期间没有模型目录请求 '+width);
      check(await tab.locator('#notice').isVisible(),'连接等待时历史正文和连接提示同时可见 '+width);
      await tab.locator('#message').fill('尚未发送的草稿');
      assert.ok(releaseConnection);releaseConnection();
      await tab.waitForFunction(()=>state?.connected&&!document.querySelector('#notice').offsetHeight&&!document.querySelector('#send').disabled);
      check(catalogRequests===1&&!!releaseCatalog,'连接成功后才开始模型预读 '+width);
      check(await tab.locator('#message').inputValue()==='尚未发送的草稿','模型查询仍在等待时已经可以继续输入且草稿保留 '+width);
      releaseCatalog();await context.close();
    }
    check(errors.length===0,'浏览器没有脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{
    releaseConnection?.();releaseCatalog?.();
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
