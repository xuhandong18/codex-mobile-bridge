'use strict';
// Desktop providers use the same conversation, composer and workspace presentation as Codex.
class DesktopSessionsView {
  constructor({root,select,request,notify,onSelect,csrf,onUnauthorized,drafts=new Map()}) {
    Object.assign(this,{root,select,request,notify,onSelect,csrf,onUnauthorized});this.provider='codex';this.generation=0;this.detailRevision=0;this.drafts=drafts;this.accountDrafts=new Map();this.pending=new Map();this.sendChoices=new Map();this.rows=[];this.messageNodes=new Map();this.providerViews=new Map();this.detailCache=new Map();this.activity=new SessionActivity({key:'bridge-desktop-session-activity',onRead:(key,row)=>this.syncDesktopRead(key,row)});try{this.collapsedGroups=new Set(JSON.parse(localStorage.getItem('bridge-desktop-session-groups')||'[]'));}catch{this.collapsedGroups=new Set();}
    this.readTasks=new Map();this.readEpoch=0;this.providerReadEpochs=new Map();this.accountEpochs=new Map();this.listPrefetchAt=new Map();this.detailCacheSizes=new Map();this.detailCacheBytes=0;
    this.container=this.node('section','desktop-sessions');root.append(this.container);this.container.hidden=true;
    this.list=this.node('aside','ds-list');this.main=this.node('main','ds-main');this.container.append(this.list,this.main);
    this.search=this.node('input','search');this.search.placeholder=BridgeI18n.t('搜索');this.label(this.search,'搜索聊天或项目');this.search.oninput=()=>this.renderList();
    const filters=this.node('div','list-filters');const display=this.node('label','list-mode');display.append(this.translated('span','显示方式'));this.listMode=this.node('select');this.label(this.listMode,'聊天列表显示方式');for(const [id,title] of [['recent','最近交互'],['project','按项目']])this.listMode.add(new Option(BridgeI18n.t(title),id));this.listMode.onchange=()=>this.renderList();display.append(this.listMode);
    this.surface=this.node('select','ds-surface');this.label(this.surface,'会话类型');this.surface.add(new Option(BridgeI18n.t('全部会话'),'all'));this.surface.value='all';this.surfaceSelection='all';this.surface.hidden=true;this.surface.onchange=()=>{this.surfaceSelection=this.surface.value;this.renderList();};const archive=this.node('label','archive');this.archived=this.node('input');this.archived.type='checkbox';this.archived.onchange=()=>this.renderList();archive.append(this.archived,this.translated('span','已归档'));filters.append(this.surface,display,archive);
    this.listStatus=this.node('p','muted ds-list-status');this.listStatus.setAttribute('role','status');this.connectionRetry=this.button('重试连接',async()=>{const provider=this.provider;if(this.retryingClient||!this.retryClient)return;this.retryingClient=provider;this.renderConnectionStatus();try{await this.retryClient(provider);}finally{this.retryingClient=null;this.renderConnectionStatus();}});this.connectionRetry.hidden=true;
    this.connectionInitialize=this.button('初始化连接',async()=>{const provider=this.provider;if(this.initializingClient||!this.initializeClient)return;this.initializingClient=provider;this.renderConnectionStatus();try{await this.initializeClient(provider);}finally{this.initializingClient=null;this.renderConnectionStatus();}});this.connectionInitialize.hidden=true;
    this.connectionReconnect=this.button('重新连接 Desktop',async()=>{const provider=this.provider;if(this.reconnectingClient||!this.reconnectClient)return;this.reconnectingClient=provider;this.renderConnectionStatus();try{await this.reconnectClient(provider);}finally{this.reconnectingClient=null;this.renderConnectionStatus();}});this.connectionReconnect.hidden=true;
    this.connectionNotice=this.node('p','muted');this.connectionNotice.hidden=true;this.connectionRefresh=this.button('刷新状态',async()=>{if(this.refreshingClient||!this.refreshClients)return;this.refreshingClient=true;this.renderConnectionStatus();try{await this.refreshClients();}finally{this.refreshingClient=false;this.renderConnectionStatus();}});this.connectionRefresh.hidden=true;this.rowsRoot=this.node('div','sessions');const toolbar=this.node('div','chat-list-toolbar');toolbar.append(this.search,filters);this.list.append(toolbar,this.listStatus,this.connectionNotice,this.connectionRetry,this.connectionReconnect,this.connectionInitialize,this.connectionRefresh,this.rowsRoot);if(typeof bindChatListToolbar==='function')bindChatListToolbar(toolbar);if(typeof bindListActions==='function')bindListActions(toolbar,this.archived,()=>this.listActions?.()||[]);
    this.welcome=this.node('div','welcome ds-welcome');const logo=this.node('img','mark large');logo.src='/icon.png';logo.alt='';logo.width=72;logo.height=72;this.welcome.append(logo,this.translated('h1','从一条聊天继续'),this.translated('p','选择电脑上的聊天，查看进度或发送消息。','muted'));
    this.conversation=this.node('section','ds-conversation chat');this.conversation.hidden=true;this.main.append(this.welcome,this.conversation);
    this.back=this.iconButton('返回聊天列表','m15 5-7 7 7 7',()=>{if(!this.workbench.back())this.backToList();});this.back.classList.add('ds-back');
    this.clientIcon=this.node('span','client-icon');const info=this.node('div','chat-info');this.title=this.node('span','ds-title');this.titleButton=this.button('',()=>this.chatDetails());this.titleButton.className='chat-title-button';this.label(this.titleButton,'查看聊天详情');this.titleButton.append(this.title);info.append(this.titleButton);
    this.status=this.node('span','status');this.status.setAttribute('role','status');const settings=this.iconButton('设置','M5 12h.01M12 12h.01M19 12h.01',()=>{document.getElementById('appearance-dialog')?.showModal();window.loadNotificationDefaults?.();});settings.className='ds-settings appearance-button';settings.setAttribute('data-open-appearance','');
    const head=this.node('header','ds-head chat-head');head.append(this.back,this.clientIcon,info,this.status,settings);
    this.messages=this.node('div','ds-messages timeline');this.messages.tabIndex=-1;this.requests=this.node('div','ds-requests');this.notice=this.node('p','notice');this.notice.hidden=true;this.resumeButton=this.button('继续会话',()=>this.mutate('resume',{}));this.resumeButton.hidden=true;
    this.form=this.node('form','ds-composer composer');this.tools=this.node('div','composer-tools');this.modelButton=this.button('',()=>this.models());this.modelButton.className='tool-button ds-model';this.modelName=this.translated('span','模型','ds-model-name');this.modelEffort=this.node('span','ds-model-effort');this.modelButton.append(this.modelName,this.modelEffort);
    this.referenceButton=this.node('button','tool-button reference-button','＋');this.referenceButton.type='button';this.label(this.referenceButton,'添加引用');this.permissionsButton=this.button('权限',()=>this.permissions());this.permissionsButton.className='tool-button';this.permissionsButton.hidden=true;
    this.composerToggle=this.iconButton('收起输入区','m6 9 6 6 6-6',()=>this.collapseComposer(!this.composerBody.hidden));this.composerToggle.className='composer-toggle';this.composerToggle.setAttribute('aria-expanded','true');this.contextButton=this.button('',()=>this.contextDetails());this.contextButton.className='tool-button context-usage ds-context';this.contextRing=this.node('span','context-usage-ring');this.contextRing.setAttribute('aria-hidden','true');this.contextButton.append(this.contextRing);this.tools.append(this.modelButton,this.referenceButton,this.permissionsButton,this.contextButton,this.composerToggle);
    this.composerBody=this.node('div','ds-composer-body');this.attachmentList=this.node('div','attachment-list');this.attachmentList.hidden=true;this.attachmentInput=this.node('input');this.attachmentInput.type='file';this.attachmentInput.multiple=true;this.attachmentInput.accept='image/png,image/jpeg,image/gif,image/webp';this.attachmentInput.hidden=true;this.attachButton=this.iconButton('添加文件或图片','m8 12 6-6a3.5 3.5 0 0 1 5 5l-8 8a5 5 0 0 1-7-7l8-8m-6 10 7-7',()=>{});this.attachButton.className='attach-button';this.error=this.node('div','error');this.error.setAttribute('role','alert');this.input=this.node('textarea');this.input.rows=1;this.input.maxLength=100000;this.input.placeholder=BridgeI18n.t('继续这条聊天…');this.label(this.input,'消息内容');this.input.oninput=()=>{if(this.sid)this.drafts.set(this.provider+':'+this.sid,this.input.value);this.resizeInput();this.updateComposer();};
    this.mode=this.node('select');this.label(this.mode,'发送方式');for(const [id,title] of [['send','发送新消息'],['queue','完成后发送'],['steer','补充当前任务']])this.mode.add(new Option(BridgeI18n.t(title),id));
    this.workMode=this.node('select');this.label(this.workMode,'工作模式');for(const [id,title] of [['default','普通模式'],['plan','计划模式'],['goal','目标模式']]){const option=new Option(BridgeI18n.t(title),id);option.dataset.i18n=title;this.workMode.add(option);}
    this.modeHint=this.node('span','mode-hint');this.modeHint.hidden=true;this.goalRoot=this.node('div','goal-state');this.goalRoot.hidden=true;this.goalToggle=this.iconButton('目标进度','M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8',()=>{});this.goalToggle.append(this.translated('span','目标进度'));this.goalToggle.className='goal-toggle';this.goalToggle.hidden=true;
    const goalAction=async(goalAction,payload)=>{if(!await this.mutate('settings',{goalAction,...payload}))throw Error(this.error.textContent||'目标操作失败，请重试');};
    this.workModes=new WorkModes({select:this.workMode,hint:this.modeHint,goalRoot:this.goalRoot,goalToggle:this.goalToggle,storage:localStorage,newId:()=>this.requestId(),onCancel:payload=>goalAction('clear',payload),onStatus:payload=>goalAction(payload.status,payload),onEdit:payload=>goalAction('edit',payload)});this.mode.onchange=()=>this.updateComposer();
    this.send=this.button('发送 ↑',()=>{});this.send.className='primary';this.send.type='submit';this.stop=this.button('■ 停止',()=>this.mutate('stop',{}));this.stop.className='stop';this.stop.hidden=true;
    const actions=this.node('div','ds-actions compose-bottom'),sendActions=this.node('div','compose-actions');sendActions.append(this.goalToggle,this.stop,this.send);actions.append(this.attachButton,this.attachmentInput,this.mode,this.workMode,sendActions);this.composerBody.append(this.attachmentList,this.error,this.input,actions,this.modeHint);this.form.append(this.tools,this.composerBody);this.form.onsubmit=e=>{e.preventDefault();return this.submit();};
    this.referencePicker=new globalThis.ChatReferencePicker({button:this.referenceButton,input:this.input,context:()=>this.referenceContext(),load:(kind,options)=>this.loadReferences(kind,options),onInsert:()=>this.collapseComposer(false)});
    this.attachments=new ChatAttachments({root:this.attachmentList,button:this.attachButton,input:this.attachmentInput,paste:this.input,drop:this.form,onChange:()=>this.updateComposer(),upload:(key,id,file)=>this.uploadAttachment(key,id,file),preview:(key,id)=>this.attachmentUrl(key,id,'preview'),thumbnail:async(key,id,file)=>{const image=await this.attachments.thumbnailBlob(file);return this.uploadBinary(this.attachmentUrl(key,id,'thumb')+'&width='+image.width+'&height='+image.height,image.data,image.mime);}});
    const addAttachments=this.attachments.add.bind(this.attachments);this.attachments.add=files=>{if(!this.attachments.key||this.attachments.locked)return;if(this.overRequestLimit([...this.attachments.rows,...files])){this.attachments.error=this.requestLimitMessage();this.attachments.render();return;}if(this.provider!=='claude'||this.state?.backend!=='cli'){if(files.some(file=>!file.type?.startsWith('image/'))){this.attachments.error='此应用的消息附件仅支持图片；其他文件请使用文件传输。';this.attachments.render();return;}}addAttachments(files);};
    this.conversation.append(head,this.notice,this.messages,this.requests,this.goalRoot,this.form);this.workbench=new Workbench({chat:this.conversation,request,csrf,notify,onUnauthorized});select.onchange=()=>this.choose(select.value);
    this.workbench.canQuoteMain=()=>this.isChatOpen&&!this.busy&&this.state?.capabilities?.send!==false;
    this.workbench.revealMainComposer=()=>this.collapseComposer(false);
    this.workbench.loadReferences=(kind,options)=>this.loadReferences(kind,{...options,target:{...options.target,provider:this.provider,sid:options.target.sideId||options.target.sid||this.sid,pageUrl:location.href}});
    this.listMenu=new ChatContextMenu(this.rowsRoot,target=>this.harnessActions(target));
    if(typeof SelectedTextAction==='function'){
      this.selectionButton=this.button('选区操作',()=>{});this.selectionButton.className='tool-button';this.tools.insertBefore(this.selectionButton,this.composerToggle);
      this.selectionAction=new SelectedTextAction(this.workbench.mainPane,{available:()=>this.isChatOpen&&!this.workbench.isFileVisible,context:()=>this.provider+':'+this.sid,trigger:this.selectionButton,canAdd:()=>this.workbench.selectionTargets.available(),canExplain:()=>false,add:text=>this.workbench.selectionTargets.addText(text),openMenu:snapshot=>this.selectionAction.activate('add',snapshot.token)});
    }
    if(typeof bindListActions==='function'){
      // Replace the existing action menu's content through its shared provider callback.
      this.listActions=()=>[...(this.provider==='deepseek'&&this.harnessCapabilities?.sidebar===true?[{label:'新建项目',run:()=>this.newHarnessProject()},{label:'新建分区',run:()=>this.editHarnessTitle('新建分区','',title=>this.manageHarness({operation:'section-create',title},null))}]:[]),{label:'折叠所有',run:()=>this.collapseGroups()}];
    }
    document.addEventListener('bridge-language',()=>this.relabel());const resume=()=>{clearTimeout(this.timer);if(document.hidden)this.listSync.reset();else{this.prefetchLists();if(this.provider!=='codex')this.refresh();}};document.addEventListener('visibilitychange',resume);window.addEventListener('focus',resume);
    this.appearanceObserver=new MutationObserver(()=>{this.renderMessages(this.lastMessages||[]);this.workbench.setThumbnails(document.documentElement.dataset.showFileThumbnails==='true');});this.appearanceObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-show-reasoning','data-show-process','data-show-file-thumbnails']});
    const listRegion=this.node('div','session-list-region');this.listHint=this.button('',()=>{});this.listHint.className='list-sync';this.listHint.hidden=true;this.listHint.setAttribute('aria-live','polite');listRegion.append(this.rowsRoot,this.listHint);this.list.append(listRegion);
    this.listSync=new ListSync({root:this.rowsRoot,status:this.listHint,refresh:()=>this.refreshList(),visible:()=>!this.root.hidden&&!this.container.hidden&&this.list.getBoundingClientRect().width>0,ready:()=>document.activeElement!==this.search,automatic:false});
    this.updateComposer();
  }
  node(tag,cls='',text){const n=document.createElement(tag);n.className=cls;if(text!==undefined)n.textContent=text;return n;}
  translated(tag,text,cls=''){const node=this.node(tag,cls,BridgeI18n.t(text));node.dataset.i18n=text;return node;}
  label(node,text){node.dataset.i18nAriaLabel=text;node.setAttribute('aria-label',BridgeI18n.t(text));}
  button(text,fn){const n=this.translated('button',text,'plain');n.type='button';n.onclick=async()=>{try{return await fn();}catch(e){this.notify(BridgeI18n.t(e.message));}};return n;}
  iconButton(text,path,fn){const button=this.button('',fn);button.className='icon-button';this.label(button,text);button.title=BridgeI18n.t(text);const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','header-icon');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');const shape=document.createElementNS(svg.namespaceURI,'path');shape.setAttribute('d',path);svg.append(shape);button.append(svg);return button;}
  path(action,sid=this.sid,provider=this.provider){const path='/api/desktop-sessions/'+provider+'/'+action+(sid?'?sessionId='+encodeURIComponent(sid):'');return window.BridgeRelayURL?.(path)||path;}
  sharedRead(provider,action,sid=null){
    const epoch=this.readEpoch,version=this.providerReadEpochs.get(provider)||0,key=JSON.stringify([provider,action,sid,epoch,version]);
    if(this.readTasks.has(key))return this.readTasks.get(key);
    const task={current:()=>epoch===this.readEpoch&&version===(this.providerReadEpochs.get(provider)||0)};
    task.promise=(async()=>{const value=await this.request(this.path(action,sid,provider));if(task.current()){
      if(action==='list')this.providerViews.set(provider,{...this.providerViews.get(provider),rows:value.sessions||[],projects:value.projects||[],sidebar:value.sidebar,capabilities:value.capabilities,cachedAt:Date.now()});
      else if(action==='detail'&&value.session)this.cacheDetail(JSON.stringify([provider,sid]),value);
    }return value;})();this.readTasks.set(key,task);
    const done=()=>{if(this.readTasks.get(key)===task)this.readTasks.delete(key);};task.promise.then(done,done);return task;
  }
  forgetDetail(key){this.detailCache.delete(key);this.detailCacheBytes-=this.detailCacheSizes.get(key)||0;this.detailCacheSizes.delete(key);}
  cacheDetail(key,value){
    const bytes=JSON.stringify(value).length*2,limit=8*1024*1024;this.forgetDetail(key);if(bytes>limit)return;
    this.detailCache.set(key,value);this.detailCacheSizes.set(key,bytes);this.detailCacheBytes+=bytes;
    while(this.detailCache.size>12||this.detailCacheBytes>limit)this.forgetDetail(this.detailCache.keys().next().value);
  }
  invalidateReads(provider){
    if(provider===this.provider)this.referencePicker.close();
    this.providerReadEpochs.set(provider,(this.providerReadEpochs.get(provider)||0)+1);for(const key of this.readTasks.keys())if(JSON.parse(key)[0]===provider)this.readTasks.delete(key);
    this.listPrefetchAt.delete(provider);const saved=this.providerViews.get(provider);if(saved)saved.cachedAt=0;
    if(provider===this.provider){this.freshDetail=false;this.detailRevision++;this.loading=null;this.listSync.reset();}
  }
  prefetchLists(){
    if(document.hidden||this.root.hidden)return;
    const now=Date.now();for(const client of this.clientStates||[]){
      if(!['claude','deepseek'].includes(client.id)||client.id===this.provider||!client.enabled||!this.sourceReadable(client)||client.operationUncertain)continue;
      if(now-Math.max(this.providerViews.get(client.id)?.cachedAt||0,this.listPrefetchAt.get(client.id)||0)<30000)continue;
      this.listPrefetchAt.set(client.id,now);this.sharedRead(client.id,'list').promise.catch(()=>{});
    }
  }
  setClientStates(clients,retry,initialize,refresh,reconnect){
    for(const client of clients){const old=this.clientStates?.find(row=>row.id===client.id);if(old&&(old.enabled!==false&&client.enabled===false||this.sourceReadable(old)&&!this.sourceReadable(client)))this.invalidateReads(client.id);}
    const before=this.clientStates?.find(client=>client.id===this.provider);this.clientStates=clients;this.retryClient=retry;this.initializeClient=initialize;this.refreshClients=refresh;this.reconnectClient=reconnect;
    const selected=clients.find(client=>client.id===this.provider),cliReadable=this.provider==='claude'&&this.state?.backend==='cli'&&selected?.enabled!==false&&this.sourceReadable(selected);
    if(this.state&&!this.canMutate()&&!cliReadable)this.staleDetail();else this.updateComposer();
    const current=clients.find(client=>client.id===this.provider),wasWaiting=before&&ClientLifecycle.connection(before).waiting;
    this.prefetchLists();
    if(!this.renderConnectionStatus()&&before&&(wasWaiting||(!this.sourceReadable(before)&&this.sourceReadable(current)))){this.listStatus.textContent=this.rows.length?'':BridgeI18n.t('正在读取聊天…');return this.refresh();}
  }
  sourceReadable(client){return !!client&&(client.connected===true||client.id==='claude'&&client.cliAvailable===true);}
  renderConnectionStatus(){
    const client=this.clientStates?.find(client=>client.id===this.provider),state=client&&ClientLifecycle.connection(client);
    const failure=client?.operationFailure,uncertain=!!(client?.operationUncertain||failure?.uncertain),blocked=!!state&&!client.connected&&(state.waiting||state.action||state.retryable||state.canReconnect||!!failure);
    this.listStatus.setAttribute('aria-busy',String(!!state?.waiting));this.listStatus.classList.toggle('client-connection-waiting',!!state?.waiting);
    this.connectionRetry.hidden=!blocked||!state.retryable||uncertain;this.connectionRetry.disabled=!!this.retryingClient;
    this.connectionInitialize.hidden=!blocked||!state.canInitialize||uncertain;this.connectionInitialize.disabled=!!this.initializingClient;
    this.connectionReconnect.hidden=!blocked||!state.canReconnect||uncertain;this.connectionReconnect.disabled=!!this.reconnectingClient;this.connectionReconnect.textContent=BridgeI18n.t('重新连接 Desktop');
    this.connectionInitialize.textContent=BridgeI18n.t(state?.canReconnect?'重新初始化连接':'初始化连接');
    this.connectionNotice.hidden=!failure;this.connectionNotice.textContent=failure?BridgeI18n.t(ClientLifecycle.failureMessage(failure)):'';this.connectionRefresh.hidden=!uncertain;this.connectionRefresh.disabled=!!this.refreshingClient;
    if(blocked)this.listStatus.textContent=BridgeI18n.t(state.label)+(state.reason&&state.reason!==state.label?' · '+BridgeI18n.t(state.reason):'');
    return blocked&&!(client?.enabled!==false&&client?.cliAvailable===true&&this.provider==='claude');
  }
  get isChatOpen(){return this.provider!=='codex'&&!!this.sid&&!this.conversation.hidden;}
  saveDraft(){if(this.sid)this.drafts.set(this.provider+':'+this.sid,this.input.value);}
  showSelection(open){this.conversation.hidden=!open;this.welcome.hidden=open;this.container.classList.toggle('ds-open',open);this.root.classList.toggle('chat-open',open);document.body.classList.toggle('chat-detail',open);}
  rememberView(){
    if(this.provider==='codex')return;this.saveDraft();this.workbench.rememberScroll();this.providerViews.set(this.provider,{...this.providerViews.get(this.provider),rows:this.rows,sid:this.sid,query:this.search.value,archived:this.archived.checked,listMode:this.listMode.value,surface:this.surfaceSelection,scroll:this.rowsRoot.scrollTop});
  }
  async choose(provider){
    if(provider===this.provider)return;
    this.referencePicker.close();
    this.rememberView();this.listSync.reset();clearTimeout(this.timer);this.generation++;this.detailRevision++;this.provider=provider;this.select.value=provider;this.workbench.provider=provider;this.workbench.current=null;this.workbench.panel.hidden=true;this.workbench.tabs.replaceChildren();this.conversation.classList.remove('workbench-active','wb-split');this.sid=null;this.state=null;this.freshDetail=false;const saved=this.providerViews.get(provider);this.rows=saved?.rows||[];this.harnessProjects=saved?.projects||[];this.harnessSidebar=saved?.sidebar||{sections:[],placements:{}};if(provider==='deepseek'&&![...this.listMode.options].some(o=>o.value==='native'))this.listMode.add(new Option(BridgeI18n.t('跟随客户端'),'native'));if(provider!=='deepseek')[...this.listMode.options].find(o=>o.value==='native')?.remove();if(!saved?.listMode)this.listMode.value=provider==='deepseek'?'native':'recent';this.listStamp='';this.search.value=saved?.query||'';this.archived.checked=saved?.archived||false;if(saved?.listMode)this.listMode.value=saved.listMode;this.surfaceSelection=saved?.surface||'all';this.showSelection(false);
    this.container.hidden=provider==='codex';this.root.classList.toggle('desktop-mode',provider!=='codex');this.clientIcon.replaceChildren();if(provider!=='codex'){const img=this.node('img');img.src='/client-icons/'+provider+'.png';img.alt='';this.clientIcon.append(img);}this.clientIcon.className='client-icon client-'+provider;this.listStatus.textContent=this.rows.length?'':BridgeI18n.t('正在读取聊天…');this.renderList();this.rowsRoot.scrollTop=saved?.scroll||0;this.updateComposer();if(saved?.sid)this.prepareChat(saved.sid);this.onSelect(provider);
    this.renderConnectionStatus();if(provider!=='codex')await this.refresh();
  }
  backToList(){if(!this.isChatOpen)return false;this.referencePicker.close();this.saveDraft();this.workbench.rememberScroll();this.sid=null;this.state=null;this.freshDetail=false;this.detailRevision++;this.showSelection(false);this.renderList();this.updateComposer();this.rememberView();this.onListEnter?.();return true;}
  async accountChanged(provider,previous={},next={}){
    this.accountEpochs.set(provider,(this.accountEpochs.get(provider)||0)+1);
    this.invalidateReads(provider);
    const identity=value=>JSON.stringify([provider,[...(value.activeIds||[value.activeId].filter(Boolean))].sort()]);
    if(provider===this.provider)this.saveDraft();
    const drafts=new Map([...this.drafts].filter(([key])=>key.startsWith(provider+':')));this.accountDrafts.set(identity(previous),drafts);
    if(provider===this.provider){clearTimeout(this.timer);this.generation++;this.detailRevision++;this.sid=null;this.state=null;this.freshDetail=false;this.input.value='';}
    const jsonKey=key=>{try{return JSON.parse(key)[0]===provider;}catch{return false;}};
    this.providerViews.delete(provider);for(const key of this.drafts.keys())if(key.startsWith(provider+':'))this.drafts.delete(key);
    for(const [key,text] of this.accountDrafts.get(identity(next))||[])this.drafts.set(key,text);
    for(const key of this.detailCache.keys())if(jsonKey(key))this.forgetDetail(key);
    for(const key of this.pending.keys())if(key.startsWith(provider+':'))this.pending.delete(key);for(const key of this.sendChoices.keys())if(JSON.parse(key)[0]===provider)this.sendChoices.delete(key);
    for(const key of Object.keys(this.activity.rows))if(key.startsWith(provider+'|'))delete this.activity.rows[key];this.activity.save();
    this.workbench.reset(provider);this.workbench.fileQuotes.forget(key=>key.startsWith(provider+'|'));this.attachments.forget(jsonKey);
    if(provider!==this.provider)return;
    this.rows=[];this.listStamp='';this.lastMessages=[];this.requestStamp='';this.messageNodes.clear();this.messages.replaceChildren();this.requests.replaceChildren();this.showSelection(false);this.renderList();this.updateComposer();await this.refresh();
  }
  clear(){this.referencePicker.close();this.listSync.reset();this.readEpoch++;this.readTasks.clear();this.providerReadEpochs.clear();this.listPrefetchAt.clear();this.detailCacheSizes.clear();this.detailCacheBytes=0;this.clientStates=[];this.workbench.reset();this.workbench.fileQuotes.reset();clearTimeout(this.timer);this.generation++;this.detailRevision++;this.provider='codex';this.select.value='codex';this.select.hidden=true;this.container.hidden=true;this.root.classList.remove('desktop-mode');this.sid=null;this.state=null;this.showSelection(false);this.drafts.clear();this.accountDrafts.clear();this.providerViews.clear();this.detailCache.clear();this.activity.clear();this.freshDetail=false;this.rows=[];this.listStamp='';this.rowsRoot.replaceChildren();this.lastMessages=[];this.requestStamp='';this.pending.clear();this.sendChoices.clear();this.attachments.reset();this.messages.replaceChildren();this.requests.replaceChildren();this.messageNodes.clear();}
  async refresh(){
    clearTimeout(this.timer);const generation=this.generation,provider=this.provider;if(provider==='codex'||document.hidden||this.root.hidden)return;
    if(this.renderConnectionStatus()){this.updateActivity(this.rows,false);this.renderIndicators();this.freshDetail=false;this.updateComposer();return;}
    if(this.loading?.generation===generation)return this.loading.promise;const loading={generation};this.loading=loading;
    if(this.sid)this.detail(generation).catch(error=>{if(generation===this.generation){this.error.textContent=BridgeI18n.t(error.message);this.status.textContent=BridgeI18n.t('连接失败');}});
    loading.promise=this.refreshList().catch(()=>{}).finally(()=>{if(this.loading===loading){this.loading=null;if(generation===this.generation)this.timer=setTimeout(()=>this.refresh(),this.sid||ClientLifecycle.connection(this.clientStates?.find(client=>client.id===provider)).waiting?2000:5000);}});
    return loading.promise;
  }
  refreshList(){
    const generation=this.generation,provider=this.provider;if(provider==='codex'||document.hidden||this.root.hidden||this.renderConnectionStatus())return Promise.resolve(false);
    const task=this.sharedRead(provider,'list');if(this.listRead?.task===task&&this.listRead.generation===generation)return this.listRead.promise;
    const reading={task,generation};this.listRead=reading;
    reading.promise=(async()=>{
      try{const value=await task.promise;if(!task.current()||generation!==this.generation)return false;this.rows=value.sessions||[];this.harnessProjects=value.projects||[];this.harnessSidebar=value.sidebar||{sections:[],placements:{}};this.harnessCapabilities=value.capabilities||{};this.updateActivity(this.rows,value.connected!==false);this.listStatus.textContent=value.connected===false?BridgeI18n.t('尚未连接'):this.rows.length?'':BridgeI18n.t('电脑上还没有聊天');this.renderConnectionStatus();this.renderList();this.rememberView();this.onListReady?.(provider,value);if(value.connected===false)throw Error(BridgeI18n.t('尚未连接'));this.listSync.acknowledgeSuccess();return true;}
      catch(error){if(!task.current()||generation!==this.generation)return false;this.updateActivity(this.rows,false);this.renderIndicators();if(!this.renderConnectionStatus()){this.listStatus.textContent=this.rows.length?'':BridgeI18n.t(error.message);if(!this.listSync.busy)this.listSync.reportFailure(error);}if(this.sid&&!this.state)this.error.textContent=BridgeI18n.t(error.message);throw error;}
      finally{if(this.listRead===reading)this.listRead=null;}
    })();return reading.promise;
  }
  visibleActivity(){return this.isChatOpen&&!this.root.hidden&&!this.container.hidden&&!document.hidden&&!this.workbench.isFileVisible?this.provider+'|'+this.sid:null;}
  async syncDesktopRead(key,row){
    const split=key.indexOf('|'),provider=key.slice(0,split),sessionId=key.slice(split+1);if(provider!=='deepseek')return;
    try{const value=await this.request(this.path('read-state',sessionId,provider),{id:this.requestId(),sessionId,turnId:row.turnId,turnStatus:row.turnStatus});if(['unknown','unsupported'].includes(value.status))this.notify(BridgeI18n.t(value.message||'桌面已读状态尚未同步'));}catch(error){this.notify(BridgeI18n.t(error.message));}
  }
  updateActivity(rows,connected=true,sync=false){this.activity.update(rows.map(row=>({id:row.id,host:this.provider,connected,status:row.status,runningSubagents:row.childActive||0,turnId:row.turnId,turnStatus:row.turnStatus})),this.visibleActivity(),{sync});}
  renderIndicators(){
    const rows=new Map(this.rows.map(row=>[row.id,row]));for(const button of this.rowsRoot.querySelectorAll('.session')){button.querySelector('.session-indicator')?.remove();const row=this.freshDetail&&button.dataset.id===this.sid?this.state:rows.get(button.dataset.id),indicator=row?.requests?.length?(this.activity.rows[this.provider+'|'+button.dataset.id]?.offline?{kind:'unknown',label:'运行状态暂不可用'}:{kind:'awaiting',label:'等待回应'}):this.activity.indicator(this.provider+'|'+button.dataset.id);if(indicator){const dot=this.node('span','session-indicator '+indicator.kind);dot.title=BridgeI18n.t(indicator.label);dot.setAttribute('aria-label',BridgeI18n.t(indicator.label));button.querySelector('strong')?.prepend(dot);}}
  }
  renderList(){
    if(this.provider==='deepseek'&&this.listMode.value==='native')return this.renderHarnessList();
    const types=new Set(this.provider==='claude'?(this.rows||[]).map(row=>row.backend).filter(kind=>['code','cowork','cli'].includes(kind)):[]),showTypes=types.size>1,selected=showTypes&&types.has(this.surfaceSelection)?this.surfaceSelection:'all';this.surfaceSelection=selected;const optionStamp=JSON.stringify([BridgeI18n.language(),...['code','cowork','cli'].filter(kind=>types.has(kind))]);if(optionStamp!==this.surfaceOptionsStamp){this.surface.replaceChildren(new Option(BridgeI18n.t('全部会话'),'all'),...['code','cowork','cli'].filter(kind=>types.has(kind)).map(kind=>new Option(kind==='cli'?'CLI':kind==='cowork'?'Cowork':'Code',kind)));this.surfaceOptionsStamp=optionStamp;}if(this.surface.value!==selected)this.surface.value=selected;this.surface.hidden=!showTypes;
    const query=this.search.value.trim().toLowerCase();const stamp=JSON.stringify([this.provider,this.sid,query,this.archived.checked,this.listMode.value,selected,showTypes,this.rows,BridgeI18n.language()]);if(stamp===this.listStamp){this.renderIndicators();return;}this.listStamp=stamp;const scroll=this.rowsRoot.scrollTop,top=this.rowsRoot.getBoundingClientRect().top,anchor=scroll>0?[...this.rowsRoot.querySelectorAll('.session')].find(node=>node.getBoundingClientRect().bottom>top):null,offset=anchor?anchor.getBoundingClientRect().top-top:0;this.rowsRoot.replaceChildren();
    const timestamp=value=>{const raw=Number(value||0);return raw<1e12?raw*1000:raw;};
    const rows=(this.rows||[]).filter(row=>(selected==='all'||row.backend===selected)&&(this.archived.checked||!row.archived)&&((row.title||'')+' '+(row.cwd||'')).toLowerCase().includes(query)).sort((a,b)=>timestamp(b.updatedAt)-timestamp(a.updatedAt));
    const groups=new Map();for(const row of rows){const key=this.listMode.value==='project'?row.cwd||BridgeI18n.t('电脑上的聊天'):'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
    for(const [name,items] of groups){let target=this.rowsRoot;if(name){const group=this.node('details','project-group ds-session-group'),key=JSON.stringify([this.provider,this.listMode.value,name]);group.open=!this.collapsedGroups.has(key);group.ontoggle=()=>{if(!group.isConnected)return;if(group.open)this.collapsedGroups.delete(key);else this.collapsedGroups.add(key);try{localStorage.setItem('bridge-desktop-session-groups',JSON.stringify([...this.collapsedGroups]));}catch{}};group.append(this.node('summary','',name));this.rowsRoot.append(group);target=group;}
      for(const row of items){const button=this.button('',()=>this.open(row.id));button.className='session ds-session-row'+(row.id===this.sid?' selected':'');button.dataset.id=row.id;button.dataset.provider=this.provider;const meta=this.node('small'),location=this.node('span','',row.cwd||''),time=this.node('time');if(row.updatedAt){const date=new Date(timestamp(row.updatedAt));if(Number.isFinite(date.getTime()))time.textContent=date.toLocaleDateString(BridgeI18n.locale(),{month:'numeric',day:'numeric'});}meta.append(location,time);button.append(this.node('strong','',row.title||BridgeI18n.t('新会话')));{const kind=this.node('span','ds-session-type',this.provider==='claude'?({code:'Code',cowork:'Cowork',cli:'CLI'}[row.backend]||BridgeI18n.t('其他来源')):'APP');kind.setAttribute('aria-label',BridgeI18n.t('会话类型')+': '+kind.textContent);button.append(kind);}button.append(meta);target.append(button);}
    }
    if(!rows.length&&this.rows.length)this.rowsRoot.append(this.translated('p','没有匹配的聊天','muted ds-list-empty'));this.rowsRoot.scrollTop=scroll;if(anchor){const next=[...this.rowsRoot.querySelectorAll('.session')].find(node=>node.dataset.id===anchor.dataset.id);if(next)this.rowsRoot.scrollTop+=next.getBoundingClientRect().top-this.rowsRoot.getBoundingClientRect().top-offset;}this.renderIndicators();
  }
  prepareChat(sid){
    this.referencePicker.close();
    this.workModes.open(JSON.stringify([this.provider,sid]));
    this.saveDraft();this.sid=sid;this.state=null;this.freshDetail=false;this.detailRevision++;const row=this.rows.find(r=>r.id===sid);this.title.textContent=row?.title||BridgeI18n.t('正在读取聊天…');this.status.textContent=BridgeI18n.t('正在连接…');this.input.value=this.drafts.get(this.provider+':'+sid)||'';this.requestStamp='';this.error.textContent='';this.notice.hidden=true;this.messages.replaceChildren(this.translated('p','正在读取聊天…','muted'));this.messageNodes.clear();this.lastMessages=[];this.requests.replaceChildren();this.showSelection(true);this.attachments.open(JSON.stringify([this.provider,sid]));this.workbench.open(sid,'local');const cached=this.detailCache.get(JSON.stringify([this.provider,sid]));if(cached){this.applyDetail(cached,true);this.messages.scrollTop=this.workbench.current.scroll||0;}this.activity.read(this.provider+'|'+sid,{explicit:true,sync:false});this.updateComposer();this.renderList();this.resizeInput();this.rememberView();
  }
  async open(sid){
    const generation=this.generation;this.prepareChat(sid);
    try{await this.detail(generation);}catch(error){if(generation===this.generation&&sid===this.sid){this.error.textContent=BridgeI18n.t(error.message);this.status.textContent=BridgeI18n.t('连接失败');this.updateComposer();}}
  }
  async detail(generation){
    const sid=this.sid,provider=this.provider,revision=this.detailRevision,task=this.sharedRead(provider,'detail',sid),current=()=>task.current()&&generation===this.generation&&provider===this.provider&&sid===this.sid&&revision===this.detailRevision;let value;
    try{value=await task.promise;}catch(error){if(current()){this.staleDetail();throw error;}return;}if(!current())return;this.applyDetail(value);
  }
  canMutate(){const client=this.clientStates?.find(row=>row.id===this.provider);if(!this.state||!this.freshDetail||client?.enabled===false)return false;if(this.provider==='claude'&&this.state.backend==='cli')return ['ready','active','awaiting'].includes(this.state.connectionState);return !client||client.connected===true;}
  canResume(){const client=this.clientStates?.find(row=>row.id===this.provider);return this.provider==='claude'&&this.state?.backend==='cli'&&this.freshDetail&&client?.enabled!==false&&this.state.capabilities?.resume===true;}
  staleDetail(){this.freshDetail=false;this.renderRequests([]);this.requestStamp='';this.updateComposer();}
  applyDetail(value,cached=false){
    if(!value.session){this.staleDetail();this.status.textContent=BridgeI18n.t('尚未连接');return;}
    const workspace=this.workbench.current;if(workspace?.id===this.sid&&workspace.provider===this.provider){const before=workspace.access?.canUseSideChat;workspace.cwd=value.session.cwd||'';workspace.access={canUseSideChat:!cached&&value.capabilities?.sideChat===true};if(!cached&&workspace.access.canUseSideChat&&!before)this.workbench.refreshSideChats();}
    this.freshDetail=!cached&&value.connected!==false;this.state={...value.session,capabilities:value.capabilities||value.session.capabilities||{},maxRequestBytes:value.maxRequestBytes||value.session.maxRequestBytes||0};this.title.textContent=this.state.title;this.status.textContent=BridgeI18n.t(cached?'正在连接…':!this.canMutate()?(this.state.backend==='cli'?'历史记录':'尚未连接'):this.state.requests?.length?'等待回应':this.state.status==='active'?'运行中':'已连接');this.updateComposer();this.sessionFiles=value.files||[];this.renderMessages(value.messages||[]);
    const requests=this.canMutate()?this.state.requests||[]:[],stamp=JSON.stringify([requests,BridgeI18n.language()]);if(stamp!==this.requestStamp){this.renderRequests(requests);this.requestStamp=stamp;}
    this.detailNotice=value.notice||'';this.renderNotice();if(!cached){const last=value.turns?.at(-1);this.updateActivity([{...this.state,...last?{turnId:last.turnId,turnStatus:last.status}:{}}],value.connected!==false,true);}this.renderIndicators();
  }
  renderNotice(){const resumable=this.canResume();this.notice.textContent=BridgeI18n.t(this.detailNotice||(resumable?'可先阅读聊天历史；继续时将恢复原 Claude Code 会话。':''));this.notice.hidden=!this.detailNotice&&!resumable;if(resumable)this.notice.append(this.resumeButton);}
  updateComposer(){
    const state=this.state,caps=state?.capabilities||{},active=state?.status==='active',ready=this.canMutate();this.modelName.textContent=state?.model||BridgeI18n.t('模型');delete this.modelName.dataset.i18n;this.modelEffort.textContent=state?.effort?'· '+state.effort:'';this.modelEffort.hidden=!state?.effort;this.modelButton.title=[state?.model||BridgeI18n.t('模型'),state?.effort].filter(Boolean).join(' · ');this.modelButton.disabled=!ready||!!this.busy||caps.models===false;
    const permission=state?.permissionLabel||({'default':'默认权限','acceptEdits':'允许文件编辑','plan':'计划模式','bypassPermissions':'完全访问'}[state?.permissionMode])||state?.permissionMode||'权限';this.permissionsButton.textContent=BridgeI18n.t(permission);this.permissionsButton.dataset.i18n=permission;this.renderContext();
    this.resumeButton.textContent=BridgeI18n.t('继续会话');this.resumeButton.hidden=!this.canResume();this.resumeButton.disabled=!!this.busy||!this.canResume();
    const canAttach=caps.attachments===true;this.attachmentInput.accept=this.provider==='claude'&&state?.backend==='cli'?'':'image/png,image/jpeg,image/gif,image/webp';this.attachButton.hidden=!canAttach;this.form.classList.toggle('ds-has-attachments',canAttach);if(this.attachments){const locked=!ready||!!this.busy||!canAttach;if(this.attachments.locked!==locked)this.attachments.setLocked(locked);this.attachmentList.hidden=!canAttach||(!this.attachments.rows.length&&!this.attachments.error);}
    this.attachButton.title=BridgeI18n.t('添加文件或图片')+(state?.maxRequestBytes?' · '+BridgeI18n.t('消息和图片编码后合计最多 10 MiB'):'');this.referenceButton.disabled=!this.referenceContext();this.referenceButton.title=BridgeI18n.t('添加引用');
    this.send.disabled=!ready||!!this.busy||caps.send===false||(canAttach&&(!this.attachments.ready()||this.overRequestLimit(this.attachments.rows)));this.stop.disabled=!ready||!active||!!this.busy;this.stop.hidden=!active||caps.stop===false;this.permissionsButton.hidden=caps.permissions!==true;this.permissionsButton.disabled=!ready||!!this.busy;this.mode.disabled=!ready||!!this.busy;
    this.mode.options[1].disabled=caps.queue===false;if(this.mode.options[1].disabled&&this.mode.value==='queue')this.mode.value='send';const steer=this.mode.options[2];steer.disabled=!active||caps.steer===false;if(steer.disabled&&this.mode.value==='steer')this.mode.value='send';
    const harness=this.provider==='deepseek';this.workMode.hidden=!harness;this.form.classList.toggle('ds-work-modes',harness);
    this.workModes.render(harness&&state?{...state,host:'local',loadingHistory:!ready,workModesLocked:active,goalRuntimeAvailable:ready&&caps.goal===true,goalUnavailableReason:'当前 Harness 会话不支持目标模式，请更新接入或检查智能体配置'}:null,this.mode.value,this.busy);
    this.workMode.disabled=this.workMode.disabled||active;this.workMode.options[1].disabled=caps.workModes!==true;this.workMode.options[1].title=BridgeI18n.t(caps.workModes===true?'':'当前 Harness 会话不支持计划模式，请更新接入或检查智能体配置');
    if(caps.workModes!==true&&this.workMode.value==='plan')this.workMode.value='default';
    if(!harness){this.goalRoot.hidden=true;this.goalToggle.hidden=true;this.modeHint.hidden=true;}
  }
  renderContext(){
    const usage=this.state?.contextUsage,used=usage?.usedTokens,limit=usage?.contextWindow;
    const known=Number.isFinite(used)&&used>=0&&Number.isFinite(limit)&&limit>0,percent=known?Math.round(used/limit*100):null;
    this.contextButton.hidden=!this.state;this.contextRing.style.setProperty('--context-percent',known?Math.min(100,percent)+'%':'0%');this.contextRing.classList.toggle('unknown',!known);
    this.contextButton.title=BridgeI18n.t('上下文使用量')+' · '+(known?percent+'%':BridgeI18n.t('暂未提供'));this.contextButton.setAttribute('aria-label',this.contextButton.title);
  }
  contextDetails(){
    if(!this.state)return;const dialog=this.dialog('上下文使用量'),usage=this.state.contextUsage;
    const number=value=>Number.isFinite(value)&&value>=0?value.toLocaleString(BridgeI18n.locale()):BridgeI18n.t('暂未提供');
    if(!usage)dialog.append(this.translated('p',this.state.contextUsageStatus==='unsupported'?'当前客户端或会话模式未提供上下文用量接口。':this.state.contextUsageStatus==='unavailable'?'当前会话尚未提供上下文用量；有可用数据时会自动更新。':'当前客户端尚未提供此会话的上下文用量。','muted'));
    else {for(const [label,key] of [[usage.measurement==='lastPrompt'?'最近一次模型输入':'已用 Token','usedTokens'],['上下文容量','contextWindow']])dialog.append(this.node('p','',BridgeI18n.t(label)+' · '+number(usage[key])));
      if(usage.contextWindow>0&&Number.isFinite(usage.usedTokens))dialog.append(this.node('p','',BridgeI18n.t('使用占比')+' · '+(usage.usedTokens/usage.contextWindow*100).toFixed(1)+'%'));
      if(usage.model)dialog.append(this.node('p','',BridgeI18n.t('模型')+' · '+usage.model));
      if(usage.compacted)dialog.append(this.translated('p','最近一次压缩后统计。','muted'));
      if(usage.measurement==='lastPrompt')dialog.append(this.translated('p','统计最近一次请求的输入与缓存 Token；不包含尚未发送的内容。','muted'));
      if(usage.estimated)dialog.append(this.translated('p','包含客户端对尚未发送内容的估算。','muted'));
      if(!this.freshDetail)dialog.append(this.translated('p','当前为缓存数据，连接恢复后更新。','muted'));
    }dialog.showModal();
  }
  resizeInput(){if(this.composerBody.hidden)return;this.input.style.height='auto';this.input.style.height=Math.min(160,Math.max(48,this.input.scrollHeight||48))+'px';}
  collapseComposer(value){this.composerBody.hidden=value;this.form.classList.toggle('is-collapsed',value);this.composerToggle.setAttribute('aria-expanded',String(!value));this.label(this.composerToggle,value?'展开输入区':'收起输入区');this.composerToggle.title=BridgeI18n.t(value?'展开输入区':'收起输入区');if(!value)this.resizeInput();}
  renderMessages(messages){
    this.lastMessages=messages;const atBottom=this.messages.scrollHeight-this.messages.scrollTop-this.messages.clientHeight<100,top=this.messages.scrollTop,nodes=[],next=new Map();
    for(const [index,message] of messages.entries()){
      const key=String(message.id??index),stamp=JSON.stringify([message,BridgeI18n.language(),this.sessionFiles]);const prior=this.messageNodes.get(key);let node=prior?.stamp===stamp?prior.node:null;
      if(!node){const activity=['activity','reasoning'].includes(message.role);node=this.node(activity?'details':'article',activity?'activity timeline-row':'message timeline-row '+message.role);if(activity){node.open=!!prior?.node.open;node.append(this.node('summary','',BridgeI18n.t(message.title||(message.role==='reasoning'?'思考摘要':'执行过程'))));node.append(this.node('pre','activity-body',message.text||''));}
        else{const who=message.role==='user'?BridgeI18n.t('你'):message.role==='error'?BridgeI18n.t('执行错误'):[this.provider==='claude'?'Claude':'DeepSeek',message.model&&[message.model,message.effort].filter(Boolean).join(' ')].filter(Boolean).join(' · ');node.append(this.node('span','who',who));const body=this.node('div','message-body');renderMarkdown(body,message.text||'',this.sessionFiles||[],file=>this.workbench.url(this.workbench.current,'download',file.path));node.append(body);const actions=this.node('div','message-actions');const copy=this.button('复制',()=>window.BridgeClipboard.copy(async()=>message.text||'',copy));copy.classList.add('message-copy');actions.append(copy,this.button('引用',()=>{this.workbench.selectionTargets.addText(message.text||'');}));node.append(actions);}
      }
      node.hidden=message.role==='reasoning'?(document.documentElement.dataset.showProcess==='false'||document.documentElement.dataset.showReasoning==='false'):message.role==='activity'&&document.documentElement.dataset.showProcess==='false';next.set(key,{stamp,node});nodes.push(node);
    }
    this.messageNodes=next;
    const scope=JSON.stringify([this.provider,this.sid]);if(scope!==this.messageGroupScope){this.messageGroupScope=scope;this.messageGroups=new ChatMessageGroups(this.messages,(...args)=>this.node(...args));}
    this.messageGroups.render(messages.map((message,index)=>({key:String(message.id??index),node:nodes[index],message,turnId:message.turnId,turnStatus:message.turnStatus})),{showProcess:document.documentElement.dataset.showProcess!=='false'});
    if(!nodes.length&&this.state)this.messages.append(this.translated('p','这条聊天还没有消息','muted ds-history-empty'));if(atBottom)this.messages.scrollTop=this.messages.scrollHeight;else this.messages.scrollTop=top;
  }
  renderRequests(requests){const saved=new Map([...this.requests.children].map(form=>[form.dataset.requestKey,new Map((form.answerInputs||[]).map(({key,signature,area,custom})=>[signature||key,{values:[...area.querySelectorAll('input:checked')].map(n=>n.value),custom:custom.value}]))]));this.requests.replaceChildren();for(const request of requests){const sid=this.sid,generation=this.generation,form=this.node('form','approval');form.dataset.requestKey=JSON.stringify([this.provider,sid,request.id]);const answers=saved.get(form.dataset.requestKey);form.append(this.node('strong','',BridgeI18n.t(request.tool||'等待确认')));const inputs=[];
    if(request.needsInput){for(const [i,q] of (request.input?.questions||[]).entries()){const key=String(q.id||q.question||i);const label=this.node('fieldset','ds-question');label.dataset.answerKey=JSON.stringify([key,q]);label.append(this.node('legend','',q.question||q.header||BridgeI18n.t('问题')));const area=this.node('div');for(const option of q.options||[]){const line=this.node('label','ds-answer-option');const check=this.node('input');check.type=q.multiSelect?'checkbox':'radio';check.name='q'+i;check.value=option.label;check.checked=answers?.get(JSON.stringify([key,q]))?.values.includes(option.label)||false;line.append(check,document.createTextNode(option.label+(option.description?' — '+option.description:'')));area.append(line);}const custom=this.node('input');custom.value=answers?.get(JSON.stringify([key,q]))?.custom||'';custom.placeholder=BridgeI18n.t('补充回答');this.label(custom,'补充回答');label.append(area,custom);form.append(label);inputs.push({key,signature:JSON.stringify([key,q]),area,custom});}}
    else form.append(this.node('pre','',JSON.stringify(request.input||{},null,2)));
    form.answerInputs=inputs;const accept=this.button(request.needsInput?'提交回答':'允许本次',()=>{});accept.type='submit';form.append(accept);
    // Harness question events have no denial vocabulary; never invent a response.
    if(!request.needsInput||this.provider==='claude')form.append(this.button('拒绝',()=>{if(this.freshDetail&&sid===this.sid&&generation===this.generation)return this.mutate('respond',{requestId:request.id,decision:'decline'});}));
    form.onsubmit=event=>{event.preventDefault();if(!this.freshDetail||sid!==this.sid||generation!==this.generation)return;const answers={};for(const {key,area,custom} of inputs){const values=[...area.querySelectorAll('input:checked')].map(n=>n.value);if(custom.value.trim())values.push(custom.value.trim());if(!values.length){this.notify(BridgeI18n.t('请回答每一项问题'));return;}answers[key]={answers:values};}accept.disabled=true;this.mutate('respond',{requestId:request.id,decision:'accept',answers}).finally(()=>accept.disabled=false);};this.requests.append(form);window.AnswerDrafts?.bind(form,{scope:[this.provider,'local','main',sid,request.tool||'',request.id],request:this.request});
  }}
  requestId(){if(typeof uuid==='function')return uuid();if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const h=[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
  async mutate(action,body,sessionId=action==='create'?null:this.sid){
    if(this.busy||action!=='manage'&&sessionId&&(!(action==='resume'?this.canResume():this.canMutate())||sessionId!==this.sid))return null;const provider=this.provider,generation=this.generation,key=provider+':'+sessionId+':'+action+':'+JSON.stringify(body);this.invalidateReads(provider);const epoch=this.readEpoch,providerEpoch=this.providerReadEpochs.get(provider),currentWrite=()=>epoch===this.readEpoch&&providerEpoch===this.providerReadEpochs.get(provider);this.busy=true;this.error.textContent='';this.updateComposer();
    try{let id=this.pending.get(key);if(!id){id=this.requestId();this.pending.set(key,id);}const result=await this.request(this.path(action,null,provider),{...body,id,sessionId});if(action==='resume'&&result.status==='blocked')this.pending.delete(key);if(!['accepted','queued','ready'].includes(result.status))throw Error(result.message||'结果待核对，请检查桌面原会话');this.pending.delete(key);if(action==='access'&&result.mode&&provider===this.provider&&sessionId===this.sid&&generation===this.generation&&currentWrite()&&this.state){this.state.permissionMode=result.mode;const option=result.options?.find(row=>(row.value??row.id)===result.mode);this.state.permissionLabel=option?.label||option?.name||null;}return result;}
    catch(error){if(generation===this.generation&&sessionId===this.sid)this.error.textContent=BridgeI18n.t(error.message);this.notify(BridgeI18n.t(error.message));return null;}
    finally{const current=currentWrite();if(current)this.invalidateReads(provider);this.busy=false;this.updateComposer();if(current&&provider===this.provider)this.refresh();}
  }
  attachmentUrl(key,id,action){const [provider,sid]=JSON.parse(key);return this.path('uploads/'+encodeURIComponent(id)+'/'+action,sid,provider);}
  async uploadBinary(url,data,type){const response=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':type||'application/octet-stream','X-CSRF-Token':this.csrf()},body:data});const result=await response.json();if(!response.ok){if(response.status===401)this.onUnauthorized();throw Error(result.error||BridgeI18n.t('附件上传失败，请重试'));}return result;}
  uploadAttachment(key,id,file){const [provider,sid]=JSON.parse(key);return this.uploadBinary(this.path('uploads',sid,provider)+'&id='+encodeURIComponent(id)+'&name='+encodeURIComponent(file.name),file,'application/octet-stream');}
  requestLimitMessage(){return 'Claude 单次消息与图片编码后不能超过 10 MiB，请减少附件';}
  overRequestLimit(rows){const limit=this.state?.maxRequestBytes;if(!limit)return false;return rows.reduce((total,row)=>total+Math.ceil(row.size/3)*4,0)+new TextEncoder().encode(JSON.stringify(this.workbench.fileQuotes.text())).length>limit;}
  referenceContext(){
    if(!this.isChatOpen||!this.state||this.busy)return null;
    const {cwd='',backend='',host='local'}=this.state;
    return {key:JSON.stringify([this.provider,this.sid,this.generation,this.readEpoch,this.providerReadEpochs.get(this.provider)||0,cwd,host]),provider:this.provider,sid:this.sid,cwd,backend,host,pageUrl:location.href,canSkills:this.state.capabilities?.skills===true};
  }
  async loadReferences(kind,{target,query='',offset=0,path='',hidden=false,signal}){
    const page=(items,extra={})=>({items:items.slice(offset,offset+200),nextOffset:items.length>offset+200?offset+200:null,...extra});
    const matches=(...values)=>values.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    if(kind==='skills'){
      if(!target.canSkills)return {items:[],nextOffset:null,notice:'当前客户端或会话未提供可用技能目录'};
      const catalog=await this.request(this.path('catalog',target.sid,target.provider),undefined,signal);
      return page((catalog.skills||[]).filter(skill=>matches(skill.displayName,skill.name,skill.id,skill.description)).map(skill=>{const item=globalThis.ChatReferencePicker.skillItem(skill);return {...item,description:[item.description,skill.kind==='plugin'?BridgeI18n.t('插件')+' · '+BridgeI18n.t(skill.status||'只读'):''].filter(Boolean).join(' · '),disabled:item.disabled||skill.kind==='plugin'||catalog.capabilities?.skills===false};}),{notice:catalog.notice,error:catalog.pluginError});
    }
    if(kind==='files'){
      if(target.host!=='local')return {items:[],nextOffset:null,error:'当前客户端的项目文件接口暂不支持 SSH 目录'};
      const url=this.path('workspace',target.sid,target.provider)+'&path='+encodeURIComponent(path)+'&hidden='+hidden+'&search='+encodeURIComponent(query)+'&offset='+offset+(query.trim()?'&recursive=true':'');
      const result=await this.request(url,undefined,signal),value=globalThis.ChatReferencePicker.fileItems(result);
      return {...value,notice:[value.notice,result.notice].filter(Boolean).join(' '),error:result.error||(!result.root?'当前会话未提供可访问的项目完整目录':'')};
    }
    if(kind==='sessions'){
      const result=await this.request(this.path('list',null,target.provider),undefined,signal),base=new URL(target.pageUrl);
      if(!['http:','https:'].includes(base.protocol))return {items:[],nextOffset:null,error:'当前页面未提供可用的会话链接'};
      base.search='';base.hash='';
      const rows=(result.sessions||[]).map(row=>{
        const host=row.host||'local',cwd=row.cwd||'',project=cwd.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||BridgeI18n.t('电脑上的聊天');
        const groups=[{id:'section:'+host,title:BridgeI18n.t('默认分区')+(host!=='local'?' · '+(row.hostLabel||host):'')},{id:'project:'+JSON.stringify([host,cwd]),title:project}];
        const url=new URL(base.href);url.hash=encodeURIComponent(row.id).replace(/~/g,'%7E')+'~'+encodeURIComponent('desktop:'+target.provider);
        return {id:row.id,title:row.title||BridgeI18n.t('新会话'),description:[cwd,row.hostLabel,row.backend==='cli'?'CLI':row.backend].filter(Boolean).join(' · '),value:url.href,groups};
      }).filter(item=>matches(item.title,item.description,...item.groups.map(group=>group.title)));
      return page(rows,{notice:['当前客户端未提供原生会话链接，引用使用本页面的会话链接。',result.notice].filter(Boolean).join(' '),error:result.connected===false?'尚未连接':result.error});
    }
    return {items:[],nextOffset:null};
  }
  async submit(){
    const raw=this.input.value,quotes=this.workbench.fileQuotes,quoteKey=quotes.key,quoteIds=quotes.rows.map(row=>row.id),ids=this.state?.capabilities?.attachments===true?this.attachments.ids():[];
    let text;try{text=quotes.validate().trim();}catch(error){this.error.textContent=error.message;return;}
    if((!text&&!ids.length)||!this.sid||!this.state||!this.freshDetail||this.busy||this.state.capabilities.send===false||ids.length&&!this.attachments.ready())return;
    if(this.overRequestLimit(ids.length?this.attachments.rows:[])){this.error.textContent=BridgeI18n.t(this.requestLimitMessage());return;}
    const sid=this.sid,provider=this.provider,key=JSON.stringify([provider,sid]),epoch=this.readEpoch,accountEpoch=this.accountEpochs.get(provider)||0;const choiceKey=JSON.stringify([provider,sid,text,ids]),choice=this.sendChoices.get(choiceKey);let mode=choice?.mode||this.mode.value,workMode=choice?choice.workMode:this.workModes.value(mode);
    if(provider==='deepseek'&&!this.sendChoices.has(choiceKey)&&this.state.status==='active'&&mode==='send'){
      mode=await this.runningSendChoice();if(!mode||provider!==this.provider||sid!==this.sid||epoch!==this.readEpoch||accountEpoch!==(this.accountEpochs.get(provider)||0))return;
    }
    if(mode==='steer'||!choice&&this.state.status==='active')workMode=null;if(provider==='deepseek')this.sendChoices.set(choiceKey,{mode,workMode});const body={text,mode};if(provider==='deepseek'&&workMode)body.workMode=workMode;if(ids.length)body.attachments=ids;const result=await this.mutate('send',body);
    if(result&&provider==='deepseek')this.workModes.submitted(key,workMode);
    if(result)this.sendChoices.delete(choiceKey);if(result&&epoch===this.readEpoch&&accountEpoch===(this.accountEpochs.get(provider)||0)){this.attachments.clear(key,ids);quotes.clear(quoteKey,quoteIds);if(sid===this.sid&&provider===this.provider&&this.input.value===raw){this.input.value='';this.resizeInput();this.drafts.delete(provider+':'+sid);}this.updateComposer();}
  }
  runningSendChoice(){
    if(this.sendChoice?.open)return Promise.resolve(null);
    return new Promise(resolve=>{const dialog=this.sendChoice=this.dialog('当前任务正在运行'),finish=value=>{if(this.sendChoice===dialog)this.sendChoice=null;resolve(value);dialog.close();};dialog.append(this.translated('p','请选择这条消息的发送方式。'),this.button('完成后发送',()=>finish('queue')),this.button('补充当前任务',()=>finish('steer')));const cancel=this.button('取消',()=>finish(null));dialog.append(cancel);dialog.addEventListener('close',()=>{if(this.sendChoice===dialog)this.sendChoice=null;resolve(null);},{once:true});dialog.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();finish(null);}});dialog.showModal();cancel.focus();});
  }
  dialog(title){const dialog=this.node('dialog','picker ds-picker'),head=this.node('div','picker-head');head.append(this.translated('h2',title));const close=this.button('×',()=>dialog.close());close.className='icon-button';this.label(close,'关闭');head.append(close);dialog.append(head);dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);return dialog;}
  async models(){
    const sid=this.sid,generation=this.generation;if(!sid||!this.state)return;const dialog=this.dialog('模型设置'),loading=this.translated('p','正在读取模型…','muted');dialog.append(loading);dialog.showModal();
    try{const catalog=await this.request(this.path('catalog'));if(sid!==this.sid||generation!==this.generation||!dialog.open)return dialog.close();loading.remove();const rows=catalog.models||[],model=this.node('select'),effort=this.node('select');this.label(model,'模型');this.label(effort,'思考强度');for(const row of rows)model.add(new Option(row.name||row.id,row.id));const current=catalog.currentModel||this.state.model||'';model.value=rows.some(r=>r.id===current)?current:rows[0]?.id||'';
      const sync=()=>{const row=rows.find(r=>r.id===model.value),options=(row?.efforts||[]).map(item=>typeof item==='string'?{id:item,name:item}:item);effort.replaceChildren(new Option(BridgeI18n.t('默认'),''));for(const item of options)effort.add(new Option(item.name||item.id,item.id));const preferred=model.value===current?(catalog.currentEffort||this.state.effort||''):row?.defaultEffort||'';effort.value=options.some(item=>item.id===preferred)?preferred:'';effort.disabled=!options.length||catalog.capabilities?.effort===false;};model.onchange=sync;sync();
      const modelLabel=this.translated('label','模型'),effortLabel=this.translated('label','思考强度');modelLabel.append(model);effortLabel.append(effort);const save=this.button('应用到此会话',async()=>{if(sid!==this.sid||generation!==this.generation)return dialog.close();save.disabled=true;const body={model:model.value};if(effort.value&&!effort.disabled)body.effort=effort.value;if(await this.mutate('settings',body))dialog.close();else save.disabled=false;});save.className='primary';save.disabled=!rows.length||catalog.capabilities?.models===false;dialog.append(modelLabel,effortLabel,this.node('p','muted',BridgeI18n.t(catalog.notice||(!rows.length?'暂未提供可用模型':''))),save);
    }catch(error){if(dialog.open){loading.textContent=BridgeI18n.t(error.message);loading.className='error';}}
  }
  async permissions(){
    if(!this.sid||!this.state?.capabilities?.permissions)return;const sid=this.sid,generation=this.generation,value=await this.request(this.path('access'));if(sid!==this.sid||generation!==this.generation)return;const dialog=this.dialog('权限');for(const option of value.options||[]){const mode=option.value??option.id,button=this.button('',async()=>{if(sid!==this.sid||generation!==this.generation)return dialog.close();if(await this.mutate('access',{mode,...mode==='bypassPermissions'?{confirmed:true}:{}}))dialog.close();});permissionOption(button,mode,option.label||option.name||mode,option.description||'',mode===value.mode);dialog.append(button);}dialog.showModal();
  }
  chatDetails(){if(!this.state)return;const dialog=this.dialog('聊天详情');dialog.append(this.node('p','',this.state.title),this.node('p','muted',[this.provider==='claude'?(this.state.backend==='cowork'?'Claude · Cowork':'Claude · Code'):'DeepSeek Harness',this.state.model,this.state.effort].filter(Boolean).join(' · ')),this.node('p','muted',this.state.cwd||''),this.button('聊天通知设置',()=>{dialog.close();return this.notifications();}));dialog.showModal();}
  async notifications(){
    const sid=this.sid,provider=this.provider,generation=this.generation;if(!sid||!this.state)return;
    const dialog=this.dialog('聊天通知设置'),loading=this.translated('p','正在读取…','muted'),current=()=>sid===this.sid&&provider===this.provider&&generation===this.generation&&dialog.open;
    dialog.append(loading);dialog.showModal();
    try{
      const value=await this.request(this.path('notifications',sid,provider));if(!current())return dialog.close();loading.remove();
      const form=this.node('form'),fields={};
      for(const [key,title] of [['requests','请求处理通知'],['completion','运行完毕通知']]){
        const label=this.node('label'),select=this.node('select');this.label(select,title);label.append(this.translated('span',title),select);
        for(const [id,text] of [['inherit','跟随全局设置'],['on','开启'],['off','未开启']]){const option=this.translated('option',text);option.value=id;select.add(option);}select.value=value[key]||'inherit';fields[key]=select;form.append(label);
      }
      const error=this.node('p','error');error.setAttribute('role','alert');const save=this.button('保存配置',()=>{});save.type='submit';save.className='primary';
      form.append(this.translated('p',value.available?'通知通道已开启':'尚未配置通知通道，请在第三方通知中配置。','muted'),error,save);
      form.onsubmit=async event=>{event.preventDefault();if(!current())return dialog.close();if(save.disabled)return;save.disabled=true;error.textContent='';try{await this.request(this.path('notifications',sid,provider),{requests:fields.requests.value,completion:fields.completion.value});if(current()){dialog.close();this.notify(BridgeI18n.t('聊天提醒设置已保存'));}}catch(failure){if(current())error.textContent=BridgeI18n.t(failure.message);}finally{save.disabled=false;}};
      dialog.append(form);
    }catch(error){if(current()){loading.textContent=BridgeI18n.t(error.message);loading.className='error';}}
  }
  collapseGroups(){
    for(const group of this.rowsRoot.querySelectorAll('details')){group.open=false;if(group.dataset.groupKey)this.collapsedGroups.add(group.dataset.groupKey);}
    try{localStorage.setItem('bridge-desktop-session-groups',JSON.stringify([...this.collapsedGroups]));}catch{}
  }
  async manageHarness(body,sid=this.sid){
    if(this.provider!=='deepseek')return null;
    const result=await this.mutate('manage',body,sid);if(result)await this.refreshList();return result;
  }
  editHarnessTitle(label,current,save){
    const dialog=this.dialog(label),form=this.node('form'),input=this.node('input'),error=this.node('p','error'),submit=this.button('保存',()=>{});input.value=current;input.maxLength=120;this.label(input,'名称');submit.type='submit';form.append(input,error,submit);dialog.append(form);dialog.showModal();
    const provider=this.provider,generation=this.generation;form.onsubmit=async event=>{event.preventDefault();if(provider!==this.provider||generation!==this.generation)return dialog.close();if(!input.value.trim()){error.textContent=BridgeI18n.t('请输入名称');return;}submit.disabled=true;try{if(await save(input.value.trim()))dialog.close();}catch(failure){error.textContent=BridgeI18n.t(failure.message);}finally{submit.disabled=false;}};input.focus();
  }
  async placeHarness(row,project=false){
    const dialog=this.dialog('移动到分区'),sid=project?null:row.id;
    for(const section of [{id:null,title:'默认分区'},{id:'pinned',title:'置顶'},...(this.harnessSidebar?.sections||[])]){const button=this.button(section.title,async()=>{if(await this.manageHarness({operation:'place',sectionId:section.id,...project?{projectKey:row.key}:{}},sid))dialog.close();});if(section.id&&section.id!=='pinned'){button.textContent=section.title;delete button.dataset.i18n;}dialog.append(button);}dialog.showModal();
  }
  aiRenameChat(row){
    this.aiRename??=new ChatAIRename({request:this.request,newId:()=>this.requestId(),updated:(target,title)=>{
      if(this.provider!=='deepseek')return;
      this.invalidateReads('deepseek');
      const saved=this.rows.find(chat=>chat.id===target.id);if(saved)saved.title=title;
      if(this.sid===target.id){this.title.textContent=title;if(this.state)this.state.title=title;}
      this.refreshList();
    }});
    return this.aiRename.open({...row,writeUrl:this.path('manage',null,'deepseek'),readUrl:this.path('title-status',row.id,'deepseek'),body:{operation:'ai-rename',sessionId:row.id}});
  }
  harnessActions(target){
    if(this.provider!=='deepseek'||this.harnessCapabilities?.sidebar!==true)return [];
    const thread=target.closest?.('[data-id]'),project=target.closest?.('[data-project-key]'),section=target.closest?.('[data-section-id]');
    if(thread){const row=this.rows.find(r=>r.id===thread.dataset.id);if(!row)return [];
      const w=this.harnessProjects.find(p=>p.cwd===row.cwd),ids=w?.sessionIds||[],index=ids.indexOf(row.id);
      return [{label:'AI重命名',disabled:row.archived,run:()=>this.aiRenameChat(row)},
        {label:'重命名',run:()=>this.editHarnessTitle('重命名聊天',row.title,title=>this.manageHarness({operation:'rename',title},row.id))},
        {label:row.pinned?'取消置顶':'置顶',run:()=>this.manageHarness({operation:'place',sectionId:row.pinned?null:'pinned'},row.id)},
        {label:'移动到分区',run:()=>this.placeHarness(row)},
        {label:'标记未读',run:()=>{this.activity.markUnread('deepseek|'+row.id);this.renderIndicators();}},
        {label:'向上移动',disabled:index<=0,run:()=>this.manageHarness({operation:'thread-order',projectKey:w.key,beforeId:ids[index-1]},row.id)},
        {label:'向下移动',disabled:index<0||index>=ids.length-1,run:()=>this.manageHarness({operation:'thread-order',projectKey:w.key,...ids[index+2]?{beforeId:ids[index+2]}:{}},row.id)},
        {label:row.archived?'取消归档':'归档',run:()=>this.manageHarness({operation:row.archived?'unarchive':'archive',confirmed:true},row.id)}];
    }
    if(project){const row=this.harnessProjects.find(p=>p.key===project.dataset.projectKey);if(!row)return [];
      const placement=this.harnessSidebar.placements['project:'+row.key]??null,peers=this.harnessProjects.filter(p=>(this.harnessSidebar.placements['project:'+p.key]??null)===placement),index=peers.indexOf(row);
      return [{label:'新建聊天',run:()=>this.createHarness(row.key)},{label:'重命名项目',run:()=>this.editHarnessTitle('重命名项目',row.name,title=>this.manageHarness({operation:'project-rename',projectKey:row.key,title},null))},
        {label:'移动到分区',run:()=>this.placeHarness(row,true)},
        {label:'向上移动',disabled:index<=0,run:()=>this.manageHarness({operation:'project-order',projectKey:row.key,beforeKey:peers[index-1].key},null)},
        {label:'向下移动',disabled:index>=peers.length-1,run:()=>this.manageHarness({operation:'project-order',projectKey:row.key,...peers[index+2]?{beforeKey:peers[index+2].key}:{}},null)},
        {label:'移除项目',run:()=>this.manageHarness({operation:'project-delete',projectKey:row.key,confirmed:true},null)}];
    }
    if(section&&section.dataset.sectionId!=='home'&&section.dataset.sectionId!=='pinned'){
      const sections=this.harnessSidebar.sections,row=sections.find(s=>s.id===section.dataset.sectionId);if(!row)return [];const index=sections.indexOf(row);
      return [{label:'重命名分区',run:()=>this.editHarnessTitle('重命名分区',row.title,title=>this.manageHarness({operation:'section-rename',sectionId:row.id,title},null))},
        {label:'向上移动',disabled:index<=0,run:()=>this.manageHarness({operation:'section-order',sectionId:row.id,beforeId:sections[index-1].id},null)},
        {label:'向下移动',disabled:index>=sections.length-1,run:()=>this.manageHarness({operation:'section-order',sectionId:row.id,...sections[index+2]?{beforeId:sections[index+2].id}:{}},null)},
        {label:'删除分区',run:()=>this.manageHarness({operation:'section-delete',sectionId:row.id},null)}];
    }return [];
  }
  renderHarnessList(){
    const sidebar=this.harnessSidebar||{sections:[],placements:{}},projects=this.harnessProjects||[],query=this.search.value.trim().toLowerCase(),stamp=JSON.stringify([this.rows,projects,sidebar,this.sid,query,this.archived.checked,BridgeI18n.language(),this.projectPages]);
    if(stamp===this.listStamp){this.renderIndicators();return;}this.listStamp=stamp;const scroll=this.rowsRoot.scrollTop;this.rowsRoot.replaceChildren();this.surface.hidden=true;
    const matching=this.rows.filter(r=>(this.archived.checked||!r.archived)&&((r.title||'')+' '+(r.cwd||'')).toLowerCase().includes(query));
    const sections=[{id:'pinned',title:'置顶'},{id:'home',title:'默认分区'},...sidebar.sections],roots=new Map();
    const group=(key,name,parent,attrs={})=>{const node=this.node('details','project-group ds-session-group'),summary=this.node('summary'),label=this.node('span','',name),more=this.button('⋯',()=>{const rect=more.getBoundingClientRect();this.listMenu.open(summary,rect.right,rect.bottom);});more.setAttribute('aria-label',BridgeI18n.t('侧栏操作'));summary.append(label,more);Object.assign(summary.dataset,attrs);node.dataset.groupKey=key;node.open=!this.collapsedGroups.has(key);node.ontoggle=()=>{if(node.open)this.collapsedGroups.delete(key);else this.collapsedGroups.add(key);try{localStorage.setItem('bridge-desktop-session-groups',JSON.stringify([...this.collapsedGroups]));}catch{}};node.append(summary);parent.append(node);return node;};
    for(const section of sections)roots.set(section.id,group('deepseek:section:'+section.id,section.id==='home'||section.id==='pinned'?BridgeI18n.t(section.title):section.title,this.rowsRoot,{sectionId:section.id}));
    const rootFor=id=>roots.get(id)||roots.get('home'),projectRoots=new Map();
    for(const project of projects){const rows=matching.filter(r=>!r.projectless&&r.cwd===project.cwd&&!sidebar.placements['thread:'+r.id]&&!r.pinned);if(query&&!rows.length&&!project.name.toLowerCase().includes(query))continue;
      const parent=rootFor(sidebar.placements['project:'+project.key]),node=group('deepseek:project:'+project.key,project.name,parent,{projectKey:project.key});projectRoots.set(project.key,node);
      const ids=project.sessionIds||[],ordered=[...rows].sort((a,b)=>{const x=ids.indexOf(a.id),y=ids.indexOf(b.id);return x<0&&y<0?Number(b.updatedAt)-Number(a.updatedAt):x<0?1:y<0?-1:x-y;});
      this.projectPages??={};const limit=query?ordered.length:this.projectPages[project.key]||5;
      for(const row of ordered.slice(0,limit))this.appendHarnessRow(node,row);
      if(ordered.length>limit)node.append(this.button('显示更多',()=>{this.projectPages[project.key]=limit+10;this.listStamp='';this.renderList();}));
    }
    for(const row of matching){const placement=sidebar.placements['thread:'+row.id],project=projects.find(p=>p.cwd===row.cwd);if(placement||row.pinned||row.projectless||!project)this.appendHarnessRow(rootFor(placement||(row.pinned?'pinned':'home')),row);}
    for(const [id,node]of roots)if(node.children.length===1&&id==='pinned')node.hidden=true;
    this.rowsRoot.scrollTop=scroll;this.renderIndicators();
  }
  appendHarnessRow(parent,row){
    const button=this.button('',()=>this.open(row.id));button.className='session ds-session-row'+(row.id===this.sid?' selected':'');button.dataset.id=row.id;button.dataset.provider='deepseek';button.append(this.node('strong','',row.title||BridgeI18n.t('新会话')),this.node('span','ds-session-type','APP'),this.node('small','',row.cwd||''));parent.append(button);
  }
  newHarnessProject(){
    const dialog=this.dialog('新建项目'),form=this.node('form'),name=this.node('input'),cwd=this.node('input'),browse=this.button('选择文件夹',()=>{}),error=this.node('p','error'),save=this.button('创建项目',()=>{});this.label(name,'项目名称');this.label(cwd,'文件夹完整路径');name.maxLength=120;cwd.maxLength=4096;save.type='submit';for(const [caption,input]of [['项目名称',name],['文件夹完整路径',cwd]]){const label=this.translated('label',caption);label.append(input);form.append(label);}form.append(browse,error,save);dialog.append(form);dialog.showModal();
    const generation=this.generation;const picker=new ProjectFolderBrowser({button:browse,input:cwd,uuid:()=>this.requestId(),context:()=>this.provider==='deepseek'&&generation===this.generation&&dialog.open?{key:'deepseek-project',cwd:cwd.value}:null,request:(url,body,signal)=>this.request(url.replace('/api/','/api/desktop-sessions/deepseek/'),body,signal),onSelect:path=>{if(!name.value)name.value=path.split(/[\\/]/).filter(Boolean).at(-1)||'';}});
    dialog.addEventListener('close',()=>picker.close(),{once:true});form.onsubmit=async event=>{event.preventDefault();if(this.provider!=='deepseek'||generation!==this.generation)return dialog.close();save.disabled=true;try{if(await this.manageHarness({operation:'project-create',title:name.value.trim(),cwd:cwd.value.trim()},null))dialog.close();else error.textContent=BridgeI18n.t('结果待核对，请检查原会话列表');}finally{save.disabled=false;}};
  }
  async createHarness(projectKey){
    const dialog=this.dialog('新建聊天'),loading=this.translated('p','正在读取…','muted'),generation=this.generation;dialog.append(loading);dialog.showModal();
    try{const value=await this.request(this.path('projects',null));if(this.provider!=='deepseek'||generation!==this.generation||!dialog.open)return dialog.close();const form=this.node('form'),project=this.node('select'),title=this.node('input'),model=this.node('select'),effort=this.node('select'),permission=this.node('select'),error=this.node('p','error'),save=this.button('创建并打开',()=>{});save.type='submit';title.maxLength=120;title.placeholder=BridgeI18n.t('首条消息后自动命名');project.add(new Option(BridgeI18n.t('不选择项目'),''));for(const row of value.projects||[])project.add(new Option(row.name+' · '+row.cwd,row.key));project.value=typeof projectKey==='string'?projectKey:'';
      const field=(name,input)=>{const label=this.translated('label',name);this.label(input,name);label.append(input);form.append(label);};field('项目',project);field('聊天名称',title);field('模型',model);field('思考强度',effort);field('权限',permission);permission.add(new Option(BridgeI18n.t('默认'),''));for(const option of value.permissionOptions||[])permission.add(new Option(BridgeI18n.t(option.label||option.name||option.value),option.value));model.add(new Option(BridgeI18n.t('默认'),''));effort.add(new Option(BridgeI18n.t('默认'),''));
      const account=await this.request(this.path('account',null));if(generation!==this.generation||!dialog.open)return dialog.close();for(const row of account.models||[])model.add(new Option(row.name||row.id,row.id));model.onchange=()=>{effort.replaceChildren(new Option(BridgeI18n.t('默认'),''));for(const option of (account.models||[]).find(r=>r.id===model.value)?.efforts||[])effort.add(new Option(option,option));};
      loading.remove();form.append(error,save);dialog.append(form);form.onsubmit=async event=>{event.preventDefault();if(this.provider!=='deepseek'||generation!==this.generation)return dialog.close();save.disabled=true;const result=await this.mutate('create',{projectKey:project.value,title:title.value.trim(),...permission.value?{permissionMode:permission.value}:{},...model.value?{model:model.value,effort:effort.value}:{}},null);if(result?.result?.id){dialog.close();await this.open(result.result.id);}else{error.textContent=BridgeI18n.t('结果待核对，请检查原会话列表');save.disabled=false;}};
    }catch(error){if(dialog.open)loading.textContent=BridgeI18n.t(error.message);}
  }
  async create(projectKey){
    if(this.provider==='deepseek')return this.createHarness(projectKey);
    const generation=this.generation,provider=this.provider,dialog=this.dialog('新建聊天'),loading=this.translated('p','正在读取…','muted');dialog.append(this.node('p','muted',(provider==='claude'?'Claude':'DeepSeek Harness')+' · '+BridgeI18n.t('当前客户端')),loading);dialog.showModal();
    try{const value=await this.request(this.path('projects',null));if(generation!==this.generation||!dialog.open)return dialog.close();loading.remove();const projects=value.projects||[],form=this.node('form'),surface=this.node('select'),project=this.node('select'),title=this.node('input'),message=this.node('textarea'),error=this.node('p','error');this.label(project,'项目');this.label(surface,'会话类型');title.maxLength=120;title.required=true;title.value=BridgeI18n.t('新会话');this.label(title,'聊天名称');message.rows=3;message.maxLength=100000;message.required=provider==='claude'||value.createRequiresMessage===true;this.label(message,'首条消息');
      for(const kind of ['code','cowork','cli'])if(projects.some(row=>row.surface===kind))surface.add(new Option(kind==='code'?'Code':kind==='cowork'?'Cowork':'Claude Code CLI',kind));surface.value=[...surface.options].some(row=>row.value===this.state?.backend)?this.state.backend:surface.options[0]?.value||'';
      const create=this.button(message.required?'创建并发送':'创建并打开',()=>{});create.type='submit';create.className='primary';let titleField;const sync=()=>{project.replaceChildren();for(const row of projects.filter(row=>provider!=='claude'||row.surface===surface.value))project.add(new Option(row.name+' · '+row.cwd,row.key));const cli=provider==='claude'&&surface.value==='cli';title.required=!cli;titleField.hidden=cli;create.disabled=!project.options.length;};surface.onchange=sync;
      const field=(label,input)=>{const node=this.translated('label',label);node.append(input);form.append(node);return node;};if(provider==='claude')field('会话类型',surface);field('项目',project);titleField=field('聊天名称',title);if(message.required)field('首条消息',message);sync();
      form.append(this.node('p','muted',BridgeI18n.t(projects.length?'沿用所选项目与客户端配置':'请先在客户端创建一个项目会话')),error,create);form.onsubmit=async event=>{event.preventDefault();if(generation!==this.generation)return dialog.close();const cli=provider==='claude'&&surface.value==='cli';if(!cli&&!title.value.trim()||message.required&&!message.value.trim()){error.textContent=BridgeI18n.t(cli?'请输入首条消息':message.required?'请填写聊天名称和首条消息':'请输入聊天名称');return;}create.disabled=true;const body={projectKey:project.value};if(!cli)body.title=title.value.trim();if(message.required)body.firstMessage=message.value.trim();const result=await this.mutate('create',body,null);if(result?.result?.id&&generation===this.generation){dialog.close();await this.open(result.result.id);}else{error.textContent=BridgeI18n.t('结果待核对，请检查原会话列表');create.disabled=false;}};dialog.append(form);
    }catch(error){if(dialog.open){loading.textContent=BridgeI18n.t(error.message);loading.className='error';}}
  }
  relabel(){this.renderConnectionStatus();this.listStamp='';this.requestStamp='';this.search.placeholder=BridgeI18n.t('搜索');this.input.placeholder=BridgeI18n.t('继续这条聊天…');[...this.mode.options].forEach((option,i)=>option.textContent=BridgeI18n.t(['发送新消息','完成后发送','补充当前任务'][i]));this.listMode.options[0].textContent=BridgeI18n.t('最近交互');this.listMode.options[1].textContent=BridgeI18n.t('按项目');this.renderList();this.attachments.render();this.updateComposer();this.renderMessages(this.lastMessages||[]);this.collapseComposer(this.composerBody.hidden);this.workbench.relabel();this.referencePicker.relabel();for(const option of this.listMode.options)if(option.value==='native')option.textContent=BridgeI18n.t('跟随客户端');if(this.sid)this.renderNotice();if(this.sid)this.renderRequests(this.freshDetail?this.state?.requests||[]:[]);}
}
if(typeof module!=='undefined')module.exports={DesktopSessionsView};
