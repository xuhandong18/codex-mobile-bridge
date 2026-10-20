'use strict';
// Capture once and remove the bearer fragment before any API request or chat routing.
function takePairingToken(){
  if(!location.hash.startsWith('#pair='))return null;
  const token=location.hash.slice(6);
  history.replaceState(null,'',location.pathname+location.search);
  return token;
}
let initialPairingToken=takePairingToken();
let pendingEntryChatLink=null;
let entering=false;
const composerDrafts=new ComposerDrafts();
const $ = id => document.getElementById(id),t=BridgeI18n.t;
let csrf='', currentId=null, state=null, listOffset=0, listQuery='', approvalStamp='', sending=false;
let runningSendChoice=null;
let claudeCliAccessPanel=null;
let currentHost='local', listRows=[], listGeneration=0, listHasMore=false, listArchived=false, listSource='all', availableSources=[], listRenderStamp='';
let listComplete=false, listReadFinished=false, listIdentity='', listFilterKey='';
let listHostIds=[],sidebarData={sections:[],projects:[]};
const createdChats=new Map();
const projectChatPages=new Map();
const projectPins=new SidebarProjectPins(localStorage,(window.BridgeRelayBase||location.origin||location.host||'gateway')+'|project-pins');
const sectionProjectOrder=new SidebarItemOrder(localStorage,(window.BridgeRelayBase||location.origin||location.host||'gateway')+'|section-project-order:');
const sidebarPlacements=new SidebarPlacements(localStorage,(window.BridgeRelayBase||location.origin||location.host||'gateway')+'|sidebar-placement:');
let sourceFilterStamp='';
let chatTimeline=null,reconnectFailure=null;
const dismissedHostFaults=new Map();
const submittedRequestIds=new Set();
const sessionActivity=new SessionActivity({onRead:async(key,row)=>{
  const split=key.indexOf('|'),host=key.slice(0,split),id=key.slice(split+1);
  try{const result=await api(sessionUrl(id,'read-state',host),{id:uuid(),turnId:row.turnId,turnStatus:row.turnStatus});if(result.status==='unknown'||result.status==='unsupported')toast(result.message||'桌面已读状态尚未同步');}catch(error){toast(error.message);}
}});
const recentInteractions=new Map();
function bumpRecency(id,host,at=Date.now()){
  const key=chatKey(id,host);recentInteractions.set(key,Math.max(at,recentInteractions.get(key)||0));
  const row=listRows.find(row=>row.id===id&&row.host===host);
  if(row&&at>row.recency){row.recency=at;listRows.sort((a,b)=>b.recency-a.recency);renderList();}
}
let activityBusy=false;
const fastModeControl=new FastModeControl({root:$('fast-mode-control'),input:$('fast-mode-enabled'),status:$('fast-mode-status')});
let modelRequest=0,modelTarget=null,modelSaving=false;
async function goalAction(action,payload) {
  const id=currentId,host=currentHost;
  const result=await api(sessionUrl(id,'goal/'+action,host),payload);
  if(!result.confirmed)throw Error('目标操作结果尚未确认，请查看目标状态');
  if(currentId===id&&currentHost===host){state={...state,goal:action==='cancel'?null:(result.result?.goal||result.result)};workModes.render(state,$('send-mode').value,false);}
  toast(action==='cancel'?'目标已关闭':action==='edit'?'目标已修改，保持暂停':payload.status==='paused'?'目标已暂停':'目标已恢复');
}
const workModes=new WorkModes({select:$('work-mode'),hint:$('mode-hint'),goalRoot:$('goal-state'),goalToggle:$('goal-toggle'),newId:uuid,
  onCancel:payload=>goalAction('cancel',payload),onStatus:payload=>goalAction('status',payload),onEdit:payload=>goalAction('edit',payload)});
