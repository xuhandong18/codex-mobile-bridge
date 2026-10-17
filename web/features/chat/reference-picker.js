'use strict';

// References are editable draft text. There is no separate selection payload.
class ChatReferencePicker {
  static sequence=0;
  constructor({button,input,context,load,onInsert=()=>{}}){
    Object.assign(this,{button,input,context,load,onInsert});
    this.states=new Map();this.tab='skills';this.revision=0;
    button.onclick=()=>this.open();
  }
  static skillItem(skill){
    return {id:skill.id,title:skill.displayName||skill.name||skill.id,description:skill.description||'',
      value:skill.name?'$'+skill.name.replace(/^\$/,''):'',disabled:skill.selectable===false||skill.enabled===false||!skill.name};
  }
  static skillItems(result,offset=0){
    if(!Array.isArray(result.skills))throw Error(BridgeI18n.t('引用列表返回无效'));
    return {items:result.skills.map(ChatReferencePicker.skillItem),nextOffset:offset+result.skills.length<result.total?offset+result.skills.length:null,
      error:[...(result.errors||[]),result.refreshError].filter(Boolean).join('\n'),notice:['stale','legacy'].includes(result.cache?.state)?'正在显示缓存 Skill，后台会自动刷新。':''};
  }
  static fileItems(result,fallbackRoot=''){
    const candidate=result.root||fallbackRoot;
    const root=typeof candidate==='string'&&/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(candidate)?candidate:'';
    const windows=/^(?:[A-Za-z]:[\\/]|\\\\)/.test(root),separator=windows&&root.includes('\\')?'\\':'/';
    const prefix=root.replace(windows?/[\\/]$/:/\/$/,'');
    return {items:(result.entries||[]).map(entry=>{
      const parts=entry.path.split('/'),groups=parts.slice(0,-1).map((title,index)=>({
        id:'directory:'+parts.slice(0,index+1).join('/'),title,path:parts.slice(0,index+1).join('/'),kind:'directory'
      }));
      return {id:'directory:'+entry.path,title:entry.name,description:entry.path,kind:entry.kind,path:entry.path,groups,
        value:root?prefix+separator+entry.path.split('/').join(separator):'',
        disabled:entry.kind==='blocked'||entry.kind==='file'&&!root};
    }),nextOffset:result.nextOffset??null,project:root||result.project,error:root?'':'当前会话未提供可访问的项目完整目录',
      notice:result.truncated?'项目较大，搜索结果未全部列出，请缩小搜索范围。':''};
  }
  t(text){return BridgeI18n.t(text);}
  node(tag,className='',text){
    const node=document.createElement(tag);node.className=className;
    if(text!==undefined)node.textContent=text;return node;
  }
  control(text,run,className='plain'){
    const button=this.node('button',className,this.t(text));button.type='button';
    button.dataset.i18n=text;button.onclick=run;return button;
  }
  get active(){
    if(!this.states.has(this.tab))this.states.set(this.tab,{query:'',items:[],directories:new Map(),openGroups:new Map(),nextOffset:null,loaded:false});
    return this.states.get(this.tab);
  }
  current(){return this.dialog?.open&&this.target?.key===this.context()?.key;}
  cancel(){clearTimeout(this.searchTimer);this.revision++;this.controller?.abort();this.controller=null;}
  close(){this.cancel();if(this.dialog?.open)this.dialog.close();}
  dispose(){this.close();this.dialog?.remove();this.dialog=null;this.states.clear();this.target=null;}
  ensureDialog(){
    if(this.dialog)return;
    const id='reference-picker-'+(++ChatReferencePicker.sequence);
    this.dialog=this.node('dialog','picker reference-picker');this.dialog.id=id;
    const head=this.node('div','picker-head'),title=this.node('h2','',this.t('添加引用'));title.id=id+'-title';title.dataset.i18n='添加引用';
    this.dialog.setAttribute('aria-labelledby',title.id);
    const close=this.control('关闭',()=>this.close(),'icon-button');close.textContent='×';delete close.dataset.i18n;
    close.setAttribute('aria-label',this.t('关闭'));close.dataset.i18nAriaLabel='关闭';close.dataset.close=id;head.append(title,close);
    const hint=this.node('p','muted reference-hint',this.t('选择后直接插入输入框，随消息正文发送。'));hint.dataset.i18n='选择后直接插入输入框，随消息正文发送。';
    const tabs=this.node('div','reference-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',this.t('引用类型'));tabs.dataset.i18nAriaLabel='引用类型';this.tabButtons=new Map();
    for(const [kind,label] of [['skills','技能'],['files','项目文件'],['sessions','会话']]){
      const button=this.control(label,()=>this.setTab(kind));button.id=id+'-'+kind;button.dataset.referenceType=kind;
      button.setAttribute('role','tab');button.setAttribute('aria-controls',id+'-panel');
      button.onkeydown=event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        const enabled=[...this.tabButtons].filter(([,node])=>!node.disabled),index=enabled.findIndex(([key])=>key===kind);
        const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:(index+(event.key==='ArrowRight'?1:-1)+enabled.length)%enabled.length;
        event.preventDefault();enabled[next][1].focus();this.setTab(enabled[next][0]);
      };
      this.tabButtons.set(kind,button);tabs.append(button);
    }
    this.search=this.node('input','search reference-search');this.search.type='search';this.search.maxLength=200;
    this.search.setAttribute('aria-label',this.t('搜索引用'));this.search.dataset.i18nAriaLabel='搜索引用';
    this.search.oninput=()=>{
      this.cancel();const state=this.active;state.query=this.search.value.trim();state.loaded=false;state.items=[];state.directories.clear();
      this.list.replaceChildren();this.list.scrollTop=0;this.more.hidden=true;this.error.textContent='';
      this.searchTimer=setTimeout(()=>this.loadPage(),200);
    };
    this.fileOptions=this.node('label','reference-options');this.hiddenFiles=this.node('input');this.hiddenFiles.type='checkbox';
    const hiddenLabel=this.node('span','',this.t('显示隐藏文件'));hiddenLabel.dataset.i18n='显示隐藏文件';this.fileOptions.append(this.hiddenFiles,hiddenLabel);
    this.hiddenFiles.onchange=()=>{this.active.hidden=this.hiddenFiles.checked;this.active.loaded=false;return this.loadPage();};
    this.project=this.node('p','muted reference-project');
    this.list=this.node('div','reference-list');this.list.id=id+'-panel';this.list.setAttribute('role','tabpanel');
    this.list.onscroll=()=>{if(this.active.nextOffset!==null&&this.list.scrollHeight-this.list.clientHeight-this.list.scrollTop<160&&!this.loading)this.loadPage({append:true});};
    this.error=this.node('p','error');this.error.setAttribute('role','alert');
    this.notice=this.node('p','muted');this.notice.setAttribute('role','status');this.notice.setAttribute('aria-live','polite');
    const actions=this.node('div','picker-actions');
    this.refresh=this.control('刷新列表',()=>this.loadPage({refresh:true}));
    this.more=this.control('加载更多',()=>this.loadPage({append:true}));this.more.hidden=true;
    actions.append(this.refresh,this.more);this.dialog.append(head,hint,tabs,this.search,this.fileOptions,this.project,this.list,this.notice,this.error,actions);
    this.dialog.addEventListener('close',()=>{if(!this.dialog.open)this.cancel();});
    document.body.append(this.dialog);
  }
  async open(){
    const target=this.context();if(!target?.key||this.button.disabled||this.input.disabled)return;
    this.ensureDialog();
    if(this.target?.key!==target.key){this.states.clear();this.tab=target.canSkills===false?'files':'skills';}
    if(target.canSkills===false&&this.tab==='skills')this.tab='files';
    this.target=target;this.selection={value:this.input.value,start:this.input.selectionStart,end:this.input.selectionEnd};
    if(!this.dialog.open)this.dialog.showModal();
    return this.setTab(this.tab);
  }
  async setTab(kind){
    if(!this.current()||!this.tabButtons.has(kind)||kind==='skills'&&this.target.canSkills===false)return;
    this.cancel();this.tab=kind;this.loading=false;this.search.value=this.active.query;
    this.relabel();this.list.scrollTop=0;
    if(this.active.loaded){this.render();return;}
    return this.loadPage();
  }
  relabel(){
    if(!this.dialog)return;
    for(const [kind,button] of this.tabButtons){
      const selected=kind===this.tab;button.disabled=kind==='skills'&&this.target?.canSkills===false;
      button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
    }
    const placeholder=this.tab==='skills'?'搜索技能':this.tab==='files'?'搜索项目文件':'搜索会话或项目';
    this.search.placeholder=this.t(placeholder);this.search.dataset.i18nPlaceholder=placeholder;
    this.fileOptions.hidden=this.tab!=='files';this.hiddenFiles.checked=!!this.active.hidden;
    this.list.setAttribute('aria-labelledby',this.tabButtons.get(this.tab).id);
  }
  async loadPage({append=false,refresh=false}={}){
    if(!this.current())return;
    this.cancel();const revision=this.revision,state=this.active,kind=this.tab,target=this.target;
    const controller=this.controller=new AbortController();this.loading=true;state.error='';this.error.textContent='';
    if(!append){state.loaded=false;state.items=[];state.directories.clear();this.list.scrollTop=0;}
    this.render();
    try{
      const offset=append?state.nextOffset||0:0;
      const result=await this.load(kind,{target,query:state.query,offset,path:'',refresh,signal:controller.signal,hidden:!!state.hidden});
      if(!this.current()||revision!==this.revision)return;
      if(!Array.isArray(result?.items))throw Error(this.t('引用列表返回无效'));
      const previous=append?state.items:[],known=new Set(previous.map(item=>item.id));
      state.items=[...previous,...result.items.filter(item=>!known.has(item.id)&&known.add(item.id))];
      state.nextOffset=Number.isInteger(result.nextOffset)&&result.nextOffset>offset?result.nextOffset:null;
      state.project=result.project||'';state.notice=result.notice||'';state.error=result.error||'';state.loaded=true;
    }catch(error){if(this.current()&&revision===this.revision&&error.name!=='AbortError')state.error=error.message;}
    finally{if(this.current()&&revision===this.revision){this.loading=false;this.render();}}
  }
  async loadDirectory(item,{append=false,refresh=false}={}){
    if(!this.current()||this.tab!=='files'||this.active.query)return;
    const state=this.active,target=this.target,revision=this.revision;
    let directory=state.directories.get(item.path);
    if(directory?.loading)return;
    if(!directory){directory={items:[],nextOffset:null};state.directories.set(item.path,directory);}
    directory.loading=true;directory.error='';this.render();
    try{
      const result=await this.load('files',{target,query:'',path:item.path,offset:append?directory.nextOffset||0:0,refresh,signal:this.controller?.signal,hidden:!!state.hidden});
      if(!this.current()||revision!==this.revision)return;
      if(!Array.isArray(result?.items))throw Error(this.t('引用列表返回无效'));
      directory.items=append?[...directory.items,...result.items]:result.items;
      directory.nextOffset=result.nextOffset??null;directory.loaded=true;
    }catch(error){if(this.current()&&revision===this.revision&&error.name!=='AbortError')directory.error=error.message;}
    finally{directory.loading=false;if(this.current()&&revision===this.revision)this.render();}
  }
  tree(items){
    const root={children:new Map()};
    for(const item of items){
      let parent=root;
      for(const group of item.groups||[]){
        if(!parent.children.has(group.id))parent.children.set(group.id,{...group,children:new Map()});
        parent=parent.children.get(group.id);
      }
      if(item.kind==='directory'){
        const existing=parent.children.get(item.id);parent.children.set(item.id,{...existing,...item,children:existing?.children||new Map()});
      }else parent.children.set('item:'+item.id,{item});
    }
    return root;
  }
  render(){
    const state=this.active,scroll=this.list.scrollTop;
    this.list.replaceChildren();this.project.textContent=state.project||'';this.project.hidden=!state.project;
    this.error.textContent=this.t(state.error||'');this.notice.textContent=this.loading?this.t('正在读取…'):this.t(state.notice||'');
    this.refresh.disabled=this.loading;this.more.hidden=state.nextOffset===null;this.more.disabled=this.loading;
    this.list.setAttribute('aria-busy',String(this.loading));
    const items=[...state.items,...[...state.directories.values()].flatMap(directory=>directory.items)];
    const renderNode=(entry,parent)=>{
      if(entry.item){
        const item=entry.item,button=this.control('',()=>this.insert(item),'reference-item');delete button.dataset.i18n;
        button.disabled=!!item.disabled;button.dataset.referenceId=item.id;
        button.append(this.node('strong','',item.title),this.node('small','',item.description||item.value||''));parent.append(button);return;
      }
      const details=this.node('details','reference-group'),summary=this.node('summary','',entry.title),children=this.node('div','reference-children');
      details.dataset.referenceGroup=entry.id;details.open=state.openGroups.get(entry.id)??(entry.kind!=='directory'||!!state.query);
      details.append(summary,children);parent.append(details);
      for(const child of entry.children.values())renderNode(child,children);
      const directory=entry.kind==='directory'?state.directories.get(entry.path):null;
      if(directory?.loading)children.append(this.node('p','muted',this.t('正在读取…')));
      if(directory?.error){children.append(this.node('p','error',this.t(directory.error)),this.control('重试',()=>this.loadDirectory(entry)));}
      if(directory?.nextOffset!==null&&directory?.nextOffset!==undefined)children.append(this.control('加载更多',()=>this.loadDirectory(entry,{append:true})));
      if(directory?.loaded&&!directory.items.length)children.append(this.node('p','muted',this.t('目录为空')));
      details.ontoggle=()=>{
        if(details.isConnected===false||!this.current()||this.active!==state)return;
        state.openGroups.set(entry.id,details.open);
        if(details.open&&entry.kind==='directory'&&!state.query&&!directory?.loaded&&!directory?.loading&&!directory?.error)this.loadDirectory(entry);
      };
    };
    for(const entry of this.tree(items).children.values())renderNode(entry,this.list);
    if(!items.length&&!this.loading&&!state.error)this.list.append(this.node('p','muted',this.t('没有匹配的引用')));
    this.list.scrollTop=scroll;
  }
  insert(item){
    if(!this.current()||item.disabled||typeof item.value!=='string'||!item.value||this.button.disabled||this.input.disabled)return;
    const value=this.input.value,same=value===this.selection.value;
    const start=Math.min(value.length,same&&Number.isInteger(this.selection.start)?this.selection.start:value.length);
    const end=Math.min(value.length,same&&Number.isInteger(this.selection.end)?this.selection.end:start);
    const before=value.slice(0,start),after=value.slice(end),text=(before&&!/\s$/.test(before)?'\n':'')+item.value+(!after||!/^\s/.test(after)?'\n':'');
    if(this.input.maxLength>0&&before.length+text.length+after.length>this.input.maxLength){this.error.textContent=this.t('引用过长，已超出消息长度限制。');return;}
    this.input.value=before+text+after;this.close();this.input.focus();this.input.setSelectionRange?.(before.length+text.length,before.length+text.length);
    this.input.dispatchEvent(new Event('input',{bubbles:true}));this.onInsert();
  }
}

globalThis.ChatReferencePicker=ChatReferencePicker;
