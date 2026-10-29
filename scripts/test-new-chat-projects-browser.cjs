'use strict';
// Production page and synthetic navigation data only; no real clients or chats.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json'),checks=[],errors=[],writes=[],catalogs=[];
const projects=Array.from({length:72},(_,i)=>({key:'local|p'+i,host:'local',name:i===1?'同名项目':'项目 '+String(i).padStart(2,'0'),cwd:'D:/workspace/很长的项目目录/project-'+i}));
projects.push({key:'ssh:prod|remote',host:'ssh:prod',hostLabel:'生产主机',name:'同名项目',cwd:'/srv/remote/project'},
  {key:'ssh:test|test',host:'ssh:test',hostLabel:'测试主机',name:'远程测试',cwd:'/srv/test/project'});
const cli=[{key:'cli|local|fixture',host:'local',type:'cli',name:'命令行项目',cwd:'D:/cli/project'},
  {key:'cli|ssh:prod|fixture',host:'ssh:prod',hostLabel:'生产主机',type:'cli',name:'命令行项目',cwd:'/srv/cli/project'}];
const sidebar={projects,sections:[{id:'work',name:'工作',itemKeys:projects.slice(0,6).reverse().map(p=>'codex:project:'+p.key.split('|')[1])},
  {id:'research',name:'研究',itemKeys:projects.slice(6,18).map(p=>'codex:project:'+p.key.split('|')[1])}],
  sectionOrder:['custom:research','pinned','custom:work','projects','threads'],projectOrder:projects.map(p=>p.key.split('|')[1]).reverse(),pinnedProjectIds:['p20']};
const preferences={revision:1,fields:{[JSON.stringify(['order','work'])]:{value:['local|p3','local|p2','local|p1'],version:1},
  [JSON.stringify(['placement','project','local','local|p0'])]:{value:{target:'section:research'},version:1},
  [JSON.stringify(['placement','project','ssh:prod','cli|ssh:prod|fixture'])]:{value:{target:'section:work'},version:1}}};