window.addEventListener('focus',()=>{if(!$('app').hidden)accountsPanel?.refresh();});
function chatKey(id=currentId,host=currentHost){return host+'|'+id;}
function sessionUrl(id,action='',host=currentHost){const path='/api/sessions/'+id+(action?'/'+action:'')+'?host='+encodeURIComponent(host);return window.BridgeRelayURL?.(path)||path;}
function hostUrl(path,host=currentHost){const value=/^\/api\/sessions\/[0-9a-f-]{36}/.test(path)&&!/[?&]host=/.test(path)?path+(path.includes('?')?'&':'?')+'host='+encodeURIComponent(host):path;return window.BridgeRelayURL?.(value)||value;}
let listLoading=0;
let modelCatalogGeneration=0;let catalogData={models:null};let catalogResults={models:null};let catalogTasks={models:null};
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
function toast(text){text=t(text);$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,4200);}
function renderHostErrors(hosts){
  const root=$('host-errors'),gateway=(window.BridgeRelayBase||location.origin||'')+'|';
  const active=new Set(hosts.map(host=>gateway+(host.host||host.label)));
  for(const key of dismissedHostFaults.keys())if(key.startsWith(gateway)&&!active.has(key))dismissedHostFaults.delete(key);
  root.replaceChildren();
  for(const host of hosts){
    const key=gateway+(host.host||host.label),fault=String(host.error||'');
    if(dismissedHostFaults.get(key)===fault)continue;
    const row=el('div','host-error-row');row.append(el('span','',host.label+'：'+fault));
    const close=el('button','plain','×');close.type='button';close.setAttribute('aria-label',t('关闭连接错误'));
    close.onclick=()=>{dismissedHostFaults.set(key,fault);row.remove();root.hidden=!root.childElementCount;};
    row.append(close);root.append(row);
  }
  root.hidden=!root.childElementCount;
}
function clearListSnapshot(){
  for(let i=sessionStorage.length-1;i>=0;i--){const key=sessionStorage.key(i);if(key?.startsWith('codex-list-v1:'))sessionStorage.removeItem(key);}
  createdChats.clear();projectChatPages.clear();
  listIdentity='';listFilterKey='';listHostIds=[];listRows=[];listOffset=0;listHasMore=false;listComplete=false;listReadFinished=false;availableSources=[];listRenderStamp='';listGeneration++;
}
function authLost(){clearListSnapshot();if(!$('app').hidden)document.dispatchEvent(new Event('bridge-auth-lost'));showLogin();}
async function api(path,body,signal){const options={signal,credentials:'same-origin',cache:'no-store',headers:{}};if(body!==undefined){options.method='POST';options.headers={'Content-Type':'application/json','X-CSRF-Token':csrf};options.body=JSON.stringify(body);if(path==='/api/answer-drafts'&&new Blob([options.body]).size<60000)options.keepalive=true;}const response=await fetch(hostUrl(path),options);const data=await response.json();if(!response.ok){if(response.status===401)authLost();throw Object.assign(Error(data.error||t('请求失败')),{loginStatus:data.loginStatus,status:response.status});}return data;}
const workbench=window.BridgeWorkbench=new Workbench({chat:$('chat'),request:api,csrf:()=>csrf,notify:toast,onUnauthorized:authLost,openChat,loadReferences:loadComposerReferences});
workbench.canQuoteMain=()=>!!currentId&&!sending&&currentAccess().canSend;
workbench.revealMainComposer=()=>{if($('composer-toggle').getAttribute('aria-expanded')==='false')$('composer-toggle').click();};
const desktopSessions=new DesktopSessionsView({drafts:composerDrafts,root:$('app'),select:$('desktop-backend'),request:api,notify:toast,csrf:()=>csrf,onUnauthorized:authLost,onSelect:provider=>{
  if(provider!=='codex'){saveDraft();chatTimeline?.dispose();chatTimeline=null;currentId=null;state=null;workbench.reset();$('chat').hidden=true;$('welcome').hidden=false;$('app').classList.remove('chat-open');history.replaceState(null,'',location.pathname);}
  else if(clientNavigation.provider==='codex'&&!$('app').hidden)loadList(true).catch(error=>toast(error.message));
}});
const clientNavigation=new ClientNavigation({view:desktopSessions,request:api,notify:toast});
const sidebarNavigation=new SidebarNavigation($('app'));
desktopSessions.onListEnter=()=>{clientNavigation.listReadDone=false;clientNavigation.listVisit=(clientNavigation.listVisit||0)+1;if(clientNavigation.provider!=='codex')desktopSessions.refresh();};
desktopSessions.onListReady=(provider,value)=>clientNavigation.acknowledgeList(provider,value);
async function uploadAttachment(key,id,file){const separator=key.indexOf('|'),host=key.slice(0,separator),thread=key.slice(separator+1);const response=await fetch(sessionUrl(thread,'uploads',host)+'&id='+encodeURIComponent(id)+'&name='+encodeURIComponent(file.name),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':csrf},body:file});const result=await response.json();if(!response.ok){if(response.status===401)authLost();const error=Error(result.error||t('附件上传失败，请重试'));error.retryable=response.status>=500||response.status===429;throw error;}return result;}
async function uploadAttachmentWithRetry(key,id,file){if(window.BridgeSharedRelay)return uploadAttachment(key,id,file);let last;for(let attempt=0;attempt<3;attempt++){try{return await uploadAttachment(key,id,file);}catch(error){last=error;if(error.name==='AbortError'||error.retryable===false||attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,400*(attempt+1)));}}if(last instanceof TypeError)last.message=t('附件上传中断，请重试');throw last;}
const attachments=new ChatAttachments({root:$('attachment-list'),button:$('attach-button'),input:$('attachment-input'),paste:$('message'),drop:$('composer'),preview:(key,id)=>{const at=key.indexOf('|'),host=key.slice(0,at),thread=key.slice(at+1);return hostUrl(sessionUrl(thread,'uploads/'+encodeURIComponent(id)+'/preview',host));},onChange:()=>{if(currentId)$('send').disabled=applyingNewChat===chatKey()||sending||!attachments.ready()||!state||state.loadingHistory||state.activating||!currentAccess().canSend;},thumbnail:async(key,id,file)=>{
  const separator=key.indexOf('|'),host=key.slice(0,separator),thread=key.slice(separator+1);
  const image=await attachments.thumbnailBlob(file);
  const response=await fetch(sessionUrl(thread,'uploads/'+encodeURIComponent(id)+'/thumb',host)+'&width='+image.width+'&height='+image.height,{method:'POST',credentials:'same-origin',headers:{'Content-Type':image.mime,'X-CSRF-Token':csrf},body:image.data});
  const result=await response.json();if(!response.ok){if(response.status===401)authLost();throw Error(result.error||t('缩略图生成失败'));}return result;
},upload:uploadAttachmentWithRetry});
function visibleChat(){return clientNavigation.provider==='codex'&&currentId&&!workbench.isFileVisible&&!document.hidden&&$('app').classList.contains('chat-open')?chatKey():null;}
function renderActivity(){let unknownAppeared=false;for(const button of $('sessions').querySelectorAll('.session')){
  const previous=button.querySelector('.session-indicator'),indicator=sessionActivity.indicator(chatKey(button.dataset.id,button.dataset.host));
  if(indicator?.kind==='unknown'&&!previous?.classList.contains('unknown'))unknownAppeared=true;
  previous?.remove();
  if(indicator){const dot=el('span','session-indicator '+indicator.kind);dot.title=t(indicator.label);dot.setAttribute('aria-label',t(indicator.label));button.querySelector('strong').prepend(dot);}
}if(state&&currentId)$('status').textContent=chatStatusText(state,sessionAccess(state.access));if(unknownAppeared&&!activityBusy)scheduleActivityRefresh();}
async function refreshActivity(){
  if($('app').hidden||document.hidden||clientNavigation.provider!=='codex')return;
  if(activityBusy){activityRefreshPending=true;return;}
  const root=$('sessions');if(!root.clientWidth||!root.clientHeight)return;
  const bounds=root.getBoundingClientRect(),top=Math.max(0,bounds.top),bottom=Math.min(window.innerHeight,bounds.bottom),left=Math.max(0,bounds.left),right=Math.min(window.innerWidth,bounds.right);
  if(bottom<=top||right<=left)return;
  const listed=new Set(listRows.map(row=>chatKey(row.id,row.host))),hosts={};
  for(const button of root.querySelectorAll('.session')){
    if(button.closest('details:not([open]),[hidden]')||!button.getClientRects().length)continue;
    const rect=button.getBoundingClientRect(),{id,host}=button.dataset,key=chatKey(id,host);
    if(rect.bottom<=top||rect.top>=bottom||rect.right<=left||rect.left>=right||!listed.has(key))continue;
    const ids=hosts[host]??=[];if(!ids.includes(id))ids.push(id);
  }
  if(!Object.keys(hosts).length)return;activityBusy=true;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const result=await api('/api/activity',{hosts},controller.signal);
    if(!$('app').hidden&&!document.hidden&&clientNavigation.provider==='codex'){
      sessionActivity.update(result.sessions,visibleChat(),{sync:false});
      for(const row of result.sessions)if(row.recency)bumpRecency(row.id,row.host,row.recency);
      renderActivity();
    }
  }catch{
    if(!$('app').hidden&&!document.hidden&&clientNavigation.provider==='codex'){
      const rows=Object.entries(hosts).flatMap(([host,ids])=>ids.map(id=>({id,host,connected:false,status:'unknown',activityError:controller.signal.aborted?'timeout':'unavailable'})));
      sessionActivity.update(rows,visibleChat(),{sync:false});renderActivity();
    }
  }finally{clearTimeout(timeout);activityBusy=false;if(activityRefreshPending){activityRefreshPending=false;scheduleActivityRefresh();}}
}
let activityRefreshTimer=null,activityRefreshPending=false;
function scheduleActivityRefresh(){clearTimeout(activityRefreshTimer);activityRefreshTimer=setTimeout(refreshActivity,100);}
setInterval(()=>{if(!activityBusy)refreshActivity();},5000);
window.addEventListener('focus',refreshActivity);
window.addEventListener('resize',scheduleActivityRefresh);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshActivity();});
if(typeof MutationObserver==='function')new MutationObserver(scheduleActivityRefresh).observe($('app'),{attributes:true,attributeFilter:['class','hidden']});
let loginStatus={attemptsRemaining:5,attemptLimit:5,blocked:false};
function renderLoginStatus(status=loginStatus){
  loginStatus=status||loginStatus;
  $('login-attempts').textContent=loginStatus.blocked?t('此 IP 已被封禁，请在电脑网关 App 的“登录设备”中解除。'):t('剩余尝试次数：')+loginStatus.attemptsRemaining+'/'+loginStatus.attemptLimit+t('；连续输错 5 次将封禁此 IP。');
  $('login-button').disabled=loginStatus.blocked;
}
function showLogin(passwordless=false,status){composerDrafts.bind('');clientNavigation.pendingChatLink=null;pendingEntryChatLink=null;currentId=null;$('message').value='';window.BridgeDownloads?.clear();$('mobile-binding-status').hidden=true;if(typeof codexCliAccessPanel!=='undefined')codexCliAccessPanel?.clear();claudeCliAccessPanel?.clear();if(window.BridgeSharedRelay){location.replace((window.BridgeRelayBase||'')+'/relay/');return;}desktopSessions.clear();workbench.reset();if(typeof accountsPanel!=='undefined')accountsPanel?.clear();chatTimeline?.dispose();chatTimeline=null;document.querySelectorAll('dialog[open]').forEach(d=>d.close());$('app').hidden=true;$('login').hidden=false;$('credentials').hidden=passwordless;$('noauth').hidden=!passwordless;$('username').required=!passwordless;$('password').value='';$('remember-login').parentElement.hidden=passwordless||BridgeHost.isNativeApp();$('login-attempts').hidden=passwordless;renderLoginStatus(status);$('bootstrap-status').hidden=true;window.BridgeBootstrap?.ready();}
async function start(pairingToken=null){
  window.BridgeBootstrap?.waitingForAuth();
  const auth=await api('/api/auth');
  if(['en','zh'].includes(auth.uiLanguage)){$('phone-language').value=auth.uiLanguage;$('phone-language').onchange();}
  if(pairingToken!==null){
    try{window.BridgeBootstrap?.pairingSubmitted();const result=await api('/api/pair',{token:pairingToken});csrf=result.csrf;await enter();return;}
    catch(error){
      if(auth.authenticated){csrf=auth.csrf;await enter(auth);toast(error.message);}
      else{showLogin(auth.passwordless,auth.loginStatus);$('login-error').textContent=t(error.message);}
      return;
    }finally{pairingToken=null;}
  }
  if(!auth.authenticated){clearListSnapshot();showLogin(auth.passwordless,auth.loginStatus);return;}csrf=auth.csrf;await enter(auth);
}
async function refreshComputer(){
  $('connected-computer').dataset.deviceName=location.host;
  $('computer-name').textContent=location.host;$('connected-computer').title=location.host;
  try{const auth=await api('/api/auth');if(!auth.authenticated||$('app').hidden)return;
    const binding=$('mobile-binding-status');binding.hidden=!auth.trustedDevice;binding.setAttribute('data-i18n','此手机已绑定，可在电脑网关的“登录设备”中解除绑定。');binding.textContent=t('此手机已绑定，可在电脑网关的“登录设备”中解除绑定。');
    const name=auth.computer?.name||location.host;$('connected-computer').dataset.deviceName=name;$('computer-name').textContent=name;
    $('connected-computer').title=[name,auth.computer?.platform,location.host].filter(Boolean).join(' · ');
  }catch{/* Older or temporarily unavailable gateways keep the connected address. */}
  finally{document.dispatchEvent(new Event('bridge-computer'));}
}
async function openHarness(){
  try{const state=await api('/api/harness');if(state.running)location.assign('/harness/');else toast('请在电脑 App 中启动 DeepSeek Harness');}
  catch(error){toast(error.message);}
}
$('harness-open').onclick=openHarness;
async function enter(authInfo){
  entering=true;
  try{
    desktopSessions.onListEnter();const chatLink=location.hash;$('desktop-backend').hidden=false;
    if(/(?:^|[?&])open=harness(?:&|$)/.test(location.search||'')){history.replaceState(null,'','/');await openHarness();}
    const verified=authInfo?.authenticated?authInfo:await api('/api/auth');
    if(!verified.authenticated)throw Error(t('登录状态暂不可用'));
    sidebarData={sections:[],projects:[]};
    listIdentity=await listAuthIdentity(verified);
    composerDrafts.bind(listIdentity);
    restoreListSnapshot();
    refreshComputer();$('login').hidden=true;$('app').hidden=false;$('bootstrap-status').hidden=true;window.BridgeBootstrap?.ready();document.dispatchEvent(new Event('bridge-authenticated'));
    const clientsReady=clientNavigation.refresh();accountsPanel?.refresh();
    if(clientNavigation.provider==='codex')loadList(true).catch(async e=>{await clientsReady.catch(()=>{});if(clientNavigation.provider==='codex')toast(e.message);});
    await clientsReady;
    const target=pendingEntryChatLink||chatLink;pendingEntryChatLink=null;entering=false;
    await clientNavigation.openChatLink(target,openChat);
  }finally{entering=false;}
}
$('login-form').addEventListener('submit',async event=>{event.preventDefault();if(loginStatus.blocked)return;$('login-button').disabled=true;$('login-error').textContent='';try{const result=await api('/api/login',{username:$('username').value,password:$('password').value,remember:$('remember-login').checked});renderLoginStatus({attemptsRemaining:5,attemptLimit:5,blocked:false});csrf=result.csrf;$('password').value='';await enter();}catch(error){$('login-error').textContent=t(error.message);renderLoginStatus(error.loginStatus);}finally{$('login-button').disabled=loginStatus.blocked;}});
$('logout').onclick=async()=>{await api('/api/logout',{});composerDrafts.forget();document.dispatchEvent(new Event('bridge-logged-out'));csrf='';state=null;currentId=null;$('messages').replaceChildren();$('approvals').replaceChildren();$('queued').replaceChildren();$('sessions').replaceChildren();$('message').value='';clearListSnapshot();sessionStorage.clear();workbench.fileQuotes.forget(()=>true);attachments.reset();sessionActivity.clear();recentInteractions.clear();showLogin();};
function dateText(value){if(!value)return '';return new Date(value*1000).toLocaleDateString(BridgeI18n.locale(),{month:'numeric',day:'numeric'});}
function listAuthIdentity(auth){return auth?.authenticated&&/^[0-9a-f]{64}$/.test(auth.listCacheIdentity||'')?auth.listCacheIdentity:'';}
function listSnapshotKey(filter){return listIdentity?'codex-list-v1:'+listIdentity+':'+filter:'';}
function currentListFilter(){return JSON.stringify([$('search').value,$('archived').checked,listSource]);}
function restoreListSnapshot(filter=currentListFilter()){
  const key=listSnapshotKey(filter);if(!key)return false;
  let saved;try{saved=JSON.parse(sessionStorage.getItem(key)||'null');}catch{return false;}
  if(!saved||!Array.isArray(saved.rows)||!Array.isArray(saved.sources)||!Array.isArray(saved.hosts))return false;
  listFilterKey=filter;listRows=saved.rows;availableSources=saved.sources;listHostIds=saved.hosts;
  listOffset=saved.offset;listHasMore=saved.hasMore===true;listComplete=false;listReadFinished=false;
  listQuery=$('search').value;listArchived=$('archived').checked;renderSourceFilter();renderList();return true;
}
function saveListSnapshot(filter){
  const key=listSnapshotKey(filter);if(!key)return;
  try{sessionStorage.setItem(key,JSON.stringify({rows:listRows,sources:availableSources,hosts:listHostIds,offset:listOffset,hasMore:listHasMore}));}catch{}
}
$('list-mode').value=localStorage.getItem('list-mode')||'codex';
$('list-mode').onchange=()=>{localStorage.setItem('list-mode',$('list-mode').value);renderList();};
listSource=localStorage.getItem('codex-source-filter')||'all';
if(!['all','desktop','cli'].includes(listSource))listSource='all';
$('source-filter').onchange=()=>{listSource=$('source-filter').value;localStorage.setItem('codex-source-filter',listSource);loadList(true).catch(e=>toast(e.message));};
function renderSourceFilter(){
  const sources=['desktop','cli'].filter(source=>availableSources.includes(source));
  const visible=sources.length>1;
  $('source-filter-label').hidden=!visible;
  if(listSource!=='all'&&(!visible||!sources.includes(listSource))){listSource='all';localStorage.setItem('codex-source-filter','all');return false;}
  const stamp=JSON.stringify([sources,BridgeI18n.locale()]);
  if(stamp!==sourceFilterStamp){
    const options=[['all',t('全部会话')],...sources.map(source=>[source,source==='desktop'?'APP':source.toUpperCase()])];
    $('source-filter').replaceChildren(...options.map(([value,label])=>{const option=el('option','',label);option.value=value;return option;}));
    sourceFilterStamp=stamp;
  }
  if($('source-filter').value!==listSource)$('source-filter').value=listSource;
  return true;
}
if(typeof bindChatListToolbar==='function')bindChatListToolbar(document.querySelector('#sidebar .chat-list-toolbar'));
function sessionAccess(access){
  if(!access)return {source:'desktop',runtime:'desktop',canSend:true,canInterrupt:true,canApprove:true,canReconnect:true,canConfigure:true,canChangePermissions:true,canChangeModel:true,canSelectSkills:true,canUseModes:true,canUseGoal:true,canUseSideChat:true,canEditMessages:true,readOnly:false};
  const legacy=access.source==='desktop';
  const allowed=name=>(name==='canReconnect'||!access.readOnly)&&(access[name]===undefined?legacy:access[name]===true);
  const specific=name=>access[name]===undefined?allowed('canConfigure'):allowed(name);
  return {...access,source:access.source||'unknown',runtime:access.runtime||null,canSend:allowed('canSend'),canInterrupt:allowed('canInterrupt'),canApprove:allowed('canApprove'),canReconnect:allowed('canReconnect'),canConfigure:allowed('canConfigure'),canChangePermissions:specific('canChangePermissions'),canChangeModel:specific('canChangeModel'),canSelectSkills:specific('canSelectSkills'),canUseModes:allowed('canUseModes'),canUseGoal:allowed('canUseGoal'),canUseSideChat:allowed('canUseSideChat'),canEditMessages:allowed('canEditMessages'),readOnly:access.readOnly===true};
}
function currentAccess(){return sessionAccess(state?.access||listRows.find(row=>row.id===currentId&&row.host===currentHost)?.access);}
function sourceLabel(access){return access?.source==='cli'?'CLI':access?.source==='ide'?'IDE':access?.source==='unknown'?t('其他来源'):'';}
function chatStatusText(view,access){
  if(view.connected&&view.requests?.length)return t('等待回应');
  if(view.connected&&view.status==='active')return t('运行中');
  const indicator=sessionActivity.indicator(chatKey());
  if(indicator?.kind==='running'||indicator?.kind==='unknown')return t(indicator.label);
  return !view.connected?(view.loadingHistory?t('读取历史中'):access.source==='cli'?t('历史记录'):view.activating?t('正在加载桌面聊天…'):view.connecting?t('连接桌面中'):t('历史记录')):t('已连接');
}
function isPlaceholderChatTitle(title){return !title||['新聊天','未命名聊天','New chat','Untitled chat',t('新聊天'),t('未命名聊天')].includes(title);}
function rememberCreatedChat(result,attempt){
  const project=newChatProjects.find(project=>project.key===attempt.project),host=result.host||'local';
  const row={id:result.id,host,title:attempt.autoTitle?t('新聊天'):attempt.title,projectKey:attempt.project,
    projectName:project?.name||t('独立聊天'),hostLabel:project?.hostLabel||t('此电脑'),cwd:project?.cwd||'',
    recency:Date.now(),archived:false,access:{source:attempt.kind==='cli'?'cli':'desktop'}};
  createdChats.set(chatKey(row.id,host),row);
  listRows=[row,...listRows.filter(item=>item.id!==row.id||item.host!==host)];
  listRenderStamp='';renderList();
}
function mergeCreatedChats(rows,host,query,archived,source){
  const ids=new Set(rows.map(row=>row.id)),merged=[...rows];
  for(const [key,row] of createdChats){
    if(row.host!==host)continue;
    if(ids.has(row.id)){createdChats.delete(key);continue;}
    if(!query&&!archived&&(source==='all'||source===row.access.source))merged.push(row);
  }
  return merged;
}
function sidebarEntry(kind,row){
  const id=kind==='project'?row.key:row.id,host=row.host||'local';
  const itemKey='codex:'+kind+':'+(kind==='project'?id.slice(id.indexOf('|')+1):id);
  const section=(sidebarData.sections||[]).find(section=>section.itemKeys?.includes(itemKey)||kind==='thread'&&row.thread_section_id&&section.hostSectionIds?.[host]===row.thread_section_id);
  const pinned=kind==='project'?sidebarData.pinnedProjectIds?.includes(id.slice(id.indexOf('|')+1)):row.is_pinned||sidebarData.pinnedThreadIds?.includes(id);
  return {kind,id,host,name:kind==='project'?row.name:row.title,native:section?'section:'+section.id:pinned?'pinned':'home',projectKey:kind==='project'?row.key:row.projectKey};
}
function sidebarTarget(item){return sidebarPlacements.resolve(item,(sidebarData.sections||[]).map(section=>section.id),item.native);}
function sectionProjectRows(item){
  const node=[...$('sessions').querySelectorAll('.project-group')].find(node=>node.dataset.projectKey===item.id&&node.dataset.host===item.host);
  const root=node?.parentElement;
  return {scope:root?.dataset.section||'projects',ids:root?[...root.children].filter(child=>child.dataset.projectKey).map(child=>child.dataset.projectKey):[]};
}
function sortSectionProjects(root,scope){
  const nodes=[...root.children],projects=nodes.filter(node=>node.dataset.projectKey),byId=new Map(projects.map(node=>[node.dataset.projectKey,node]));
  const ids=sectionProjectOrder.sort(scope,projects.map(node=>node.dataset.projectKey));let next=0;
  root.replaceChildren(...nodes.map(node=>node.dataset.projectKey?byId.get(ids[next++]):node));
}
function shiftSectionProject(item,direction){
  const {scope,ids}=sectionProjectRows(item),index=ids.indexOf(item.id),target=index+direction;
  if(index<0||target<0||target>=ids.length)return;
  try{
    if(sectionProjectOrder.move(scope,ids,item.id,direction<0?ids[target]:ids[target+1]||null)){listRenderStamp='';renderList();}
  }catch{toast('无法保存项目顺序，请检查设备存储权限。');}
}
function projectRows(key){
  return listRows.filter(row=>row.projectKey===key&&($('list-mode').value!=='codex'||sidebarTarget(sidebarEntry('thread',row))==='home'));
}
function isProjectPinned(row){return projectPins.read(row.projectKey).has(row.id);}
function toggleProjectPin(row){
  const current=listRows.find(chat=>chat.id===row.id&&chat.host===row.host);
  if(!current||current.projectKey!==row.projectKey||!projectRows(row.projectKey).includes(current))throw Error(t('侧栏条目已变化，请刷新后重试。'));
  try{projectPins.toggle(row.projectKey,row.id);}
  catch{throw Error(t('无法保存项目内置顶，请检查设备存储权限。'));}
  listRenderStamp='';renderList();
}
function projectPage(key){
  if(!projectChatPages.has(key))projectChatPages.set(key,{limit:5,loading:false});
  return projectChatPages.get(key);
}
async function loadProjectChats(key){
  const page=projectPage(key);
  if(page.loading||listLoading)return;
  const target=page.limit+10,filter=listFilterKey;
  page.loading=true;listRenderStamp='';renderList();
  try{
    // The existing API reads cumulative global pages. Keep reading metadata until
    // this project has its next ten rows, even if other projects fill a page.
    while(projectRows(key).filter(row=>!isProjectPinned(row)).length<target&&listHasMore){
      if(await loadList()===false)return;
      if(projectChatPages.get(key)!==page||filter!==listFilterKey)return;
    }
    if(projectChatPages.get(key)===page&&filter===listFilterKey)page.limit=target;
  }catch(error){toast(error.message);}
  finally{page.loading=false;listRenderStamp='';renderList();}
}
function collapseSidebarGroups(){
  for(const group of $('sessions').querySelectorAll('.sidebar-section, .project-group')){
    group.open=false;
    // Save now: a refresh can replace this node before its queued toggle event.
    group.ontoggle?.();
  }
}
function renderList(){
  const pageStamp=['codex','project'].includes($('list-mode').value)?[listHasMore,listLoading,[...projectChatPages].filter(([,page])=>page.limit!==5||page.loading)]:null;
  const stamp=JSON.stringify([$('list-mode').value,$('search').value,currentId,currentHost,BridgeI18n.locale(),availableSources,sidebarData,pageStamp,listRows.length?null:[listComplete,listReadFinished],listRows.map(row=>[row.id,row.host,row.title,row.projectKey,row.projectName,row.hostLabel,row.recency,row.access,row.is_pinned,row.thread_section_id,row.section_position])]);
  if(stamp===listRenderStamp&&$('sessions').children.length){renderActivity();return;}
  listRenderStamp=stamp;
  const scrollTop=$('sessions').scrollTop;
  $('sessions').replaceChildren();
  const native=$('list-mode').value==='codex',grouped=native||$('list-mode').value==='project', groups=new Map(),sectionRoots=new Map();
  const rememberGroup=(details,key,fallback)=>{
    let saved;try{saved=localStorage.getItem(key);}catch{}
    details.open=saved==='closed'?false:saved==='open'?true:fallback;
    details.ontoggle=()=>{if(details.isConnected===false)return;try{localStorage.setItem(key,details.open?'open':'closed');}catch{}scheduleActivityRefresh();};
  };
  if(native){
    const sections=[{id:'pinned',name:t('置顶')},...sidebarData.sections,{id:'projects',name:t('项目')},{id:'threads',name:t('聊天')}],order=sidebarData.sectionOrder||[];
    sections.sort((a,b)=>{const rank=section=>{const key=sidebarData.sections.includes(section)?'custom:'+section.id:section.id;const i=order.indexOf(key);return i<0?order.length:i;};return rank(a)-rank(b);});
    for(const section of sections){
      const details=el('details','sidebar-section');details.dataset.section=section.id;
      rememberGroup(details,'sidebar-section:'+section.id,!(section.collapsed??sidebarData.collapsedSections?.[section.id]));details.append(el('summary','',section.name));
      sectionRoots.set(section.id,details);$('sessions').append(details);
    }
  }
  const projectParent=project=>{
    if(!native)return $('sessions');
    const destination=sidebarTarget(sidebarEntry('project',project));
    return sectionRoots.get(destination==='home'?'projects':destination==='pinned'?'pinned':destination.slice(8));
  };
  const addProject=project=>{
    const details=el('details','project-group'),summary=el('summary','');
    rememberGroup(details,'group:'+project.key,true);
    summary.append(el('span','project-name',project.name+' · '+(project.host==='local'?t('此电脑'):project.hostLabel)));
    const create=el('button','plain project-create','+');create.type='button';
    create.title=t('新建')+' · '+project.name;create.setAttribute('aria-label',create.title);
    create.onclick=event=>{event.preventDefault();event.stopPropagation();openNewChat(project);};
    summary.append(create);details.append(summary);
    summary.dataset.projectKey=project.key;summary.dataset.host=project.host;summary.dataset.projectName=project.name;
    details.dataset.itemKey='codex:project:'+project.key.slice(project.key.indexOf('|')+1);
    details.dataset.projectKey=project.key;details.dataset.host=project.host;
    groups.set(project.key,details);projectParent(project).append(details);return details;
  };
  if(grouped&&!$('archived').checked&&listSource!=='cli'){
    const query=$('search').value.trim().toLocaleLowerCase();
    const projects=(sidebarData.projects||[]).filter(p=>!query||[p.name,p.cwd,p.hostLabel].join(' ').toLocaleLowerCase().includes(query)),order=sidebarData.projectOrder||[];
    projects.sort((a,b)=>{const rank=p=>{const i=order.indexOf(p.key.slice(p.key.indexOf('|')+1));return i<0?order.length:i;};return rank(a)-rank(b);});
    for(const project of projects)addProject(project);
  }
  for(const chat of listRows){
    let parent=$('sessions');
    const destination=native?sidebarTarget(sidebarEntry('thread',chat)):'home';
    if(native&&destination!=='home'){
      parent=sectionRoots.get(destination==='pinned'?'pinned':destination.slice(8));
    }else if(native&&chat.projectKey===chat.host+'|independent'){
      parent=sectionRoots.get('threads');
    }else if(grouped){
      if(!groups.has(chat.projectKey))addProject({key:chat.projectKey,name:chat.projectName,host:chat.host,hostLabel:chat.hostLabel,type:sessionAccess(chat.access).source==='cli'?'cli':'desktop',cwd:chat.cwd});
      parent=groups.get(chat.projectKey);
    }
    const button=el('button','session'+(chat.id===currentId&&chat.host===currentHost?' selected':''));
    button.dataset.id=chat.id;button.dataset.host=chat.host;button.dataset.itemKey='codex:thread:'+chat.id;button.dataset.sectionPosition=chat.section_position??'';
    button.append(el('strong','',chat.title));
    const source=sessionAccess(chat.access).source;
    button.append(el('span','session-source',source==='desktop'?'APP':sourceLabel({source})||t('其他来源')));
    const meta=el('small');meta.append(el('span','',chat.projectName+' · '+(chat.host==='local'?t('此电脑'):chat.hostLabel)),el('time','',dateText(chat.recency/1000)));
    button.append(meta);button.onclick=()=>openChat(chat.id,chat.host).catch(e=>toast(e.message));parent.append(button);
    if(groups.get(chat.projectKey)===parent&&isProjectPinned(chat)){
      button.dataset.projectPinned='true';button.setAttribute('aria-label',chat.title+' · '+t('项目内置顶'));
    }
  }
  if(native){
    const chatOrder=new Map(listRows.map((chat,index)=>[chat.host+'|'+chat.id,index]));
    const sortChildren=(root,keys=[])=>{
      const [summary,...items]=Array.from(root.children);
      items.sort((a,b)=>{const rank=node=>{const i=keys.indexOf(node.dataset.itemKey);return i<0?keys.length:i;};return rank(a)-rank(b)||(Number(a.dataset.sectionPosition||0)-Number(b.dataset.sectionPosition||0));});
      // Preserve project positions; native saved chat positions must not hide recent activity.
      const chats=items.filter(node=>node.dataset.id).sort((a,b)=>chatOrder.get(a.dataset.host+'|'+a.dataset.id)-chatOrder.get(b.dataset.host+'|'+b.dataset.id));let next=0;
      root.replaceChildren(summary,...items.map(node=>node.dataset.id?chats[next++]:node));
    };
    for(const [id,root] of sectionRoots)sortChildren(root,sidebarData.sections.find(section=>section.id===id)?.itemKeys||[]);
  }
  if(native)for(const [id,root] of sectionRoots)sortSectionProjects(root,id);
  else if(grouped)sortSectionProjects($('sessions'),'projects');
  if(grouped)for(const [key,root] of groups){
    const [summary,...items]=Array.from(root.children);
    const pins=projectPins.read(key),pinned=items.filter(node=>pins.has(node.dataset.id));
    // listRows is already recent-first; pins always precede ordinary pagination.
    const page=projectPage(key),ordered=items.filter(node=>!pins.has(node.dataset.id));
    root.replaceChildren(summary,...pinned,...ordered.slice(0,page.limit));
    if(ordered.length>page.limit||listHasMore){
      const more=el('button','plain project-load-more',t(page.loading?'正在读取…':'加载更多'));more.type='button';more.disabled=page.loading||!!listLoading;
      more.onclick=()=>loadProjectChats(key);root.append(more);
    }
  }
  if(native)for(const root of sectionRoots.values())if(root.children.length===1&&!sidebarData.sections.some(section=>section.id===root.dataset.section))root.hidden=true;
  if(!listRows.length&&!groups.size)$('sessions').append(el('p','muted',t(listComplete?'没有找到聊天。':listReadFinished?'暂不可用':'正在读取…')));renderActivity();$('sessions').scrollTop=scrollTop;scheduleActivityRefresh();
}
async function loadList(reset=false){
  if(!reset&&(listLoading||!listHasMore))return false;
  const generation=++listGeneration,offset=reset?0:listOffset;
  const query=$('search').value,archived=$('archived').checked,source=listSource;
  const filter=JSON.stringify([query,archived,source]);
  if(reset&&filter!==listFilterKey){
    projectChatPages.clear();
    if(!restoreListSnapshot(filter)){listRows=[];availableSources=[];listOffset=0;listHasMore=false;listHostIds=[];listFilterKey=filter;}
    $('sessions').scrollTop=0;
  }
  const targetCount=reset?Math.max(100,listOffset):offset+100;
  listComplete=false;listReadFinished=false;listLoading++;renderList();
  const groups=new Map();for(const row of listRows)(groups.get(row.host)||groups.set(row.host,[]).get(row.host)).push(row);
  const sources=new Set(availableSources),freshSources=new Map(),errors=[],pinnedGroups=new Map();
  const publish=()=>{
    if(generation!==listGeneration)return [];
    const merged=[...groups.values()].flat().sort((a,b)=>(b.recency-a.recency)||b.id.localeCompare(a.id)||b.host.localeCompare(a.host));
    const prefix=merged.slice(0,targetCount),known=new Set(prefix.map(row=>chatKey(row.id,row.host)));
    listRows=[...prefix,...[...pinnedGroups.values()].flat().filter(row=>isProjectPinned(row)&&!known.has(chatKey(row.id,row.host)))].sort((a,b)=>b.recency-a.recency||b.id.localeCompare(a.id)||b.host.localeCompare(a.host));
    availableSources=[...sources].sort();renderList();
    return merged;
  };
  const read=async host=>{
    const url='/api/sessions?scope=host&host='+encodeURIComponent(host)+'&q='+encodeURIComponent(query)+'&offset='+(targetCount-100)+'&archived='+archived+'&source='+source;
    try{
      const result=await api(url);if(generation!==listGeneration)return null;
      const visible=new Set((result.sessions||[]).map(row=>row.id));
      const missing=[...new Set(projectPins.entries().filter(([project,id])=>project.startsWith(host+'|')&&/^[0-9a-f-]{36}$/.test(id)&&!visible.has(id)).map(([,id])=>id))];
      const pinned=(result.sessions||[]).filter(row=>row.host===host&&isProjectPinned(row));
      // Read only metadata for older pins; they do not consume the recent page.
      for(let start=0;start<missing.length;start+=50){
        const extra=await api(url+'&ids='+encodeURIComponent(missing.slice(start,start+50).join(',')));
        if(generation!==listGeneration)return null;
        if(extra.complete===false)throw Error(extra.unavailableHosts?.[0]?.error||t('暂不可用'));
        pinned.push(...(extra.sessions||[]).filter(row=>row.host===host&&isProjectPinned(row)));
      }
      pinnedGroups.set(host,pinned);
      if(host==='local'){
        listHostIds=result.remoteHosts||[];
        if(result.sidebar)sidebarData=result.sidebar;
        for(const known of groups.keys())if(known!=='local'&&!listHostIds.includes(known))groups.delete(known);
      }
      if(result.complete===false||result.unavailableHosts?.length)errors.push(...(result.unavailableHosts||[{host,label:host,error:t('暂不可用')}]));
      else{
        const previousTitles=new Map(listRows.filter(row=>row.host===host).map(row=>[row.id,row.title]));
        for(const row of [...result.sessions,...pinned.filter(row=>!visible.has(row.id))]){
          const key=chatKey(row.id,row.host);row.recency=Math.max(row.recency,recentInteractions.get(key)||0);
          const previous=previousTitles.get(row.id);
          if(isPlaceholderChatTitle(row.title)&&previous&&!isPlaceholderChatTitle(previous))row.title=previous;
        }
        groups.set(host,mergeCreatedChats(result.sessions,host,query,archived,source));freshSources.set(host,result.availableSources||[]);
        const active=[...result.sessions,...pinned].find(row=>row.id===currentId&&row.host===currentHost);
        if(state&&isPlaceholderChatTitle(state.title)&&active?.title&&!isPlaceholderChatTitle(active.title))renderState({...state,title:active.title});
        for(const item of result.availableSources||[])sources.add(item);
      }
      publish();return result;
    }catch(error){if(generation===listGeneration){errors.push({host,label:host,error:error.message});publish();}return null;}
  };
  try{
    const local=await read('local');
    if(generation!==listGeneration)return false;
    await Promise.all(listHostIds.map(read));
    if(generation!==listGeneration)return false;
    const merged=publish();listReadFinished=true;listComplete=errors.length===0;
    if(listComplete){
      availableSources=[...new Set([...freshSources.values()].flat())].sort();
      // Host prefixes include one look-ahead row. Older aggregate responses did
      // not, so keep their conservative continuation behaviour.
      listOffset=Math.min(merged.length,targetCount);listHasMore=merged.length>targetCount||merged.length===targetCount&&local?.complete===undefined;
      listQuery=query;listArchived=archived;listFilterKey=filter;
      if(!renderSourceFilter()){loadList(true).catch(e=>toast(e.message));return false;}
      saveListSnapshot(filter);clientNavigation.acknowledgeList('codex',{...local,unavailableHosts:[],complete:true});listSync.acknowledgeSuccess();
    }
    renderHostErrors(errors);renderList();refreshActivity();
    if(errors.length)throw Error(errors[0].error);
    return true;
  }finally{listLoading--;renderList();}
}
function loadMoreSessions(){
  const root=$('sessions');
  if(document.hidden||$('app').hidden||clientNavigation.provider!=='codex'||!root.clientHeight||listQuery!==$('search').value||listArchived!==$('archived').checked)return;
  if(root.scrollHeight-root.clientHeight-root.scrollTop<240)loadList().catch(e=>toast(e.message));
}
$('sessions').addEventListener('scroll',loadMoreSessions,{passive:true});
$('sessions').addEventListener('scroll',scheduleActivityRefresh,{passive:true});
// Collapsed project groups may leave too little content for a scroll event.
$('sessions').addEventListener('wheel',event=>{if(event.deltaY>0)loadMoreSessions();},{passive:true});
let listTouch=null;
$('sessions').addEventListener('touchstart',event=>{listTouch=event.touches.length===1?{x:event.touches[0].clientX,y:event.touches[0].clientY}:null;},{passive:true});
$('sessions').addEventListener('touchmove',event=>{
  if(!listTouch)return;
  if(event.touches.length!==1){listTouch=null;return;}
  const dx=event.touches[0].clientX-listTouch.x,dy=listTouch.y-event.touches[0].clientY;
  if(Math.abs(dx)>Math.max(10,Math.abs(dy))){listTouch=null;return;}
  if(dy>40){listTouch=null;loadMoreSessions();}
},{passive:true});
$('sessions').addEventListener('touchend',()=>{listTouch=null;},{passive:true});
$('sessions').addEventListener('touchcancel',()=>{listTouch=null;},{passive:true});
$('search').oninput=()=>{clearTimeout(loadList.timer);loadList.timer=setTimeout(()=>loadList(true).catch(e=>toast(e.message)),300);};$('refresh').onclick=()=>loadList(true).catch(e=>toast(e.message));
let sessionDiagnosticsText='';
const diagnosticsPath='/api/sessions/diagnostics';
function diagnosticsSummary(value){
  const lines=[t('SSH 连接诊断')];
  for(const host of value.hosts||[]){
    const location=host.host==='local'?t('此电脑'):t('远端电脑')+' '+(String(host.host).match(/^remote-\d+$/)?.[0].slice(7)||'?'),status=host.status==='ok'?t('可用'):t('不可用');
    lines.push(location+' · '+status+' · '+t(host.phase==='ssh'?'SSH 连接':host.phase==='store'?'历史读取':'会话发现'));
    if(host.status==='ok'){
      const counts=host.counts||{};
      lines.push([['CLI',counts.cli],['Desktop',counts.desktop],[t('其他来源'),counts.other],[t('可见会话'),counts.visible],[t('已归档'),counts.archived]].map(([name,count])=>name+': '+(Number.isInteger(count)?count:0)).join(' · '));
    }else if(host.reason)lines.push(t(host.reason==='remote_read_failed'?'远端读取失败':'本机历史读取失败'));
  }
  return lines.join('\n');
}
async function loadSessionDiagnostics(){
  const status=$('session-diagnostics-status'),summary=$('session-diagnostics-summary'),error=$('session-diagnostics-error');
  status.textContent=t('正在读取 SSH 连接诊断…');summary.textContent='';error.textContent='';sessionDiagnosticsText='';
  $('session-diagnostics-copy').disabled=true;
  try{
    const value=await api(diagnosticsPath);
    sessionDiagnosticsText=diagnosticsSummary(value);summary.textContent=sessionDiagnosticsText;
    status.textContent=t('诊断已更新');$('session-diagnostics-copy').disabled=false;
  }catch(e){status.textContent='';error.textContent=t(e.message);}
}
$('open-session-diagnostics').onclick=()=>{
  $('appearance-dialog').close();$('session-diagnostics-dialog').showModal();
  const exportLink=$('session-diagnostics-export');
  const nativeUnsupported=BridgeHost.isNativeApp()&&window.BridgeMobileCapabilities?.diagnosticsExport!==true;
  exportLink.hidden=nativeUnsupported;
  $('session-diagnostics-export-note').hidden=!nativeUnsupported;
  $('session-diagnostics-export-note').textContent=nativeUnsupported?t('此版本 App 不支持导出文件，请复制摘要或更新 App。'):'';
  loadSessionDiagnostics();
};
$('session-diagnostics-refresh').onclick=loadSessionDiagnostics;
$('session-diagnostics-copy').onclick=()=>window.BridgeClipboard.copy(()=>sessionDiagnosticsText,$('session-diagnostics-copy'));
$('session-diagnostics-export').onclick=event=>{if(BridgeHost.isNativeApp()&&window.BridgeMobileCapabilities?.diagnosticsExport!==true){event.preventDefault();return;}event.currentTarget.href=window.BridgeRelayURL?.(diagnosticsPath)||diagnosticsPath;};
$('archived').onchange=()=>loadList(true).catch(e=>toast(e.message));
const listSync=window.BridgeListSync=new ListSync({root:$('sessions'),status:$('list-sync'),refresh:()=>loadList(true),visible:()=>!$('app').hidden&&clientNavigation.provider==='codex',ready:()=>!listLoading&&document.activeElement!==$('search')});
const contextUsageControl=new ContextUsageControl();$('permissions-button').after(contextUsageControl.button);
let newChatProjects=[],creatingChat=false,approvalBusy=0;
const sidebarManagement=typeof SidebarManagementUI==='function'?new SidebarManagementUI({request:api,dialog:title=>desktopSessions.dialog(title),snapshot:()=>sidebarData,
  context:()=>currentId&&currentHost==='local'&&state?.origin==='desktop'?currentId:null,uuid,notify:toast,
  refresh:async body=>{
    if(body?.kind==='project'){
      const project=(sidebarData.projects||[]).find(p=>p.key===body.targetId);
      if(project)sidebarPlacements.set(sidebarEntry('project',project),'native',(sidebarData.sections||[]).map(s=>s.id));
    }
    $('list-mode').value='codex';try{localStorage.setItem('list-mode','codex');}catch{}
    await loadList(true);
  }}):null;
