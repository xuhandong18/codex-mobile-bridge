'use strict';

class ProjectFolderBrowser {
  static sequence=0;
  static attempts=new Map();
  constructor({button,input,request,context=()=>({key:'project'}),uuid,canCreate=()=>true,onSelect=()=>{}}){
    Object.assign(this,{button,input,request,context,uuid,canCreate,onSelect});
    this.generation=0;this.directories=[];this.roots=[];this.currentPath='';this.currentParent=null;
    button.onclick=()=>this.open();
  }
  t(source){return BridgeI18n.t(source);}
  node(tag,className='',text){const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;}
  icon(kind){
    const paths={folder:'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
      home:'m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10',computer:'M3 4h18v13H3zM8 21h8m-4-4v4',drive:'M5 4h14l3 13v3H2v-3Zm-3 13h20M6 17h.01M10 17h.01',
      up:'m5 12 7-7 7 7M12 5v15',refresh:'M20 8a8 8 0 1 0 0 8M20 3v5h-5',plus:'M12 5v14M5 12h14',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
      chevron:'m9 5 7 7-7 7',edit:'m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z',check:'m5 12 4 4L19 6',close:'m6 6 12 12M6 18 18 6'};
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.6');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[kind]||paths.folder);svg.append(path);return svg;
  }
  control(label,run,kind,className='plain',translate=true){
    const button=this.node('button',className),text=translate?this.t(label):label;button.type='button';button.setAttribute('aria-label',text);button.title=text;
    if(translate){button.dataset.i18nAriaLabel=label;button.dataset.i18nTitle=label;}
    if(kind)button.append(this.icon(kind));const caption=this.node('span','',text);if(translate)caption.dataset.i18n=label;button.append(caption);button.onclick=run;return button;
  }
  static trail(value){
    if(!value)return [];
    const windows=/^(?:[A-Za-z]:[\\/]|\\\\)/.test(value),sep=windows&&value.includes('\\')?'\\':'/';
    let anchor,rest;
    if(windows&&/^\\\\/.test(value)){
      const match=value.match(/^(\\\\[^\\]+\\[^\\]+)(?:\\|$)/);if(!match)return [{name:value,path:value}];anchor=match[1]+sep;rest=value.slice(match[0].length);
    }else if(windows){anchor=value.slice(0,3);rest=value.slice(3);}
    else{anchor='/';rest=value.slice(1);}
    const parts=rest.split(sep).filter(Boolean),trail=[{name:anchor.replace(/[\\/]$/,'')||'/',path:anchor}];let path=anchor;
    for(const name of parts){path+=(path.endsWith(sep)?'':sep)+name;trail.push({name,path});}
    return trail;
  }
  key(parent,name){return (window.BridgeRelayBase||location.origin||'gateway')+'|'+JSON.stringify([parent,name]);}
  attempt(parent,name){
    const key=this.key(parent,name);if(ProjectFolderBrowser.attempts.has(key))return ProjectFolderBrowser.attempts.get(key);
    try{const value=JSON.parse(sessionStorage.getItem('project-folder:'+key)||'null');if(value?.id&&value.parent===parent&&value.name===name){ProjectFolderBrowser.attempts.set(key,value);return value;}}catch{}
    return null;
  }
  remember(attempt){
    const key=this.key(attempt.parent,attempt.name);ProjectFolderBrowser.attempts.set(key,attempt);
    try{sessionStorage.setItem('project-folder:'+key,JSON.stringify(attempt));}catch{}
  }
  current(){return this.dialog?.open&&this.context()?.key===this.target?.key;}
  ensure(){
    if(this.dialog)return;
    const id='project-folder-picker-'+(++ProjectFolderBrowser.sequence);
    this.dialog=this.node('dialog','picker project-folder-picker');this.dialog.id=id;
    const head=this.node('div','picker-head pf-head'),identity=this.node('div','pf-heading'),badge=this.node('span','pf-badge');badge.append(this.icon('folder'));
    const titles=this.node('div'),title=this.node('h2','',this.t('选择项目文件夹'));title.id=id+'-title';title.dataset.i18n='选择项目文件夹';
    const hint=this.node('p','muted pf-hint',this.t('选择存放项目的位置，也可以在这里新建文件夹。'));hint.dataset.i18n='选择存放项目的位置，也可以在这里新建文件夹。';titles.append(title,hint);identity.append(badge,titles);
    this.closeButton=this.control('关闭',()=>this.close(),'close','icon-button pf-icon-button');head.append(identity,this.closeButton);this.dialog.setAttribute('aria-labelledby',title.id);
    const body=this.node('div','pf-body');this.shortcuts=this.node('nav','pf-shortcuts');this.shortcuts.setAttribute('aria-label',this.t('常用位置'));this.shortcuts.dataset.i18nAriaLabel='常用位置';
    const main=this.node('div','pf-main'),navigation=this.node('div','pf-navigation');
    this.upButton=this.control('上一级文件夹',()=>this.navigate(this.currentParent||''),'up','pf-icon-button');
    this.refreshButton=this.control('刷新文件夹',()=>this.navigate(this.currentPath),'refresh','pf-icon-button');
    this.breadcrumbs=this.node('nav','pf-breadcrumbs');this.breadcrumbs.setAttribute('aria-label',this.t('当前文件夹路径'));this.breadcrumbs.dataset.i18nAriaLabel='当前文件夹路径';
    this.editButton=this.control('输入完整路径',()=>this.editAddress(),'edit','pf-icon-button');navigation.append(this.upButton,this.refreshButton,this.breadcrumbs,this.editButton);
    this.addressRow=this.node('div','pf-address-row');this.addressRow.hidden=true;this.address=this.node('input');this.address.type='text';this.address.maxLength=4096;this.address.setAttribute('aria-label',this.t('文件夹完整路径'));this.address.dataset.i18nAriaLabel='文件夹完整路径';
    this.goButton=this.control('前往',()=>this.navigate(this.address.value.trim()),'chevron','plain');this.addressRow.append(this.address,this.goButton);
    this.address.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();this.navigate(this.address.value.trim());}if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.addressRow.hidden=true;this.editButton.focus();}};
    const tools=this.node('div','pf-tools'),searchBox=this.node('div','pf-search-box');searchBox.append(this.icon('search'));this.search=this.node('input');this.search.type='search';this.search.placeholder=this.t('搜索当前文件夹');this.search.dataset.i18nPlaceholder='搜索当前文件夹';this.search.setAttribute('aria-label',this.t('搜索当前文件夹'));this.search.dataset.i18nAriaLabel='搜索当前文件夹';this.search.oninput=()=>this.renderList();searchBox.append(this.search);
    this.newFolderButton=this.control('新建文件夹',()=>this.showCreateForm(),'plus','plain pf-new-folder');tools.append(searchBox,this.newFolderButton);
    this.createPanel=this.node('div','pf-create-panel');this.createPanel.hidden=true;
    const createField=this.node('label','pf-create-field'),createCaption=this.node('span','',this.t('文件夹名称'));createCaption.dataset.i18n='文件夹名称';this.folderName=this.node('input');this.folderName.type='text';this.folderName.maxLength=120;this.folderName.autocomplete='off';this.folderName.placeholder=this.t('输入新文件夹名称');this.folderName.dataset.i18nPlaceholder='输入新文件夹名称';createField.append(createCaption,this.folderName);
    this.folderName.oninput=()=>this.renderCreate();this.folderName.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();this.createDirectory();}};
    const createActions=this.node('div','pf-create-actions');this.folderCancel=this.control('取消',()=>{this.createPanel.hidden=true;this.newFolderButton.focus();});
    this.checkButton=this.control('核对创建结果',()=>this.checkAttempt());this.checkButton.hidden=true;this.folderCreate=this.control('创建文件夹',()=>this.createDirectory(),'plus','pf-create-submit');createActions.append(this.checkButton,this.folderCancel,this.folderCreate);
    this.createStatus=this.node('p','muted pf-create-status');this.createStatus.setAttribute('role','status');this.createStatus.setAttribute('aria-live','polite');this.createPanel.append(createField,this.createStatus,createActions);
    const listHead=this.node('div','pf-list-head'),caption=this.node('span','',this.t('文件夹'));caption.dataset.i18n='文件夹';this.count=this.node('span');listHead.append(caption,this.count);
    this.list=this.node('div','pf-list');this.list.setAttribute('aria-label',this.t('文件夹列表'));this.list.dataset.i18nAriaLabel='文件夹列表';this.status=this.node('p','pf-status');this.status.setAttribute('role','status');this.status.setAttribute('aria-live','polite');
    this.error=this.node('p','error pf-error');this.error.setAttribute('role','alert');
    main.append(navigation,this.addressRow,tools,this.createPanel,listHead,this.list,this.status,this.error);body.append(this.shortcuts,main);
    const footer=this.node('div','pf-footer'),selection=this.node('div','pf-selection'),selectionCaption=this.node('span','',this.t('当前选择'));selectionCaption.dataset.i18n='当前选择';this.selectedPath=this.node('strong');selection.append(selectionCaption,this.selectedPath);
    const actions=this.node('div','pf-footer-actions');this.cancelButton=this.control('取消',()=>this.close(),'','secondary');this.selectButton=this.control('选择此文件夹',()=>this.select(),'check','primary');actions.append(this.cancelButton,this.selectButton);footer.append(selection,actions);
    this.dialog.append(head,body,footer);this.dialog.addEventListener('cancel',event=>{event.preventDefault();this.close();});
    this.dialog.addEventListener('close',()=>{if(!this.dialog.open)this.close();});
    this.dialog.addEventListener('keydown',event=>{if(event.altKey&&event.key==='ArrowUp'){event.preventDefault();if(!this.loading&&!this.writing)this.navigate(this.currentParent||'');}});
    document.body.append(this.dialog);
  }
  async open(){
    if(this.locked||this.button.disabled||this.button.isConnected===false)return;
    this.ensure();this.target=this.context();if(!this.target)return;
    this.createPanel.hidden=true;this.search.value='';this.error.textContent='';this.createStatus.textContent='';
    if(!this.dialog.open)this.dialog.showModal();
    const path=this.input.value.trim()||this.target.cwd||'';
    if(!this.roots.length&&path){this.loadRoots();}
    return this.navigate(path);
  }
  close(){
    if(this.activeAttempt&&this.writing){this.activeAttempt.status='unknown';this.remember(this.activeAttempt);this.writing=false;this.activeAttempt=null;}
    ++this.generation;this.controller?.abort();if(this.dialog?.open)this.dialog.close();
  }
  setLocked(value){this.locked=value;this.button.disabled=value;if(value)this.close();}
  async loadRoots(){
    const target=this.target;
    try{const value=await this.request('/api/project-directories?path=');if(!this.current()||target!==this.target)return;this.roots=value.directories||[];this.renderShortcuts();}catch{}
  }
  async navigate(path){
    if(!this.current()||this.writing||this.locked)return;
    const generation=++this.generation;this.controller?.abort();const controller=this.controller=new AbortController();
    this.requestedPath=path;
    this.loading=true;this.failed=false;this.error.textContent='';this.search.value='';this.createPanel.hidden=true;this.status.textContent=this.t('正在读取文件夹…');this.renderControls();this.renderList();
    try{
      const value=await this.request('/api/project-directories?path='+encodeURIComponent(path),undefined,controller.signal);
      if(!this.current()||generation!==this.generation)return;
      if(typeof value.path!=='string'||!Array.isArray(value.directories))throw Error(this.t('文件夹列表返回无效'));
      this.currentPath=value.path;this.currentParent=value.parent;this.directories=value.directories;
      if(!value.path)this.roots=value.directories;
      this.address.value=value.path;this.addressRow.hidden=true;this.renderShortcuts();this.renderBreadcrumbs();
    }catch(error){if(this.current()&&generation===this.generation&&error.name!=='AbortError'){this.failed=true;this.error.textContent=this.t(error.message);}}
    finally{if(this.current()&&generation===this.generation){this.loading=false;this.status.textContent='';this.renderControls();this.renderList();}}
  }
  renderShortcuts(){
    this.shortcuts.replaceChildren();const heading=this.node('span','pf-shortcuts-heading',this.t('常用位置'));heading.dataset.i18n='常用位置';this.shortcuts.append(heading);
    const entry=(name,path,icon,translate=false)=>{
      const button=this.control(name,()=>this.navigate(path),icon,'pf-shortcut',translate);button.dataset.path=path;button.setAttribute('aria-current',String(this.currentPath===path));
      this.shortcuts.append(button);
    };
    entry('此电脑','','computer',true);
    this.roots.forEach((row,index)=>entry(index===0?'用户目录':row.name,row.path,index===0?'home':'drive',index===0));
    if(this.target.cwd&&!this.roots.some(row=>row.path===this.target.cwd))entry('当前项目',this.target.cwd,'folder',true);
  }
  renderBreadcrumbs(){
    this.breadcrumbs.replaceChildren();const home=this.control('此电脑',()=>this.navigate(''),'computer','pf-crumb pf-crumb-home');this.breadcrumbs.append(home);
    for(const crumb of ProjectFolderBrowser.trail(this.currentPath)){
      this.breadcrumbs.append(this.icon('chevron'));this.breadcrumbs.append(this.control(crumb.name,()=>this.navigate(crumb.path),'','pf-crumb',false));
    }
    this.breadcrumbs.scrollLeft=this.breadcrumbs.scrollWidth;
  }
  editAddress(){if(this.loading||this.writing)return;this.addressRow.hidden=!this.addressRow.hidden;if(!this.addressRow.hidden){this.address.value=this.currentPath;this.address.focus();this.address.select();}}
  renderList(){
    this.list.replaceChildren();this.list.setAttribute('aria-busy',String(this.loading));
    const query=this.search.value.trim().toLocaleLowerCase(),rows=this.directories.filter(row=>[row.name,row.path].join(' ').toLocaleLowerCase().includes(query));
    this.count.textContent=this.loading?'':String(rows.length);
    if(this.loading||this.failed||!rows.length){
      const empty=this.node('div','pf-empty');empty.append(this.icon(this.loading?'refresh':'folder'));
      const title=this.loading?'正在读取文件夹…':this.failed?'文件夹暂不可用':query?'没有匹配的文件夹':this.currentPath?'这个文件夹还是空的':'请选择一个位置';
      const heading=this.node('strong','',this.t(title));empty.append(heading);
      if(!this.loading&&!this.failed){const hint=query?'试试其他名称，或清空搜索。':this.currentPath?'可以选择当前文件夹，或新建一个文件夹。':'从常用位置或磁盘开始浏览。';empty.append(this.node('span','',this.t(hint)));}
      if(this.failed)empty.append(this.control('重试',()=>this.navigate(this.requestedPath)));
      this.list.append(empty);return;
    }
    for(const row of rows){
      const button=this.node('button','pf-folder-row');button.type='button';button.dataset.path=row.path;button.disabled=!!this.writing;
      const icon=this.node('span','pf-folder-icon');icon.append(this.icon(/^[A-Za-z]:[\\/]?$/.test(row.path)?'drive':'folder'));
      const info=this.node('span','pf-folder-info');info.append(this.node('strong','',row.name),this.node('small','',row.path));button.append(icon,info,this.icon('chevron'));button.onclick=()=>this.navigate(row.path);this.list.append(button);
    }
  }
  renderControls(){
    const busy=this.loading||this.writing||this.locked;
    this.upButton.disabled=busy||this.currentParent===null;this.refreshButton.disabled=busy;this.editButton.disabled=busy;this.goButton.disabled=busy;this.search.disabled=busy;
    this.newFolderButton.disabled=busy||this.failed||!this.currentPath||!this.canCreate();this.selectButton.disabled=busy||this.failed||!this.currentPath;
    this.selectedPath.textContent=this.currentPath||this.t('尚未选择文件夹');this.selectedPath.title=this.currentPath;
    for(const button of this.shortcuts.children)if(button.tagName==='BUTTON')button.disabled=!!busy;
    for(const button of this.breadcrumbs.children)if(button.tagName==='BUTTON')button.disabled=!!busy;
  }
  select(){
    if(!this.current()||this.selectButton.disabled)return;
    const path=this.currentPath;this.input.value=path;this.input.dispatchEvent(new Event('input',{bubbles:true}));this.onSelect(path);this.close();this.button.focus();
  }
  showCreateForm(){
    if(!this.current()||this.newFolderButton.disabled)return;
    this.addressRow.hidden=true;this.createPanel.hidden=false;this.folderName.value='';this.createStatus.textContent='';this.renderCreate();this.folderName.focus();
  }
  renderCreate({preserveMessage=false}={}){
    const name=this.folderName.value.trim(),attempt=this.attempt(this.currentPath,name),unconfirmed=attempt&&['pending','creating','unknown'].includes(attempt.status);
    this.folderName.disabled=!!this.writing;this.folderCancel.disabled=!!this.writing;this.folderCreate.disabled=!!this.writing||!name||!!unconfirmed;
    this.checkButton.hidden=!unconfirmed;this.checkButton.disabled=!!this.writing;
    if(!preserveMessage){
      if(unconfirmed&&!this.writing)this.createStatus.textContent=this.t('创建结果尚未确认，请核对结果或刷新目录，不要重复创建。');
      else if(!this.writing)this.createStatus.textContent='';
    }
  }
  async createDirectory(){
    if(!this.current()||this.writing||this.locked||!this.canCreate()||!this.currentPath)return;
    const name=this.folderName.value.trim();if(!name)return;
    const prior=this.attempt(this.currentPath,name);
    if(prior&&['pending','creating','unknown','completed'].includes(prior.status))return this.checkAttempt(prior);
    if(/[<>:"/\\|?*\x00-\x1f]/.test(name)||['.','..'].includes(name)||name.endsWith('.')||name.length>120){this.createStatus.textContent=this.t('请输入有效的单层文件夹名称。');return;}
    const attempt={id:this.uuid(),parent:this.currentPath,name,status:'pending'};
    if(this.target.contextId)attempt.contextId=this.target.contextId;
    this.remember(attempt);return this.runAttempt(attempt,true);
  }
  checkAttempt(attempt){
    if(!this.current()||this.writing)return;
    attempt=attempt||this.attempt(this.currentPath,this.folderName.value.trim());if(!attempt)return;
    return this.runAttempt(attempt,false);
  }
  async runAttempt(attempt,submit){
    const generation=this.generation;this.writing=true;this.activeAttempt=attempt;this.renderControls();this.renderCreate();this.renderList();this.createStatus.textContent=this.t(submit?'正在创建文件夹…':'正在核对创建结果…');
    try{
      const body={id:attempt.id,parent:attempt.parent,name:attempt.name,...(attempt.contextId?{contextId:attempt.contextId}:{})};
      let result=await this.request(submit?'/api/project-directories':'/api/project-directory-operations?id='+encodeURIComponent(attempt.id),submit?body:undefined);
      while(true){
        if(!result||result.id!==attempt.id||!['pending','creating','completed','failed','unknown'].includes(result.status))throw Error(this.t('文件夹创建回执无效，无法确认结果。'));
        attempt.status=result.status;attempt.message=result.message||'';this.remember(attempt);
        if(!this.current()||generation!==this.generation)return;
        if(!['pending','creating'].includes(result.status))break;
        this.createStatus.textContent=this.t(result.message||'正在创建文件夹…');await new Promise(resolve=>setTimeout(resolve,1000));
        if(!this.current()||generation!==this.generation)return;
        result=await this.request('/api/project-directory-operations?id='+encodeURIComponent(attempt.id));
      }
      if(result.status==='completed'){
        const directory=result.directory;
        if(!directory||typeof directory.path!=='string'||!directory.path||directory.parent!==attempt.parent||directory.name!==attempt.name)throw Error(this.t('文件夹创建回执无效，无法确认结果。'));
        this.writing=false;this.activeAttempt=null;this.createPanel.hidden=true;const navigationGeneration=this.generation+1;await this.navigate(directory.path);
        if(this.current()&&this.generation===navigationGeneration){this.status.textContent=this.t('文件夹已创建，可以选择此文件夹。');this.selectButton.focus();}
      }else this.createStatus.textContent=this.t(result.message||'创建结果尚未确认，请核对结果或刷新目录，不要重复创建。');
    }catch(error){
      attempt.status=submit&&[400,401,403,404,409].includes(error.status)?'failed':'unknown';attempt.message=error.message;this.remember(attempt);
      if(this.current()&&generation===this.generation)this.createStatus.textContent=this.t(error.message)+(attempt.status==='unknown'?' '+this.t('创建结果尚未确认，请核对结果或刷新目录，不要重复创建。'):'');
    }finally{
      if(generation===this.generation){this.writing=false;this.activeAttempt=null;if(this.current()){this.renderControls();this.renderCreate({preserveMessage:true});this.renderList();}}
    }
  }
}

globalThis.ProjectFolderBrowser=ProjectFolderBrowser;
