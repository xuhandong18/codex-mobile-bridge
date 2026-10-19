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
let rows=[];const errors=[],writes=[],selectedReads=[];
const server=http.createServer(async(req,res)=>{
  const p=new URL(req.url,'http://127.0.0.1').pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    if(req.method!=='GET'&&p!=='/api/activity')writes.push(p);
    let value={};res.setHeader('Content-Type','application/json');
    if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'},uiLanguage:'zh'};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions'){
      const query=new URL(req.url,'http://127.0.0.1').searchParams,ids=query.get('ids')?.split(',');
      if(ids)selectedReads.push(ids);
      const matching=rows.filter(row=>(!ids||ids.includes(row.id))&&(!query.get('q')||row.title.includes(query.get('q'))));
      value={sessions:[...matching].sort((a,b)=>b.recency-a.recency).slice(0,ids?50:Number(query.get('offset')||0)+101),remoteHosts:[],sources:['desktop'],complete:true,sidebar};
    }
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
      await context.addInitScript(({mode,project,order})=>{
        localStorage.setItem('list-mode',mode);localStorage.setItem('navigation:sidebar','open');
        localStorage.setItem(location.origin+'|project-thread-order:'+project,JSON.stringify(order));
      },{mode,project,order:initialRows.filter(row=>row.projectKey===project).map(row=>row.id).reverse()});
      const loaded=()=>page.waitForFunction(()=>listReadFinished&&listRows.length===14);
      const ids=selector=>page.locator(selector).evaluateAll(nodes=>nodes.map(node=>node.dataset.id));
      const group='#sessions .project-group[data-project-key="'+project+'"]',buttons=group+' > .session',label=mode+' '+width;
      await page.goto('http://127.0.0.1:'+server.address().port+'/');await loaded();
      if(mode==='recent')check(await ids('#sessions .session'),initialRows.map(row=>row.id),'最近列表从新到旧 '+label);
      else{
        check(await ids(buttons),initialRows.slice(0,5).map(row=>row.id),'忽略旧手动顺序并在项目首屏显示最新五条 '+label);
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
        check(await page.getByRole('button',{name:/在项目中[上下]移/}).count(),0,'普通聊天菜单不再提供手动调序 '+label);
        await page.getByRole('button',{name:'取消',exact:true}).click();
        check(await page.locator(buttons).evaluateAll(nodes=>nodes.every(node=>!node.draggable)),true,'项目内聊天不再支持拖动排序 '+label);
        rows[6].recency=300;
        await page.evaluate(id=>bumpRecency(id,'local',300),id(7));
        check((await ids(buttons))[0],id(7),'旧手动顺序不再将最新聊天挤到加载更多 '+label);
        const heading=page.locator(group+' > summary');
        if(width<1000){
          await heading.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:100,clientY:180});
          await page.locator('.chat-context-menu').waitFor();
          await heading.dispatchEvent('pointerup',{pointerType:'touch',isPrimary:true});
        }else await heading.click({button:'right'});
        check(await page.getByRole('button',{name:'聊天按最近交互排序',exact:true}).count(),0,'项目菜单无需恢复最近排序选项 '+label);
        await page.getByRole('button',{name:'取消',exact:true}).click();
        await page.reload();await loaded();
        check((await ids(buttons)).slice(0,2),[id(7),id(8)],'整页刷新始终按最近交互排序 '+label);
      }
      await context.close();
    }
    for(const width of [390,820,1280])for(const mode of ['codex','project']){
      rows=initialRows.map(row=>({...row}));
      const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<1000}),page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));
      await context.addInitScript(mode=>{localStorage.setItem('list-mode',mode);localStorage.setItem('navigation:sidebar','open');},mode);
      const group='#sessions .project-group[data-project-key="'+project+'"]',buttons=group+' > .session',label=mode+' '+width;
      const ids=()=>page.locator(buttons).evaluateAll(nodes=>nodes.map(node=>node.dataset.id));
      const ready=()=>page.waitForFunction(()=>listReadFinished&&listRows.length>=14);
      const menu=async n=>{
        const target=page.locator(buttons+'[data-id="'+id(n)+'"]');
        await target.scrollIntoViewIfNeeded();
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        if(width<1000){
          await target.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:100,clientY:180});
          try{await page.locator('.chat-context-menu').waitFor();}catch(error){console.error({label,n,errors,state:await page.evaluate(()=>({dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.outerHTML),rows:listRows.length,loading:listLoading,finished:listReadFinished}))});throw error;}
          await target.dispatchEvent('pointerup',{pointerType:'touch',isPrimary:true});
        }else await target.click({button:'right'});
      };
      const pin=async n=>{await menu(n);await page.getByRole('button',{name:'在项目内置顶',exact:true}).click();};
      await page.goto('http://127.0.0.1:'+server.address().port+'/');await ready();
      await page.locator(group+' > .project-load-more').click();await pin(8);await pin(7);
      check((await ids()).slice(0,2),[id(7),id(8)],'项目内多个置顶按交互时间排列 '+label);
      check(await page.locator('#sessions [data-section="pinned"] > .session[data-id="'+id(8)+'"]').count(),0,'项目内置顶不移入全局置顶区 '+label);
      await menu(8);
      check(await page.getByRole('button',{name:'在项目中上移',exact:true}).count(),0,'置顶聊天不提供普通手动排序 '+label);
      await page.getByRole('button',{name:'取消',exact:true}).click();
      rows[7].recency=200;rows[2].recency=300;
      await page.evaluate(ids=>{bumpRecency(ids[0],'local',200);bumpRecency(ids[1],'local',300);},[id(8),id(3)]);
      check((await ids()).slice(0,3),[id(8),id(7),id(3)],'置顶内部更新且普通新交互不越过置顶 '+label);
      await page.reload();await ready();
      check(await ids(),[id(8),id(7),id(3),id(1),id(2),id(4),id(5)],'刷新保留置顶并另显示五条普通聊天 '+label);
      check(await page.locator(buttons+'[data-project-pinned="true"] strong').allTextContents(),['排序测试 8','排序测试 7'],'项目内置顶不在聊天名前添加提示文字 '+label);
      const pinBackgrounds=await page.locator(group).evaluate(root=>{
        const pinned=root.querySelector('[data-project-pinned="true"]'),ordinary=root.querySelector('.session:not([data-project-pinned])');
        const colors=[];
        for(const theme of ['light','dark']){
          document.documentElement.dataset.theme=theme;
          const background=getComputedStyle(pinned).backgroundColor;
          pinned.classList.add('selected');const selected=getComputedStyle(pinned).backgroundColor;pinned.classList.remove('selected');
          colors.push(background!==getComputedStyle(ordinary).backgroundColor&&selected!==background);
        }
        document.documentElement.dataset.theme='light';return colors;
      });
      check(pinBackgrounds,[true,true],'明暗主题通过背景区分置顶且选中状态仍可辨认 '+label);
      if(mode==='codex')await page.screenshot({path:path.resolve(__dirname,'../.tmp/project-pins-'+width+'.png')});
      await menu(8);await page.getByRole('button',{name:'取消项目内置顶',exact:true}).click();
      check((await ids()).slice(0,4),[id(7),id(3),id(8),id(1)],'取消后按最近时间回到普通列表 '+label);
      // A pin in the look-ahead row must survive the normal prefix truncation.
      const other=Array.from({length:120},(_,i)=>({id:id(100+i),host:'local',title:'其他项目 '+i,cwd:'/other',projectKey:'local|other',projectName:'其他项目',recency:1000+i,access:{source:'desktop'}}));
      rows.push(...other.slice(0,93));await page.evaluate(()=>sessionStorage.clear());await page.reload();await ready();
      check((await ids())[0],id(7),'全局分页预读行中的项目置顶不会被截掉 '+label);
      // Move it beyond that look-ahead row as well, then drop tab cache again.
      rows.push(...other.slice(93));
      await page.evaluate(()=>sessionStorage.clear());await page.reload();await ready();
      check((await ids())[0],id(7),'冷启动仍读取最近一百条以外的项目置顶 '+label);
      check(await page.locator('#sessions .session').count(),6,'补读旧置顶不展开其他项目的普通分页 '+label);
      await page.locator('#search').fill('排序测试 1');
      await page.waitForFunction(()=>listReadFinished&&listQuery==='排序测试 1');
      check(await page.locator(buttons+'[data-project-pinned="true"]').count(),0,'搜索不会被不匹配的旧置顶穿透 '+label);
      await context.close();
    }
    check(selectedReads.some(ids=>ids.includes(id(7))),true,'旧置顶使用定向只读元数据查询');
    check(writes,[],'排序验证没有打开聊天或发送写入');
    check(errors,[],'浏览器无脚本异常');
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