if(typeof bindListActions==='function')bindListActions(document.querySelector('#sidebar .chat-list-toolbar'),$('archived'),[
  ...(sidebarManagement?sidebarManagement.topActions(()=>openNewProject()):[{label:'新建项目',run:()=>openNewProject()}]),
  {label:'折叠所有',run:collapseSidebarGroups}
]);
function openNewProject(){
  const dialog=desktopSessions.dialog('新建项目'),form=el('form'),error=el('p','error');
  dialog.classList.add('new-project-dialog');
  const field=(text,node)=>{const label=el('label','',t(text));label.append(node);form.append(label);return node;};
  const name=field('项目名称',el('input')),path=el('input'),pathRow=field('关联文件夹',el('div','project-path-row')),section=field('所属分区',el('select'));
  name.maxLength=120;name.required=true;path.required=true;path.placeholder=t('输入此电脑上的完整文件夹路径');
  name.setAttribute('aria-label',t('项目名称'));path.setAttribute('aria-label',t('关联文件夹'));section.setAttribute('aria-label',t('所属分区'));
  section.append(new Option(t('不属于分区'),''));for(const row of sidebarData.sections||[])section.append(new Option(row.name,row.id));
  const browse=el('button','project-browse-button',t('浏览文件夹'));browse.type='button';pathRow.append(path,browse);
  form.append(el('p','muted',t('项目由 Codex 桌面保存。可以选择已有文件夹或新建文件夹，无需先为这个目录创建聊天；首次使用可能需要在电脑确认信任。')));
  const folderHint=el('p','muted',t('新建文件夹需要新版手机网关，请在电脑上重启手机网关后重新打开此窗口。'));folderHint.hidden=true;form.append(folderHint);
  let busy=false,attempt=null,metadataReady=false,directoryReady=false,uncertain=false;
  const folderBrowser=new ProjectFolderBrowser({button:browse,input:path,request:api,uuid,canCreate:()=>metadataReady&&directoryReady&&!busy&&!uncertain,
    creationHint:()=>metadataReady&&!directoryReady?'新建文件夹需要新版手机网关，请在电脑上重启手机网关后重新打开此窗口。':'',
    context:()=>({key:chatKey()+'|'+modelCatalogGeneration,cwd:state?.cwd||'',...(currentId&&currentHost==='local'&&state?.origin==='desktop'?{contextId:currentId}:{})}),
    onSelect:cwd=>{if(!name.value.trim())name.value=ProjectFolderBrowser.trail(cwd).at(-1)?.name||'';}});
  browse.prepend(folderBrowser.icon('folder'));dialog.addEventListener('close',()=>{folderBrowser.close();folderBrowser.dialog?.remove();});
  const actions=el('div','actions'),submit=el('button','primary',t('创建项目')),cancel=el('button','secondary',t('取消'));
  submit.type='submit';cancel.type='button';cancel.onclick=()=>{if(!busy)dialog.close();};actions.append(submit,cancel);form.append(error,actions);
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!metadataReady||uncertain)return;
    const value={name:name.value.trim(),cwd:path.value.trim(),sectionId:section.value||null};
    if(currentId&&currentHost==='local'&&state?.origin==='desktop')value.contextId=currentId;
    if(!value.name||!value.cwd){error.textContent=t('请填写项目名称并选择文件夹');return;}
    if(!attempt||JSON.stringify(attempt.value)!==JSON.stringify(value))attempt={id:uuid(),value};
    busy=true;folderBrowser.setLocked(true);dialog.querySelectorAll('input,select,button').forEach(node=>node.disabled=true);error.textContent=t('正在等待 Codex 桌面创建项目，请留意电脑上的文件夹信任提示');
    try{
      let result=await api('/api/projects',{id:attempt.id,...value});
      while(['pending','creating','assigning','verifying'].includes(result.status)){
        error.textContent=t(result.message);await new Promise(resolve=>setTimeout(resolve,1000));
        result=await api('/api/project-operations?id='+encodeURIComponent(attempt.id));
      }
      if(result.status!=='completed'){
        uncertain=['unknown','partial'].includes(result.status);
        if(result.status==='failed')attempt=null;
        if(result.project)await loadList(true);
        throw Object.assign(Error(result.message||t('项目创建未完成，请检查 Codex 桌面')),{nativeResult:true});
      }
      dialog.close();$('list-mode').value='codex';$('search').value='';$('archived').checked=false;listSource='all';
      try{localStorage.setItem('list-mode','codex');}catch{}
      await loadList(true);
      const node=[...$('sessions').querySelectorAll('.project-group')].find(node=>node.dataset.projectKey===result.project.key);
      for(let parent=node;parent&&parent!==$('sessions');parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
      node?.scrollIntoView({block:'nearest'});toast('项目已创建');
    }catch(failure){if(!failure.status&&!failure.nativeResult)uncertain=true;error.textContent=t(failure.message);}
    finally{busy=false;folderBrowser.setLocked(false);dialog.querySelectorAll('input,select,button').forEach(node=>node.disabled=false);submit.disabled=!metadataReady||uncertain;}
  };
  dialog.addEventListener('cancel',event=>{if(busy)event.preventDefault();});dialog.append(form);dialog.showModal();name.focus();
  submit.disabled=true;section.disabled=true;
  api('/api/projects?metadata=1').then(value=>{
    if(!dialog.open)return;
    section.replaceChildren(new Option(t('不属于分区'),''));
    for(const row of value.sections||[])section.append(new Option(row.name,row.id));
    metadataReady=value.canCreateProject===true;directoryReady=value.canCreateDirectory===true;folderHint.hidden=!metadataReady||directoryReady;section.disabled=false;submit.disabled=!metadataReady;
    if(folderBrowser.dialog?.open)folderBrowser.renderControls();
    if(!metadataReady)error.textContent=t('尚未接通 Codex 桌面的原生项目创建接口，请先在桌面端添加项目；不会保存为网关项目');
  }).catch(failure=>{if(dialog.open)error.textContent=t(failure.message);});
}
let applyingNewChat=null;
const newChatScopes=new Map();
try{for(const row of JSON.parse(localStorage.getItem('new-chat-scopes')||'[]'))if(Array.isArray(row)&&row.length===2&&row.every(value=>typeof value==='string'))newChatScopes.set(...row);}catch{}
function newChatPreferencePrefix(){return (window.BridgeRelayBase||location.origin||location.host||'gateway')+'|';}
const newChatSettings=new NewChatSettings($('new-chat-form'),{request:api,scope:(project,kind)=>newChatPreferencePrefix()+(newChatProjects.find(row=>row.key===project)?.host||'local')+'|'+kind});
function rememberNewChatSetting(id,host,changes){const scope=newChatScopes.get(chatKey(id,host));if(scope?.startsWith(newChatPreferencePrefix()))newChatSettings.defaults.remember(scope,changes);}
$('new-chat-title').value=t('新聊天');
$('new-chat-title').oninput=()=>{$('new-chat-title').dataset.edited='true';};
$('new-chat').onclick=()=>openNewChat();
async function openNewChat(preselected=null){
  if(creatingChat||$('new-chat-dialog').open)return;
  $('new-chat-error').textContent='';$('new-chat-submit').disabled=true;
  $('new-chat-project').replaceChildren();$('new-chat-path').textContent=t('正在读取电脑项目…');
  $('new-chat-dialog').showModal();
  try{
    newChatProjects=(await api('/api/projects')).projects;
    if(preselected)$('new-chat-type').value=preselected.type||'desktop';
    $('new-chat-type').onchange();
    if(preselected){
      const project=newChatProjects.find(p=>p.key===preselected.key)||newChatProjects.find(p=>p.host===preselected.host&&p.cwd===preselected.cwd&&(p.type||'desktop')===(preselected.type||'desktop'));
      if(!project)throw Error(t('请选择现有项目'));
      $('new-chat-project').value=project.key;$('new-chat-project').onchange();
    }
  }catch(e){$('new-chat-error').textContent=t(e.message);$('new-chat-path').textContent='';$('new-chat-submit').disabled=true;}
};
$('new-chat-type').onchange=()=>{
  const kind=$('new-chat-type').value,selected=listRows.find(row=>row.id===currentId&&row.host===currentHost)?.projectKey;
  $('new-chat-help').textContent=t(kind==='cli'?'选择已有 CLI 项目目录，在此创建聊天。':'选择已有项目，或不选择项目创建独立聊天。电脑会打开这条聊天。');
  $('new-chat-project').replaceChildren();
  if(kind==='desktop')$('new-chat-project').append(new Option(t('不选择项目'),'local|independent'));
  for(const project of newChatProjects.filter(p=>(p.type||'desktop')===kind))$('new-chat-project').append(new Option(project.name+' · '+(project.host==='local'?t('此电脑'):project.hostLabel),project.key));
  if(newChatProjects.some(p=>p.key===selected&&(p.type||'desktop')===kind))$('new-chat-project').value=selected;
  $('new-chat-project').onchange();
  $('new-chat-submit').disabled=!$('new-chat-project').value;
  $('new-chat-submit').textContent=t(kind==='cli'?'创建聊天':'创建并打开');
};
$('new-chat-project').onchange=()=>{$('new-chat-path').textContent=$('new-chat-project').value==='local|independent'?t('在此电脑创建独立聊天'):newChatProjects.find(p=>p.key===$('new-chat-project').value)?.cwd||'';newChatSettings.load($('new-chat-project').value,$('new-chat-type').value);};
$('new-chat-dialog').addEventListener('cancel',event=>{if(creatingChat)event.preventDefault();});
$('new-chat-form').onsubmit=async event=>{
  event.preventDefault();if(creatingChat)return;
  const project=$('new-chat-project').value,title=$('new-chat-title').value.trim()||t('新聊天'),kind=$('new-chat-type').value;
  const autoTitle=!$('new-chat-title').value.trim()||$('new-chat-title').dataset.edited!=='true'&&title===t('新聊天');
  if(newChatSettings.loading){$('new-chat-error').textContent=t('正在读取模型设置，请稍候。');return;}
  const preferences=newChatSettings.value(),preferenceScope=newChatSettings.key;
  if(newChatSettings.model.value==='__custom__'&&!preferences.model||preferences.model&&!/^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}$/.test(preferences.model)){$('new-chat-error').textContent=t('模型 ID 格式不正确');return;}
  if(preferences.permission==='full-access'&&!confirm(t('允许新聊天完全访问电脑文件和网络？')) )return;
  if(!project||!title){$('new-chat-error').textContent=t('请选择项目或不选择项目，并填写聊天名称。');return;}
  let attempt;
  try{attempt=JSON.parse(sessionStorage.getItem('new-chat-attempt')||'null');}catch{}
  if(!attempt||attempt.project!==project||attempt.title!==title||attempt.kind!==kind||attempt.autoTitle!==autoTitle)attempt={id:uuid(),project,title,kind,autoTitle};
  sessionStorage.setItem('new-chat-attempt',JSON.stringify(attempt));
  creatingChat=true;setLanguageBusy();$('new-chat-error').textContent='';$('new-chat-submit').textContent=t('正在创建…');
  $('new-chat-form').querySelectorAll('input,select,button').forEach(n=>n.disabled=true);
  document.querySelector('[data-close="new-chat-dialog"]').disabled=true;
  try{
    const result=await api('/api/sessions',attempt);
    newChatSettings.defaults.remember(preferenceScope,preferences);newChatScopes.set(chatKey(result.id,result.host),preferenceScope);
    while(newChatScopes.size>200)newChatScopes.delete(newChatScopes.keys().next().value);
    try{localStorage.setItem('new-chat-scopes',JSON.stringify([...newChatScopes]));}catch{}
    sessionStorage.removeItem('new-chat-attempt');$('new-chat-dialog').close();
    $('new-chat-title').value=t('新聊天');$('new-chat-title').dataset.edited='false';
    $('search').value='';$('archived').checked=false;
    if(listSource!=='all'&&listSource!==kind){listSource='all';renderSourceFilter();}
    rememberCreatedChat(result,attempt);
    loadList(true).catch(e=>toast(e.message));toast(result.message);
    applyingNewChat=chatKey(result.id,result.host);
    try{
      const settingErrors=[];
      // The owner validates settings independently of the browser history read.
      try{await waitForCreatedChat(()=>api(sessionUrl(result.id,'',result.host)));await openChat(result.id,result.host);}catch(error){settingErrors.push(t(error.message));}
      const applySetting=async(action,body,label)=>{
        try{
          const applied=await api(sessionUrl(result.id,action,result.host),body);
          if(!applied.confirmed)throw Error(t('设置已提交，等待 Codex 确认；发送前请检查模型和权限。'));
        }catch(error){settingErrors.push(t(label)+'：'+t(error.message));}
      };
      if(preferences.model)await applySetting('settings',{model:preferences.model,effort:preferences.effort},'模型和推理强度');
      if(preferences.permission)await applySetting('permissions',{preset:preferences.permission,confirmed:preferences.permission==='full-access'},'权限');
      if(settingErrors.length)throw Error(settingErrors.join('；'));
    }catch(error){throw Error(t('聊天已创建，但设置或连接尚未完成：')+t(error.message));}
    finally{applyingNewChat=null;if(state)renderState(state);}
  }catch(e){
    if($('new-chat-dialog').open)$('new-chat-error').textContent=t(e.message)+t('；若结果不确定，请先刷新列表检查，避免重复创建。');
    else toast(e.message);
  }finally{
    creatingChat=false;setLanguageBusy();$('new-chat-submit').textContent=t(kind==='cli'?'创建聊天':'创建并打开');
    $('new-chat-form').querySelectorAll('input,select,button').forEach(n=>n.disabled=false);
    $('new-chat-submit').disabled=!$('new-chat-project').value;
    document.querySelector('[data-close="new-chat-dialog"]').disabled=false;
  }
};
const messageActions=new MessageActions({request:api,openChat,refresh:()=>loadList(true).catch(e=>toast(e.message)),uuid,notify:toast,busy:value=>{approvalBusy+=value?1:-1;setLanguageBusy();}});
document.addEventListener('bridge-message-error',event=>toast(event.detail));
new ChatContextMenu($('sessions'),target=>{
  const nativeActions=sidebarManagement?.items(target);
  if(nativeActions!==null&&nativeActions!==undefined){
    const summary=target.closest('summary[data-project-key]');
    return nativeActions.length&&summary?[...nativeActions,...sidebarProjectOrderActions(sidebarEntry('project',{
      key:summary.dataset.projectKey,host:summary.dataset.host,name:summary.dataset.projectName
    }))]:nativeActions;
  }
  const button=target.closest('.session');
  if(!button){
    const summary=target.closest('summary[data-project-key]');
    if(!summary||target.closest('button'))return [];
    return sidebarPlacementActions(sidebarEntry('project',{key:summary.dataset.projectKey,host:summary.dataset.host,name:summary.dataset.projectName}));
  }
  const row=listRows.find(row=>row.id===button.dataset.id&&row.host===button.dataset.host);if(!row)return [];
  const items=[{label:'复制会话路径',copy:true,run:copy=>window.BridgeClipboard.copy(()=>'codex://threads/'+encodeURIComponent(row.id),copy)}];
  items.push({label:'标记为未读',run:()=>{sessionActivity.markUnread(chatKey(row.id,row.host));renderActivity();}});
  items.push(...sidebarPlacementActions(sidebarEntry('thread',row)));
  if(button.closest('.project-group')&&row.projectKey!==row.host+'|independent')items.push({label:isProjectPinned(row)?'取消项目内置顶':'在项目内置顶',run:()=>toggleProjectPin(row)});
  if(sessionAccess(row.access).source==='desktop'){
    items.push({label:row.archived?'取消归档':'归档聊天',run:()=>manageChat(row,row.archived?'unarchive':'archive')});
    items.push({label:'永久删除聊天',run:()=>manageChat(row,'delete')});
  }
  return items;
},{label:'侧栏操作'});
function sidebarPlacementActions(item){
  const items=[{label:sidebarTarget(item)==='pinned'?'取消置顶':'置顶',run:()=>changeSidebarPlacement(item,'toggle-pin')},
    {label:'移动到分区…',run:()=>openSidebarPlacement(item)}];
  if(item.kind==='project')items.push(...sidebarProjectOrderActions(item));
  return items;
}
function sidebarProjectOrderActions(item){
  const {ids}=sectionProjectRows(item),index=ids.indexOf(item.id);
  return index<0?[]:[{label:'上移',disabled:index===0,run:()=>shiftSectionProject(item,-1)},
    {label:'下移',disabled:index===ids.length-1,run:()=>shiftSectionProject(item,1)}];
}
function currentSidebarEntry(item){
  let row;
  if(item.kind==='thread')row=listRows.find(row=>row.id===item.id&&row.host===item.host);
  else{
    row=(sidebarData.projects||[]).find(project=>project.key===item.id&&project.host===item.host);
    if(!row){const chat=listRows.find(row=>row.projectKey===item.id&&row.host===item.host);if(chat)row={key:chat.projectKey,host:chat.host,name:chat.projectName};}
  }
  if(!row)throw Error(t('侧栏条目已变化，请刷新后重试。'));
  return sidebarEntry(item.kind,row);
}
function changeSidebarPlacement(item,destination){
  const fresh=currentSidebarEntry(item),sections=(sidebarData.sections||[]).map(section=>section.id);
  try{
    if(destination==='toggle-pin')sidebarPlacements.togglePin(fresh,sections,fresh.native);
    else sidebarPlacements.set(fresh,destination,sections,fresh.native);
  }catch(error){throw Error(t(error.message==='分区已变化，请重新选择。'?error.message:'无法保存侧栏设置，请检查设备存储权限。'));}
  $('list-mode').value='codex';try{localStorage.setItem('list-mode','codex');}catch{}
  listRenderStamp='';renderList();
  const selector=item.kind==='project'?'.project-group':'.session';
  const node=[...$('sessions').querySelectorAll(selector)].find(node=>node.dataset.host===item.host&&(item.kind==='project'?node.dataset.projectKey:node.dataset.id)===item.id);
  for(let parent=node?.parentElement;parent&&parent!==$('sessions');parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;
}
function openSidebarPlacement(item){
  item=currentSidebarEntry(item);
  const dialog=desktopSessions.dialog('移动到分区'),form=el('form'),label=el('label','',t('所属分区')),select=el('select'),error=el('p','error');
  dialog.classList.add('sidebar-placement-dialog');
  dialog.append(el('p','muted',item.name));label.append(select);form.append(label);
  select.append(new Option(t('跟随 Codex'),'native'),new Option(t(item.kind==='project'?'普通项目':'原项目或聊天列表'),'home'),new Option(t('置顶'),'pinned'));
  for(const section of sidebarData.sections||[])select.append(new Option(section.name,'section:'+section.id));
  const saved=sidebarPlacements.read(item),sections=(sidebarData.sections||[]).map(section=>section.id);
  select.value=sidebarPlacements.valid(saved?.target,sections)?saved.target:'native';select.setAttribute('aria-label',t('所属分区'));
  const actions=el('div','actions'),save=el('button','primary',t('保存')),cancel=el('button','secondary',t('取消'));
  save.type='submit';cancel.type='button';cancel.onclick=()=>dialog.close();actions.append(save,cancel);form.append(error,actions);
  form.onsubmit=event=>{event.preventDefault();try{changeSidebarPlacement(item,select.value);dialog.close();}catch(failure){error.textContent=t(failure.message);}};
  dialog.append(el('p','muted',t('分区和置顶设置保存在当前设备。')),form);dialog.showModal();
}
async function manageChat(row,action){
  if(action==='delete'&&!confirm(t('永久删除此聊天及其子智能体记录？此操作无法恢复。')+'\n\n'+row.title))return;
  try{await api(sessionUrl(row.id,action,row.host),{confirmed:action==='delete'});}
  catch(error){toast(t(error.message)+t('；若结果不确定，请刷新列表检查，不要重复操作。'));return;}
  if(action!=='unarchive'&&currentId===row.id&&currentHost===row.host){
    saveDraft();chatTimeline?.dispose();chatTimeline=null;currentId=null;state=null;workbench.reset();$('chat').hidden=true;$('welcome').hidden=false;$('app').classList.remove('chat-open');history.replaceState(null,'',location.pathname);
  }
  createdChats.delete(chatKey(row.id,row.host));
  listRows=listRows.filter(chat=>chat.id!==row.id||chat.host!==row.host);listRenderStamp='';renderList();loadList(true).catch(error=>toast(error.message));
  toast(action==='delete'?'聊天已删除':action==='archive'?'聊天已归档':'聊天已取消归档');
}
const selectedTextAction=new SelectedTextAction($('messages'),{available:()=>!!currentId&&!$('chat').hidden,context:()=>chatKey(),trigger:$('selection-button'),openMenu:snapshot=>selectedTextAction.activate('add',snapshot.token),canAdd:()=>workbench.selectionTargets.available(),canExplain:()=>false,add:text=>workbench.selectionTargets.addText(text)});
let nativeSelectionTarget=null;
window.BridgeSelection=Object.freeze({
  capture:()=>{
    nativeSelectionTarget?.action.releaseNative(nativeSelectionTarget.token);
    const action=(workbench.current?.files||[]).map(tab=>tab.sideChat?.selectionAction).find(action=>action?.available()&&action.selected())||selectedTextAction;
    const snapshot=action.captureNative();nativeSelectionTarget=snapshot.token?{action,token:snapshot.token,id:uuid()}:null;
    return {...snapshot,token:nativeSelectionTarget?.id};
  },
  run:(action,token)=>{const target=nativeSelectionTarget;if(!target||target.id!==token)return false;const consumed=target.action.activate(action,target.token);if(consumed)nativeSelectionTarget=null;return consumed;},
  release:token=>{const target=nativeSelectionTarget;if(target?.id===token){nativeSelectionTarget=null;target.action.releaseNative(target.token);}}
});
const messageSelectionMenu=new ChatContextMenu($('messages'),()=>[],{touch:false,show:()=>{const snapshot=selectedTextAction.captureMenu();return !!snapshot&&selectedTextAction.activate('add',snapshot.token);}});
$('fork-source').onclick=()=>{const source=state?.forkedFrom;if(source){$('chat-details-dialog').close();openChat(source.id,source.host).catch(e=>toast(e.message));}};
function saveDraft(){runningSendChoice?.close();composerReferences.close();if(currentId)composerDrafts.set('codex:'+chatKey(),$('message').value);}
$('message').oninput=saveDraft;
let catalogStarted=false;
async function openChat(id,host="local"){if(messageActions.pending&&messageActions.dialog.open)return;messageActions.dialog.close();workbench.open(id,host);saveDraft();chatTimeline?.dispose();currentId=id;currentHost=host;state=null;catalogStarted=false;workbench.current.access=sessionAccess(listRows.find(row=>row.id===id&&row.host===host)?.access);contextUsageControl.update(null);workModes.open(chatKey(id,host));attachments.open(chatKey(id,host));modelCatalogGeneration++;catalogData={models:null};catalogResults={models:null};catalogTasks={models:null};modelRequest++;modelTarget=null;fastModeControl.reset();$('model-dialog').close();notificationState={available:false,watching:false,notifyOnCompletion:false};notificationRequest++;$('notify-dialog').close();$('rename-dialog').close();$('chat-details-dialog').close();$('notify-button').disabled=true;renderNotificationState();approvalStamp='';submittedRequestIds.clear();$('messages').replaceChildren();$('approvals').replaceChildren();$('queued').replaceChildren();$('message').value=composerDrafts.get('codex:'+chatKey(id,host))||sessionStorage.getItem('draft:'+chatKey(id,host))||'';sessionStorage.removeItem('draft:'+chatKey(id,host));composerDrafts.set('codex:'+chatKey(id,host),$('message').value);$('send-error').textContent='';$('chat-title').textContent=t('正在连接…');$('chat-meta').textContent='';$('status').textContent=t('连接中');$('welcome').hidden=true;$('chat').hidden=false;$('app').classList.add('chat-open');$('send').disabled=true;history.replaceState(null,'','#'+id+'~'+encodeURIComponent(host));document.querySelectorAll('.session').forEach(n=>n.classList.toggle('selected',n.dataset.id===id&&n.dataset.host===host));const timeline=chatTimeline=new ChatTimeline({url:action=>sessionUrl(id,action,host),request:api,renderMeta:renderState,canEdit:()=>currentAccess().canEditMessages,renderText:(node,text,files,fullText)=>renderMarkdown(node,text,files,file=>sessionUrl(id,'files/'+file.id,host),{fullText}),onAction:(action,row,timeline)=>{if(!currentAccess().canEditMessages)return;const pendingKey='fork-edit:'+host+'|'+id;let pending;try{pending=JSON.parse(sessionStorage.getItem(pendingKey));}catch{}if(pending&&pending.sourceTurnId===row.turnId&&action==='edit'){sessionStorage.setItem('message-edit:'+timeline.url('message-action')+':'+row.key,pending.text);sessionStorage.removeItem(pendingKey);}return messageActions.open(action,row,timeline);},status:text=>{$('status').textContent=t(text);}});
  reconnectFailure=null;
  window.BridgePresentation?.openChat();
  sessionActivity.read(chatKey(id,host),{explicit:true,sync:false});renderActivity();
  if(currentAccess().source==='desktop'&&currentAccess().canChangeModel){catalogStarted=true;startCatalog();}
  const reading=timeline.start();
  const openingAccess=sessionAccess(listRows.find(row=>row.id===id&&row.host===host)?.access);
  if(openingAccess.source==='desktop'&&openingAccess.canReconnect)api(sessionUrl(id,'reconnect',host),{activate:true},timeline.abort.signal).catch(error=>{if(!timeline.abort.signal.aborted)toast(error.message);});
  await reading;
  if(!timeline.abort.signal.aborted)loadNotificationState(id,host);
}
let notificationState={available:false,watching:false,notifyOnCompletion:false},notificationRequest=0;
function renderNotificationState(){$('notify-button').textContent=t('聊天通知设置');}
async function loadNotificationState(id=currentId,host=currentHost){
  const request=++notificationRequest;
  $('notify-button').disabled=true;
  try{const result=await api(sessionUrl(id,'notifications',host));if(request!==notificationRequest||id!==currentId||host!==currentHost)return;notificationState=result;renderNotificationState();return true;}
  catch(e){if(request===notificationRequest&&id===currentId&&host===currentHost){$('notify-error').textContent=t(e.message);notificationState={...notificationState,error:e.message};}return false;}
  finally{if(request===notificationRequest&&id===currentId&&host===currentHost)$('notify-button').disabled=false;}
}
$('notify-button').onclick=async()=>{
  const key=chatKey();
  $('chat-details-dialog').close();
  $('notify-error').textContent='';$('notify-dialog').showModal();
  for(const id of ['notify-enabled','notify-completion','notify-save'])$(id).disabled=true;
  const loaded=await loadNotificationState();
  if(!$('notify-dialog').open||key!==chatKey()||!loaded)return;
  $('notify-enabled').value=notificationState.requests||'inherit';
  $('notify-completion').value=notificationState.completion||'inherit';
  for(const id of ['notify-enabled','notify-completion','notify-save'])$(id).disabled=false;
  $('notify-channel-status').textContent=t(notificationState.available?'通知通道已开启':'尚未配置通知通道，请在第三方通知中配置。');
};
$('notify-form').onsubmit=async event=>{
  event.preventDefault();
  const id=currentId,host=currentHost,request=++notificationRequest;
  const body={requests:$('notify-enabled').value,completion:$('notify-completion').value};
  $('notify-button').disabled=true;$('notify-save').disabled=true;$('notify-error').textContent='';
  try{
    const result=await api(sessionUrl(id,'notifications',host),body);
    if(request!==notificationRequest||id!==currentId||host!==currentHost)return;
    notificationState=result;renderNotificationState();$('notify-dialog').close();toast('聊天提醒设置已保存');
  }catch(e){if(request===notificationRequest&&id===currentId&&host===currentHost)$('notify-error').textContent=t(e.message);}
  finally{if(request===notificationRequest&&id===currentId&&host===currentHost){$('notify-button').disabled=false;$('notify-save').disabled=false;}}
};
let notificationDefaultsRequest=0;
window.loadNotificationDefaults=async()=>{
  if(window.BridgeSharedRelay)return;
  const request=++notificationDefaultsRequest;
  for(const id of ['notification-requests','notification-completions'])$(id).disabled=true;
  $('notification-settings-error').textContent='';
  if($('app').hidden)return;
  try{
    const result=await api('/api/notifications/defaults');if(request!==notificationDefaultsRequest)return;
    $('notification-requests').checked=result.requests;$('notification-completions').checked=result.completion;
    for(const id of ['notification-requests','notification-completions'])$(id).disabled=false;
  }catch(error){$('notification-settings-error').textContent=t(error.message);}
};
async function saveNotificationDefaults(){
  const body={requests:$('notification-requests').checked,completion:$('notification-completions').checked};
  for(const id of ['notification-requests','notification-completions'])$(id).disabled=true;
  try{await api('/api/notifications/defaults',body);if(currentId)await loadNotificationState();}
  catch(error){await window.loadNotificationDefaults();$('notification-settings-error').textContent=t(error.message);return;}
  await window.loadNotificationDefaults();
}
$('notification-requests').onchange=$('notification-completions').onchange=saveNotificationDefaults;
$('back').onclick=()=>{if(workbench.back())return;desktopSessions.onListEnter();workbench.rememberScroll();workbench.stopThumbnails();$('app').classList.remove('chat-open');history.replaceState(null,'',location.pathname);loadList(true).catch(e=>toast(e.message));};
function renderState(view){
  const listed=listRows.find(row=>row.id===currentId&&row.host===currentHost);
  const fallbackTitle=view.titleSource&&view.titleSource!=='native';
  if(!view.loadingHistory&&(isPlaceholderChatTitle(view.title)||fallbackTitle&&(!listed?.titleSource||listed.titleSource==='native'))&&listed?.title&&!isPlaceholderChatTitle(listed.title))view={...view,title:listed.title,titleSource:listed.titleSource};
  contextUsageControl.update(view);state=view;
  if(!view.loadingHistory&&view.title){
    const row=listRows.find(row=>row.id===currentId&&row.host===currentHost);
    if(row&&(row.title!==view.title||row.titleSource!==view.titleSource)){row.title=view.title;row.titleSource=view.titleSource;renderList();}
  }
  if(typeof document!=='undefined')for(const dialog of document.querySelectorAll('dialog[data-permission-runtime]')){
    if(!view.connected||dialog.dataset.permissionThread!==currentId||dialog.dataset.permissionHost!==currentHost||
       dialog.dataset.permissionRuntime!==(view.access?.runtime||'desktop'))dialog.close();
  }
  if(view.connected)reconnectFailure=null;
  const access=sessionAccess(view.access),limited=!!view.access;
  const permissionLabel={'ask':'请求批准','auto-review':'帮我批准','full-access':'完全访问','custom':'自定义权限'}[view.permissionMode];
  const permissionFacts=view.permissionDetails||{};
  const customPermission=permissionFacts.sandbox==='dangerFullAccess'&&permissionFacts.approvalPolicy==='on-request';
  $('permissions-button').textContent=customPermission?t('完全访问 · 请求批准'):t(permissionLabel||'权限未提供');
  $('permissions-button').title=$('permissions-button').textContent;
  $('permissions-button').disabled=!view.connected||!access.canChangePermissions;
  $('fork-source').hidden=!view.forkedFrom;$('fork-source').textContent=view.forkedFrom?t('来源会话：')+view.forkedFrom.title:'';
  if($('model-dialog').open&&modelTarget===chatKey())fastModeControl.sync(view);
  if(visibleChat()){
    sessionActivity.update([{id:currentId,host:currentHost,connected:view.connected,status:view.status,turnId:view.turnId,turnStatus:view.turnStatus}],chatKey());
    sessionActivity.read(chatKey(),{sync:false});renderActivity();
  }
  $('execution-host').textContent=t('在 ')+(view.host==='local'?t('电脑'):view.hostLabel||t('SSH 主机'))+t(' 运行');
  $('chat-title').textContent=view.loadingHistory?t('正在读取聊天…'):view.title;
  const source=sourceLabel(view.access);
  $('chat-meta').textContent=(view.host==='local'?t('此电脑'):view.hostLabel||t('SSH 主机'))+(source?' · '+source:'')+' · '+(view.cwd||t('电脑上的聊天'));
  $('model-name').textContent=view.model||t('模型');$('model-current').textContent=view.model?t('当前模型：')+view.model:'';$('model-current').hidden=!view.model;
  const effortLabel=view.effort||t('思考程度未指定');
  $('model-effort').textContent='· '+effortLabel;$('model-effort').hidden=false;
  $('model-button').title=[view.model||t('模型'),effortLabel].filter(Boolean).join(' · ');$('provider').textContent=[view.model,view.provider].filter(Boolean).join(' · ');
  $('status').textContent=chatStatusText(view,access);
  $('status').classList.toggle('offline',!view.connected);
  $('notice').hidden=view.connected;
  $('notice-text').textContent=access.source==='cli'?(t(reconnectFailure||view.connectionError)||t(access.canReconnect?'可先阅读聊天历史；继续时将连接或恢复原 CLI 会话。':access.reason||'CLI 聊天历史可阅读；当前无法继续此会话。')):limited&&!access.canReconnect?(t(access.reason)||t('已保存的历史可阅读；当前来源未提供远程控制。')):view.activating?t('正在自动连接；必要时会在电脑 Codex 中打开此聊天。'):view.connecting?t('正在连接桌面，可先阅读已保存的历史。'):t(view.connectionError)||t('暂未连接，可先阅读历史或点击重新连接。');
  $('reconnect').hidden=limited&&!access.canReconnect;
  $('reconnect').textContent=t(access.source==='cli'?'继续会话':'重新连接');
  $('history').hidden=view.historyComplete||!view.connected;
  $('working').hidden=view.status!=='active';$('stop').hidden=view.status!=='active'||!view.connected||!access.canInterrupt;
  $('send').disabled=applyingNewChat===chatKey()||view.loadingHistory||view.activating||sending||!attachments.ready()||!access.canSend;
  $('message').disabled=limited&&!access.canSend;
  $('attach-button').disabled=limited&&!access.canSend;
  $('model-button').disabled=limited&&!access.canChangeModel;
  $('skills-button').disabled=sending||!access.canSend;
  $('rename-chat').disabled=limited&&!access.canConfigure;
  if(!catalogStarted&&access.canChangeModel){catalogStarted=true;startCatalog();}
  $('send-mode').disabled=limited&&!access.canSend;
  $('send-mode').querySelector('[value=steer]').disabled=view.status!=='active'||!access.canSend;
  if((view.status!=='active'||!access.canSend)&&$('send-mode').value==='steer')$('send-mode').value='send';
  const modesView=limited&&!access.canUseGoal?{...view,goalRuntimeAvailable:false}:view;
  workModes.render(modesView,$('send-mode').value,sending);
  $('work-mode').disabled=limited&&!access.canUseModes;
  if(limited&&!access.canUseModes)$('work-mode').value='default';
  workbench.current.access=access;workbench.current.cwd=view.cwd||listed?.cwd||'';
  chatTimeline?.refreshActions();
  renderApprovals(access.canApprove?view.requests:[]);renderQueue(view.submissions||[]);
}
$('send-mode').onchange=()=>workModes.render(state,$('send-mode').value,sending);
function jsonPretty(value){return typeof value==='string'?value:JSON.stringify(value,null,2);}
function renderApprovals(requests){const stamp=JSON.stringify(requests);if(stamp===approvalStamp)return;approvalStamp=stamp;$('approvals').replaceChildren();for(const request of requests){if(request.supported&&request.params?.computerUse){$('approvals').append(renderComputerApproval(request));continue;}if(request.method==='item/plan/requestImplementation'&&request.supported){$('approvals').append(renderPlanApproval(request));continue;}const card=el('section','approval');card.dataset.request=String(request.id);const params=request.params||{}, method=request.method;const heading=method.includes('requestUserInput')?t('Codex 需要你的回复'):method.includes('fileChange')?t('允许修改文件？'):method.includes('commandExecution')?t('允许运行此命令？'):method.includes('permissions')?t('允许本轮权限？'):t('待确认请求');card.append(el('h3','',heading));const controls={};if(!request.supported){card.append(el('p','',params.message||t('请在桌面 App 处理此请求')));$('approvals').append(card);continue;}if(params.reason)card.append(el('p','',params.reason));if(params.command)card.append(el('pre','',jsonPretty(params.command)));if(params.cwd)card.append(el('p','muted',params.cwd));for(const key of ['changes','grantRoot','permissions','networkApprovalContext'])if(params[key])card.append(el('pre','',jsonPretty(params[key])));const form=el('form');if(method.includes('requestUserInput')){for(const question of params.questions||[]){const label=el('label','',question.question||question.header||question.id);label.dataset.answerKey=JSON.stringify([question.id,question]);if(question.options?.length){const select=el('select');select.append(new Option(t('请选择…'),''));for(const option of question.options)select.append(new Option(option.label+(option.description?' — '+option.description:''),option.label));select.append(new Option(t('自行填写'),'__custom__'));label.append(select);const custom=el('textarea');custom.rows=2;custom.hidden=true;custom.placeholder=t('输入你的回复');select.onchange=()=>custom.hidden=select.value!=='__custom__';label.addEventListener('draftrestore',()=>custom.hidden=select.value!=='__custom__');label.append(custom);controls[question.id]=()=>select.value==='__custom__'?custom.value:select.value;}else{const input=el('textarea');input.rows=2;input.required=true;label.append(input);controls[question.id]=()=>input.value;}form.append(label);}}else if(method==='mcpServer/elicitation/request'){if(params.message)form.append(el('p','',params.message));const schema=params.requestedSchema||{};for(const [key,field] of Object.entries(schema.properties||{})){const label=el('label','',field.title||key);label.dataset.answerKey=JSON.stringify([key,field]);let input;if(field.enum){input=el('select');input.append(new Option(t('请选择…'),''));for(const [i,value] of field.enum.entries())input.append(new Option(field.enumNames?.[i]||String(value),String(value)));}else{input=el('input');input.type=field.type==='boolean'?'checkbox':['number','integer'].includes(field.type)?'number':'text';if(input.type==='number')input.step=field.type==='integer'?'1':'any';}input.required=(schema.required||[]).includes(key)&&input.type!=='checkbox';if(field.description)label.append(el('p','muted',field.description));label.append(input);form.append(label);controls[key]=()=>input.type==='checkbox'?input.checked:input.value===''?undefined:['number','integer'].includes(field.type)?Number(input.value):input.value;}}const actions=el('div','actions'),error=el('p','error');
  function waitForDesktop(){
    const id=currentId,host=currentHost,status=el('p','muted',t('已发送，等待桌面确认…'));
    card.append(status);
    setTimeout(()=>{
      if(card.isConnected&&id===currentId&&host===currentHost&&submittedRequestIds.has(request.id))
        status.textContent=t('桌面尚未确认这条回复，答案已保留。请查看会话后再操作。');
    },15000);
  }
  async function submit(response){
    const id=currentId,host=currentHost;
    approvalBusy++;setLanguageBusy();
    const buttons=card.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);error.textContent='';
    try{
      const result=await api(sessionUrl(id,'respond',host),{requestId:request.id,response});
      if(id!==currentId||host!==currentHost||!card.isConnected)return;
      if(result.status==='ignored')throw Error('这条回复未发送：此前的未确认记录已忽略，请核对会话后重新编辑答案。');
      if(result.status==='unknown')throw Error('回复送达结果尚未确认，答案已保留。请查看会话后再操作。');
      submittedRequestIds.add(request.id);bumpRecency(id,host);toast('已发送回应');waitForDesktop();
    }catch(e){
      error.textContent=t(e.message);buttons.forEach(b=>b.disabled=false);
    }finally{
      approvalBusy--;setLanguageBusy();
    }
  }
  const isInput=method.includes('requestUserInput'),isMcp=method==='mcpServer/elicitation/request';const yes=el('button','primary',isInput?t('提交回复'):t('本次允许'));yes.type='submit';const available=params.availableDecisions;const canAccept=!available||available.includes('accept');if(isInput||isMcp||canAccept)actions.append(yes);if(!isInput){const no=el('button','secondary',t('拒绝'));no.type='button';no.onclick=()=>submit(isMcp?{action:'decline'}:{decision:'decline'});if(!available||available.includes('decline'))actions.append(no);if(method.includes('commandExecution')||method.includes('fileChange')||isMcp){const cancel=el('button','secondary',t('取消'));cancel.type='button';cancel.onclick=()=>submit(isMcp?{action:'cancel'}:{decision:'cancel'});if(!available||available.includes('cancel'))actions.append(cancel);}}form.onsubmit=event=>{event.preventDefault();if(isInput){const answers={};for(const [key,get] of Object.entries(controls)){const value=get();if(!value.trim()){error.textContent=t('请回答所有问题');return;}answers[key]=[value];}submit({answers});}else if(isMcp){const content={};for(const [key,get] of Object.entries(controls)){const value=get();if(value!==undefined)content[key]=value;}submit({action:'accept',content});}else submit({decision:'accept'});};form.append(actions,error);card.append(form);window.AnswerDrafts?.bind(form,{scope:['codex',currentHost,'main',currentId,request.method,params.turnId||'',params.itemId||'',request.id],request:api});if(submittedRequestIds.has(request.id)){card.querySelectorAll('button').forEach(button=>button.disabled=true);waitForDesktop();}$('approvals').append(card);}}
