'use strict';

// A shared, gateway-owned ephemeral fork. Disposing a view never ends the chat.
class SideChatPanel {
  static messageVisible(message){
    if(message.role==='user'||message.role==='error')return true;
    if(message.kind==='reasoning'||message.role==='reasoning')return document.documentElement.dataset.showProcess!=='false'&&document.documentElement.dataset.showReasoning!=='false'&&!!message.text?.trim();
    if(message.role!=='assistant')return document.documentElement.dataset.showProcess!=='false';
    return true;
  }
  applyVisibility(){for(const {node,message} of this.messageNodes||[])node.hidden=!SideChatPanel.messageVisible(message);this.groupMessages();this.messageMap?.update();}
  groupMessages(){
    if(!this.messageNodes)return;
    this.messageGroups??=new ChatMessageGroups(this.messages,(...args)=>this.workbench.node(...args));
    this.messageGroups.render(this.messageNodes,{showProcess:document.documentElement.dataset.showProcess!=='false'});
  }
  constructor(workbench, session, tab) {
    Object.assign(this, {workbench, session, tab});this.creationId=uuid();
    const n=(...args)=>workbench.node(...args),b=(...args)=>workbench.button(...args);
    this.head=n('div','wb-side-head');
    this.createButton=b(BridgeI18n.t('创建侧边聊天'),()=>this.create());this.createButton.className='primary';
    this.stopButton=b(BridgeI18n.t('■ 停止'),()=>this.action('stop'));this.stopButton.hidden=true;
    this.endButton=b(BridgeI18n.t('结束聊天'),async()=>{if(this.state?.expired){await workbench.close(tab.id);return;}if(await this.end())this.load();});this.endButton.hidden=true;
    this.newButton=b(BridgeI18n.t('新建'),()=>workbench.sideChat('',true),'新建侧边聊天');
    this.renameButton=b(BridgeI18n.t('重命名'),()=>this.rename(),'重命名侧边聊天');
    this.modelButton=b(BridgeI18n.t('模型与思考程度'),()=>this.modelSettings());
    this.referenceButton=b('＋',()=>{},'添加引用');this.referenceButton.className='tool-button reference-button';
    this.permissionsButton=b(BridgeI18n.t('权限'),()=>this.permissions());this.permissionsButton.className='tool-button';this.contextUsage=new ContextUsageControl();
    this.caption=workbench.raw(n('strong','wb-side-caption',tab.name));
    this.head.append(this.caption,this.renameButton,this.newButton,this.endButton);
    this.landing=n('div','wb-side-landing');
    this.help=n('p','wb-side-help',BridgeI18n.t('继承当前会话的上下文，单独讨论一个问题。主会话的任务不会被接续执行。'));
    this.landing.append(n('div','wb-side-symbol','⑂'),n('h2','',BridgeI18n.t('开启一段侧边聊天')),this.help,n('p','muted',BridgeI18n.t(session.provider==='deepseek'?'可跨设备继续。结束侧边聊天会归档 Harness 分叉记录。':'可跨设备继续。结束聊天或重启网关后，临时内容会清除。')),this.createButton);
    this.status=n('p','wb-status');this.status.setAttribute('role','status');
    this.messages=n('div','wb-side-messages');this.messages.setAttribute('data-i18n-aria-label','侧边聊天消息');this.messages.setAttribute('aria-label',BridgeI18n.t('侧边聊天消息'));
    this.latestButton=b('↓',()=>this.jumpBottom(),'返回最新内容 ↓');this.latestButton.className='plain wb-side-latest';this.latestButton.hidden=true;
    this.messageArea=n('div','wb-side-message-area');this.messageArea.append(this.messages,this.latestButton);
    this.approvals=n('div','wb-side-approvals');this.queued=n('div','wb-side-queue');
    this.form=n('form','composer wb-side-composer');this.form.hidden=true;
    this.input=n('textarea');this.input.rows=1;this.input.maxLength=20000;this.input.setAttribute('data-i18n-placeholder','继续这条聊天…');this.input.placeholder=BridgeI18n.t('继续这条聊天…');this.input.setAttribute('data-i18n-aria-label','侧边聊天输入');this.input.setAttribute('aria-label',BridgeI18n.t('侧边聊天输入'));
    this.sendButton=n('button','primary',BridgeI18n.t('发送 ↑'));this.sendButton.type='submit';this.sendButton.disabled=true;
    const tools=n('div','composer-tools'),bottom=n('div','compose-bottom'),actions=n('div','compose-actions');
    this.modelButton.className='tool-button wb-side-model';
    this.toggle=b('',()=>this.collapse(!this.collapsed),BridgeI18n.t('收起输入区'));this.toggle.className='composer-toggle';this.toggle.setAttribute('aria-expanded','true');this.toggle.append(document.querySelector('#composer-toggle svg').cloneNode(true));
    this.selectionButton=b('选区操作',()=>{},'操作选中的聊天文字');this.selectionButton.className='tool-button';
    this.stopButton.className='stop';tools.append(this.modelButton,this.referenceButton,this.permissionsButton,this.contextUsage.button,this.selectionButton,this.toggle);
    this.composerBody=n('div','wb-side-composer-body');
    this.attachmentList=n('div','attachment-list');this.fileInput=n('input');this.fileInput.type='file';this.fileInput.multiple=true;this.fileInput.hidden=true;
    this.attachButton=b('',()=>{},BridgeI18n.t('添加文件或图片'));this.attachButton.className='attach-button';
    this.attachButton.append(document.querySelector('#attach-button svg').cloneNode(true));
    const select=(label,rows)=>{const control=n('select');control.dataset.i18nAriaLabel=label;control.setAttribute('aria-label',BridgeI18n.t(label));for(const [value,text] of rows){const option=n('option','',BridgeI18n.t(text));option.value=value;control.append(option);}return control;};
    this.sendMode=select('发送方式',[['send','发送新消息'],['queue','完成后发送'],['steer','补充当前任务']]);
    this.workMode=select('工作模式',[['default','普通模式'],['plan','计划模式']]);
    if(session.provider==='deepseek'){this.workMode.append(new Option(BridgeI18n.t('目标模式'),'goal'));this.fileInput.accept='image/png,image/jpeg,image/gif,image/webp';}
    this.sendMode.onchange=()=>this.controls();this.workMode.onchange=()=>{this.modeSelected=true;this.controls();};
    actions.append(this.stopButton,this.sendButton);bottom.append(this.attachButton,this.fileInput,this.sendMode,this.workMode,actions);
    this.composerBody.append(this.attachmentList,this.input,bottom);this.form.append(tools,this.composerBody);
    if(session.provider==='deepseek'){
      this.modeHint=n('span','mode-hint');this.goalRoot=n('div','goal-state');this.goalToggle=b('',()=>{},'目标进度');this.goalToggle.append(document.querySelector('#goal-toggle svg').cloneNode(true),n('span','',BridgeI18n.t('目标进度')));this.goalToggle.className='goal-toggle';actions.prepend(this.goalToggle);this.composerBody.append(this.modeHint);this.form.prepend(this.goalRoot);
      const goalAction=(goalAction,{id,...payload})=>this.action('settings',{goalAction,...payload,operationId:id},true);
      this.nativeModes=new WorkModes({select:this.workMode,hint:this.modeHint,goalRoot:this.goalRoot,goalToggle:this.goalToggle,storage:localStorage,newId:uuid,onCancel:payload=>goalAction('clear',payload),onStatus:payload=>goalAction(payload.status,payload),onEdit:payload=>goalAction('edit',payload)});
      const change=this.workMode.onchange;this.workMode.onchange=()=>{change();this.controls();};
    }
    this.fileQuotes=new FileQuoteDrafts({input:this.input,onChange:()=>this.controls()});this.fileQuotes.open(session.key+'|'+tab.id);
    this.references=new ChatReferencePicker({button:this.referenceButton,input:this.input,context:()=>this.referenceContext(),
      load:(kind,options)=>this.loadReferences(kind,options),onInsert:()=>this.collapse(false)});
    this.selectionAction=new SelectedTextAction(tab.body,{available:()=>!this.disposed&&workbench.isVisible(session,tab),context:()=>session.key+'|'+tab.id+'|'+(this.state?.id||''),trigger:this.selectionButton,
      canAdd:()=>workbench.selectionTargets.available(session),canExplain:()=>false,add:text=>workbench.selectionTargets.addText(text,session),
      openMenu:snapshot=>this.selectionAction.activate('add',snapshot.token)});
    this.attachments=new ChatAttachments({root:this.attachmentList,button:this.attachButton,input:this.fileInput,paste:this.input,drop:this.form,
      onChange:()=>this.controls(),preview:(key,id)=>this.uploadUrl(key,id,'preview'),
      upload:(key,id,file)=>this.uploadFile(this.uploadUrl(key,id)+'&name='+encodeURIComponent(file.name),file),
      thumbnail:async(key,id,file)=>{const thumb=await this.attachments.thumbnailBlob(file);return this.uploadFile(this.uploadUrl(key,id,'thumb')+'&width='+thumb.width+'&height='+thumb.height,thumb.data);}});
    if(session.provider==='deepseek'){
      const add=this.attachments.add.bind(this.attachments);this.attachments.add=files=>{if(files.some(file=>!file.type?.startsWith('image/'))){this.attachments.error='此应用的消息附件仅支持图片；其他文件请使用文件传输。';this.attachments.render();return;}add(files);};
    }
    this.form.onsubmit=e=>{e.preventDefault();this.send();};
    this.input.oninput=()=>{this.resizeInput();this.controls();};
    tab.body.append(this.head,this.landing,this.status,this.messageArea,this.approvals,this.queued,this.form);
    this.following=true;this.lastMessageTop=0;
    this.messages.onscroll=()=>{const top=this.messages.scrollTop;if(top===this.lastMessageTop)return;this.following=top>this.lastMessageTop&&this.messages.scrollHeight-this.messages.clientHeight-top<60;this.latestButton.hidden=this.following;this.lastMessageTop=this.messages.scrollTop;};
    this.messageMap=new ChatMessageMap({viewport:this.messages,railBottomInset:40,directoryRows:()=>this.navigationRows(),navigateMessage:entry=>this.navigateMessage(entry)});
    this.visibilityObserver=new MutationObserver(()=>this.applyVisibility());
    this.visibilityObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-show-reasoning','data-show-process']});
    this.controls();this.load();this.schedule();
  }
  resizeInput(){this.input.style.height='auto';this.input.style.height=Math.min(160,Math.max(48,this.input.scrollHeight))+'px';}
  navigationRows(){return (this.messageNodes||[]).filter(({message})=>message.role==='user'&&!message.isUserContext).map(({key,message},order)=>({rowKey:key,order,summary:messageSummary(message)}));}
  readingAnchor(){
    const top=this.messages.getBoundingClientRect().top,row=this.messageNodes?.find(({node})=>!node.hidden&&node.getBoundingClientRect().bottom>top);
    return row?{key:row.key,offset:row.node.getBoundingClientRect().top-top}:null;
  }
  navigateMessage(entry){
    if(this.disposed||!this.workbench.isVisible(this.session,this.tab))return;
    const row=this.messageNodes?.find(({key,message,node})=>key===entry.rowKey&&!node.hidden&&messageSummary(message)===entry.summary);if(!row)return;
    this.following=false;this.latestButton.hidden=false;this.messages.scrollTop+=row.node.getBoundingClientRect().top-this.messages.getBoundingClientRect().top-12;
    this.lastMessageTop=this.messages.scrollTop;this.messageMap.close();
  }
  jumpBottom(){this.following=true;this.latestButton.hidden=true;this.messages.scrollTop=this.messages.scrollHeight;this.lastMessageTop=this.messages.scrollTop;}
  updateCaption(){this.caption.textContent=this.tab.customTitle?this.tab.name:BridgeI18n.t(this.tab.name);this.caption.title=this.caption.textContent;}
  rename(){
    if(this.disposed||this.busy)return;
    this.renameDialog?.close();
    const child=this.state?.id,dialog=this.renameDialog=this.dialog('修改侧边聊天名称');
    const form=this.workbench.node('form'),label=this.workbench.node('label','','聊天名称'),input=this.workbench.node('input');
    input.maxLength=120;input.value=this.tab.customTitle||this.tab.name;label.append(input);
    const error=this.workbench.node('p','error'),actions=this.workbench.node('div','actions');
    const save=this.workbench.button('保存',()=>{});save.type='submit';
    actions.append(save,this.workbench.button('取消',()=>dialog.close()));form.append(label,error,actions);dialog.append(form);
    dialog.addEventListener('close',()=>{if(this.renameDialog===dialog)this.renameDialog=null;},{once:true});
    form.onsubmit=async event=>{
      event.preventDefault();if(this.busy||this.disposed||this.workbench.current!==this.session||(this.state?.id||null)!==(child||null))return;
      const title=input.value.trim();
      if(!title||[...title].length>120||/[\u0000-\u001f\u007f-\u009f]/.test(input.value)){
        error.textContent=BridgeI18n.t('聊天名称需为 1–120 个字符，不能包含换行或控制字符');return;
      }
      if(!child){
        this.workbench.setSideChatTitle(this.session,this.tab,{title});this.updateCaption();this.workbench.paint();dialog.close();return;
      }
      this.readRevision=(this.readRevision||0)+1;this.busy=true;save.disabled=true;this.controls();error.textContent='';
      try{
        const state=await this.request({action:'rename',id:child,title});
        if(!this.disposed&&this.state?.id===child)this.apply(state);
        dialog.close();
      }catch(e){error.textContent=BridgeI18n.t(e.message);}
      finally{this.busy=false;save.disabled=false;if(!this.disposed)this.controls();}
    };
    input.focus();input.select();
  }
  quoteSelection(text){
    if(!this.canReceiveQuote())return;
    const prompt=BridgeI18n.t('请进一步解释以下内容：')+'\n\n'+text.split('\n').map(line=>'> '+line).join('\n');
    this.input.value=(this.input.value.trim()?this.input.value+'\n\n':'')+prompt;this.collapse(false);this.input.oninput();
    if(!this.state?.id){
      if(!this.selectionPreview){this.selectionPreview=this.workbench.node('blockquote','wb-side-selection');this.landing.append(this.selectionPreview);}
      this.selectionPreview.textContent=this.input.value;
    }else this.input.focus();
  }
  collapse(value){this.collapsed=value;this.composerBody.hidden=value;this.form.classList.toggle('is-collapsed',value);this.toggle.setAttribute('aria-expanded',String(!value));const label=value?'展开输入区':'收起输入区';this.toggle.dataset.i18nTitle=label;this.toggle.dataset.i18nAriaLabel=label;this.toggle.title=BridgeI18n.t(label);this.toggle.setAttribute('aria-label',BridgeI18n.t(label));if(!value)this.resizeInput();}
  uploadUrl(child,id,operation=''){
    if(this.session.provider==='deepseek')return '/api/desktop-sessions/deepseek/uploads'+(operation?'/'+encodeURIComponent(id)+'/'+operation:'')+'?sessionId='+encodeURIComponent(child)+(operation?'':'&id='+encodeURIComponent(id));
    const path='/api/sessions/'+this.session.id+'/uploads'+(operation?'/'+encodeURIComponent(id)+'/'+operation:'')+'?host='+encodeURIComponent(this.session.host)+'&side='+encodeURIComponent(child)+(operation?'':'&id='+encodeURIComponent(id));
    return window.BridgeRelayURL?.(path)||path;
  }
  async uploadFile(url,file){
    const response=await fetch(url,{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type||'application/octet-stream','X-CSRF-Token':this.workbench.csrf()},body:file});
    const result=await response.json();if(!response.ok){if(response.status===401)this.workbench.onUnauthorized();const error=Error(result.error||BridgeI18n.t('上传失败'));error.status=response.status;throw error;}return result;
  }
  relabel(){
    for(const [control,labels] of [[this.sendMode,['发送新消息','完成后发送','补充当前任务']],[this.workMode,['普通模式','计划模式','目标模式']]])[...control.options].forEach((option,i)=>option.textContent=BridgeI18n.t(labels[i]));
    if(this.goalToggle)this.goalToggle.querySelector('span').textContent=BridgeI18n.t('目标进度');
    this.input.setAttribute('data-i18n-placeholder','继续这条聊天…');this.input.placeholder=BridgeI18n.t('继续这条聊天…');
    this.input.setAttribute("data-i18n-aria-label",'侧边聊天输入');this.input.setAttribute('aria-label',BridgeI18n.t('侧边聊天输入'));
    this.messages.setAttribute("data-i18n-aria-label",'侧边聊天消息');this.messages.setAttribute('aria-label',BridgeI18n.t('侧边聊天消息'));
    this.references.relabel();
    if(this.state)this.apply(this.state);
  }
  referenceContext(){
    if(!this.canReceiveQuote()||!this.workbench.isVisible(this.session,this.tab))return null;
    return {key:this.session.key+'|'+this.tab.id+'|'+(this.state?.id||'draft'),id:this.session.id,host:this.session.host,
      cwd:this.state?.cwd||this.session.cwd||'',canSkills:!!this.state?.id,sideId:this.state?.id,provider:this.session.provider||'codex',sid:this.state?.id||this.session.id};
  }
  async loadReferences(kind,options){
    if(kind!=='skills')return this.workbench.loadReferences(kind,options);
    const {target,query,offset,refresh,signal}=options;
    const result=await this.workbench.request(this.url(),{action:'skills',id:target.sideId,query,offset,refresh},signal);
    return ChatReferencePicker.skillItems(result,offset);
  }
  url(){return (this.session.provider==='deepseek'?'/api/desktop-sessions/deepseek/side-chat?sessionId='+encodeURIComponent(this.session.id):'/api/sessions/'+this.session.id+'/side-chat?host='+encodeURIComponent(this.session.host))+(this.tab.slot?'&slot='+encodeURIComponent(this.tab.slot):'');}
  async request(body){
    if(this.disposed)throw Error('此侧边聊天已关闭或已失效，请刷新标签');
    if(body&&['send','respond','settings','permissions','stop','cancel-queued'].includes(body.action)&&(!this.state?.connected||this.state.expired||body.id!==this.state.id))throw Error('此侧边聊天已关闭或已失效，请刷新标签');
    if(this.session.provider!=='deepseek'||!body||['catalog','skills'].includes(body.action))return this.workbench.request(this.url(),body);
    const key=JSON.stringify(body);this.mutations??=new Map();if(!this.mutations.has(key))this.mutations.set(key,body.operationId||uuid());
    const value=await this.workbench.request(this.url(),{...body,operationId:this.mutations.get(key)});
    if(value.status==='unknown')throw Error(value.message||'结果待核对，请检查桌面原会话');
    this.mutations.delete(key);return value;
  }
  controls(){
    const created=!!this.state?.id,active=!!this.state?.connected&&this.state.status==='active',locked=!!this.busy||!!this.pending||!this.state?.connected;
    this.form.hidden=!created&&!this.fileQuotes.rows.length&&!this.input.value.trim();this.landing.hidden=created||!!this.busy;this.head.hidden=false;this.messageArea.hidden=!created;this.messages.hidden=!created;this.queued.hidden=!created;
    this.latestButton.hidden=!created||this.following!==false;
    this.input.readOnly=created&&!this.state.connected;
    if(this.attachments&&this.attachments.locked!==locked)this.attachments.setLocked(locked);
    for(const button of [this.modelButton,this.permissionsButton])button.disabled=locked;
    this.referenceButton.disabled=!this.canReceiveQuote();
    if(this.referenceButton.disabled)this.references?.close();
    this.sendMode.disabled=locked;this.workMode.disabled=locked||this.sendMode.value==='steer';
    this.sendMode.querySelector('[value=steer]').disabled=!active;
    if(!active&&this.sendMode.value==='steer')this.sendMode.value='send';
    this.workMode.disabled=locked||this.sendMode.value==='steer';
    this.workMode.title=BridgeI18n.t(this.sendMode.value==='steer'?'补充内容沿用当前任务模式':this.workMode.value==='plan'?'先讨论并制定计划，确认后执行。':'');
    if(this.nativeModes){
      const caps=this.state?.capabilities||{};this.nativeModes.render(this.state?.id?{...this.state,host:'local',loadingHistory:!this.state.connected,workModesLocked:active,goalRuntimeAvailable:this.state.connected&&caps.goal===true,goalUnavailableReason:'当前 Harness 会话不支持目标模式，请更新接入或检查智能体配置'}:null,this.sendMode.value,locked);
      this.workMode.disabled=this.workMode.disabled||active;this.workMode.querySelector('[value=plan]').disabled=caps.workModes!==true;this.workMode.querySelector('[value=plan]').title=BridgeI18n.t(caps.workModes===true?'':'当前 Harness 会话不支持计划模式，请更新接入或检查智能体配置');
      if(caps.workModes!==true&&this.workMode.value==='plan')this.workMode.value='default';
    }
    this.sendButton.disabled=locked||((active||!!this.state?.requests?.length)&&this.sendMode.value==='send')||(!!this.state?.requests?.length&&this.sendMode.value==='steer')||(!this.input.value.trim()&&!this.fileQuotes.rows.length&&!this.attachments?.ids().length)||!this.attachments?.ready();
    this.createButton.disabled=!!this.busy||created;
    this.stopButton.hidden=!created||!active;this.stopButton.disabled=!!this.busy;
    this.endButton.hidden=!created;this.endButton.disabled=!!this.busy;
    const endLabel=this.state?.expired?'关闭标签':'结束聊天';this.endButton.dataset.i18n=endLabel;this.endButton.textContent=BridgeI18n.t(endLabel);
    this.newButton.disabled=!!this.busy;this.renameButton.disabled=!!this.busy;
    this.status.hidden=!this.status.textContent;
  }
  canReceiveQuote(){return !this.disposed&&!this.busy&&!this.pending&&!this.state?.expired&&(!this.state?.id?!this.tab?.titleChild:this.state.connected===true);}
  dialog(title){
    const n=(...a)=>this.workbench.node(...a),dialog=n('dialog','picker'),head=n('div','picker-head');
    head.append(n('h2','',BridgeI18n.t(title)),this.workbench.button('×',()=>dialog.close(),BridgeI18n.t('关闭')));dialog.append(head);
    document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();return dialog;
  }
  permissions(){
    if(this.session.provider==='deepseek'){this.harnessPermissions();return;}
    const child=this.state.id,n=(...a)=>this.workbench.node(...a),dialog=this.dialog('会话权限'),error=n('p','error');
    dialog.append(n('p','muted',BridgeI18n.t('仅影响此侧边聊天，从下一轮生效。')));
    if(this.state.linuxPermissionChecks===true){
      permissionPicker(dialog,{load:()=>this.request({action:'linux-permission-options',id:child}),
        save:async preset=>({confirmed:true,state:await this.request({action:'permissions',id:child,preset,confirmed:preset==='full-access'})}),
        isCurrent:()=>!this.disposed&&this.state?.id===child&&this.state.connected===true,onSaved:result=>this.apply(result.state)});
      return;
    }
    for(const [preset,label,help] of [['ask','请求批准','需要额外权限时询问你。'],['auto-review','帮我批准','由 Codex 审核需要额外权限的操作。'],['full-access','完全访问权限','允许访问工作区外的文件和网络，无需逐次批准。']]){
      const button=this.workbench.button('',async()=>{
        if(preset==='full-access'&&!confirm(BridgeI18n.t('允许此会话完全访问电脑文件和网络？请仅在信任任务内容时开启。')))return;
        dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
        try{const state=await this.request({action:'permissions',id:child,preset,confirmed:preset==='full-access'});if(this.state?.id===child)this.apply(state);dialog.close();}
        catch(e){error.textContent=BridgeI18n.t(e.message);}finally{dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
      },BridgeI18n.t(label));permissionOption(button,preset,label,help,this.state.permissionMode===preset);dialog.append(button);
    }dialog.append(error);
  }
  async harnessPermissions(){
    const child=this.state.id;
    try{const value=await this.workbench.request('/api/desktop-sessions/deepseek/access?sessionId='+encodeURIComponent(child));if(this.disposed||this.state.id!==child)return;
      const dialog=this.dialog('权限');for(const option of value.options||[]){const mode=option.value??option.id;dialog.append(this.workbench.button(option.label||option.name||mode,async()=>{try{this.apply(await this.request({action:'permissions',id:child,preset:mode}));dialog.close();}catch(error){this.status.textContent=BridgeI18n.t(error.message);this.controls();}}));}
    }catch(error){this.status.textContent=BridgeI18n.t(error.message);this.controls();}
  }
  async modelSettings(){
    const child=this.state.id,n=(...args)=>this.workbench.node(...args),b=(...args)=>this.workbench.button(...args);
    try{
      const catalog=await this.request({action:'catalog',id:child});
      if(this.disposed||this.state.id!==child)return;
      const dialog=n('dialog','picker'),head=n('div','picker-head'),model=n('select'),custom=n('input'),effort=n('select'),status=n('p','error');
      head.append(n('h2','',BridgeI18n.t('侧边聊天设置')),b('×',()=>dialog.close(),BridgeI18n.t('关闭')));
      const modelLabel=n('label','',BridgeI18n.t('模型')),effortLabel=n('label','',BridgeI18n.t('思考程度'));
      for(const row of catalog.models||[])model.append(new Option(row.name||row.id,row.id));
      const manual=new Option(BridgeI18n.t('自定义模型…'),'__custom__');manual.dataset.i18n='自定义模型…';model.append(manual);
      model.value=[...model.options].some(o=>o.value===catalog.currentModel)?catalog.currentModel:'__custom__';custom.value=catalog.currentModel||'';
      custom.setAttribute("data-i18n-aria-label",'模型 ID');custom.setAttribute('aria-label',BridgeI18n.t('模型 ID'));
      const fill=()=>{custom.hidden=model.value!=='__custom__';const known=catalog.models?.find(m=>m.id===model.value);const values=known?.efforts?.length?known.efforts:['none','minimal','low','medium','high','xhigh','max','ultra'];effort.replaceChildren(...values.map(value=>new Option(value,value)));effort.value=values.includes(catalog.currentEffort)?catalog.currentEffort:known?.defaultEffort||values[0];};
      model.onchange=fill;fill();if(this.session.provider==='deepseek'){manual.remove();if(model.value==='__custom__')model.value=model.options[0]?.value||'';const nativeFill=()=>{custom.hidden=true;const known=catalog.models?.find(m=>m.id===model.value),values=known?.efforts||[];effort.replaceChildren(new Option(BridgeI18n.t('默认'),''),...values.map(value=>new Option(value,value)));effort.value=values.includes(catalog.currentEffort)?catalog.currentEffort:known?.defaultEffort||'';effort.disabled=!values.length;};model.onchange=nativeFill;nativeFill();}modelLabel.append(model,custom);effortLabel.append(effort);
      const save=b(BridgeI18n.t('保存'),async()=>{save.disabled=true;try{const state=await this.request({action:'settings',id:child,model:model.value==='__custom__'?custom.value.trim():model.value,effort:effort.value});this.apply(state);dialog.close();}catch(e){status.textContent=BridgeI18n.t(e.message);}finally{save.disabled=false;}});
      dialog.append(head,n('p','muted',BridgeI18n.t('仅影响此侧边聊天，从下一轮生效。')),modelLabel,effortLabel,status,save);
      document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();
    }catch(e){this.status.textContent=BridgeI18n.t(e.message);this.controls();}
  }
  async load(){const revision=this.readRevision=(this.readRevision||0)+1;try{const state=await this.request();if(this.disposed||revision!==this.readRevision)return;this.apply(state);this.workbench.syncSideChats(this.session,state.slots);}catch(e){if(!this.disposed&&revision===this.readRevision){if(this.state?.id)this.apply({...this.state,connected:false,error:e.message});else this.status.textContent=BridgeI18n.t(e.message);this.controls();}}}
  async create(){
    if(this.disposed||this.busy||this.state?.id)return;this.readRevision=(this.readRevision||0)+1;this.busy=true;this.status.textContent=BridgeI18n.t('正在创建临时侧边聊天…');this.controls();
    try{this.apply(await this.request({action:'create',creationId:this.creationId,...(this.tab?.customTitle?{title:this.tab.customTitle}:{})}));}
    catch(e){if(!this.disposed)this.status.textContent=BridgeI18n.t(e.message);}
    finally{this.busy=false;this.controls();}
  }
  apply(state){
    if(this.disposed)return;
    // A missing/replaced ephemeral child cannot be resumed. Keep the old view
    // readable instead of turning its named tab back into a creation form.
    const child=this.state?.id||this.tab.titleChild;
    if(child&&(this.state?.expired||state.id!==child))state={...this.state,id:child,connected:false,expired:true,requests:[],slots:state.slots};
    if(child&&this.state?.id===state.id&&!state.connected&&!state.turns?.length&&this.state.turns?.length)state={...state,turns:this.state.turns};
    if(this.nativeModes&&state.id!==this.state?.id)this.nativeModes.open(JSON.stringify(['deepseek',this.session.id,this.tab.slot,state.id]));
    this.state=state;this.contextUsage.update(state);
    if(this.workbench.setSideChatTitle(this.session,this.tab,state)&&this.workbench.current===this.session)this.workbench.paint();
    this.updateCaption();
    if(state.id&&this.attachments.key!==state.id)this.attachments.open(state.id);
    if(state.id){this.modelButton.textContent=[state.model,state.effort].filter(Boolean).join(' · ')||BridgeI18n.t('模型与思考程度');delete this.modelButton.dataset.i18n;}
    if(!this.nativeModes&&!this.modeSelected)this.workMode.value=state.collaborationMode==='plan'?'plan':'default';
    const permission={'ask':'请求批准','auto-review':'帮我批准','full-access':'完全访问'}[state.permissionMode]||'权限';this.permissionsButton.textContent=BridgeI18n.t(permission);this.permissionsButton.dataset.i18n=permission;
    this.tab.body.classList.toggle('has-side-chat',!!state.id);
    if(this.pending&&state.submissions?.some(s=>s.id===this.pending.submissionId&&['accepted','queued'].includes(s.status))){
      this.completeSubmission();this.attachments.clear(state.id,this.pending.attachments);this.pending=null;this.references.close();this.resizeInput();
    }
    this.status.textContent=state.expired?BridgeI18n.t('此侧边聊天已失效，当前记录仅供只读查看，不能输入消息或添加选区内容。请新建侧边聊天继续。'):state.id&&!state.connected?BridgeI18n.t('侧边聊天已断开，已有记录仅供只读查看，暂时不能输入消息或添加选区内容。')+(state.error?' '+BridgeI18n.t(state.error):''):state.error||(!state.id?'':this.pending?BridgeI18n.t('发送结果未确认，请核对消息，避免重复发送。'):state.requests?.length?BridgeI18n.t('有请求需要处理'):state.status==='active'?BridgeI18n.t('正在回复…'):'');
    const stamp=JSON.stringify([state.id,state.connected,state.expired,state.turns]);
    if(stamp!==this.stamp){
      this.stamp=stamp;const scroll=this.messages.scrollTop,follow=this.following!==false&&this.messages.scrollHeight-this.messages.clientHeight-scroll<60,anchor=follow?null:this.readingAnchor();
      const expanded=new Map((this.messageNodes||[]).map(({key,node})=>[key,node.querySelector('details')?.open]));
      this.messages.replaceChildren();this.messageNodes=[];
      for(const [turnIndex,turn] of (state.turns||[]).entries()){for(const [messageIndex,message] of (turn.messages||[]).entries()){
        const turnId=turn.turnId||turn.id||String(turnIndex),key=JSON.stringify([state.id,turnId,message.id||messageIndex]);
        const card=this.workbench.node('article','wb-side-message '+message.role);
        if(['user','assistant','error'].includes(message.role)){
          card.append(this.workbench.node('small','',message.role==='user'?BridgeI18n.t('你'):message.role==='error'?BridgeI18n.t('执行错误'):this.session.provider==='deepseek'?'DeepSeek':'Codex'));
          const text=this.workbench.node('div','message-body');renderMarkdown(text,message.text||'');card.append(text);
          if(message.attachments?.length){const list=this.workbench.node('div','attachment-list');for(const file of message.attachments){
            const chip=this.workbench.node('div','attachment-chip');if(file.image){const image=this.workbench.node('img','attachment-thumb');image.src=this.uploadUrl(state.id,file.id,'preview');image.alt=file.name;image.dataset.imagePreview=image.src+'&variant=original';image.dataset.imageName=file.name;image.tabIndex=0;image.setAttribute('role','button');chip.append(image);}
            chip.append(this.workbench.raw(this.workbench.node('strong','',file.name)));list.append(chip);
          }card.append(list);}
        }else{
          const details=this.workbench.node('details');details.open=!!expanded.get(key);details.append(this.workbench.node('summary','',message.title||message.kind||BridgeI18n.t('工具活动')),this.workbench.node('pre','',message.output||message.text||''));card.append(details);
        }
        card.hidden=!SideChatPanel.messageVisible(message);this.messageNodes.push({node:card,message,key,turnId,turnStatus:turn.status});
      }if(turn.error){const message={role:'error'},node=this.workbench.node('p','error',BridgeI18n.t('本次回复未完成，请检查模型接入。'));this.messageNodes.push({node,message,key:'error:'+turnIndex});}}
      this.groupMessages();
      if(!this.messages.children.length)this.messages.append(this.workbench.node('p','wb-empty',state.expired?BridgeI18n.t('这段临时聊天的记录已不可用，无法恢复。'):state.connected?BridgeI18n.t('上下文已准备好，开始单独讨论。'):BridgeI18n.t('新建后即可在这里提问。')));
      this.messages.scrollTop=follow?this.messages.scrollHeight:scroll;
      const target=anchor&&this.messageNodes.find(row=>row.key===anchor.key);
      if(target)this.messages.scrollTop+=target.node.getBoundingClientRect().top-this.messages.getBoundingClientRect().top-anchor.offset;
      this.following=follow;this.lastMessageTop=this.messages.scrollTop;this.messageMap?.update();
    }
    this.renderApprovals(state.connected?state.requests||[]:[]);this.renderQueue(state.submissions||[]);this.controls();
    this.workbench.onSideChatActivity?.(this.session,state,this.workbench.isVisible(this.session,this.tab));
  }
  renderQueue(rows){
    const stamp=JSON.stringify([this.state?.connected,rows]);if(stamp===this.queueStamp)return;this.queueStamp=stamp;this.queued.replaceChildren();
    for(const row of rows.filter(r=>['queued','failed','unknown'].includes(r.status))){
      const card=this.workbench.node('div','queue-card');card.append(this.workbench.node('strong','',BridgeI18n.t(row.status==='queued'?'完成后发送':row.status==='failed'?'发送失败':'发送结果未确认')),this.workbench.raw(this.workbench.node('p','',row.text)));
      if(row.error)card.append(this.workbench.node('p','error',BridgeI18n.t(row.error)));
      if(row.status==='queued'&&this.state?.connected)card.append(this.workbench.button(BridgeI18n.t('取消'),()=>this.action('cancel-queued',{submissionId:row.id})));
      this.queued.append(card);
    }
  }
  renderApprovals(requests){
    const stamp=JSON.stringify(requests);if(stamp===this.approvalStamp)return;this.approvalStamp=stamp;this.approvals.replaceChildren();
    const n=(...args)=>this.workbench.node(...args);
    for(const request of requests){
      const card=n('form','wb-side-approval'),p=request.params||{},method=request.method,controls={};
      card.append(n('strong','',BridgeI18n.t('需要你的确认')));
      if(!request.supported){card.append(n('p','',p.message));this.approvals.append(card);continue;}
      for(const key of ['reason','command','cwd','message'])if(p[key])card.append(n(key==='command'?'pre':'p','',p[key]));
      if(p.changes)card.append(n('pre','',p.changes.map(c=>c.path+'\n'+(c.diff||'')).join('\n')));
      if(p.permissions)card.append(n('pre','',JSON.stringify(p.permissions,null,2)));
      const isInput=method.includes('requestUserInput'),isMcp=method==='mcpServer/elicitation/request';
      if(isInput)for(const q of p.questions||[]){
        const label=n('label','',q.question||q.header||q.id),input=n('textarea');label.dataset.answerKey=JSON.stringify([q.id,q]);input.rows=2;input.required=true;
        if(q.options?.length){const select=n('select');select.append(new Option(BridgeI18n.t('选择答案或自行填写'),''));for(const option of q.options)select.append(new Option(option.label,option.label));select.onchange=()=>{input.value=select.value;};label.append(select);}
        label.append(input);card.append(label);controls[q.id]=()=>input.value;
      }
      if(isMcp)for(const [key,field] of Object.entries(p.requestedSchema?.properties||{})){
        const label=n('label','',field.title||key);label.dataset.answerKey=JSON.stringify([key,field]);let input;
        if(field.enum){input=n('select');input.append(new Option(BridgeI18n.t('请选择…'),''));for(const value of field.enum)input.append(new Option(String(value),String(value)));}
        else{input=n('input');input.type=field.type==='boolean'?'checkbox':['number','integer'].includes(field.type)?'number':'text';if(input.type==='number')input.step=field.type==='integer'?'1':'any';}
        input.required=(p.requestedSchema.required||[]).includes(key)&&input.type!=='checkbox';label.append(input);card.append(label);
        controls[key]=()=>input.type==='checkbox'?input.checked:input.value===''?undefined:['number','integer'].includes(field.type)?Number(input.value):input.value;
      }
      const actions=n('div','wb-side-head'),error=n('p','error');
      const respond=async response=>{
        card.querySelectorAll('button').forEach(b=>b.disabled=true);
        try{this.apply(await this.request({action:'respond',id:this.state.id,requestId:request.id,response}));}
        catch(e){error.textContent=BridgeI18n.t(e.message);card.querySelectorAll('button').forEach(b=>b.disabled=false);}
      };
      const available=p.availableDecisions||['accept','decline'];
      const yes=n('button','',''+(isInput?BridgeI18n.t('提交回复'):BridgeI18n.t('本次允许')));yes.type='submit';if(isInput||isMcp||available.includes('accept'))actions.append(yes);
      if(!isInput&&available.includes('decline'))actions.append(this.workbench.button(BridgeI18n.t('拒绝'),()=>respond(isMcp?{action:'decline'}:{decision:'decline'})));
      card.onsubmit=e=>{e.preventDefault();if(isInput){const answers={};for(const [key,get] of Object.entries(controls)){const value=get();if(!value.trim()){error.textContent=BridgeI18n.t('请完整回答问题');return;}answers[key]=[value];}respond({answers});}
        else if(isMcp){const content={};for(const [key,get] of Object.entries(controls)){const value=get();if(value!==undefined)content[key]=value;}respond({action:'accept',content});}
        else respond({decision:'accept'});};
      card.append(actions,error);this.approvals.append(card);
      window.AnswerDrafts?.bind(card,{scope:[this.session.provider||'codex',this.session.host||'local','side',this.state.id,request.method,p.turnId||'',p.itemId||'',request.id],request:this.workbench.request});
    }
  }
  schedule(){
    clearTimeout(this.timer);if(this.disposed)return;
    this.timer=setTimeout(async()=>{try{if(!this.busy&&this.workbench.isVisible(this.session,this.tab)&&!document.hidden)await this.load();}finally{this.schedule();}},1200);
  }
  async send(){
    if(this.sendButton.disabled)return;
    let text;try{text=this.fileQuotes.validate();}catch(error){this.status.textContent=error.message;this.controls();return;}
    this.readRevision=(this.readRevision||0)+1;
    this.pendingDraft={raw:this.input.value,quotes:this.fileQuotes.rows.map(row=>row.id)};
    this.busy=true;this.pending={text,submissionId:uuid(),attachments:this.attachments.ids(),mode:this.sendMode.value,workMode:this.sendMode.value==='steer'||this.nativeModes&&this.state.status==='active'?null:this.workMode.value};const attachmentIds=this.pending.attachments;this.status.textContent=BridgeI18n.t('正在发送…');this.controls();
    try{const result=await this.request({action:'send',id:this.state.id,...this.pending});if(this.disposed)return;
      if(['accepted','queued'].includes(result.status)){this.attachments.clear(this.state.id,attachmentIds);this.completeSubmission();this.pending=null;this.references.close();this.resizeInput();await this.load();}
      else this.status.textContent=BridgeI18n.t('发送结果未确认，请核对消息，避免重复发送。');
    }catch(e){if(!this.disposed){if([400,401,403,404].includes(e.status))this.pending=null;this.status.textContent=BridgeI18n.t(e.message);}}
    finally{this.busy=false;this.controls();}
  }
  completeSubmission(){
    if(this.nativeModes)this.nativeModes.submitted(this.nativeModes.key,this.pending.workMode);
    if(this.input.value===(this.pendingDraft?.raw??this.pending.text))this.input.value='';
    this.fileQuotes.clear(this.fileQuotes.key,this.pendingDraft?.quotes||[]);this.pendingDraft=null;
  }
  async action(action,fields={},rethrow=false){if(this.busy||!this.state?.connected)return;this.readRevision=(this.readRevision||0)+1;this.busy=true;this.controls();try{this.apply(await this.request({action,id:this.state.id,...fields}));}catch(e){this.status.textContent=BridgeI18n.t(e.message);if(rethrow)throw e;}finally{this.busy=false;this.controls();}}
  async end(){
    if(this.busy)return false;if(!this.state?.id||this.state.expired)return true;
    if(!confirm(BridgeI18n.t(this.session.provider==='deepseek'?'结束此侧边聊天？正在运行的回复会停止，Harness 分叉记录会归档。':'结束此侧边聊天？正在运行的回复会停止，临时内容将清除，所有设备都无法继续此聊天。')))return false;
    this.readRevision=(this.readRevision||0)+1;
    this.busy=true;this.controls();
    try{await this.request({action:'close',id:this.state.id});this.apply({id:null,connected:false,turns:[],requests:[]});return true;}
    catch(e){this.status.textContent=BridgeI18n.t(e.message);return false;}
    finally{this.busy=false;this.controls();}
  }
  dispose(){this.visibilityObserver?.disconnect();this.messageMap?.dispose();this.messages.onscroll=null;this.contextUsage.dispose();this.disposed=true;this.renameDialog?.close();this.selectionAction.dispose();this.references.dispose();this.fileQuotes.close();clearTimeout(this.timer);this.input.value='';this.attachments.reset();this.messages.replaceChildren();}
}
