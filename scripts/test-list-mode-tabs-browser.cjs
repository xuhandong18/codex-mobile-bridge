'use strict';
// Production sidebar with synthetic read-only APIs; no real client or chat access.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const rows=Array.from({length:8},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i+1).padStart(12,'0'),host:'local',title:'标签测试 '+(i+1),
  cwd:'/fixture',projectKey:'local|fixture',projectName:'Fixture',recency:100-i,access:{source:'desktop'}}));
const writes=[],errors=[],checks=[];
const check=(value,expected,label)=>{assert.deepEqual(value,expected,label);checks.push(label);};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    let body='';for await(const part of req)body+=part;
    if(req.method!=='GET'&&p!=='/api/activity')writes.push(p);
    let value={};
    if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'b'.repeat(64),computer:{name:'Fixture'},uiLanguage:'zh'};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sidebar-preferences')value={revision:0,fields:{}};
    else if(p==='/api/sessions')value={sessions:rows,remoteHosts:[],sources:['desktop'],complete:true,
      sidebar:{sections:[],projects:[{key:'local|fixture',host:'local',name:'Fixture',cwd:'/fixture'}]}};
    else if(p==='/api/activity')value={sessions:rows.map(row=>({id:row.id,host:'local',connected:true,status:'idle',recency:row.recency}))};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;
  }
  if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(web,'index.html')));return;}
  let files=assets[p];
  if(!files&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))files=p.slice(1);
  if(!files){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat([].concat(files).map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [820,1280,1440]){
      const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(5000);
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(()=>{if(!localStorage.getItem('list-mode'))localStorage.setItem('list-mode','recent');localStorage.setItem('navigation:sidebar','open');});
      await page.goto('http://127.0.0.1:'+server.address().port+'/');
      await page.waitForFunction(()=>listReadFinished&&listRows.length===8);
      const tabs=page.locator('#sidebar .chat-list-mode-tabs'),buttons=tabs.getByRole('tab');
      await tabs.waitFor({state:'visible'});
      check(await buttons.allTextContents(),['分区','最近交互','项目'],'三个标签使用简短文字 '+width);
      check(await page.locator('#list-mode').isVisible(),false,'宽屏隐藏原下拉框 '+width);
      check(await tabs.getByRole('tab',{selected:true}).textContent(),'最近交互','读取已保存的选中方式 '+width);
      const geometry=await tabs.evaluate(node=>{const search=document.getElementById('search'),r=node.getBoundingClientRect(),s=search.getBoundingClientRect();return {below:r.top>=s.bottom,inside:node.scrollWidth<=node.clientWidth};});
      check(geometry,{below:true,inside:true},'标签在搜索框下方且不溢出 '+width);
      await page.locator('#search').fill('标签');
      for(const [label,mode] of [['分区','codex'],['项目','project'],['最近交互','recent']]){
        await tabs.getByRole('tab',{name:label,exact:true}).click();
        check(await page.locator('#list-mode').inputValue(),mode,'点击同步原显示状态 '+label+' '+width);
        check(await page.evaluate(()=>localStorage.getItem('list-mode')),mode,'点击保存显示方式 '+label+' '+width);
        check(await page.locator('#search').inputValue(),'标签','切换保留搜索文字 '+label+' '+width);
        check(await tabs.getByRole('tab',{selected:true}).count(),1,'只有一个标签处于选中状态 '+label+' '+width);
        check(await page.locator('#sessions .sidebar-section').count()>0,mode==='codex','切换实际渲染对应分组 '+label+' '+width);
      }
      await tabs.getByRole('tab',{name:'分区',exact:true}).focus();await page.keyboard.press('ArrowRight');
      check(await tabs.getByRole('tab',{selected:true}).textContent(),'最近交互','方向键切换并选中相邻标签 '+width);
      await page.keyboard.press('End');check(await page.locator('#list-mode').inputValue(),'project','End 选择最后一项 '+width);
      await page.keyboard.press('Home');check(await page.locator('#list-mode').inputValue(),'codex','Home 选择第一项 '+width);
      await page.keyboard.press('ArrowLeft');check(await page.locator('#list-mode').inputValue(),'project','方向键循环切换 '+width);
      await page.evaluate(()=>{$('list-mode').value='recent';renderList();});
      check(await tabs.getByRole('tab',{selected:true}).textContent(),'最近交互','程序内更改显示方式同步标签 '+width);
      await page.evaluate(()=>BridgeI18n.setLanguage('en'));
      check((await buttons.allTextContents())[0],'Sections','语言切换更新分区标签 '+width);
      check((await buttons.allTextContents())[2],'Projects','语言切换更新项目标签 '+width);
      check(await tabs.getAttribute('aria-label'),'Chat list display mode','标签组的可访问名称同步语言 '+width);
      await page.evaluate(()=>BridgeI18n.setLanguage('zh'));
      await page.locator('#search').focus();
      await page.locator('#search').blur();
      for(const theme of ['light','dark']){
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        check(await tabs.getByRole('tab',{selected:true}).evaluate(node=>getComputedStyle(node).borderBottomColor!==getComputedStyle(node.parentElement.querySelector('[aria-selected="false"]')).borderBottomColor),true,'主题下清晰显示选中下划线 '+theme+' '+width);
        if(width===1280&&process.argv.includes('--screenshots')){
          fs.mkdirSync(path.join(root,'.tmp'),{recursive:true});await page.locator('#sidebar .chat-list-toolbar').screenshot({path:path.join(root,'.tmp','list-mode-tabs-'+theme+'.png')});
        }
      }
      await page.setViewportSize({width:390,height:844});
      check(await tabs.isVisible(),false,'窄屏继续使用下拉框 '+width);
      check(await page.locator('#list-mode').isVisible(),true,'窄屏下拉框可见 '+width);
      await page.locator('#list-mode').selectOption('project');
      await page.setViewportSize({width,height:900});
      check(await tabs.getByRole('tab',{selected:true}).textContent(),'项目','窄宽切换保留选中方式 '+width);
      check(await page.locator('#search').inputValue(),'标签','窄宽切换保留搜索文字 '+width);
      await page.reload();await page.waitForFunction(()=>listReadFinished&&listRows.length===8);
      check(await tabs.getByRole('tab',{selected:true}).textContent(),'项目','刷新保留选中标签 '+width);
      await context.close();
    }
    check(writes,[],'切换标签不发送聊天或修改远端设置');check(errors,[],'浏览器无脚本异常');
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