function renderComputerApproval(request){
  const id=currentId,host=currentHost,card=el('section','approval'),computer=request.params.computerUse;
  card.dataset.request=String(request.id);card.append(el('h3','',t('允许使用电脑应用？')),el('p','',computer.app));
  if(request.params.message)card.append(el('p','',request.params.message));
  const actions=el('div','actions'),error=el('p','error');card.append(actions,error);
  let busy=submittedRequestIds.has(request.id);
  async function submit(response){
    if(busy)return;busy=true;approvalBusy++;setLanguageBusy();actions.querySelectorAll('button').forEach(b=>b.disabled=true);error.textContent='';
    try{await api(sessionUrl(id,'respond',host),{requestId:request.id,response});bumpRecency(id,host);if(id===currentId&&host===currentHost)submittedRequestIds.add(request.id);card.append(el('p','muted',t('已发送，等待桌面确认…')));}
    catch(e){error.textContent=t(e.message);busy=false;actions.querySelectorAll('button').forEach(b=>b.disabled=false);}
    finally{approvalBusy--;setLanguageBusy();}
  }
  function choice(label,response,primary=false){const button=el('button',primary?'primary':'secondary',t(label));button.type='button';button.disabled=busy;button.onclick=()=>submit(response);actions.append(button);}
  if(computer.persistModes.includes('always'))choice('始终允许',{action:'accept',persist:'always'});
  choice('拒绝',{action:'decline'});
  if(computer.persistModes.includes('session'))choice('允许此对话',{action:'accept',persist:'session'},true);
  else choice('本次允许',{action:'accept'},true);
  return card;
}
function renderPlanApproval(request){
  const id=currentId,host=currentHost,key=chatKey(id,host),card=el('section','approval plan-approval');
  card.dataset.request=String(request.id);card.append(el('h3','',t('计划已就绪')));
  const details=el('details'),summary=el('summary','',t('查看计划')),content=el('div','plan-content');
  renderMarkdown(content,request.params.planContent||'',[],()=>null);details.append(summary,content);card.append(details);
  const label=el('label','',t('修改意见（可选）')),input=el('textarea');input.rows=2;input.maxLength=20000;label.append(input);card.append(label);
  const actions=el('div','actions'),yes=el('button','primary',t('按照当前规划结果执行')),revise=el('button','secondary',t('按照修改意见继续规划')),error=el('p','error');
  yes.type=revise.type='button';actions.append(yes,revise);card.append(actions,error);
  let busy=submittedRequestIds.has(request.id);
  function updateActions(){
    const hasFeedback=!!input.value.trim();
    yes.disabled=busy||hasFeedback;revise.disabled=busy||!hasFeedback;
    yes.className=hasFeedback?'secondary':'primary';revise.className=hasFeedback?'primary':'secondary';
  }
  input.oninput=updateActions;updateActions();
  async function submit(action){
    if(busy)return;
    if(action==='implement'&&input.value.trim()){updateActions();return;}
    if(action==='revise'&&!input.value.trim()){error.textContent=t('请填写修改意见');return;}
    const response=action==='implement'?{action}:{action,text:input.value};
    busy=true;approvalBusy++;setLanguageBusy();yes.disabled=revise.disabled=true;error.textContent='';
    try{
      const result=await api(sessionUrl(id,'respond',host),{requestId:request.id,response});
      if(currentId!==id||currentHost!==host)return;
      bumpRecency(id,host);submittedRequestIds.add(request.id);
      if(result.status==='unknown'){error.textContent=t('发送结果尚未确认，请查看会话后再操作。');return;}
      workModes.selection=action==='implement'?'default':'plan';sessionStorage.setItem('work-mode:'+key,workModes.selection);workModes.render();
      card.append(el('p','muted',t('已发送，等待桌面确认…')));
    }catch(e){if(currentId===id&&currentHost===host){error.textContent=t(e.message);busy=false;updateActions();}}
    finally{approvalBusy--;setLanguageBusy();}
  }
  yes.onclick=()=>submit('implement');revise.onclick=()=>submit('revise');return card;
}
async function ignoreSubmission(value){
  const result=await api('/api/accounts/ignore-submission',value);
  const key='pending:'+chatKey(value.threadId,value.host);
  try{if(JSON.parse(sessionStorage.getItem(key))?.id===value.submissionId)sessionStorage.removeItem(key);}catch{}
  if(currentId===value.threadId&&currentHost===value.host&&state){state.submissions=(state.submissions||[]).filter(row=>row.id!==value.submissionId);renderQueue(state.submissions);}
  return result;
}
function renderQueue(rows){
  $('queued').replaceChildren();
  const target=currentId,host=currentHost;
  for(const row of rows){
    const card=el('div','queue-card'),reply=row.text.startsWith('<send_user_message_question_reply>');
    card.append(el('strong','',row.status==='queued'?t('等待当前任务完成'):t('发送结果待确认')),el('p','',reply?t('问题回复'):row.text));
    if(row.attachments?.length)card.append(el('small','muted',t('附件：')+row.attachments.join('、')));
    if(row.status==='queued'){
      const cancel=el('button','plain',t('撤回待发送消息'));
      cancel.onclick=async()=>{try{await api(sessionUrl(target,'queue',host),{id:row.id});toast('已撤回');}catch(e){toast(e.message);}};card.append(cancel);
    }else{
      card.append(el('p','muted',t('请检查聊天记录。网关不会自动重发这条消息。')));
      const ignore=el('button','plain',t('忽略'));
      ignore.onclick=async()=>{
        if(!window.confirm(t('忽略只会移除未确认提示，不会撤回或重发消息。请先检查聊天记录。')))return;
        ignore.disabled=true;
        try{accountsPanel?.accept(await ignoreSubmission({threadId:target,submissionId:row.id,host}));toast('已忽略未确认记录');}
        catch(e){ignore.disabled=false;toast(e.message);}
      };if(!window.BridgeSharedRelay)card.append(ignore);
    }
    $('queued').append(card);
  }
}
function uuid(){const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
function chooseRunningSendMode(){
  if(runningSendChoice)return Promise.resolve(null);
  return new Promise(resolve=>{
    const dialog=el('dialog','picker running-send-dialog');dialog.id='running-send-dialog';
    const title=el('h2','',t('当前任务正在运行'));title.id='running-send-heading';title.setAttribute('data-i18n','当前任务正在运行');
    const description=el('p','muted',t('这条消息要如何发送？'));description.id='running-send-description';description.setAttribute('data-i18n','这条消息要如何发送？');
    dialog.setAttribute('aria-labelledby',title.id);dialog.setAttribute('aria-describedby',description.id);
    const head=el('div','picker-head');head.append(title);dialog.append(head,description);
    const options=el('div','running-send-options'),cancel=el('button','plain',t('取消'));
    cancel.type='button';cancel.autofocus=true;cancel.setAttribute('data-i18n','取消');cancel.setAttribute('data-close',dialog.id);
    const finish=mode=>{
      if(runningSendChoice?.dialog!==dialog)return;
      runningSendChoice=null;if(dialog.open)dialog.close();dialog.remove();resolve(mode);
    };
    for(const [mode,label,help] of [['queue','排队发送','当前任务完成后再发送。'],['steer','补充当前任务','立即补充到正在执行的任务。']]){
      const button=el('button','secondary');button.type='button';button.dataset.sendMode=mode;button.setAttribute('aria-label',t(label));button.setAttribute('data-i18n-aria-label',label);
      const name=el('strong','',t(label)),hint=el('small','muted',t(help));name.setAttribute('data-i18n',label);hint.setAttribute('data-i18n',help);
      button.append(name,hint);button.onclick=()=>finish(mode);options.append(button);
    }
    cancel.onclick=()=>finish(null);dialog.append(options,cancel);
    dialog.addEventListener('close',()=>finish(null),{once:true});
    runningSendChoice={dialog,close:()=>finish(null)};
    document.body.append(dialog);dialog.showModal();cancel.focus();
  });
}
$('composer').onsubmit=async event=>{
  event.preventDefault();
  if(applyingNewChat===chatKey()||sending||runningSendChoice||!currentId||!currentAccess().canSend)return;
  const target=currentId,targetHost=currentHost,raw=$('message').value,quoteIds=workbench.fileQuotes.rows.map(row=>row.id);
  let text;try{text=workbench.fileQuotes.validate();}catch(error){$('send-error').textContent=error.message;return;}
  if(!attachments.ready()){toast('请等待附件上传完成');return;}
  const attachmentIds=attachments.ids();
  if(!text.trim()&&!attachmentIds.length)return;
  let mode=$('send-mode').value;
  const requestedWorkMode=workModes.value('queue'),key='pending:'+chatKey(target,targetHost);
  let pending;try{pending=JSON.parse(sessionStorage.getItem(key));}catch{}
  const matches=mode=>pending&&pending.text===text&&pending.mode===mode&&pending.workMode===(mode==='steer'?null:requestedWorkMode)&&JSON.stringify(pending.attachments||[])===JSON.stringify(attachmentIds);
  const current=()=>currentId===target&&currentHost===targetHost;
  const unchanged=()=>current()&&workbench.fileQuotes.text()===text&&JSON.stringify(attachments.ids())===JSON.stringify(attachmentIds);
  $('send-error').textContent='';
  // An existing attempt may already have reached Codex. Reuse its identity and
  // mode to check the result; choosing a different mode would create a duplicate.
  if(pending&&['send','queue','steer'].includes(pending.mode)&&matches(pending.mode))mode=pending.mode;
  if(state?.status==='active'&&!matches(mode)){
    mode=await chooseRunningSendMode();
    if(!mode||!unchanged()||!currentAccess().canSend)return;
  }
  while(current()){
    const workMode=mode==='steer'?null:requestedWorkMode;
    if(workMode==='goal'&&attachmentIds.length){$('send-error').textContent=t('目标模式暂不支持附件');return;}
    if(!matches(mode))pending={id:uuid(),text,mode,workMode,attachments:attachmentIds,uiLocale:BridgeI18n.locale()};
    sessionStorage.setItem(key,JSON.stringify(pending));
    sending=true;attachments.setLocked(true);workModes.render(state,mode,true);$('send').disabled=true;$('send-error').textContent='';
    let rejectedBusy=false;
    try{
      const result=await api(sessionUrl(target,'send',targetHost),pending);
      if(result.status==='ignored')throw Error(t('这条未确认记录已忽略，请刷新后重新编辑消息。'));
      if(result.status==='unknown')throw Error(t('消息可能已送达，请检查聊天记录。再次点击不会重复提交。'));
      bumpRecency(target,targetHost);sessionStorage.removeItem(key);workModes.submitted(chatKey(target,targetHost),workMode);
      attachments.clear(chatKey(target,targetHost),attachmentIds);
      if(current()&&$('message').value===raw){$('message').value='';window.BridgePresentation?.resizeMessage();}
      workbench.fileQuotes.clear(chatKey(target,targetHost),quoteIds);
      if(composerDrafts.get('codex:'+chatKey(target,targetHost))===raw)composerDrafts.delete('codex:'+chatKey(target,targetHost));
      toast(workMode==='goal'?(result.activation?.status==='queued'?t('目标已创建，启动已排队'):result.activation?t('目标已创建，正在启动'):t('已提交目标请求，等待桌面确认')):result.status==='queued'?t('已加入待发送队列'):t('已发送到会话'));
    }catch(error){
      rejectedBusy=current()&&mode==='send'&&error.status===400&&error.message==='Codex 正在执行。请选择「排队发送」或「补充当前任务」。';
      if(rejectedBusy){sessionStorage.removeItem(key);pending=null;}
      else if(current()){$('send-error').textContent=t(error.message);window.BridgePresentation?.showError();}
    }finally{
      sending=false;attachments.setLocked(false);workModes.render(state,$('send-mode').value,false);
      $('send').disabled=!state||state.loadingHistory||state.activating||!attachments.ready()||!currentAccess().canSend;
    }
    if(!rejectedBusy||!unchanged())return;
    mode=await chooseRunningSendMode();
    if(!mode||!unchanged()||!currentAccess().canSend)return;
  }
};
$('message').onkeydown=event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();$('composer').requestSubmit();}};
$('stop').onclick=async()=>{if(!currentAccess().canInterrupt)return;try{await api(sessionUrl(currentId,'stop'),{});toast('已请求停止');}catch(e){toast(e.message);}};
$('history').onclick=async()=>{$('history').disabled=true;try{await api('/api/sessions/'+currentId+'/history',{});}catch(e){toast(e.message);}finally{$('history').disabled=false;}};
$('reconnect').onclick=async()=>{const access=currentAccess();if(!access.canReconnect)return;const id=currentId,host=currentHost;$('reconnect').disabled=true;reconnectFailure=null;try{await api(sessionUrl(id,'reconnect',host),{activate:true});}catch(e){if(id===currentId&&host===currentHost&&access.source==='cli'){reconnectFailure=e.message;$('notice').hidden=false;$('notice-text').textContent=t(e.message);}toast(e.message);}finally{$('reconnect').disabled=false;}};
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>$(button.dataset.close).close());
async function loadCatalogKind(kind,refresh=false){
  if(kind!=='models')throw Error(t('未知目录类型'));
  if(refresh)modelCatalogGeneration++;
  const target=currentId,targetHost=currentHost,generation=modelCatalogGeneration;
  if(!refresh&&catalogResults[kind])return catalogResults[kind];
  if(!refresh&&catalogTasks[kind])return catalogTasks[kind];
  const request=api('/api/sessions/'+target+'/catalog?kind='+kind+(refresh?'&refresh=true':'')).then(value=>{
    if(currentId!==target||currentHost!==targetHost||generation!==modelCatalogGeneration)throw Error(t('聊天已切换'));
    const payload=value?.[kind]??value?.data??value;
    if(!Array.isArray(payload)){
      const actual=payload===null?'null':typeof payload;
      throw Error(t('模型目录返回无效')+' ('+kind+': '+actual+')');
    }
    catalogData[kind]=payload.map(row=>typeof row==='string'?{id:row,name:row}:row).filter(row=>row&&(row.id||row.model));
    const result={...value,kind,[kind]:catalogData[kind]};
    catalogResults[kind]=result;
    return result;
  }).finally(()=>{if(catalogTasks[kind]===request)catalogTasks[kind]=null;});
  catalogTasks[kind]=request;
  return request;
}
function startCatalog(){loadCatalogKind('models').catch(()=>{});}
function resetModelCatalog(){
  composerReferences.close();composerReferences.states.clear();
  modelCatalogGeneration++;catalogData.models=null;catalogResults.models=null;catalogTasks.models=null;
  modelRequest++;modelTarget=null;fastModeControl.reset();$('model-dialog').close();
}
function renderEfforts(){
  const id=$('model-select').value,models=Array.isArray(catalogData?.models)?catalogData.models:[];
  const model=models.find(m=>m.id===(id==='__custom__'?$('custom-model').value.trim():id));
  $('custom-model-label').hidden=id!=='__custom__';$('custom-model').required=id==='__custom__';
  const options=model?.efforts?.length?model.efforts:catalogResults.models?.modelSource==='api'?['none','minimal','low','medium','high','xhigh','max','ultra']:[];
  $('effort-select').replaceChildren(...options.map(value=>new Option(value,value)));
  $('effort-select').value=options.includes(state?.effort)?state.effort:options.includes(model?.defaultEffort)?model.defaultEffort:options[0]||'';
  $('effort-select').disabled=!options.length;
  $('model-description').textContent=!options.length?t('未能读取此模型的推理能力，请重新打开模型设置'):model?.description||t('自定义模型需要当前 API 服务支持。');
  fastModeControl.select(id);$('model-save').disabled=!state?.connected||!id||!options.length;
}
$('model-button').onclick=async()=>{
  if(modelSaving)return;
  $('model-refresh').disabled=true;
  const request=++modelRequest,target=chatKey();modelTarget=target;fastModeControl.reset();
  $('model-form').querySelectorAll('input,select,button').forEach(n=>n.disabled=false);
  $('model-error').textContent='';$('model-select').replaceChildren(new Option(t('读取模型列表…'),''));$('model-save').disabled=true;$('model-dialog').showModal();
  try{
    const catalog=await loadCatalogKind('models',true);
    if(request!==modelRequest||target!==chatKey())return;
    $('model-select').replaceChildren(...(catalog.modelSource==='api'?[new Option(t('请选择上游模型'),'')]:[]),...(Array.isArray(catalog.models)?catalog.models:[]).map(m=>new Option(m.name,m.id)),new Option(t('自定义模型…'),'__custom__'));
    const current=state?.model||catalog.currentModel,models=Array.isArray(catalog.models)?catalog.models:[],known=models.some(m=>m.id===current);$('model-select').value=known?current:catalog.modelSource==='api'&&models.length?'':'__custom__';$('custom-model').value=current||'';
    $('model-error').textContent=catalog.modelError?t(catalog.modelError):catalog.modelSource==='api'&&!known&&models.length?t('当前聊天模型不在上游列表中，请选择可用模型后应用。'):'';
    $('model-access').textContent=(catalog.modelAccessName?t('当前接入：')+catalog.modelAccessName:t('聊天接入：')+(state?.provider||''));
    catalog.kind='models';
    fastModeControl.open(catalog,state,$('model-select').value);renderEfforts();
  }catch(e){if(request===modelRequest&&target===chatKey())$('model-error').textContent=t(e.message);}
  finally{if(request===modelRequest)$('model-refresh').disabled=false;}
};
$('model-refresh').onclick=()=>$('model-button').onclick();
$('model-select').onchange=renderEfforts;
$('custom-model').oninput=renderEfforts;
$('model-form').onsubmit=async event=>{
  event.preventDefault();if(modelSaving||modelTarget!==chatKey()||$('model-save').disabled)return;
  const request=modelRequest,target=currentId,host=currentHost;
  const model=$('model-select').value==='__custom__'?$('custom-model').value.trim():$('model-select').value;
  const body={model,effort:$('effort-select').value,...fastModeControl.payload()};
  modelSaving=true;fastModeControl.setBusy(true);$('model-form').querySelectorAll('input,select,button').forEach(n=>n.disabled=true);$('model-save').disabled=true;$('model-error').textContent='';
  try{
    const result=await api(sessionUrl(target,'settings',host),body);
    rememberNewChatSetting(target,host,{model:body.model,effort:body.effort});
    if(request===modelRequest&&chatKey(target,host)===chatKey()){$('model-dialog').close();toast(result.confirmed?t('模型设置已同步'):t('Codex 已接受设置，等待同步'));}
  }catch(e){if(request===modelRequest&&chatKey(target,host)===chatKey())$('model-error').textContent=t(e.message);}
  finally{modelSaving=false;if(request===modelRequest){$('model-form').querySelectorAll('input,select,button').forEach(n=>n.disabled=false);fastModeControl.setBusy(false);renderEfforts();}}
};
async function loadComposerReferences(kind,{target,query,offset,path,refresh,signal,hidden=false}){
  if(kind==='skills'){
    const result=await api(sessionUrl(target.id,'catalog',target.host)+'&kind=skills&q='+encodeURIComponent(query)+'&offset='+offset+'&limit=200'+(refresh?'&refresh=true':''),undefined,signal);
    return ChatReferencePicker.skillItems(result,offset);
  }
  if(kind==='files'){
    const result=await api(sessionUrl(target.id,'workspace',target.host)+'&path='+encodeURIComponent(path)+'&search='+encodeURIComponent(query)+'&offset='+offset+'&hidden='+hidden+'&recursive='+!!query,undefined,signal);
    return ChatReferencePicker.fileItems(result,target.cwd);
  }
  if(kind!=='sessions')throw Error(t('未知目录类型'));
  const [result,metadata]=await Promise.all([
    api('/api/sessions?q='+encodeURIComponent(query)+'&offset='+offset+'&archived=false&source=all',undefined,signal),
    !refresh&&target.sidebar?target.sidebar:api('/api/projects?metadata=1',undefined,signal)
  ]);
  target.sidebar=metadata;
  const sections=metadata.sections||[],projects=metadata.projects||[],ids=sections.map(section=>section.id);
  const destination=(kind,row)=>{
    const host=row.host||'local',id=kind==='project'?row.key:row.id;
    const nativeId=kind==='project'?id.slice(id.indexOf('|')+1):id;
    const section=sections.find(section=>section.itemKeys?.includes('codex:'+kind+':'+nativeId)||kind==='thread'&&row.thread_section_id&&section.hostSectionIds?.[host]===row.thread_section_id);
    const pinned=kind==='project'?metadata.pinnedProjectIds?.includes(nativeId):row.is_pinned||metadata.pinnedThreadIds?.includes(id);
    return sidebarPlacements.resolve({kind,id,host},ids,section?'section:'+section.id:pinned?'pinned':'home');
  };
  const sectionGroup=target=>({id:target,title:target==='pinned'?t('置顶'):target==='projects'?t('项目'):target==='threads'?t('聊天'):sections.find(section=>'section:'+section.id===target)?.name||t('项目')});
  const items=(result.sessions||[]).map(row=>{
    const placed=destination('thread',row);let groups;
    if(placed!=='home')groups=[sectionGroup(placed)];
    else if(!row.projectKey||row.projectKey===row.host+'|independent')groups=[sectionGroup('threads')];
    else{
      const project=projects.find(project=>project.key===row.projectKey)||{key:row.projectKey,name:row.projectName,host:row.host};
      const placedProject=destination('project',project);
      groups=[sectionGroup(placedProject==='home'?'projects':placedProject),{id:'project:'+project.key,title:(project.name||row.projectName||t('项目'))+(row.host!=='local'?' · '+(row.hostLabel||row.host):'')}];
    }
    const value='codex://threads/'+encodeURIComponent(row.id);
    return {id:chatKey(row.id,row.host),title:row.title||t('未命名聊天'),description:value,value,groups};
  });
  const order=(metadata.sectionOrder||[]).map(id=>id.startsWith('custom:')?'section:'+id.slice(7):id),rank=item=>{const index=order.indexOf(item.groups[0].id);return index<0?order.length:index;};
  items.sort((a,b)=>rank(a)-rank(b));
  return {items,nextOffset:items.length===100?offset+100:null,
    notice:result.unavailableHosts?.length?'部分主机暂不可用，当前显示已读取的会话。':''};
}
const composerReferences=new ChatReferencePicker({button:$('skills-button'),input:$('message'),
  context:()=>currentId&&!sending&&clientNavigation.provider==='codex'?{key:chatKey(),id:currentId,host:currentHost,cwd:state?.cwd||'',canSkills:currentAccess().canSelectSkills}:null,
  load:loadComposerReferences,onInsert:()=>{saveDraft();window.BridgePresentation?.resizeMessage();}});

