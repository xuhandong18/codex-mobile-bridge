'use strict';
// Independent browser contexts and the production UI, with synthetic clients.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const web=path.resolve(__dirname,'../web'),assets=require('../web/assets.json'),project='local|a';
const id=n=>'11111111-1111-4111-8111-'+String(n).padStart(12,'0');
const rows=Array.from({length:8},(_,i)=>({id:id(i+1),host:'local',title:'跨设备聊天 '+(i+1),cwd:'/a',projectKey:project,projectName:'项目 A',recency:100-i,access:{source:'desktop'}}));
let preferences,sidebar,dropSave=false;const errors=[],writes=[],checks=[];
function reset(){
  preferences={revision:0,fields:{}};
  sidebar={projects:[{key:project,host:'local',name:'项目 A',cwd:'/a'},{key:'local|b',host:'local',name:'项目 B',cwd:'/b'}],
    sections:[{id:'work',name:'工作',itemKeys:['codex:project:a','codex:project:b']},{id:'other',name:'其他',itemKeys:[]}],
    sectionOrder:['pinned','custom:work','custom:other','projects','threads']};
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1'),p=url.pathname;res.setHeader('Cache-Control','no-store');
  if(p.startsWith('/api/')){
    let value={};res.setHeader('Content-Type','application/json');
    if(p==='/api/auth')value={authenticated:true,csrf:'synthetic-csrf',listCacheIdentity:'a'.repeat(64),computer:{name:'Fixture'},uiLanguage:'zh'};
    else if(p==='/api/clients')value={clients:[{id:'codex',name:'Codex',enabled:true,configured:true,connected:true,installed:true,running:true}]};
    else if(p==='/api/accounts')value={accounts:[],current:{kind:'api'}};
    else if(p==='/api/sessions')value={sessions:rows,remoteHosts:[],availableSources:['desktop'],complete:true,sidebar,sidebarPreferences:preferences};
    else if(p==='/api/projects')value=sidebar;
    else if(p==='/api/activity')value={sessions:[]};
    else if(p==='/api/sidebar-preferences'){
      if(req.method==='POST'){
        let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);writes.push({path:p,body});
        if(body.changes.some(row=>(preferences.fields[row.key]?.version||0)!==row.version)){res.statusCode=409;res.end(JSON.stringify({error:'conflict'}));return;}
        for(const row of body.changes)preferences.fields[row.key]={value:row.value,version:row.version+1};preferences.revision++;
        if(dropSave){dropSave=false;res.writeHead(200);res.write('{"revision":');setTimeout(()=>res.destroy(),30);return;}
      }
      value=preferences;
    }else if(p==='/api/sidebar-management'&&req.method==='POST'){
      let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);writes.push({path:p,body});
      assert.equal(body.action,'move');
      if(body.kind==='project'){
        const key='codex:project:'+body.targetId.split('|')[1];
        for(const section of sidebar.sections)section.itemKeys=section.itemKeys.filter(item=>item!==key);
        sidebar.sections.find(section=>section.id===body.sectionId)?.itemKeys.push(key);
        const placement=JSON.stringify(['placement','project','local',body.targetId]);
        preferences.fields[placement]={value:null,version:(preferences.fields[placement]?.version||0)+1};preferences.revision++;
      }else{
        const key='custom:'+body.targetId,order=sidebar.sectionOrder.filter(item=>item!==key);
        order.splice(body.beforeId?order.indexOf('custom:'+body.beforeId):order.length,0,key);sidebar.sectionOrder=order;
      }
      value={id:body.id,status:'completed',message:'合成侧栏操作完成'};
    }else if(req.method!=='GET'){writes.push({path:p});res.statusCode=400;value={error:'Unexpected fixture write'};}
    res.end(JSON.stringify(value));return;
  }
  if(p==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(path.join(web,'index.html')));return;}
  let parts=assets[p];
  if(!parts&&(p.startsWith('/vendor/')||/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(p))&&!p.includes('..'))parts=p.slice(1);
  if(!parts){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat([].concat(parts).map(file=>fs.readFileSync(path.join(web,file)))));
});
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks.push(label);};
const group='#sessions .project-group[data-project-key="'+project+'"]';
async function menu(page,selector,width){
  const target=page.locator(selector);await target.scrollIntoViewIfNeeded();
  if(width<1000){
    await target.dispatchEvent('pointerdown',{pointerType:'touch',isPrimary:true,clientX:100,clientY:180});
    await page.locator('.chat-context-menu').waitFor();
    await target.dispatchEvent('pointerup',{pointerType:'touch',isPrimary:true});
  }else await target.click({button:'right'});
}
async function refresh(page){await page.evaluate(()=>loadList(true));}
async function ready(page){await page.waitForFunction(()=>listReadFinished&&listRows.length===8);}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280]){
      reset();const otherWidth=width===1280?390:1280,label=width+' ↔ '+otherWidth;
      const a=await browser.newContext({viewport:{width,height:900},hasTouch:width<1000}),b=await browser.newContext({viewport:{width:otherWidth,height:900},hasTouch:otherWidth<1000});
      const phone=await a.newPage(),computer=await b.newPage();
      for(const page of [phone,computer]){page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));}
      await a.addInitScript(({project,chat})=>{localStorage.setItem('navigation:sidebar','open');if(!localStorage.getItem('fixture-seeded')){localStorage.setItem(location.origin+'|project-pins',JSON.stringify([[project,chat]]));localStorage.setItem(location.origin+'|sidebar-placement:'+JSON.stringify(['project','local',project]),JSON.stringify({target:'section:work'}));localStorage.setItem('fixture-seeded','1');}},{project,chat:id(8)});
      await b.addInitScript(()=>localStorage.setItem('navigation:sidebar','open'));
      const base='http://127.0.0.1:'+server.address().port;
      await phone.goto(base);await ready(phone);await computer.goto(base);await ready(computer);
      const pinned=page=>page.locator(group+' > .session[data-project-pinned="true"]').evaluateAll(nodes=>nodes.map(node=>node.dataset.id));
      check(await pinned(computer),[id(8)],'旧设备置顶迁移到全新设备 '+label);

      await menu(phone,group+' > .session[data-id="'+id(3)+'"]',width);
      await phone.getByRole('button',{name:'在项目内置顶',exact:true}).click();
      await phone.waitForFunction(chat=>projectPins.read('local|a').has(chat),id(3));
      await computer.bringToFront();await computer.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await computer.waitForFunction(chat=>projectPins.read('local|a').has(chat),id(3));
      check(await pinned(computer),[id(3),id(8)],'另一设备回到前台自动同步项目置顶 '+label);

      await menu(phone,group+' > .session[data-id="'+id(3)+'"]',width);
      await menu(computer,group+' > .session[data-id="'+id(3)+'"]',otherWidth);await computer.getByRole('button',{name:'取消项目内置顶',exact:true}).click();
      await computer.waitForFunction(chat=>!projectPins.read('local|a').has(chat),id(3));
      await phone.getByRole('button',{name:'取消项目内置顶',exact:true}).click();
      await phone.waitForFunction(chat=>!projectPins.read('local|a').has(chat),id(3));
      check(await pinned(phone),[id(8)],'旧菜单取消置顶不会反向重新置顶 '+label);

      await menu(phone,group+' > summary',width);await phone.getByRole('button',{name:'下移',exact:true}).click();
      await phone.waitForFunction(()=>sectionProjectOrder.read('work')[0]==='local|b');await refresh(computer);
      check(await computer.locator('#sessions [data-section="work"] > .project-group').evaluateAll(nodes=>nodes.map(node=>node.dataset.projectKey)),['local|b','local|a'],'项目上下顺序跨设备一致 '+label);

      await menu(phone,group+' > summary',width);await phone.getByRole('button',{name:'移动到分区…',exact:true}).click();
      const moveProject=phone.locator('dialog[open]').filter({has:phone.getByRole('heading',{name:'移动项目',exact:true})});await moveProject.getByLabel('所属分区').selectOption('other');await moveProject.getByRole('button',{name:'保存',exact:true}).click();
      await phone.waitForFunction(()=>sidebarData.sections.find(s=>s.id==='other').itemKeys.includes('codex:project:a'));await refresh(computer);
      check(await computer.locator('#sessions [data-section="other"] > .project-group').getAttribute('data-project-key'),project,'原生项目跨分区移动在另一设备恢复 '+label);

      await menu(phone,'#sessions .sidebar-section[data-section="other"] > summary',width);await phone.getByRole('button',{name:'移动顺序…',exact:true}).click();
      const moveSection=phone.locator('dialog[open]').filter({has:phone.getByRole('heading',{name:'移动分区顺序',exact:true})});await moveSection.getByLabel('移动到',{exact:true}).selectOption('work');await moveSection.getByRole('button',{name:'保存',exact:true}).click();
      await phone.waitForFunction(()=>sidebarData.sectionOrder.indexOf('custom:other')<sidebarData.sectionOrder.indexOf('custom:work'));await refresh(computer);
      check(await computer.locator('#sessions > .sidebar-section').evaluateAll(nodes=>nodes.map(node=>node.dataset.section).filter(id=>['work','other'].includes(id))),['other','work'],'分区上下移动跨设备一致 '+label);

      await menu(phone,group+' > .session[data-id="'+id(3)+'"]',width);await phone.getByRole('button',{name:'移动到分区…',exact:true}).click();
      const placement=phone.locator('.sidebar-placement-dialog');await placement.getByLabel('所属分区').selectOption('section:work');await placement.getByRole('button',{name:'保存',exact:true}).click();await placement.waitFor({state:'hidden'});await refresh(computer);
      check(await computer.locator('#sessions [data-section="work"] > .session[data-id="'+id(3)+'"]').count(),1,'聊天所属分区也跨设备同步 '+label);

      const before=writes.filter(row=>row.path==='/api/sidebar-preferences').length;dropSave=true;
      await menu(phone,group+' > .session[data-id="'+id(8)+'"]',width);await phone.getByRole('button',{name:'取消项目内置顶',exact:true}).click();
      await phone.waitForFunction(chat=>!projectPins.read('local|a').has(chat),id(8));await refresh(computer);
      check((await pinned(computer)).includes(id(8)),false,'回包丢失后通过只读核对同步取消置顶 '+label);
      check(writes.filter(row=>row.path==='/api/sidebar-preferences').length-before,1,'回包丢失也只提交一次 '+label);
      await computer.reload();await ready(computer);
      check(await computer.locator('#sessions [data-section="other"] > .project-group').getAttribute('data-project-key'),project,'全页重载保留项目分区 '+label);
      check(await computer.locator('#sessions > .sidebar-section').evaluateAll(nodes=>nodes.map(node=>node.dataset.section).filter(id=>['work','other'].includes(id))),['other','work'],'全页重载保留分区顺序 '+label);
      check((await pinned(computer)).includes(id(8)),false,'全页重载不会恢复已取消的旧置顶 '+label);
      await a.close();await b.close();
    }
    check(writes.filter(row=>!['/api/sidebar-preferences','/api/sidebar-management'].includes(row.path)),[],'没有打开聊天、发送消息或启动真实客户端');
    check(errors,[],'所有设备页面没有脚本异常');
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