let includeCli=true,metadataAvailable=true,holdProjects=false,releaseProjects,projectWaitStarted;
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
    if(p.startsWith('/api/')){
      res.setHeader('Content-Type','application/json');let value={};
      if(req.method!=='GET'){writes.push(p);req.resume();res.statusCode=400;return res.end(JSON.stringify({error:'Unexpected fixture write'}));}
      if(p==='/api/auth')value={authenticated:true,csrf:'fixture',listCacheIdentity:'a'.repeat(64),computer:{name:'测试电脑'}};
      else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
      else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
      else if(p==='/api/sessions')value={sessions:[],sidebar,sidebarPreferences:preferences,remoteHosts:[],complete:true,availableSources:['desktop','cli']};
      else if(p==='/api/activity')value={sessions:[]};
      else if(p==='/api/sidebar-preferences')value=preferences;
      else if(p==='/api/projects'){
        if(url.searchParams.has('metadata')){
          if(!metadataAvailable){res.statusCode=503;return res.end(JSON.stringify({error:'offline'}));}value=sidebar;
        }else{const rows=[...projects,...includeCli?cli:[]];if(holdProjects)await new Promise(resolve=>{releaseProjects=resolve;projectWaitStarted?.();});value={projects:rows};}
      }else if(p==='/api/new-chat-models'){catalogs.push(url.searchParams.get('project'));value={models:[]};}
      return res.end(JSON.stringify(value));
    }
    let parts=assets[p];if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
    if(!parts){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p==='/'?'text/html;charset=utf-8':'application/octet-stream');
    res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
  }catch(error){errors.push(error.message);res.statusCode=500;res.end('{}');}
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
  try{
    browser=await chromium.launch({headless:true,...process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}});
    const base='http://127.0.0.1:'+server.address().port;
    for(const [width,height] of [[320,740],[390,844],[820,1180],[844,390],[1440,1000]]){
      const context=await browser.newContext({viewport:{width,height},colorScheme:'light'}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base);await page.waitForFunction(()=>listComplete&&sidebarPreferences.revision===1);
      const expected=await page.evaluate(()=>[...document.querySelectorAll('#sessions > .sidebar-section')].filter(section=>section.querySelector('.project-group')).map(section=>({id:section.dataset.section,keys:[...section.querySelectorAll(':scope > .project-group')].map(p=>p.dataset.projectKey)})));
      await page.locator('#new-chat').click();await page.locator('#new-chat-project-button').click();
      const actual=await page.locator('.nc-project-group').evaluateAll(groups=>groups.map(group=>({id:group.dataset.section,keys:[...group.querySelectorAll('.nc-project-option')].map(p=>p.dataset.key)})));
      assert.deepEqual(actual,expected);check(true,'分区归属、置顶和项目顺序与导航完全一致 '+width);
      check(await page.locator('.nc-project-option').count()===projects.length+1,'大量项目和独立聊天均可选择 '+width);
      check(await page.locator('.nc-project-list').evaluate(node=>node.scrollHeight>node.clientHeight&&node.getBoundingClientRect().width<=innerWidth),'项目列表有界滚动且没有横向溢出 '+width);
      const search=page.locator('.nc-project-search');await search.fill('项目');
      for(const theme of ['dark','light','system']){
        if(theme==='system')await page.emulateMedia({colorScheme:'dark'});
        await page.evaluate(theme=>{const control=document.querySelector('#appearance-theme');control.value=theme;control.dispatchEvent(new Event('change'));},theme);
        await page.waitForFunction(expected=>document.documentElement.dataset.theme===expected,theme==='light'?'light':'dark');
        const appearance=await page.evaluate(()=>{
          const rgb=value=>[...value.matchAll(/[\d.]+/g)].map(match=>Number(match[0]));
          const background=node=>{
            const parents=[];for(let current=node;current;current=current.parentElement)parents.unshift(current);
            return parents.reduce((base,parent)=>{const [r,g,b,a=1]=rgb(getComputedStyle(parent).backgroundColor);return [r,g,b].map((v,i)=>v*a+base[i]*(1-a));},[255,255,255]);
          };
          const luminance=color=>color.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((total,value,i)=>total+value*[.2126,.7152,.0722][i],0);
          const contrast=node=>{const a=luminance(rgb(getComputedStyle(node).color)),b=luminance(background(node));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
          const input=getComputedStyle(document.querySelector('#new-chat-title'));
          return {raised:input.backgroundColor,surfaces:['.nc-project-trigger','.nc-project-panel','.nc-project-heading'].map(selector=>getComputedStyle(document.querySelector(selector)).backgroundColor),
            names:[...document.querySelectorAll('.nc-project-trigger>strong,.nc-project-title>strong')].map(contrast),
            details:[...document.querySelectorAll('.nc-project-heading,.nc-project-path,.nc-project-host')].map(contrast),
            query:document.querySelector('.nc-project-search').value,selected:document.querySelector('#new-chat-project').value,open:!document.querySelector('.nc-project-panel').hidden};
        });
        check(appearance.surfaces.every(color=>color===appearance.raised),'选择按钮、面板和分区标题使用当前主题表面色 '+theme+' '+width);
        check(Math.min(...appearance.names)>=4.5&&Math.min(...appearance.details)>=3,'普通及选中项目名称、主机和目录在当前主题中清晰可见 '+theme+' '+width);
        check(appearance.open&&appearance.query==='项目'&&appearance.selected==='local|independent','切换主题保留展开、搜索和项目选择 '+theme+' '+width);
        const option=page.locator('.nc-project-option[aria-selected=false]').first();await option.hover();
        const hovered=await option.evaluate(node=>getComputedStyle(node).backgroundColor!=='rgba(0, 0, 0, 0)');
        await page.mouse.move(0,0);await search.focus();await search.press('ArrowDown');
        check(hovered&&await page.evaluate(()=>document.activeElement.matches('.nc-project-option:focus-visible')&&getComputedStyle(document.activeElement).outlineStyle!=='none'),'当前主题的悬停和键盘焦点保持可见 '+theme+' '+width);
        if(theme==='dark'&&process.argv.includes('--screenshots')){const dir=path.resolve(__dirname,'../.tmp/new-chat-projects');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,width+'x'+height+'-dark.png')});}
      }
      await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
      await search.fill('生产主机');
      check(await page.locator('.nc-project-option').count()===1,'按运行主机搜索 '+width);
      await page.locator('.nc-project-option').click();await page.waitForFunction(()=>!newChatSettings.loading);
      check(await page.locator('#new-chat-project').inputValue()==='ssh:prod|remote'&&await page.locator('#new-chat-path').textContent()==='/srv/remote/project','同名项目选中正确主机和目录 '+width);
      check(catalogs.at(-1)==='ssh:prod|remote','模型目录沿用选中的运行主机 '+width);
      await page.locator('#new-chat-project-button').click();await search.fill('PROJECT-71');
      check(await page.locator('.nc-project-option').count()===1,'按目录搜索不区分大小写 '+width);
      await search.fill('找不到的项目');check(await page.locator('.nc-project-empty').isVisible(),'无匹配项目时显示空状态 '+width);
      await search.fill('研究');check(await page.locator('.nc-project-group').count()===1,'按分区名称搜索 '+width);
      await search.press('Enter');check(await page.locator('#new-chat-dialog').isVisible()&&writes.length===0,'搜索回车不创建聊天 '+width);
      await search.press('ArrowDown');await page.keyboard.press('Enter');check(await page.locator('.nc-project-panel').isHidden(),'方向键和回车选择项目 '+width);
      await page.locator('#new-chat-project-button').click();await search.press('Escape');
      check(await page.locator('.nc-project-panel').isHidden()&&await page.locator('#new-chat-dialog').isVisible(),'Escape 只收起项目列表 '+width);
      await page.locator('#new-chat-type').selectOption('cli');await page.locator('#new-chat-project-button').click();
      check(await page.locator('.nc-project-option').count()===cli.length&&!await page.locator('[data-key="local|independent"]').count(),'命令行项目独立选择且不混入桌面项目 '+width);
      await search.fill('生产主机');await page.locator('.nc-project-option').click();
      check(await page.locator('#new-chat-project').inputValue()===cli[1].key,'命令行同名项目保留主机身份 '+width);
      await page.evaluate(()=>{document.querySelector('#phone-language').value='en';document.querySelector('#phone-language').dispatchEvent(new Event('change'));});await page.locator('#new-chat-project-button').click();
      check(await search.getAttribute('placeholder')==='Search projects, folders or hosts','搜索和空状态支持英文 '+width);
      await page.evaluate(()=>{document.querySelector('#phone-language').value='zh';document.querySelector('#phone-language').dispatchEvent(new Event('change'));});await page.locator('#new-chat-type').selectOption('desktop');
      await page.locator('#new-chat-project-button').click();
      if(process.argv.includes('--screenshots')){const dir=path.resolve(__dirname,'../.tmp/new-chat-projects');fs.mkdirSync(dir,{recursive:true});await page.screenshot({path:path.join(dir,width+'x'+height+'.png')});}
      await page.getByRole('button',{name:'关闭新建聊天',exact:true}).click();
      if(width===390){
        metadataAvailable=false;await page.locator('#new-chat').click();await page.locator('#new-chat-project-button').click();
        check(await page.locator('.nc-project-group').count()===expected.length,'元数据读取失败时保留导航分组 '+width);metadataAvailable=true;
        await page.getByRole('button',{name:'关闭新建聊天',exact:true}).click();
      }
      const remote=page.locator('#sessions .project-group[data-project-key="ssh:prod|remote"]');
      const beforeCatalogs=catalogs.length;await remote.locator('summary .project-create').click();await page.waitForFunction(()=>document.querySelector('#new-chat-project').value==='ssh:prod|remote'&&!newChatSettings.loading);
      check(await page.locator('#new-chat-project-button').textContent().then(text=>text.includes('同名项目')&&text.includes('生产主机')),'导航项目旁的加号预选正确项目 '+width);
      check(catalogs.length===beforeCatalogs+1,'预选项目只加载对应主机的模型，不先查询其他项目 '+width);
      await context.close();
    }
    const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.waitForFunction(()=>listComplete);holdProjects=true;
    const started=new Promise(resolve=>projectWaitStarted=resolve);await page.locator('#new-chat').click();await started;
    await page.getByRole('button',{name:'关闭新建聊天',exact:true}).click();holdProjects=false;includeCli=false;
    await page.locator('#new-chat').click();await page.locator('#new-chat-project-button').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('#new-chat-project-button').disabled);
    await page.locator('#new-chat-type').selectOption('cli');await page.locator('#new-chat-project-button').click();
    check(await page.locator('.nc-project-empty').isVisible()&&await page.locator('#new-chat-submit').isDisabled(),'没有命令行项目时显示空状态并禁止创建');
    const oldResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/projects'&&!new URL(response.url()).searchParams.has('metadata'));
    releaseProjects();await oldResponse;await page.waitForLoadState('networkidle');
    check(await page.locator('.nc-project-option').count()===0&&await page.locator('#new-chat-submit').isDisabled(),'关闭后重新打开忽略上次晚到的项目回包');await context.close();
    check(writes.length===0,'浏览和选择项目不会创建聊天或写入导航设置');check(errors.length===0,'浏览器无脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{releaseProjects?.();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