window.addEventListener('pagehide',saveDraft);
function startFromLink(token){return start(token).catch(()=>{if(window.BridgeBootstrap?.failed())return;showLogin();$('login-error').textContent=t('无法连接网关，请检查网络后重新加载。');});}
startFromLink(initialPairingToken);initialPairingToken=null;
window.addEventListener('hashchange',()=>{const token=takePairingToken();if(token!==null)startFromLink(token);else if(!$('app').hidden)clientNavigation.openChatLink(location.hash,openChat).catch(error=>toast(error.message));});
function setLanguageBusy(){$('phone-language').disabled=!!(approvalBusy||creatingChat);$('appearance-language').disabled=$('phone-language').disabled;}
$('phone-language').value=BridgeI18n.language();
$('phone-language').onchange=()=>{
  if(approvalBusy||creatingChat)return;
  const replies=[...$('approvals').querySelectorAll('input,textarea,select')].map(node=>({value:node.value,checked:node.checked}));
  BridgeI18n.setLanguage($('phone-language').value);BridgeI18n.apply();if(typeof accountsPanel!=="undefined")accountsPanel?.render();renderSourceFilter();renderList();
  if($('new-chat-title').dataset.edited!=='true')$('new-chat-title').value=t('新聊天');
  $('new-chat-help').textContent=t($('new-chat-type').value==='cli'?'选择已有 CLI 项目目录，在此创建聊天。':'选择已有项目，或不选择项目创建独立聊天。电脑会打开这条聊天。');
  $('new-chat-submit').textContent=t($('new-chat-type').value==='cli'?'创建聊天':'创建并打开');
  renderLoginStatus();
  for(const id of ['login-error','send-error','model-error','new-chat-error','notify-error','rename-error','rename-summary-status','pushplus-error','toast'])$(id).textContent=t($(id).textContent);
  for(const option of $('new-chat-project').options){const project=newChatProjects.find(p=>p.key===option.value);if(project)option.textContent=project.name+' · '+(project.host==='local'?t('此电脑'):project.hostLabel);}
  if($('model-select').querySelector('[value=__custom__]'))$('model-select').querySelector('[value=__custom__]').textContent=t('自定义模型…');
  if(state){approvalStamp='';renderState(state);[...$('approvals').querySelectorAll('input,textarea,select')].forEach((node,i)=>{if(replies[i]){node.value=replies[i].value;node.checked=replies[i].checked;if(node.tagName==='SELECT')node.dispatchEvent(new Event('change'));}});}
  renderNotificationState();
  if(chatTimeline)chatTimeline.relabel();messageActions.relabel();
  window.BridgePresentation?.relabel();workbench.relabel();attachments.render();renderActivity();
  composerReferences.relabel();
};
BridgeI18n.apply();

