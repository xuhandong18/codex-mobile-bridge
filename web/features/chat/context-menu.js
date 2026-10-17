'use strict';

// One gesture implementation for touch/pen long presses and desktop context menus.
class ChatContextMenu {
  constructor(root,items,{touch=true,label='聊天操作'}={}){
    this.root=root;this.items=items;this.label=label;this.suppressUntil=0;this.touchAt=-Infinity;
    root.addEventListener('contextmenu',event=>{if(!touch&&(event.pointerType==='touch'||event.pointerType==='pen'||event.sourceCapabilities?.firesTouchEvents||!event.pointerType&&Date.now()-this.touchAt<1200))return;if(this.menu?.open||this.open(event.target,event.clientX,event.clientY))event.preventDefault();});
    root.addEventListener('pointerdown',event=>{
      this.cancel();if(event.pointerType==='touch'||event.pointerType==='pen')this.touchAt=Date.now();if(!touch||event.pointerType==='mouse'||!event.isPrimary)return;
      const {clientX:x,clientY:y,target}=event;this.origin={x,y};
      this.timer=setTimeout(()=>{this.timer=null;if(this.open(target,x,y))this.suppressUntil=Date.now()+900;},600);
    },{passive:true});
    root.addEventListener('pointermove',event=>{if(this.origin&&Math.hypot(event.clientX-this.origin.x,event.clientY-this.origin.y)>10)this.cancel();},{passive:true});
    for(const name of ['pointerup','pointercancel','scroll'])root.addEventListener(name,()=>this.cancel(),{passive:true,capture:true});
    root.addEventListener('click',event=>{if(Date.now()<this.suppressUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
  }
  cancel(){clearTimeout(this.timer);this.timer=null;this.origin=null;}
  open(target,x,y){
    if(document.querySelector('dialog[open]'))return false;
    const rows=this.items(target);if(!rows?.length)return false;
    this.cancel();document.querySelector('.chat-context-menu')?.remove();
    const menu=this.menu=document.createElement('dialog');menu.className='chat-context-menu picker';menu.setAttribute('aria-label',BridgeI18n.t(this.label));
    const close=()=>menu.close();
    for(const row of rows){
      const button=document.createElement('button');button.type='button';button.className='plain'+(row.copy?' message-copy':'');button.textContent=BridgeI18n.t(row.label);button.disabled=row.disabled===true;
      button.onclick=()=>{close();Promise.resolve().then(()=>row.run(button)).catch(error=>document.dispatchEvent(new CustomEvent('bridge-message-error',{detail:error.message})));};menu.append(button);
    }
    const cancel=document.createElement('button');cancel.type='button';cancel.className='plain';cancel.textContent=BridgeI18n.t('取消');cancel.onclick=close;menu.append(cancel);
    menu.addEventListener('click',event=>{if(event.target===menu)close();});menu.addEventListener('close',()=>{if(this.menu===menu)this.menu=null;menu.remove();},{once:true});document.body.append(menu);menu.showModal();
    menu.style.margin='0';menu.style.left=Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))+'px';
    return true;
  }
}

class NewChatDefaults {
  constructor(storage=localStorage){this.storage=storage;}
  read(scope){try{const value=JSON.parse(this.storage.getItem('new-chat-defaults:'+scope)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
  remember(scope,changes){try{this.storage.setItem('new-chat-defaults:'+scope,JSON.stringify({...this.read(scope),...changes}));}catch{}}
}

class NewChatSettings {
  constructor(form,{request,scope}){
    this.request=request;this.scope=scope;this.defaults=new NewChatDefaults();this.revision=0;
    const field=(label,node)=>{const row=document.createElement('label'),caption=document.createElement('span');caption.dataset.i18n=label;caption.textContent=BridgeI18n.t(label);row.append(caption,node);form.querySelector('#new-chat-error').before(row);return node;};
    this.model=field('模型',document.createElement('select'));this.model.id='new-chat-model';
    this.custom=field('自定义模型 ID',document.createElement('input'));this.custom.maxLength=200;this.custom.id='new-chat-custom-model';
    this.effort=field('推理强度',document.createElement('select'));this.effort.id='new-chat-effort';
    this.permission=field('权限',document.createElement('select'));this.permission.id='new-chat-permission';
    for(const [value,label] of [['','沿用 Codex 默认设置'],['ask','请求批准'],['auto-review','帮我批准'],['full-access','完全访问权限']])this.permission.append(this.option(label,value));
    this.model.onchange=()=>this.fillEfforts();
  }
  option(label,value){const option=new Option(BridgeI18n.t(label),value);option.dataset.i18n=label;return option;}
  async load(project,kind){
    const revision=++this.revision;this.loading=true;this.key=this.scope(project,kind);const saved=this.defaults.read(this.key);
    this.permission.value=saved.permission||'';this.custom.value=saved.model||'';this.rows=[];
    this.model.replaceChildren(this.option('沿用 Codex 默认设置',''));this.fillEfforts();
    this.model.disabled=true;this.permission.disabled=true;
    if(!project){this.loading=false;return;}
    try{
      const catalog=await this.request('/api/new-chat-models?project='+encodeURIComponent(project)+'&kind='+encodeURIComponent(kind));
      if(revision!==this.revision)return;
      this.rows=Array.isArray(catalog.models)?catalog.models:[];
      this.model.append(...this.rows.map(row=>new Option(row.name||row.id,row.id)),this.option('自定义模型…','__custom__'));
      this.model.value=saved.model?(this.rows.some(row=>row.id===saved.model)?saved.model:'__custom__'):'';this.fillEfforts(saved.effort);
    }catch{
      if(revision!==this.revision)return;
      this.model.append(this.option('自定义模型…','__custom__'));this.model.value=saved.model?'__custom__':'';this.fillEfforts(saved.effort);
    }finally{if(revision===this.revision){this.loading=false;this.model.disabled=false;this.permission.disabled=false;}}
  }
  fillEfforts(preferred=this.effort.value){
    this.custom.parentElement.hidden=this.model.value!=='__custom__';
    const row=this.rows.find(row=>row.id===this.model.value),values=row?.efforts?.length?row.efforts:['none','minimal','low','medium','high','xhigh','max','ultra'];
    this.effort.replaceChildren(...(this.model.value?values.map(value=>new Option(value,value)):[this.option('沿用 Codex 默认设置','')]));
    if(this.model.value)this.effort.value=values.includes(preferred)?preferred:values.includes(row?.defaultEffort)?row.defaultEffort:values.includes('medium')?'medium':values[0]||'';this.effort.disabled=!this.model.value;
  }
  value(){return {model:this.model.value==='__custom__'?this.custom.value.trim():this.model.value,effort:this.effort.value,permission:this.permission.value};}
  remember(value){this.defaults.remember(this.key,value);}
}

// The Android shell extends its own selection menu through capture/activate.
// Browsers and older shells retain a nearby toolbar without blocking selection.
class SelectedTextAction {
  constructor(root,{available,run,add,canAdd=()=>!!add,canExplain=()=>true,context=()=>''}){
    Object.assign(this,{root,available,run,add,canAdd,canExplain,context});this.revision=0;
    this.bar=document.createElement('div');this.bar.className='selection-actions';this.bar.hidden=true;this.bar.setAttribute('role','toolbar');
    const button=(label,action)=>{const node=document.createElement('button');node.type='button';node.className='selection-more';node.hidden=true;node.textContent=BridgeI18n.t(label);node.onclick=()=>this.activate(action,this.snapshot?.token);this.bar.append(node);return node;};
    this.addButton=button('添加到会话','add');this.button=button('在侧边聊天中了解更多','explain');
    this.bar.onpointerdown=event=>event.preventDefault();document.body.append(this.bar);
    const schedule=()=>{clearTimeout(this.timer);this.timer=setTimeout(()=>this.update(),160);};
    document.addEventListener('selectionchange',schedule);document.addEventListener('scroll',schedule,true);
    window.addEventListener('resize',schedule);window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
    document.addEventListener('pointerdown',event=>{if(!root.contains(event.target)&&!this.bar.contains(event.target)){this.bar.hidden=true;this.snapshot=null;}},{passive:true});
  }
  selected(){
    const selection=window.getSelection();if(!selection?.rangeCount||selection.isCollapsed)return '';
    const range=selection.getRangeAt(0),start=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement,end=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement;
    const body=start?.closest('.message-body, .activity-body');if(!body||!body.contains(end)||!this.root.contains(body))return '';
    const text=selection.toString();return text.trim()?text:'';
  }
  capture(){
    const text=this.available()?this.selected():'';
    if(!text){this.snapshot=null;return null;}
    const range=window.getSelection().getRangeAt(0),context=this.context(),old=this.snapshot;
    if(old&&old.text===text&&old.context===context&&old.range.startContainer===range.startContainer&&old.range.startOffset===range.startOffset&&old.range.endContainer===range.endContainer&&old.range.endOffset===range.endOffset)return old;
    return this.snapshot={text,context,range:range.cloneRange(),token:String(++this.revision)};
  }
  captureNative(){
    const snapshot=this.capture();this.nativeSnapshot=snapshot;this.nativeActive=!!snapshot;
    if(!snapshot)return {add:false,explain:false};
    this.bar.hidden=true;
    return {token:snapshot.token,add:this.canAdd(),explain:this.canExplain()};
  }
  releaseNative(token){if(this.nativeSnapshot?.token!==token)return;this.nativeSnapshot=null;this.nativeActive=false;this.update();}
  activate(action,token){
    const snapshot=token?(this.nativeSnapshot?.token===token?this.nativeSnapshot:this.snapshot?.token===token?this.snapshot:null):this.capture();
    if(!snapshot||!this.available()||snapshot.context!==this.context()||!this.root.contains(snapshot.range.startContainer)||!this.root.contains(snapshot.range.endContainer)||snapshot.range.toString()!==snapshot.text)return false;
    const selected=window.getSelection()?.toString();if(selected?.trim()&&selected!==snapshot.text)return false;
    if(action!=='add'&&action!=='explain'||action==='add'&&!this.canAdd()||action==='explain'&&!this.canExplain())return false;
    this.snapshot=null;this.nativeSnapshot=null;this.nativeActive=false;this.bar.hidden=true;
    try{(action==='add'?this.add:this.run)(snapshot.text);window.getSelection()?.removeAllRanges();return true;}
    catch(error){document.dispatchEvent(new CustomEvent('bridge-message-error',{detail:error.message}));return false;}
  }
  update(){
    if(this.nativeSnapshot&&(this.nativeSnapshot.context!==this.context()||!this.root.contains(this.nativeSnapshot.range.startContainer)||!this.root.contains(this.nativeSnapshot.range.endContainer))){this.nativeSnapshot=null;this.nativeActive=false;}
    const snapshot=this.capture();this.text=snapshot?.text||'';
    this.button.hidden=!this.text||!this.canExplain();this.addButton.hidden=!this.text||!this.canAdd();this.bar.hidden=this.nativeActive||this.button.hidden&&this.addButton.hidden;if(this.bar.hidden)return;
    const rect=window.getSelection().getRangeAt(0).getBoundingClientRect();this.button.textContent=BridgeI18n.t('在侧边聊天中了解更多');
    this.addButton.textContent=BridgeI18n.t('添加到会话');
    const viewport=window.visualViewport,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
    this.bar.style.left=Math.max(left+8,Math.min(rect.left,left+width-this.bar.offsetWidth-8))+'px';this.bar.style.top=Math.max(top+8,Math.min(rect.bottom+8,top+height-this.bar.offsetHeight-8))+'px';
  }
}
