'use strict';
// Production page and isolated HTTP fixture; no real clients or credentials.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
let fixture;
const html='<!DOCTYPE html><html>private proxy error</html>';
const server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://127.0.0.1').pathname;
  res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    fixture.calls[p]=(fixture.calls[p]||0)+1;
    req.resume();
    if(p.endsWith('/stop')||p==='/api/auth'&&fixture.calls[p]===1||p==='/api/clients'&&(fixture.persistent||fixture.calls[p]===1)){
      if(p.endsWith('/stop'))fixture.writes++;
      res.writeHead(502,{'Content-Type':'text/html'});return res.end(html);
    }
    let data={};
    if(p==='/api/auth')data={authenticated:true,csrf:'synthetic',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'}};
    else if(p==='/api/clients')data={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')data={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions')data={sessions:[{id:'11111111-1111-4111-8111-111111111111',host:'local',title:'启动恢复测试',cwd:'/fixture',projectKey:'local|fixture',projectName:'Fixture',is_pinned:true,recency:1}],hosts:[],availableSources:['desktop'],complete:true,hasMore:false};
    else if(p==='/api/activity')data={sessions:[]};
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(data));
  }
  if(p==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(fs.readFileSync(path.join(web,'index.html')));}
  let parts=assets[p];
  if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
  if(!parts){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser,checks=0;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280])for(const persistent of [false,true]){
      fixture={persistent,calls:{},writes:0};
      const context=await browser.newContext({viewport:{width,height:900}}),tab=await context.newPage(),errors=[];
      tab.on('pageerror',error=>errors.push(error.message));tab.setDefaultTimeout(10000);
      await tab.goto('http://127.0.0.1:'+server.address().port+'/');
      try{await tab.waitForFunction(()=>!document.querySelector('#app').hidden&&document.querySelector('#sessions').textContent.includes('启动恢复测试'));}
      catch(error){console.error({width,persistent,errors,calls:fixture.calls,page:await tab.locator('body').innerText()});throw error;}
      if(persistent){
        await tab.waitForFunction(()=>!document.querySelector('#toast').hidden&&document.querySelector('#toast').textContent.includes('网关返回了异常响应'));
        assert.equal(fixture.calls['/api/clients'],3);
      }else{
        await tab.waitForFunction(()=>clientNavigation.statusLoaded);
        assert.equal(fixture.calls['/api/clients'],2);
        assert.equal(await tab.locator('#toast').isVisible(),false);
      }
      checks+=2;
      assert.equal(fixture.writes,0);checks++;
      const error=await tab.evaluate(async()=>{try{await rawApi('/api/sessions/fixture/stop',{id:'synthetic'});}catch(error){return {message:error.message,status:error.status};}});
      assert.equal(error.status,502);assert.match(error.message,/结果尚未确认/);assert.equal(fixture.writes,1);checks+=3;
      assert.doesNotMatch(await tab.locator('body').innerText(),/Unexpected token|DOCTYPE|private proxy error/);checks++;
      assert.deepEqual(errors,[]);checks++;
      await context.close();
    }
    console.log(JSON.stringify({passed:checks,widths:[390,820,1280],scenarios:['启动短暂异常自动恢复','持续异常中文提示','写入异常不重发']},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