let renameTarget=null,renameBusy=false;
const titleSummary=new ChatTitleSummary({dialog:$('rename-dialog'),button:$('rename-summary'),
  input:$('rename-title'),status:$('rename-summary-status'),request:api,updated:(target,title)=>{
    if(currentId===target.id&&currentHost===target.host){
      if(state){state.title=title;state.titleSource='native';}
      $('chat-title').textContent=title;$('details-title').textContent=title;
    }
    loadList(true).catch(()=>{});
  }});
$('rename-chat').onclick=()=>{
  if(!currentId||renameBusy||!currentAccess().canConfigure)return;
  renameTarget={id:currentId,host:currentHost};
  $('rename-title').value=state?.title||$('chat-title').textContent;
  $('rename-error').textContent='';$('chat-details-dialog').close();$('rename-dialog').showModal();
  titleSummary.open(renameTarget,sessionUrl(renameTarget.id,'auto-title',renameTarget.host));
};
$('rename-form').onsubmit=async event=>{
  event.preventDefault();if(renameBusy||!renameTarget||!currentAccess().canConfigure)return;
  const target=renameTarget,title=$('rename-title').value.trim();
  if(!title)return;
  renameBusy=true;$('rename-save').disabled=true;$('rename-error').textContent='';
  try{
    const result=await api(sessionUrl(target.id,'rename',target.host),{title});
    if(currentId===target.id&&currentHost===target.host){
      if(state)state.title=result.title;
      $('chat-title').textContent=result.title;$('details-title').textContent=result.title;
    }
    $('rename-dialog').close();toast('聊天名称已修改');
    await loadList(true);
  }catch(error){$('rename-error').textContent=t(error.message);}
  finally{renameBusy=false;$('rename-save').disabled=false;}
};
let notificationChannelBusy=false,selectedNotificationChannel='',notificationListRequest=0,notificationCommonLoaded=false;
const notificationChannelDetails={
  bark:{name:'Bark',enabled:'barkEnabled',server:'barkServer',secret:'barkKey',hasSecret:'hasBarkKey',clear:'clearBarkKey',secretLabel:'Device Key',help:'在 iPhone 的 Bark 中获取 Device Key，并填写服务地址。'},
  ntfy:{name:'ntfy',enabled:'enabled',server:'server',secret:'token',hasSecret:'hasToken',clear:'clearToken',secretLabel:'Token',help:'在 Android 的 ntfy 中订阅相同服务和主题。公共主题可以留空 Token。'},
  pushplus:{name:'PushPlus',enabled:'pushplusEnabled',secret:'pushplusToken',hasSecret:'hasPushplusToken',clear:'clearPushplusToken',secretLabel:'Token',help:'通过微信获取 PushPlus Token，保存后可以发送测试通知。'}
};
function renderNotificationChannel(config){
  const channel=notificationChannelDetails[selectedNotificationChannel];
  $('pushplus-heading').textContent=channel.name;
  $('notification-channel-help').textContent=t(channel.help);
  $('pushplus-help').hidden=selectedNotificationChannel!=='pushplus';
  $('notification-channel-enable-label').textContent=t('启用 '+channel.name);
  $('pushplus-enabled').checked=!!config[channel.enabled];
  $('notification-server-row').hidden=!channel.server;
  $('notification-topic-row').hidden=selectedNotificationChannel!=='ntfy';
  if(channel.server){
    $('notification-server-label').textContent=t(channel.name+' 服务地址');
    $('notification-server').value=config[channel.server]||'';
  }
  if(selectedNotificationChannel==='ntfy')$('notification-topic').value=config.topic||'';
  $('notification-secret-label').textContent=channel.secretLabel;
  $('notification-clear-label').textContent=t('清除已保存的 '+channel.secretLabel);
  $('pushplus-token').value='';$('pushplus-clear').checked=false;
  $('pushplus-token').placeholder=t(config[channel.hasSecret]?'已保存，留空保留':'填写 '+channel.name+' '+channel.secretLabel);
}
function renderNotificationCommon(config){
  for(const id of ['security-enabled','address-enabled','include-title'])$('notification-'+id).checked=!!config[{'security-enabled':'securityEnabled','address-enabled':'addressEnabled','include-title':'includeTitle'}[id]];
  $('notification-address-name').value=config.addressName||'';
  $('notification-click-base').value=config.clickBase||'';
}
function notificationCommonControls(enabled){
  for(const id of ['security-enabled','address-enabled','address-name','include-title','click-base','common-save'])$('notification-'+id).disabled=!enabled;
}
async function loadNotificationCommon(request){
  notificationCommonLoaded=false;notificationCommonControls(false);
  $('notification-common-retry').hidden=true;$('notification-common-error').textContent='';
  try{
    const config=await api('/api/notifications/channels/common');
    if(request!==notificationListRequest||!$('notification-channels-dialog').open)return;
    renderNotificationCommon(config);notificationCommonLoaded=true;notificationCommonControls(true);
  }catch(error){
    if(request!==notificationListRequest||!$('notification-channels-dialog').open)return;
    $('notification-common-error').textContent=t(error.message);$('notification-common-retry').hidden=false;
  }
}
async function loadNotificationChannelStatuses(request){
  for(const name of Object.keys(notificationChannelDetails))$('notification-status-'+name).textContent=t('读取中');
  const responses=await Promise.allSettled(Object.keys(notificationChannelDetails).map(name=>api('/api/notifications/channels/'+name)));
  if(request!==notificationListRequest||!$('notification-channels-dialog').open)return;
  for(const [index,name] of Object.keys(notificationChannelDetails).entries()){
    const result=responses[index],channel=notificationChannelDetails[name];
    const status=result.status==='rejected'?'读取失败':(name==='ntfy'?!!result.value.topic:!!result.value[channel.hasSecret])?(result.value[channel.enabled]?'已开启':'已关闭'):'未配置';
    $('notification-status-'+name).textContent=t(status);
  }
}
$('pushplus-settings').onclick=async()=>{
  if(notificationChannelBusy)return;
  const request=++notificationListRequest;
  $('notification-channels-dialog').showModal();
  await Promise.all([loadNotificationCommon(request),loadNotificationChannelStatuses(request)]);
};
$('notification-channels-dialog').addEventListener('close',()=>{notificationListRequest++;notificationCommonLoaded=false;notificationCommonControls(false);});
$('notification-common-retry').onclick=()=>loadNotificationCommon(notificationListRequest);
for(const button of document.querySelectorAll('[data-notification-channel]'))button.onclick=async()=>{
  if(notificationChannelBusy)return;
  const channel=button.dataset.notificationChannel;
  const request=notificationListRequest;
  notificationChannelBusy=true;button.disabled=true;
  try{
    const config=await api('/api/notifications/channels/'+channel);
    if(request!==notificationListRequest||!$('notification-channels-dialog').open)return;
    selectedNotificationChannel=channel;
    renderNotificationChannel(config);
    $('pushplus-error').textContent='';
    $('notification-channels-dialog').close();
    $('pushplus-dialog').showModal();
  }catch(error){if(request===notificationListRequest&&$('notification-channels-dialog').open)$('notification-common-error').textContent=t(error.message);}
  finally{notificationChannelBusy=false;button.disabled=false;}
};
$('notification-channel-back').onclick=()=>{$('pushplus-dialog').close();$('pushplus-settings').onclick();};
$('notification-common-save').onclick=async()=>{
  if(notificationChannelBusy||!notificationCommonLoaded||!$('notification-channels-dialog').open)return;
  notificationChannelBusy=true;$('notification-common-save').disabled=true;$('notification-common-error').textContent='';
  const request=notificationListRequest;
  try{
    const config=await api('/api/notifications/channels/common',{
      securityEnabled:$('notification-security-enabled').checked,
      addressEnabled:$('notification-address-enabled').checked,
      addressName:$('notification-address-name').value.trim(),
      includeTitle:$('notification-include-title').checked,
      clickBase:$('notification-click-base').value.trim()
    });
    if(request===notificationListRequest&&$('notification-channels-dialog').open){renderNotificationCommon(config);toast('通用通知设置已保存');}
  }catch(error){if(request===notificationListRequest&&$('notification-channels-dialog').open)$('notification-common-error').textContent=t(error.message);}
  finally{notificationChannelBusy=false;if(request===notificationListRequest&&notificationCommonLoaded)notificationCommonControls(true);}
};
async function notificationChannelAction(test){
  if(notificationChannelBusy||!selectedNotificationChannel)return;
  notificationChannelBusy=true;
  const ids=['pushplus-save','pushplus-test','pushplus-enabled','notification-server','notification-topic','pushplus-token','pushplus-clear'];
  for(const id of ids)$(id).disabled=true;
  $('pushplus-error').textContent='';
  const channel=notificationChannelDetails[selectedNotificationChannel];
  try{
    const url='/api/notifications/channels/'+selectedNotificationChannel;
    if(test){
      await api(url+'/test',{});
      toast(channel.name+' 已接受测试通知，请在手机确认是否收到');
    }else{
      const body={[channel.enabled]:$('pushplus-enabled').checked,[channel.secret]:$('pushplus-token').value.trim(),[channel.clear]:$('pushplus-clear').checked};
      if(channel.server)body[channel.server]=$('notification-server').value.trim();
      if(selectedNotificationChannel==='ntfy')body.topic=$('notification-topic').value.trim();
      renderNotificationChannel(await api(url,body));
      toast(channel.name+' 配置已保存');
      if(currentId)await loadNotificationState(currentId,currentHost);
    }
  }catch(error){$('pushplus-error').textContent=t(error.message);}
  finally{notificationChannelBusy=false;for(const id of ids)$(id).disabled=false;}
}
$('pushplus-form').onsubmit=event=>{event.preventDefault();return notificationChannelAction(false);};
$('pushplus-test').onclick=()=>notificationChannelAction(true);

