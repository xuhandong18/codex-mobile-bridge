'use strict';
// Real desktop renderer and controls, synthetic controller API; no native client operations.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
let enabled=true,saves=0;
const fixture=()=>({
  preferences:{autoStart:false,port:8787,lan:true,lanAddresses:null,localAccess:true,tunnel:false,connections:[],cloudflared:'',codexHome:'/fixture',ipcPath:'',codexBin:''},
  auth:{mode:'password',username:'fixture',sessionHours:12},origins:[],
  notifications:{enabled:false,server:'https://ntfy.sh',topic:'',barkEnabled:false,barkServer:'https://api.day.app',pushplusEnabled:false,addressEnabled:true,securityEnabled:true},
  codexRecovery:{enabled},watches:[],notificationUrls:[],notificationStatus:{},addressNotificationStatus:{},securityNotificationStatus:{},
  dataDir:'/fixture',credentialsAvailable:false,runtime:{running:true,supportsNotifications:true,instanceId:'fixture'},
  urls:['http://127.0.0.1:8787/'],externalStatus:{},cloudflared:{available:false,path:''},quickTunnel:{},
});
const optionalScripts=new Set(['../web/features/accounts/account.js','../web/features/accounts/accounts.js',
  '../web/features/accounts/client-accounts.js','../web/features/accounts/cli-access.js','../web/features/clients/client-lifecycle.js',
  'features/clients/desktop-sessions.js','features/clients/harness.js','../web/features/workspace/file-actions.js','features/files/settings.js']);
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);return res.end();}
    let body=fs.readFileSync(file);
    if(file.endsWith('desktop'+path.sep+'index.html'))body=Buffer.from(body.toString().replace(/<script src="([^"]+)"><\/script>/g,(tag,source)=>optionalScripts.has(source)?'':tag));
    res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');
    res.end(body);
  }catch(error){res.writeHead(500);res.end(error.message);}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;const errors=[];
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    await context.exposeBinding('recoveryFixtureSnapshot',()=>fixture());
    await context.exposeBinding('recoveryFixtureSave',(_source,value)=>{
      assert.equal(typeof value.codexRecovery.enabled,'boolean');
      enabled=value.codexRecovery.enabled;saves++;return fixture();
    });
    await context.addInitScript(()=>{
      let language='zh-CN';
      window.bridgeDesktop={
        snapshot:()=>window.recoveryFixtureSnapshot(),
        save:value=>window.recoveryFixtureSave(value),
        language:async()=>language,setLanguage:async value=>(language=value),
        logs:async()=>({text:''}),readCredentials:async()=>({}),
        start:async()=>{throw Error('Unexpected native start');},stop:async()=>{throw Error('Unexpected native stop');},
      };
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const address='http://127.0.0.1:'+server.address().port+'/desktop/index.html';
    await page.goto(address);
    try{await page.waitForFunction(()=>document.querySelector('#port').value==='8787',{},{timeout:10000});}
    catch(error){console.error('Renderer errors:',errors,'Feedback:',await page.locator('#toast-message').textContent());throw error;}
    await page.locator('[data-tab="advanced"]').click();
    const toggle=page.locator('#codex-recovery-enabled');
    assert.equal(await toggle.isVisible(),true);assert.equal(await toggle.isChecked(),true);assert.equal(await toggle.isEnabled(),true);
    assert.match(await page.locator('#codex-recovery-hint').innerText(),/10 分钟.*3 次/);
    await toggle.uncheck();await page.locator('#save').click();
    await page.waitForFunction(()=>document.querySelector('#save-bar').hidden);
    assert.equal(enabled,false);assert.equal(saves,1);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#port').value==='8787');
    await page.locator('[data-tab="advanced"]').click();assert.equal(await toggle.isChecked(),false);
    await toggle.check();await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#save-bar').hidden);
    assert.equal(enabled,true);assert.equal(saves,2);
    await page.locator('#language').selectOption('en');
    await page.waitForFunction(()=>document.querySelector('#codex-recovery-hint').textContent.includes('10 minutes'));
    await page.setViewportSize({width:900,height:700});await toggle.scrollIntoViewIfNeeded();
    assert.equal(await toggle.isVisible(),true);assert.equal(await toggle.isEnabled(),true);
    await page.locator('#toast-close').click();
    if(process.argv.includes('--screenshots'))await page.screenshot({path:path.join(root,'.tmp','codex-recovery-settings.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: default, live toggle, real save submission, reload, re-enable, English and smaller desktop window');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
