'use strict';
// Full production page with synthetic metadata; never opens real desktop chats.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json'),project='local|fixture-project';
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const initialRows=Array.from({length:14},(_,i)=>({id:id(i+1),host:'local',title:'排序测试 '+(i+1),cwd:'/fixture',
  projectKey:i<12?project:'local|independent',projectName:i<12?'TVPlayer 测试项目':'独立聊天',recency:100-i,
  section_position:14-i,...(i===8||i===9?{thread_section_id:'native-daily'}:{}),access:{source:'desktop'}}));
const sidebar={sections:[{id:'daily',name:'Daily',hostSectionIds:{local:'native-daily'},itemKeys:['codex:thread:'+id(10),'codex:project:fixture-project','codex:thread:'+id(9)]}],
  projects:[{key:project,host:'local',name:'TVPlayer 测试项目',cwd:'/fixture'}],
  threadOrders:{'fixture-project':{threadIds:initialRows.slice(0,8).map(row=>row.id).reverse()}},pinnedThreadIds:[id(12),id(11)]};
let rows=[];const errors=[],writes=[];
const server=http.createServer(async(req,res)=>{
  const p=new URL(req.url,'http://127.0.0.1').pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    if(req.method!=='GET'&&p!=='/api/activity')writes.push(p);
    let value={};res.setHeader('Content-Type','application/json');
    if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'},uiLanguage:'zh'};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions')value={sessions:[...rows].sort((a,b)=>b.recency-a.recency),remoteHosts:[],sources:['desktop'],complete:true,sidebar};
    else if(p==='/api/activity')value={sessions:[]};
    res.end(JSON.stringify(value));return;
  }
  if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(web,'index.html')));return;}
  let parts=assets[p];
  if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
  if(!parts){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const checks=[];
  const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks.push(label);};
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280])for(const mode of ['codex','project','recent']){
      rows=initialRows.map(row=>({...row}));
      const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(mode=>{localStorage.setItem('list-mode',mode);localStorage.setItem('navigation:sidebar','open');},mode);
      const loaded=()=>page.waitForFunction(()=>listReadFinished&&listRows.length===14);
      const ids=selector=>page.locator(selector).evaluateAll(nodes=>nodes.map(node=>node.dataset.id));
      const group='#sessions .project-group[data-project-key="'+project+'"]',buttons=group+' > .session',label=mode+' '+width;
      await page.goto('http://127.0.0.1:'+server.address().port+'/');await loaded();
      if(mode==='recent')check(await ids('#sessions .session'),initialRows.map(row=>row.id),'最近列表从新到旧 '+label);
      else{
        check(await ids(buttons),initialRows.slice(0,5).map(row=>row.id),'项目首屏先显示最新五条 '+label);
        await page.locator(group+' > summary').click();await page.locator(group+' > summary').click();
        check(await ids(buttons),initialRows.slice(0,5).map(row=>row.id),'折叠后重新展开保持最新在前 '+label);
        await page.locator(group+' > .project-load-more').click();
        const expected=(mode==='codex'?initialRows.slice(0,8):initialRows.slice(0,12)).map(row=>row.id);
        check(await ids(buttons),expected,'加载更多沿用时间顺序 '+label);
      }
      if(mode==='codex'){
        check(await ids('#sessions [data-section="daily"] > .session'),[id(9),id(10)],'自定义分区聊天从新到旧 '+label);
        check(await ids('#sessions [data-section="pinned"] > .session'),[id(11),id(12)],'置顶聊天从新到旧 '+label);
        check(await ids('#sessions [data-section="threads"] > .session'),[id(13),id(14)],'独立聊天从新到旧 '+label);
      }
      rows[7].recency=200;
      await page.evaluate(id=>bumpRecency(id,'local',200),id(8));
      check((await ids(mode==='recent'?'#sessions .session':buttons))[0],id(8),'新的交互立即排到最前 '+label);
      await page.evaluate(()=>loadList(true));
      check((await ids(mode==='recent'?'#sessions .session':buttons))[0],id(8),'后台刷新保持最新在前 '+label);
      await page.reload();await loaded();
      check((await ids(mode==='recent'?'#sessions .session':buttons))[0],id(8),'整页刷新保持最新在前 '+label);
      if(mode!=='recent'){
        await page.locator(buttons).first().dispatchEvent('contextmenu',{clientX:100,clientY:180});
        await page.getByRole('button',{name:'在项目中下移',exact:true}).click();
        check((await ids(buttons)).slice(0,2),[id(1),id(8)],'显式手动下移使用屏幕当前顺序 '+label);
        await page.reload();await loaded();
        check((await ids(buttons)).slice(0,2),[id(1),id(8)],'显式手动顺序在整页刷新后保留 '+label);
      }
      await context.close();
    }
    check(writes,[],'排序验证没有打开聊天或发送写入');
    check(errors,[],'浏览器无脚本异常');
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