const codexCliRoot=el('div');
const codexCliDetails=el('details','account-compact'),codexCliSummary=el('summary','',t('Codex CLI 接入'));codexCliSummary.dataset.i18n='Codex CLI 接入';codexCliDetails.append(codexCliSummary,codexCliRoot);$('accounts-dialog').append(codexCliDetails);
const codexCliAccessPanel=typeof CliAccessPanel==='undefined'?null:new CliAccessPanel({root:codexCliRoot,provider:'codex',read:()=>api('/api/cli-access'),request:value=>api('/api/cli-access',value)});
$('accounts-dialog').addEventListener('close',()=>codexCliAccessPanel?.clear());
const accountsPanel=window.BridgeSharedRelay||typeof AccountsPanel==='undefined'?null:new AccountsPanel({root:$('accounts-content'),toolbar:$('accounts-heading'),read:()=>api('/api/accounts'),request:({action,...value})=>action==='ignoreSubmission'?ignoreSubmission(value):api(action==='account'?'/api/accounts/account':action==='details'?'/api/accounts/details':action==='reminders'?'/api/accounts/reminders':action==='checkDesktopUpdate'||action==='requestDesktopUpdate'?'/api/accounts/desktop-update':'/api/accounts/switch',action==='checkDesktopUpdate'||action==='requestDesktopUpdate'?{action,...value}:value),onChanged:()=>resetModelCatalog(),onUpdate:()=>{const label='账号管理';$('accounts-button').setAttribute('data-i18n',label);$('accounts-button').textContent=t(label);}});
function openCurrentAccounts(){
  const provider=clientNavigation.provider;
  if(!provider)return false;
  if(provider==='codex'){
    if(!accountsPanel)return false;
    $('accounts-dialog').showModal();accountsPanel.refresh();codexCliAccessPanel?.refresh();return true;
  }
  const name=clientNavigation.clients.find(row=>row.id===provider)?.name||provider;
  const dialog=desktopSessions.dialog('账号与接入'),content=el('div','provider-account');
  dialog.append(el('h3','',name),content);
  const panel=new DesktopClientAccountsPanel({root:content,provider,
    read:()=>api('/api/desktop-sessions/'+provider+'/accounts'),
    request:value=>api('/api/desktop-sessions/'+provider+'/accounts',value),
    readModels:()=>api('/api/desktop-sessions/'+provider+'/account'),
    onChanged:(value,previous)=>desktopSessions.accountChanged(provider,previous,value)
  });
  if(provider==='claude'&&typeof CliAccessPanel!=='undefined'){
    const details=el('details','account-compact'),root=el('div'),summary=el('summary','',t('Claude Code CLI 接入'));summary.dataset.i18n='Claude Code CLI 接入';details.append(summary,root);dialog.append(details);
    claudeCliAccessPanel=new CliAccessPanel({root,provider:'claude',read:()=>api('/api/cli-access'),request:value=>api('/api/cli-access',value)});
    claudeCliAccessPanel.refresh();
  }
  dialog.addEventListener('close',()=>{panel.dispose();claudeCliAccessPanel?.dispose();claudeCliAccessPanel=null;});dialog.showModal();panel.resume();
  return true;
}
$('accounts-button').onclick=openCurrentAccounts;
window.BridgeNavigation={
  openChat(hash){
    if(!clientNavigation.chatTarget(hash))return;
    clientNavigation.cancelChatLink();
    if($('app').hidden||entering){pendingEntryChatLink=hash;history.replaceState(null,'',location.pathname+location.search+hash);return;}
    const target=clientNavigation.chatTarget(hash);
    if(target.provider==='codex'&&clientNavigation.provider==='codex'&&currentId===target.id&&currentHost===target.host&&chatTimeline)return;
    if(target.provider!=='codex'&&desktopSessions.provider===target.provider&&desktopSessions.isChatOpen&&desktopSessions.sid===target.id)return;
    clientNavigation.openChatLink(hash,openChat).catch(error=>toast(error.message));
  },
  accounts:openCurrentAccounts,
  back(){
    const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);if(dialog){dialog.close();return true;}
    if(clientNavigation.provider!=='codex'){
      if(desktopSessions.workbench?.back())return true;
      return desktopSessions.backToList();
    }
    if(workbench.back())return true;
    if($('app').classList.contains('chat-open')){$('back').click();return true;}
    return false;
  }
};

