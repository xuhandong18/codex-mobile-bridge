'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const official={visible:true,loginType:'chatgpt',accountKey:'a'.repeat(64),limits:[],resetCredits:null,canReset:false,updatedAt:1900000000};
const allNodes=node=>[node,...node.children.flatMap(allNodes)];
const isSkillRequest=url=>url.includes('/catalog?')&&new URL(url,'http://fixture').searchParams.get('kind')==='skills';
const skillRequests=ui=>ui.requests.filter(isSkillRequest);

async function runSearch(ui,value){
  const search=ui.run('composerReferences.search');search.value=value;search.oninput();
  const pending=[...ui.timers.entries()].filter(([,t])=>t.delay===200);assert.equal(pending.length,1,'Reference search should keep one 200 ms debounce');
  const timer=pending[0];
  ui.timers.delete(timer[0]);await timer[1].fn();await new Promise(setImmediate);
}

async function fixture(read,kind='chatgpt',catalog=null,gatewayLanguage,accountSnapshot=null){
  const nodes=new Map(),timers=new Map(),requests=[],intervals=[],events={},responses=[];let timerId=0,delayNextSkill=null,failNextSkill=false;
  const matches=(node,selector)=>selector.startsWith('.')?String(node.className||'').split(/\s+/).includes(selector.slice(1)):
    selector.startsWith('[')?node[selector.slice(1,-1).split('=')[0]]===selector.slice(1,-1).split('=')[1]?.replace(/["']/g,''):node.tagName===selector.toUpperCase();
  const node=(tag='div')=>{const listeners=new Map();return {tagName:tag.toUpperCase(),getBoundingClientRect(){return {width:0};},value:'',checked:false,disabled:false,hidden:false,open:false,textContent:'',dataset:{},options:[],children:[],style:{setProperty(k,v){this[k]=v;}},scrollTop:0,parentElement:null,
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},setAttribute(k,v){this[k]=String(v);},
    addEventListener(type,fn,options={}){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({fn,once:options.once});},
    dispatchEvent(event){event.target??=this;this['on'+event.type]?.(event);for(const entry of [...listeners.get(event.type)||[]]){if(entry.once)listeners.set(event.type,listeners.get(event.type).filter(value=>value!==entry));entry.fn(event);}return !event.defaultPrevented;},
    closest(selector){for(let current=this;current;current=current.parentElement)if(matches(current,selector))return current;return selector==='dialog'?nodes.get('accounts-dialog'):null;},
    replaceChildren(...children){for(const child of this.children)child.parentElement=null;this.children=[];this.textContent='';this.append(...children);},append(...children){for(const child of children){child.parentElement=this;this.children.push(child);}},after(child){const parent=this.parentElement;if(parent?.children){parent.children.splice(parent.children.indexOf(this)+1,0,child);child.parentElement=parent;}},
    querySelectorAll(selector){return this.children.flatMap(allNodes).filter(child=>selector.split(',').some(value=>matches(child,value.trim())));},querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
    focus(){document.activeElement=this;},remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;},
    setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
    showModal(){this.open=true;},close(){if(this.open){this.open=false;this.dispatchEvent({type:'close'});}}};};
  const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
  for(const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){
    const n=node(match[1]);n.hidden=/\bhidden\b/.test(match[2]);nodes.set(match[3],n);
  }
  const document={body:node('body'),activeElement:null,addEventListener(){},dispatchEvent(){},documentElement:{},getElementById:id=>nodes.get(id)||allNodes(document.body).find(node=>node.id===id),querySelector:()=>({classList:{toggle(){}}}),querySelectorAll:()=>[],createElement:node};
  document.body.append(...nodes.values());
  for(const value of ['default','plan','goal']){const option=node('option');option.value=value;nodes.get('work-mode').append(option);}
  const storage=()=>{const saved=new Map();return {getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,String(value)),removeItem:key=>saved.delete(key),clear:()=>saved.clear()};};
  const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
  const context=vm.createContext({SidebarNavigation:class{},ChatContextMenu:class{},SelectedTextAction:class{},NewChatSettings:class{constructor(){this.defaults={remember(){}};}load(){}},ClientNavigation:class{constructor(){this.provider="codex";}async refresh(){}async openChatLink(hash){assert.equal(hash,'','This fixture enters without a chat deep link');return false;}},DesktopSessionsView:class{clear(){}},Workbench:class{constructor(){this.fileQuotes={rows:[],validate:()=>nodes.get('message').value,text:()=>nodes.get('message').value,clear(){},forget(){}};}open(){}reset(){}setThumbnails(){}relabel(){}},Event:class{constructor(type){this.type=type;}},navigator:{userAgent:'test'},Date,crypto:webcrypto,Option:function(text,value){return {...node('option'),textContent:text,value};},document,
    AbortController,window:{addEventListener:(name,fn)=>events[name]=fn},localStorage:storage(),sessionStorage:storage(),
    location:{hash:'',pathname:'/',search:''},history:{replaceState(){}},
    setTimeout(fn,delay){timers.set(++timerId,{fn,delay});return timerId;},clearTimeout(id){timers.delete(id);},setInterval(fn,delay){intervals.push({fn,delay});},
    fetch:async(url,options={})=>{
      requests.push(url);
      if(url==='/api/auth')return response({authenticated:true,csrf:'fixture',uiLanguage:gatewayLanguage});
      if(url.startsWith('/api/sessions?'))return response({sessions:[]});
      if(url==='/api/projects?metadata=1')return response({sections:[],projects:[]});
      if(url.includes('/workspace?'))return response({root:'D:\\fixture',entries:[{name:'README.md',path:'README.md',kind:'file'}],nextOffset:null});
      if(url==='/api/accounts')return response(accountSnapshot||{accounts:[],activeId:null,current:{kind,status:'ready',name:'Fixture'},switch:{phase:'idle'}});
      if(isSkillRequest(url)){
        if(failNextSkill){failNextSkill=false;return response({error:'Skill fixture error'},500);}
        const params=new URL(url,'http://fixture').searchParams;const rows=catalog?.skills||[];const query=(params.get('q')||'').toLowerCase();
        const filtered=rows.filter(row=>[row.name,row.displayName,row.description].join(' ').toLowerCase().includes(query));
        const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||200);
        const result={skills:filtered.slice(offset,offset+limit),errors:[],total:filtered.length,offset,limit,cache:{state:'fresh',updatedAt:1,bucketId:'fixture-bucket'}};
        if(delayNextSkill){const wait=delayNextSkill;delayNextSkill=null;await wait.promise;}
        return response(result);
      }
      if(url.includes('/catalog?kind=models'))return response(catalog);
      if(url.includes('/catalog'))return response(catalog);
      if(url.includes('/settings')){responses.push(JSON.parse(options.body));return response({confirmed:true});}
      if(url.includes('/respond')){responses.push(JSON.parse(options.body));return response({});}
      if(url.includes('/send')){responses.push(JSON.parse(options.body));return response({status:'accepted'});}
      throw Error('Unexpected request '+url);
    }});
  for(const file of ['web/hosts/environment.js','web/shared/i18n.js','web/features/chat/list-sync.js','web/features/chat/session-list.js','web/features/accounts/account.js','web/features/accounts/accounts.js','web/features/chat/modes.js','web/features/chat/attachments.js','web/features/chat/activity.js','web/features/chat/fast-mode.js','web/features/chat/message-actions.js','web/features/chat/permissions.js','web/features/chat/reference-picker.js','web/features/chat/project-folder-browser.js','web/shell/app.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),context);
  await new Promise(setImmediate);
  return {nodes,requests,timers,intervals,events,responses,run:code=>vm.runInContext(code,context),
    failNextSkill(){failNextSkill=true;},
    delayNextSkill(){let release;const promise=new Promise(resolve=>release=resolve);delayNextSkill={promise,release};return release;},
    async retry(){const entry=[...timers.entries()].find(([,t])=>t.delay<=5000);assert.ok(entry,'Account read should retry promptly without user input');timers.delete(entry[0]);await entry[1].fn();await new Promise(setImmediate);}};
}

test('official and API connections have no current-account fallback outside saved cards',async()=>{
 const desktopHtml=fs.readFileSync(path.join(__dirname,'../desktop/index.html'),'utf8');
 assert.doesNotMatch(desktopHtml,/id="account-(?:details|button|content)"/);
 for(const kind of ['chatgpt','api']){
  const ui=await fixture(r=>r(official),kind);
  assert.equal(ui.nodes.get('accounts-button').textContent,'账号管理');
  for(const id of ['account-status','account-dialog','account-details','account-button','account-content'])assert.equal(ui.nodes.has(id),false,id);
  assert.equal(ui.requests.filter(url=>url==='/api/account').length,0);
  ui.nodes.get('accounts-button').onclick();await new Promise(setImmediate);
  assert.equal(ui.nodes.get('accounts-dialog').open,true);
  assert.equal(ui.requests.some(url=>url==='/api/account'||url==='/api/account?cached=1'),false);
 }
});
test('saved official card retains its direct reset action without a second quota panel',async()=>{
 const account={id:'official',kind:'chatgpt',name:'Official',details:{usage:{status:'ready',checkedAt:Date.now()/1000,limits:[],resetCredits:{availableCount:1}}}};
 const ui=await fixture(r=>r(official),'chatgpt',null,null,{accounts:[account],activeId:account.id,current:{id:account.id,kind:'chatgpt',status:'ready',name:account.name},switch:{phase:'idle'},blockers:[]});
 ui.nodes.get('accounts-button').onclick();await new Promise(setImmediate);
 const all=node=>[node,...node.children.flatMap(all)];
 const card=all(ui.nodes.get('accounts-content')).find(node=>node.className==='account-bucket');
 assert.ok(card);assert.ok(all(card).some(node=>node.tagName==='BUTTON'&&node.textContent==='使用重置卡'));
 assert.equal(ui.nodes.has('account-details'),false);
 assert.equal(ui.requests.some(url=>url==='/api/account'||url==='/api/account?cached=1'),false);
});
test('opening, refreshing and logging out never read the old current-account endpoint',async()=>{
 const ui=await fixture(r=>r(official));
 ui.nodes.get('accounts-button').onclick();await new Promise(setImmediate);
 await ui.run('accountsPanel.refresh()');ui.run('showLogin()');
 assert.equal(ui.requests.some(url=>url==='/api/account'||url==='/api/account?cached=1'),false);
});
test('computer approval buttons send precisely the selected persistence and retain their original chat',async()=>{
 const ui=await fixture(r=>r(official));
 for(const [label,persist] of [['始终允许','always'],['允许此对话','session'],['拒绝',undefined]]){
  ui.run("currentId='11111111-1111-4111-8111-111111111111';currentHost='local';submittedRequestIds.clear();renderApprovals([{id:'computer-'+Math.random(),method:'mcpServer/elicitation/request',supported:true,params:{computerUse:{app:'Fixture app',persistModes:['session','always']}}}])");
  const all=n=>[n,...n.children.flatMap(all)],card=ui.nodes.get('approvals');
  assert.equal(all(card).some(n=>n.textContent==='本次允许'),false);
  const button=all(card).find(n=>n.textContent===label);assert.ok(button);
  ui.run("currentId='22222222-2222-4222-8222-222222222222'");await button.onclick();
  const reply=ui.responses.at(-1).response;assert.equal(reply.persist,persist);assert.equal(reply.action,persist?'accept':'decline');
  assert.match(ui.requests.at(-1),/11111111-1111-4111-8111-111111111111/);
 }
});

test('API chat picker shows upstream Gemini models and requires replacing the unavailable old model explicitly',async()=>{
 const catalog={models:[{id:'gemini-fixture',name:'gemini-fixture',efforts:[]}],skills:[],modelSource:'api',currentModel:'gpt-old',fastMode:{allowed:false}};
 const ui=await fixture(r=>r(official),'api',catalog);
 ui.run("currentId='11111111-1111-4111-8111-111111111111';state={model:'gpt-old',provider:'bridge_api',connected:true,effort:'high'}");
 await ui.nodes.get('model-button').onclick();
 const select=ui.nodes.get('model-select');assert.ok(select.children.some(o=>o.value==='gemini-fixture'));
 assert.equal(select.children.some(o=>o.value.startsWith('gpt')),false);assert.equal(select.value,'');
 assert.match(ui.nodes.get('model-error').textContent,/当前聊天模型不在上游/);assert.equal(ui.nodes.get('model-save').disabled,true);
 assert.equal(ui.responses.length,0);select.value='gemini-fixture';select.onchange();
 assert.equal(ui.nodes.get('model-save').disabled,false);assert.equal(ui.nodes.get('fast-mode-control').hidden,true);
 await ui.nodes.get('model-form').onsubmit({preventDefault(){}});
 assert.equal(ui.responses[0].model,'gemini-fixture');assert.equal(ui.responses[0].effort,'high');
 assert.equal(ui.responses[0].fastMode,undefined);
});
test('API model discovery failure shows its error with manual input instead of stale GPT options',async()=>{
 const ui=await fixture(r=>r(official),'api',{models:[],skills:[],modelSource:'api',modelError:'上游拒绝访问，请检查 API Key 和模型列表权限',fastMode:{allowed:false}});
 ui.run("currentId='11111111-1111-4111-8111-111111111111';state={model:'gpt-old',provider:'openai',connected:true}");
 await ui.nodes.get('model-button').onclick();
 assert.match(ui.nodes.get('model-error').textContent,/上游拒绝/);assert.equal(ui.nodes.get('custom-model-label').hidden,false);
 assert.equal(ui.nodes.get('model-select').children.some(o=>o.value.startsWith('gpt')),false);
 assert.equal(ui.responses.length,0);
});
test('reference picker creates its dialog lazily and replaces the old Skill selection UI',async()=>{
  const ui=await fixture(r=>r(official));
  const picker=ui.run('composerReferences');
  assert.equal(picker.dialog,undefined);
  assert.equal(skillRequests(ui).length,0);
  assert.equal(picker.button,ui.nodes.get('skills-button'));
  assert.match(fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8'),/<button\b[^>]*\bid="skills-button"[^>]*>＋<\/button>/);
  for(const id of ['skill-count','skill-pills','skills-dialog','skill-list','skills-error'])assert.equal(ui.nodes.has(id),false,id);
  ui.run("currentId='thread';currentHost='local';state={connected:true};startCatalog()");await new Promise(setImmediate);
  assert.equal(skillRequests(ui).length,0,'Model preloading must leave skills lazy');
  await picker.button.onclick();
  assert.equal(picker.dialog.open,true);
  assert.deepEqual(Array.from(picker.tabButtons.keys()),['skills','files','sessions']);
  assert.deepEqual(Array.from(picker.tabButtons.values(),button=>button.textContent),['技能','项目文件','会话']);
  assert.equal(skillRequests(ui).length,1);
});
test('cached async model catalog still renders the picker instead of returning raw rows',async()=>{
  const catalog={models:[{id:'fixture-model',name:'Fixture',efforts:['high']}],skills:[],modelSource:'codex',currentModel:'fixture-model',fastMode:{allowed:false}};
  const ui=await fixture(r=>r(official),'api',catalog);
  ui.run("currentId='11111111-1111-4111-8111-111111111111';currentHost='local';state={connected:true,model:'fixture-model'}");
  ui.run("catalogData.models=[{id:'fixture-model',name:'Fixture',efforts:['high']}];catalogResults.models=null");
  await ui.nodes.get('model-button').onclick();
  assert.equal(ui.nodes.get('model-error').textContent,'');
  assert.ok(ui.nodes.get('model-select').children.some(o=>o.value==='fixture-model'));
  assert.equal(ui.nodes.get('model-save').disabled,false);
  await ui.nodes.get('model-button').onclick();
  assert.equal(ui.nodes.get('model-error').textContent,'');
  assert.ok(ui.nodes.get('model-select').children.some(o=>o.value==='fixture-model'));
});
test('model catalog accepts legacy array payloads and reports invalid payload types',async()=>{
  const catalog={data:[{id:'legacy-model',name:'Legacy',efforts:[]}],modelSource:'api',fastMode:{allowed:false}};
  const ui=await fixture(r=>r(official),'api',catalog);
  ui.run("currentId='11111111-1111-4111-8111-111111111111';currentHost='local';state={connected:true,model:'fixture-model'}");
  await ui.nodes.get('model-button').onclick();
  assert.ok(ui.nodes.get('model-select').children.some(o=>o.value==='legacy-model'));
  const bad=await fixture(r=>r(official),'api',{...catalog,models:'invalid'});
  bad.run("currentId='11111111-1111-4111-8111-111111111111';currentHost='local';state={connected:true,model:'fixture-model'}");
  await bad.nodes.get('model-button').onclick();
  assert.match(bad.nodes.get('model-error').textContent,/models: string/);
});
test('opening references loads one skill page and repeated opens do not refetch',async()=>{
  const rows=Array.from({length:5000},(_,i)=>({id:'skill-'+i,name:'skill-'+i,displayName:'Skill '+i,description:'Fixture skill '+i}));
  const ui=await fixture(r=>r(official),'api',{models:[],skills:rows,modelSource:'codex',fastMode:{allowed:false}});
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  const picker=ui.run('composerReferences');assert.equal(skillRequests(ui).length,0);
  await picker.open();
  assert.equal(skillRequests(ui).length,1);
  assert.equal(picker.active.items.length,200);assert.equal(picker.active.nextOffset,200);
  assert.equal(picker.list.querySelectorAll('.reference-item').length,200);
  assert.ok(allNodes(picker.list).some(node=>node.textContent==='Skill 0'));
  assert.equal(allNodes(picker.list).some(node=>node.textContent==='Skill 4000'),false);
  picker.close();await picker.button.onclick();
  assert.equal(skillRequests(ui).length,1);
});

test('skill search debounces to a new page and refresh is explicit',async()=>{
  const rows=Array.from({length:3},(_,i)=>({id:'skill-'+i,name:'skill-'+i,displayName:'Skill '+i,description:'Fixture '+i}));
  const ui=await fixture(r=>r(official),'api',{skills:rows});
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  const picker=ui.run('composerReferences');await picker.open();
  picker.search.value='ignored';picker.search.oninput();
  assert.equal(skillRequests(ui).length,1,'Typing should wait for the debounce');
  await runSearch(ui,'fixture');
  assert.equal(skillRequests(ui).length,2,'Later input should cancel the earlier debounce');
  const searched=skillRequests(ui).at(-1);
  assert.match(searched,/q=fixture/);assert.match(searched,/limit=200/);assert.match(searched,/offset=0/);
  assert.doesNotMatch(searched,/[?&]refresh=true/);
  await picker.refresh.onclick();
  assert.match(skillRequests(ui).at(-1),/refresh=true/);
});

test('a stale skill append cannot overwrite a newer search result',async()=>{
  const rows=Array.from({length:500},(_,i)=>({id:'skill-'+i,name:i===0?'needle skill':'skill-'+i,displayName:i===0?'Needle Skill':'Skill '+i,description:'Fixture '+i}));
  const ui=await fixture(r=>r(official),'api',{skills:rows});
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  const picker=ui.run('composerReferences');await picker.open();
  const releaseAppend=ui.delayNextSkill(),stale=picker.loadPage({append:true});
  assert.match(skillRequests(ui).at(-1),/offset=200/);
  await runSearch(ui,'needle');releaseAppend();await stale;
  assert.deepEqual(Array.from(picker.active.items,row=>row.id),['skill-0']);
  assert.equal(picker.active.query,'needle');assert.equal(picker.active.nextOffset,null);
  assert.equal(picker.error.textContent,'');assert.equal(picker.list.querySelectorAll('.reference-item').length,1);
});

test('skill search and refresh reset the list scroll position',async()=>{
  const rows=Array.from({length:500},(_,i)=>({id:'skill-'+i,name:'skill-'+i,displayName:'Skill '+i,description:'Fixture '+i}));
  const ui=await fixture(r=>r(official),'api',{skills:rows});
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  const picker=ui.run('composerReferences');await picker.open();
  picker.list.scrollTop=20000;await runSearch(ui,'skill-499');
  assert.equal(picker.list.scrollTop,0);
  assert.deepEqual(Array.from(picker.active.items,row=>row.id),['skill-499']);
  picker.list.scrollTop=500;await picker.refresh.onclick();
  assert.equal(picker.list.scrollTop,0);
});

test('choosing a skill inserts editable plain text without pills or implicit skills in submission',async()=>{
  const rows=[{id:'available',name:'skill-name',displayName:'Available',description:'Available'}];
  const ui=await fixture(r=>r(official),'api',{skills:rows});
  ui.run("currentId='thread';currentHost='local';state={connected:true,status:'idle'};sessionStorage.setItem('skills:'+chatKey(),JSON.stringify(['available','missing']));attachments.open(chatKey());workModes.open(chatKey())");
  const input=ui.nodes.get('message'),picker=ui.run('composerReferences');
  let inputEvents=0;input.addEventListener('input',()=>inputEvents++);
  input.value='Use this skill';input.setSelectionRange(input.value.length,input.value.length);
  await picker.open();
  assert.equal(picker.list.querySelectorAll('input').length,0,'Skills should be insertion buttons without checkboxes');
  const option=picker.list.querySelector('.reference-item');assert.ok(option);option.onclick();
  assert.equal(input.value,'Use this skill\n$skill-name\n');
  assert.equal(inputEvents,1);assert.equal(picker.dialog.open,false);
  assert.equal(ui.nodes.has('skill-pills'),false);assert.equal(ui.responses.length,0);
  assert.equal(ui.run('document.activeElement'),input);
  ui.nodes.get('send-mode').value='send';
  for(const text of [input.value,'An ordinary message after deleting the reference']){
    input.value=text;const previous=ui.responses.length;
    await ui.nodes.get('composer').onsubmit({preventDefault(){}});
    assert.equal(ui.responses.length,previous+1);assert.equal(ui.responses.at(-1).text,text);
    assert.equal(Object.hasOwn(ui.responses.at(-1),'skills'),false);
    assert.equal(ui.nodes.get('send-error').textContent,'');
  }
});

test('a stale skill search cannot overwrite a later search',async()=>{
  const rows=[{id:'older',name:'older',description:'First query'},{id:'newer',name:'newer',description:'Second query'}];
  const ui=await fixture(r=>r(official),'api',{skills:rows});
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  const picker=ui.run('composerReferences');await picker.open();
  const release=ui.delayNextSkill();
  picker.search.value='older';picker.search.oninput();
  const timer=[...ui.timers.entries()].find(([,t])=>t.delay===200);assert.ok(timer);ui.timers.delete(timer[0]);
  const stale=timer[1].fn();
  await runSearch(ui,'newer');release();await stale;
  assert.equal(picker.active.query,'newer');
  assert.deepEqual(Array.from(picker.active.items,item=>item.id),['newer']);
  assert.equal(picker.error.textContent,'');
});

test('reference tabs keep separate state and ignore a skill response after switching tabs',async()=>{
  const rows=[{id:'needle',name:'needle',description:'Fixture skill'}];
  const ui=await fixture(r=>r(official),'api',{skills:rows});
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  const picker=ui.run('composerReferences');await picker.open();await runSearch(ui,'needle');
  assert.deepEqual(Array.from(picker.active.items,item=>item.id),['needle'],'The search must finish before the cancelled refresh begins');
  assert.equal(picker.active.loaded,true);
  const skillsState=picker.active,release=ui.delayNextSkill(),stale=picker.refresh.onclick();
  await picker.tabButtons.get('files').onclick();
  assert.equal(picker.active,picker.states.get('files'));
  assert.equal(picker.search.value,'');assert.equal(picker.list.querySelector('strong').textContent,'README.md');
  release();await stale;
  assert.equal(picker.active,picker.states.get('files'));
  assert.equal(picker.list.querySelector('strong').textContent,'README.md');assert.equal(picker.error.textContent,'');
  await picker.tabButtons.get('sessions').onclick();
  assert.equal(picker.active,picker.states.get('sessions'));assert.equal(picker.active.loaded,true);
  await picker.setTab('skills');
  assert.equal(picker.active,skillsState);assert.equal(picker.search.value,'needle');
  assert.deepEqual(Array.from(picker.active.items,item=>item.id),['needle']);
});

for(const [changed,target] of [['conversation',"currentId='another-thread'"],['host',"currentHost='remote'"]])test('a stale skill response stays isolated when the '+changed+' changes',async()=>{
  const catalog={skills:[{id:'old',name:'old',description:'Old context'}]};
  const ui=await fixture(r=>r(official),'api',catalog);
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  const picker=ui.run('composerReferences'),release=ui.delayNextSkill(),stale=picker.open();
  catalog.skills=[{id:'new',name:'new',description:'New context'}];
  ui.run(target);await picker.open();
  release();await stale;
  assert.deepEqual(Array.from(picker.active.items,item=>item.id),['new']);
  assert.equal(picker.active.query,'');assert.equal(picker.active.nextOffset,null);
  assert.equal(picker.list.querySelector('strong').textContent,'new');assert.equal(picker.error.textContent,'');
  assert.equal(picker.loading,false);
  const url=new URL(skillRequests(ui).at(-1),'http://fixture');
  assert.equal(url.pathname,changed==='conversation'?'/api/sessions/another-thread/catalog':'/api/sessions/thread/catalog');
  assert.equal(url.searchParams.get('host'),changed==='host'?'remote':'local');
});

test('an account catalog reset closes references and discards cached source pages',async()=>{
  const ui=await fixture(r=>r(official),'chatgpt',{skills:[{id:'skill',name:'sample'}]});
  ui.run("currentId='thread';currentHost='local';state={connected:true}");
  await ui.nodes.get('skills-button').onclick();
  assert.equal(ui.run('composerReferences.dialog.open'),true);assert.equal(ui.run('composerReferences.active.items.length'),1);
  ui.run('resetModelCatalog()');
  assert.equal(ui.run('composerReferences.dialog.open'),false);assert.equal(ui.run('composerReferences.states.size'),0);
  await ui.nodes.get('skills-button').onclick();
  assert.equal(ui.requests.filter(url=>url.includes('kind=skills')).length,2,'The same chat must reload its new account catalog');
});

test('Skill failure clears the loading state and refresh can recover',async()=>{
  const ui=await fixture(r=>r(official),'chatgpt',{skills:[{id:'skill',name:'sample',displayName:'Sample',description:'fixture'}]});
  ui.run("currentId='thread';currentHost='local'");ui.failNextSkill();
  const picker=ui.run('composerReferences');await picker.open();
  assert.equal(picker.error.textContent,'Skill fixture error');
  assert.equal(picker.loading,false);assert.equal(picker.refresh.disabled,false);
  assert.equal(picker.list.querySelectorAll('.reference-item').length,0);
  await picker.refresh.onclick();
  assert.equal(picker.active.items.length,1);assert.equal(picker.active.loaded,true);
  assert.equal(picker.error.textContent,'');assert.equal(picker.loading,false);
  assert.match(skillRequests(ui).at(-1),/refresh=true/);
});

test('a failed explicit skill refresh can be retried without leaving the picker loading',async()=>{
  const catalog={skills:[{id:'old',name:'old'}]},ui=await fixture(r=>r(official),'api',catalog);
  ui.run("currentId='thread';currentHost='local'");const picker=ui.run('composerReferences');await picker.open();
  ui.failNextSkill();await picker.refresh.onclick();
  assert.equal(picker.error.textContent,'Skill fixture error');
  assert.equal(picker.loading,false);assert.equal(picker.refresh.disabled,false);
  catalog.skills=[{id:'new',name:'new'}];await picker.refresh.onclick();
  assert.equal(picker.error.textContent,'');assert.equal(picker.loading,false);
  assert.deepEqual(Array.from(picker.active.items,item=>item.id),['new']);
  assert.match(skillRequests(ui).at(-1),/refresh=true/);
});

test('Skill pagination uses actual scroll geometry and keeps complete descriptions',async()=>{
  const description='Full multiline Skill description. '.repeat(30);
  const rows=Array.from({length:220},(_,i)=>({id:'skill-'+i,name:'skill-'+i,displayName:'Skill '+i,description}));
  const ui=await fixture(r=>r(official),'api',{skills:rows});
  ui.run("currentId='thread';currentHost='local'");const picker=ui.run('composerReferences');await picker.open();
  assert.equal(picker.list.querySelector('strong').textContent,'Skill 0');
  assert.equal(picker.list.querySelector('small').textContent,description);
  Object.assign(picker.list,{scrollHeight:30000,clientHeight:400,scrollTop:1000});
  picker.list.onscroll();assert.equal(skillRequests(ui).length,1);
  picker.list.scrollTop=29500;picker.list.onscroll();await new Promise(setImmediate);
  assert.equal(picker.active.items.length,220);assert.equal(picker.active.nextOffset,null);
  assert.equal(picker.more.hidden,true);assert.match(skillRequests(ui).at(-1),/offset=200/);
  assert.equal(picker.list.querySelectorAll('small').at(-1).textContent,description);
});

test('entering a gateway follows its language, and manual switching remains available',async()=>{
 const ui=await fixture(r=>r(official),'chatgpt',null,'en');assert.equal(ui.run('BridgeI18n.language()'),'en');
 ui.nodes.get('phone-language').value='zh';ui.nodes.get('phone-language').onchange();assert.equal(ui.run('BridgeI18n.language()'),'zh');
 await ui.run('start()');assert.equal(ui.run('BridgeI18n.language()'),'en');
 const chinese=await fixture(r=>r(official),'chatgpt',null,'zh');assert.equal(chinese.run('BridgeI18n.language()'),'zh');
});


test('account switch discards API model capabilities before opening the official picker',async()=>{
 const catalog={models:[{id:'gpt-6-astra',name:'Astra',efforts:[]}],modelSource:'api'};
 const ui=await fixture(r=>r(official),'api',catalog);
 ui.run("currentId='11111111-1111-4111-8111-111111111111';state={connected:true,model:'gpt-6-astra',effort:'minimal'}");
 await ui.nodes.get('model-button').onclick();
 catalog.modelSource='codex';catalog.models=[{id:'gpt-6-astra',name:'Astra',efforts:['low','medium','high','xhigh','max','ultra'],defaultEffort:'low'}];
 ui.run("accountsPanel.accept({accounts:[],activeId:'official',current:{kind:'chatgpt',name:'Official'},switch:{phase:'complete'}})");
 await ui.nodes.get('model-button').onclick();
 assert.deepEqual(ui.nodes.get('effort-select').children.map(o=>o.value),catalog.models[0].efforts);
 assert.equal(ui.nodes.get('effort-select').value,'low');
 await ui.nodes.get('model-form').onsubmit({preventDefault(){}});
 assert.equal(ui.responses.at(-1).effort,'low');
});
test('official model with unknown capabilities does not offer every effort or allow saving',async()=>{
 const catalog={models:[{id:'official-missing',name:'Missing',efforts:[]}],modelSource:'codex'};
 const ui=await fixture(r=>r(official),'chatgpt',catalog);
 ui.run("currentId='11111111-1111-4111-8111-111111111111';state={connected:true,model:'official-missing',effort:'minimal'}");
 await ui.nodes.get('model-button').onclick();
 assert.equal(ui.nodes.get('effort-select').disabled,true);
 assert.equal(ui.nodes.get('effort-select').children.some(o=>o.value==='none'||o.value==='minimal'),false);
 assert.equal(ui.nodes.get('model-save').disabled,true);
});
test('model default must belong to its supported efforts',async()=>{
 const catalog={models:[{id:'official-fixture',name:'Fixture',efforts:['low','high'],defaultEffort:'minimal'}],modelSource:'codex'};
 const ui=await fixture(r=>r(official),'chatgpt',catalog);
 ui.run("currentId='11111111-1111-4111-8111-111111111111';state={connected:true,model:'official-fixture',effort:'none'}");
 await ui.nodes.get('model-button').onclick();
 assert.equal(ui.nodes.get('effort-select').value,'low');
});


test('explicit upstream refresh replaces the list and reports its access name',async()=>{
 const catalog={models:[{id:'gpt-fixture',name:'GPT',efforts:[]}],modelSource:'api',modelAccessName:'Old access'};
 const ui=await fixture(r=>r(official),'api',catalog);
 ui.run("currentId='11111111-1111-4111-8111-111111111111';state={connected:true,model:'gpt-fixture',effort:'high'}");
 await ui.nodes.get('model-button').onclick();
 catalog.models=[{id:'gemini-pro',name:'Gemini',efforts:[]}];catalog.modelAccessName='suopan-antigravity';
 await ui.nodes.get('model-refresh').onclick();
 assert.equal(ui.nodes.get('model-select').children.some(o=>o.value==='gpt-fixture'),false);
 assert.equal(ui.nodes.get('model-select').children.some(o=>o.value==='gemini-pro'),true);
 assert.match(ui.nodes.get('model-access').textContent,/suopan-antigravity/);
 assert.equal(ui.responses.length,0);
 assert.ok(ui.requests.filter(r=>r.includes('catalog?kind=models&refresh=true')).length>=2);
});