$('permissions-button').onclick=()=>{
  if(!currentId||!state?.connected)return;
  const id=currentId,host=currentHost,runtime=state.access?.runtime||'desktop',dialog=el('dialog','picker'),head=el('div','picker-head');
  dialog.dataset.permissionThread=id;dialog.dataset.permissionHost=host;dialog.dataset.permissionRuntime=runtime;
  const isCurrent=()=>{
    const current=dialog.open&&currentId===id&&currentHost===host&&state?.connected===true&&
      (state.access?.runtime||'desktop')===runtime;
    if(!current&&dialog.open)dialog.close();
    return current;
  };
  head.append(el('h2','',t('会话权限')));const close=el('button','icon-button','×');close.type='button';close.setAttribute('aria-label',t('关闭'));close.onclick=()=>dialog.close();head.append(close);dialog.append(head,el('p','muted',t('保存后从下一轮生效')));
  if(state.linuxPermissionChecks===true||state.access?.runtime==='cli'){
    document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
    permissionPicker(dialog,{nativeCli:runtime==='cli',load:()=>api(sessionUrl(id,'permissions',host)),
      save:async preset=>{const result=await api(sessionUrl(id,'permissions',host),{preset,confirmed:preset==='full-access',expectedRuntime:runtime});if(result.applied)rememberNewChatSetting(id,host,{permission:preset});return result;},
      isCurrent,onSaved:()=>toast('权限已更新')});
    return;
  }
  const error=el('p','error');
  for(const [preset,label,help] of [['ask','请求批准','需要额外权限时询问你。'],['auto-review','帮我批准','由 Codex 审核需要额外权限的操作。'],['full-access','完全访问权限','允许访问工作区外的文件和网络，无需逐次批准。']]){
    const button=permissionOption(el('button'),preset,label,help,state.permissionMode===preset);
    button.onclick=async()=>{
      if(!isCurrent())return;
      if(preset==='full-access'&&!confirm(t('允许此会话完全访问电脑文件和网络？请仅在信任任务内容时开启。')))return;
      dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{const result=await api(sessionUrl(id,'permissions',host),{preset,confirmed:preset==='full-access',expectedRuntime:runtime});if(result.applied)rememberNewChatSetting(id,host,{permission:preset});if(!isCurrent())return;if(result.confirmed){dialog.close();toast('权限已更新');}else error.textContent=t('已提交权限设置，等待桌面确认。');}
      catch(e){if(isCurrent())error.textContent=t(e.message);}finally{dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
    };dialog.append(button);
  }
  dialog.append(error);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
};


const fileTransferSettings=window.BridgeFileActions?.mountSettings($('appearance-dialog'),value=>api('/api/file-transfer',value));
if(fileTransferSettings)$('appearance-dialog').querySelector('.settings-action-row')?.after(fileTransferSettings);
