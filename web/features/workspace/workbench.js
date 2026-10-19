'use strict';

class Workbench {
  constructor({chat, request, csrf, notify, onUnauthorized, openChat, loadReferences}) {
    Object.assign(this, {chat, request, csrf, notify, onUnauthorized, openChat, loadReferences});
    window.BridgeFileActions?.register(chat,this);
    this.sessions = new Map();
    this.scrollPositions = new WeakMap();
    this.strip = this.node('nav', 'workbench-tabs'); this.strip.dataset.i18nAriaLabel='工作台标签';this.strip.setAttribute("data-i18n-aria-label",'工作台标签');this.strip.setAttribute('aria-label', BridgeI18n.t('工作台标签'));
    this.tabs = this.node('div', 'wb-tabs'); this.tabs.setAttribute('role', 'tablist');
    const add = this.button('＋', () => this.newTab(), BridgeI18n.t('新标签页')); add.className = 'wb-add';
    this.mainLabel=this.button('主会话',()=>{this.chat.querySelector('.timeline').focus();},'主会话');this.mainLabel.className='wb-main-label';
    this.toolStrip=this.node('div','wb-tool-strip');this.toolStrip.append(this.tabs,add);this.strip.append(this.mainLabel,this.toolStrip);
    const plus=document.createElementNS('http://www.w3.org/2000/svg','svg');plus.setAttribute('viewBox','0 0 24 24');plus.setAttribute('aria-hidden','true');plus.innerHTML='<path d="M12 5v14M5 12h14"/>';add.replaceChildren(plus);
    this.panel = this.node('section', 'workbench-panel'); this.panel.hidden = true;
    this.layout = this.node('div', 'wb-layout');
    this.mainPane = this.node('div', 'wb-main-pane');
    for (const child of [...chat.children]) if (!child.matches('.chat-head')) this.mainPane.append(child);
    this.divider = this.node('div', 'wb-divider'); this.divider.tabIndex=0;
    this.divider.setAttribute('role','separator'); this.divider.setAttribute('aria-orientation','vertical');
    this.divider.dataset.i18nAriaLabel='调整分屏宽度'; this.divider.setAttribute('aria-label',BridgeI18n.t('调整分屏宽度'));
    this.dropZone = this.node('div','wb-split-drop','拖到这里，在右侧打开');
    this.layout.append(this.mainPane,this.divider,this.panel,this.dropZone);
    chat.querySelector('.chat-head').after(this.strip,this.layout);
    this.bindTabSwipe();
    this.splitButton=this.button('',()=>this.splitMode?this.unsplit():this.split(this.current?.active),'在右侧分屏');
    this.splitButton.className='wb-split-button';this.toolStrip.append(this.splitButton);
    const splitIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');splitIcon.setAttribute('viewBox','0 0 24 24');splitIcon.setAttribute('aria-hidden','true');splitIcon.innerHTML='<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>';this.splitButton.append(splitIcon);
    this.divider.onpointerdown=event=>{
      if(event.button!==0||!this.splitMode)return;
      event.preventDefault();this.divider.setPointerCapture(event.pointerId);this.layout.classList.add('wb-resizing');
    };
    this.divider.onpointermove=event=>{
      if(this.divider.hasPointerCapture(event.pointerId)){const bounds=this.layout.getBoundingClientRect();this.setRatio((event.clientX-bounds.left)/bounds.width);}
    };
    this.divider.onpointerup=event=>{if(this.divider.hasPointerCapture(event.pointerId))this.divider.releasePointerCapture(event.pointerId);};
    this.divider.onlostpointercapture=()=>this.layout.classList.remove('wb-resizing');
    this.divider.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home'].includes(event.key)){event.preventDefault();this.setRatio(event.key==='Home'?.5:(this.current.splitRatio??.5)+(event.key==='ArrowLeft'?-.025:.025));}};
    this.dropZone.ondragover=event=>{if(this.dragTab&&this.canSplit()){event.preventDefault();event.dataTransfer.dropEffect='move';}};
    this.dropZone.ondrop=event=>{event.preventDefault();if(this.dragTab)this.split(this.dragTab);this.endDrag();};
    this.resizeObserver=new ResizeObserver(()=>{const eligible=this.canSplit();if(eligible!==this.splitEligible){this.rememberScroll();this.paint();}else if(this.splitMode)this.setRatio(this.current.splitRatio??.5,false);});
    this.resizeObserver.observe(chat);
    this.mobileObserver=new MutationObserver(()=>this.paint());this.mobileObserver.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
    const input=chat.querySelector('.composer').querySelector('textarea');
    this.fileQuotes=new FileQuoteDrafts({input,onChange:()=>input.dispatchEvent(new Event('input',{bubbles:true}))});
    this.selectionTargets=new ChatSelectionTargets(this);
    this.fileSelection=new FileSelectionAction(this);
    document.addEventListener('visibilitychange',()=>this.refreshSideChats());
  }
  bindTabSwipe() {
    let gesture=null,suppressUntil=0;
    const eligible=tab=>tab&&(tab.id==='chat'||tab.id==='git'||tab.id==='agents'||!!tab.sideChat);
    const source=target=>{
      const session=this.current;if(!session||document.querySelector('dialog[open]'))return null;
      const composer=target.closest('.composer');
      if(composer&&this.mainPane.contains(composer)&&!this.isFileVisible)return {session,id:'chat',root:composer};
      const tab=session.files.find(tab=>tab.id===(this.splitMode?session.splitTab:session.active));
      if(!eligible(tab)||!tab.body.contains(target))return null;
      if(tab.sideChat)return composer===tab.sideChat.form?{session,id:tab.id,root:composer}:null;
      // Git and agents own the whole page; native editing, resizing and horizontal scrolling keep priority.
      if(target.closest('input,textarea,select,[contenteditable="true"],.wb-float-grip,.wb-float-resize'))return null;
      for(let node=target;node&&node!==tab.body;node=node.parentElement){
        if(node.scrollWidth>node.clientWidth+1&&['auto','scroll'].includes(getComputedStyle(node).overflowX))return null;
      }
      return {session,id:tab.id,root:tab.body};
    };
    const selecting=root=>{
      const input=root.querySelector('textarea');
      return !!window.getSelection()?.toString()||!!(input&&document.activeElement===input&&input.selectionStart!==input.selectionEnd);
    };
    const valid=start=>{
      const current=source(start.target);
      return current&&current.session===start.session&&current.id===start.id&&current.root===start.root&&
        start.root.isConnected&&start.session.active===start.active&&start.session.splitTab===start.splitTab&&
        Date.now()-start.time<600&&!selecting(start.root);
    };
    this.layout.addEventListener('touchstart',event=>{
      const origin=source(event.target),touch=event.touches[0];
      gesture=origin&&event.touches.length===1&&!selecting(origin.root)
        ?{...origin,target:event.target,touch:touch.identifier,x:touch.clientX,y:touch.clientY,time:Date.now(),
          active:origin.session.active,splitTab:origin.session.splitTab}:null;
    },{passive:true});
    this.layout.addEventListener('touchmove',event=>{
      if(!gesture)return;
      const touch=[...event.touches].find(touch=>touch.identifier===gesture.touch);
      if(event.touches.length!==1||!touch||!valid(gesture)){gesture=null;return;}
      const dx=touch.clientX-gesture.x,dy=touch.clientY-gesture.y;
      if(Math.abs(dy)>10&&Math.abs(dy)>=Math.abs(dx)){gesture=null;return;}
      if(Math.abs(dx)>12&&Math.abs(dx)>Math.abs(dy)*1.5&&event.cancelable)event.preventDefault();
    },{passive:false});
    this.layout.addEventListener('touchend',event=>{
      const start=gesture;gesture=null;
      if(!start||event.touches.length||!valid(start))return;
      const touch=[...event.changedTouches].find(touch=>touch.identifier===start.touch);if(!touch)return;
      const dx=touch.clientX-start.x,dy=touch.clientY-start.y;
      if(Math.abs(dx)<50||Math.abs(dx)<=Math.abs(dy)*1.5)return;
      // Never filter the tab order: a file or terminal between eligible tabs blocks the gesture.
      const tabs=[{id:'chat'},...start.session.files],index=tabs.findIndex(tab=>tab.id===start.id);
      const next=tabs[index+(dx<0?1:-1)];
      suppressUntil=Date.now()+400;if(event.cancelable)event.preventDefault();
      if(eligible(next))this.select(next.id);
    },{passive:false});
    this.layout.addEventListener('touchcancel',()=>{gesture=null;},{passive:true});
    this.layout.addEventListener('click',event=>{
      if(Date.now()<suppressUntil){event.preventDefault();event.stopImmediatePropagation();}
    },true);
  }
  canSplit(){return BridgeLayout.canSplit(this.chat.clientWidth);}
  get splitMode(){return this.canSplit()&&!!this.current?.splitTab;}
  isVisible(session,tab){return this.current===session&&(this.splitMode?session.splitTab===tab.id:session.active===tab.id);}
  setRatio(value,remember=true){
    if(!this.current)return;
    const width=this.layout.clientWidth,divider=parseFloat(getComputedStyle(this.chat).getPropertyValue('--wb-divider-width'))||8;
    const minimum=Math.min(.5,(320+divider/2)/Math.max(width,1));
    const ratio=Math.max(minimum,Math.min(1-minimum,value));if(remember)this.current.splitRatio=ratio;
    this.chat.style.setProperty('--wb-left',`calc(${ratio*100}% - var(--wb-divider-width, 8px) / 2)`);
    this.divider.setAttribute('aria-valuemin',String(Math.round(minimum*100)));this.divider.setAttribute('aria-valuemax',String(Math.round((1-minimum)*100)));this.divider.setAttribute('aria-valuenow',String(Math.round(ratio*100)));
  }
  split(id){if(!this.canSplit()||!this.current?.files.some(t=>t.id===id))return;this.rememberScroll();this.current.splitTab=id;this.current.active=id;this.paint();}
  unsplit(){if(!this.current)return;this.current.active=this.current.splitTab||this.current.active;this.current.splitTab=null;this.paint();}
  endDrag(){this.dragTab=null;this.layout.classList.remove('wb-dragging');}
  node(tag, cls = '', text) { const n = document.createElement(tag); n.className = cls; if (text !== undefined) { n._rawText=text;n.textContent = ['pre','code'].includes(tag)?text:BridgeI18n.t(text); const source=BridgeI18n.source(text); if(source&&!['pre','code'].includes(tag))n.dataset.i18n=source; } return n; }
  button(text, action, title = text) { const b = this.node('button', '', text); b.type = 'button'; b._rawTitle=title;b.title = BridgeI18n.t(title); b.setAttribute('aria-label', BridgeI18n.t(title)); const source=BridgeI18n.source(title); if(source){b.dataset.i18nTitle=source;b.dataset.i18nAriaLabel=source;} b.onclick = action; return b; }
  raw(node) { if(node._rawText!==undefined)node.textContent=node._rawText;if(node._rawTitle!==undefined){node.title=node._rawTitle;node.setAttribute('aria-label',node._rawTitle);}delete node.dataset.i18n;delete node.dataset.i18nTitle;delete node.dataset.i18nAriaLabel;return node; }
  relabel() {
    const refresh=root=>{for(const n of root.querySelectorAll('[data-i18n]'))if(![n.dataset.i18n,BridgeI18n.dictionary[n.dataset.i18n]].includes(n.children.length?[...n.childNodes].find(c=>c.nodeType===3)?.textContent:n.textContent))delete n.dataset.i18n;BridgeI18n.apply(root);for(const n of root.querySelectorAll('.wb-status,.wb-empty'))if(!n.children.length)n.textContent=BridgeI18n.t(n.textContent);};
    refresh(this.strip);refresh(this.panel);
    for(const session of this.sessions.values())for(const tab of session.files){refresh(tab.body);tab.sideChat?.relabel();}
    for(const dialog of document.querySelectorAll('.picker'))refresh(dialog);
  }
  size(bytes) { return bytes < 1024 ? bytes + ' B' : bytes < 1048576 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB'; }
  fileIcon(entry) {
    const extension = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
    const groups = {py:'python',pyw:'python',cmd:'terminal',bat:'terminal',sh:'terminal',bash:'terminal',zsh:'terminal',ps1:'terminal',js:'script',jsx:'script',ts:'typescript',tsx:'typescript',json:'config',yaml:'config',yml:'config',toml:'config',ini:'config',env:'config',md:'document',txt:'document',pdf:'pdf',png:'image',jpg:'image',jpeg:'image',gif:'image',webp:'image',svg:'image',zip:'archive',gz:'archive',tar:'archive','7z':'archive',rar:'archive',html:'web',css:'web',swift:'code',java:'code',go:'code',rs:'code',c:'code',cpp:'code'};
    const type = entry.kind === 'directory' ? 'folder' : entry.kind === 'blocked' ? 'blocked' : groups[extension] || 'file';
    const icon = this.node('span', 'wb-file-icon wb-icon-' + type); icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 36 40'); svg.setAttribute('focusable', 'false');
    const path = (d, cls) => { const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); svg.append(p); };
    if (type === 'folder') {
      path('M3 11a3 3 0 0 1 3-3h8l4 4h12a3 3 0 0 1 3 3v17H3Z', 'wb-icon-fill');
      path('M3 16h30v15a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3Z', 'wb-folder-front');
    } else if (type === 'terminal') {
      path('M5 4h26a3 3 0 0 1 3 3v26a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z', 'wb-icon-fill');
      path('m9 11 5 5-5 5m10 0h7', 'wb-icon-stroke');
    } else {
      path('M7 2h15l9 9v24a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z', 'wb-icon-paper');
      path('M22 2v9h9', 'wb-icon-stroke');
      if (type === 'image') path('M8 23l5-6 5 5 4-4 5 5M11 12h.01', 'wb-icon-stroke');
      if (type === 'blocked') path('M11 27 25 13m-10 0h10v10', 'wb-icon-stroke');
    }
    if (!['folder', 'blocked'].includes(type)) {
      const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', '18'); label.setAttribute('y', type === 'terminal' ? '31' : '33'); label.setAttribute('text-anchor', 'middle');
      label.textContent = (extension || 'FILE').slice(0, 4).toUpperCase(); svg.append(label);
    }
    icon.append(svg);
    if (entry.kind === 'file' && /^(png|jpe?g|gif|webp)$/.test(extension) && entry.size <= 20 * 1024 * 1024) icon.dataset.imagePath = entry.path;
    return icon;
  }
  setThumbnails(enabled) {
    if (this.showThumbnails === enabled) return;
    this.showThumbnails = enabled;
    this.chat.classList.toggle('wb-show-thumbnails', enabled);
    this.refreshThumbnails();
  }
  stopThumbnails() { this.thumbnailObserver?.disconnect(); this.thumbnailController?.abort(); }
  refreshThumbnails() {
    this.stopThumbnails();
    const session = this.current;
    if (!this.showThumbnails || session?.active !== 'files') return;
    const controller = this.thumbnailController = new AbortController(), queue = [];
    let running = 0;
    const pump = () => {
      while (!controller.signal.aborted && running < 2 && queue.length) {
        const icon = queue.shift(); running++;
        this.thumbnail(session, icon, controller.signal).finally(() => { running--; pump(); });
      }
    };
    this.thumbnailObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); queue.push(entry.target); }
      pump();
    }, {root:this.panel, rootMargin:'80px'});
    for (const icon of this.panel.querySelectorAll('[data-image-path]')) if (!icon.querySelector('img') && !icon.dataset.thumbnailFailed) this.thumbnailObserver.observe(icon);
  }
  async thumbnail(session, icon, signal) {
    try {
      const result = await this.request(this.url(session, 'preview', icon.dataset.imagePath), undefined, signal);
      if (signal.aborted) return;
      if (result.kind !== 'image') throw Error('No image preview');
      const source = new Image(); source.src = 'data:' + result.mime + ';base64,' + result.data;
      await source.decode();
      if (signal.aborted) return;
      // Keep only a small bitmap in the list, not the original image payload.
      const canvas = document.createElement('canvas'), scale = Math.min(1, 96 / Math.max(source.naturalWidth, source.naturalHeight));
      canvas.width = Math.max(1, Math.round(source.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      const image = this.node('img', 'wb-thumbnail'); image.alt = ''; image.src = canvas.toDataURL('image/png');
      icon.append(image); icon.classList.add('wb-has-thumbnail');
    } catch (error) { if (!signal.aborted) icon.dataset.thumbnailFailed = 'true'; }
  }
  open(id, host) {
    this.fileSelection?.close();
    this.closeReferences();
    this.rememberScroll();
    const key = (this.provider&&this.provider!=='codex'?this.provider+'|':'')+host + '|' + id;
    if(this.current?.key!==key)this.current?.sideChatRead?.abort();
    clearTimeout(this.sideChatTimer);
    if (this.previewFullscreen && this.previewFullscreen.session.key !== key) this.closePreviewFullscreen();
    if (!this.sessions.has(key)) this.sessions.set(key, {id, host, key, provider:this.provider, active: 'chat', files: [], directory: '', search: '', hidden: false, scroll: 0});
    this.current = this.sessions.get(key); this.fileQuotes.open(key); this.paint();
    // The caller sets the current access capabilities immediately after open().
    const session=this.current;Promise.resolve().then(()=>{if(this.current===session)this.refreshSideChats();});
  }
  reset(provider=null) {
    this.fileSelection?.close();this.fileQuotes.close();
    if (this.previewFullscreen && (!provider || this.previewFullscreen.session.provider === provider)) this.closePreviewFullscreen();
    const visible=!provider||this.current?.provider===provider;
    if(visible){this.stopThumbnails();this.uploadController?.abort();clearTimeout(this.sideChatTimer);}
    for(const [key,session] of this.sessions)if(!provider||session.provider===provider){session.sideChatRead?.abort();for(const tab of session.files){tab.controller?.abort();tab.pdf?.dispose();tab.html?.dispose();tab.git?.dispose();tab.terminal?.dispose();tab.agents?.dispose();tab.sideChat?.dispose();}this.sessions.delete(key);}
    if(visible){this.current=null;this.chat.classList.remove('workbench-active','wb-split');this.endDrag();this.panel.replaceChildren();this.panel.hidden=true;this.tabs.replaceChildren();}
  }
  get isFileVisible() { return !!this.current && !this.splitMode && this.current.active !== 'chat'; }
  endpoint(session, action) {
    const path = session.provider && session.provider !== 'codex'
      ? '/api/desktop-sessions/'+session.provider+'/'+action+'?sessionId='+encodeURIComponent(session.id)
      : '/api/sessions/'+session.id+'/'+action+'?host='+encodeURIComponent(session.host);
    return window.BridgeRelayURL?.(path)||path;
  }
  url(session, operation = '', path = '') { return this.endpoint(session,'workspace'+(operation?'/'+operation:''))+'&path='+encodeURIComponent(path); }
  rememberScroll() { const timeline=this.chat.querySelector('.timeline');if (this.current && !this.chat.classList.contains('workbench-active') && timeline.clientHeight) this.current.scroll = timeline.scrollTop; }
  select(id) {
    if (!this.current) return;
    this.fileSelection?.close();
    this.closeReferences();
    if (this.previewFullscreen && this.previewFullscreen.tab.id !== id) {
      const tab=this.current.files.find(tab=>tab.id===id);
      if(this.previewFullscreen.documentMode&&tab?.id.startsWith('file:'))this.syncPreviewFullscreen(tab);
      else this.closePreviewFullscreen();
    }
    this.rememberScroll(); this.current.active = id; if(this.current.splitTab&&id!=='chat')this.current.splitTab=id; this.paint();
    if (id === 'chat') { const session = this.current; requestAnimationFrame(() => { if (session === this.current && session.active === 'chat') this.chat.querySelector('.timeline').scrollTop = session.scroll; }); }
  }
  paint() {
    const session = this.current; if (!session) return;
    const restoreMain=this.chat.classList.contains('workbench-active')&&!this.isFileVisible;
    for (const node of this.panel.querySelectorAll('.wb-file-list,.wb-preview-content,.wb-git-list,.wb-git-diff,.wb-branch-list,.wb-side-messages')) this.scrollPositions.set(node, node.scrollTop);
    for (const stage of this.panel.querySelectorAll('.wb-pdf-stage')) this.scrollPositions.set(stage, {top:stage.scrollTop, left:stage.scrollLeft});
    this.splitEligible=this.canSplit();
    this.tabs.replaceChildren();
    for (const tab of [{id: 'chat', name: BridgeI18n.t('聊天')}, ...session.files]) {
      const group = this.node('div', 'wb-tab');group.dataset.tab=tab.id; group.classList.toggle('selected', this.splitMode ? ['chat',session.splitTab].includes(tab.id) : session.active === tab.id);
      const select = this.button(tab.name, () => this.select(tab.id)); if(tab.id.startsWith('file:')||tab.customTitle)this.raw(select); select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(this.splitMode?['chat',session.splitTab].includes(tab.id):session.active===tab.id));
      if(tab.sideChat)select.ondblclick=()=>tab.sideChat.rename();
      group.append(select);
      group.draggable=this.splitEligible&&tab.id!=='chat';
      group.ondragstart=event=>{if(!group.draggable){event.preventDefault();return;}this.dragTab=tab.id;event.dataTransfer.setData('text/plain',tab.id);event.dataTransfer.effectAllowed='move';this.layout.classList.add('wb-dragging');};
      group.ondragend=()=>this.endDrag();
      if (tab.id !== 'chat') group.append(this.button('×', () => this.close(tab.id), BridgeI18n.t('关闭')));
      this.tabs.append(group);
    }
    this.chat.classList.toggle('workbench-active', this.isFileVisible); this.panel.hidden = !this.isFileVisible&&!this.splitMode;
    this.chat.classList.toggle('wb-split',this.splitMode);this.splitButton.hidden=!this.splitEligible;this.splitButton.disabled=!this.splitMode&&session.active==='chat';
    const splitLabel=this.splitMode?'退出分屏':'在右侧分屏';this.splitButton.dataset.i18nTitle=splitLabel;this.splitButton.dataset.i18nAriaLabel=splitLabel;this.splitButton.title=BridgeI18n.t(splitLabel);this.splitButton.setAttribute('aria-label',BridgeI18n.t(splitLabel));this.splitButton.setAttribute('aria-pressed',String(this.splitMode));if(this.splitMode)this.setRatio(session.splitRatio??.5,false);
    const active = session.files.find(t => t.id === (this.splitMode?session.splitTab:session.active));
    // Keep the visible tool mounted across resizing (including its focus and scroll).
    if(this.panel.firstElementChild!==active?.body)this.panel.replaceChildren(...(active?[active.body]:[]));
    if (active) {
      for (const node of active.body.querySelectorAll('.wb-file-list,.wb-preview-content,.wb-git-list,.wb-git-diff,.wb-branch-list,.wb-side-messages')) node.scrollTop = this.scrollPositions.get(node) || 0;
      for (const stage of active.body.querySelectorAll('.wb-pdf-stage')) { const position=this.scrollPositions.get(stage); if(position){stage.scrollTop=position.top;stage.scrollLeft=position.left;} }
      this.scrollMarkdown(active);
    }
    if(restoreMain)this.chat.querySelector('.timeline').scrollTop=session.scroll;
    this.refreshThumbnails();
  }
  back() {
    if (this.previewFullscreen) { this.closePreviewFullscreen(); return true; }
    const floating=this.panel.querySelector('.wb-float'); if(floating){floating.querySelector('.wb-float-close').click();return true;}
    const session=this.current,files=session?.files.find(tab=>tab.id==='files');
    const viewingFiles=files&&(this.splitMode?session.splitTab==='files':session.active==='files');
    if(viewingFiles&&session.directory){this.directory(session,files,session.directory.split('/').slice(0,-1).join('/'));return true;}
    if(this.splitMode){if(!viewingFiles)return false;session.splitTab=null;this.select('chat');return true;}
    if(!this.isFileVisible)return false;
    this.select('chat');return true;
  }
  async close(id) {
    const session = this.current, index = session.files.findIndex(t => t.id === id);
    if (index < 0) return;
    const fullscreenTab=this.previewFullscreen?.documentMode&&this.previewFullscreen.tab===session.files[index]
      ?session.files.find(tab=>tab.id!==id&&tab.id.startsWith('file:')):null;
    if (this.previewFullscreen?.tab === session.files[index]&&!fullscreenTab) this.closePreviewFullscreen();
    if (session.files[index].sideChat && !await session.files[index].sideChat.end()) return;
    if (!session.files[index] || session.files[index].id !== id) return;
    session.files[index].controller?.abort(); session.files[index].pdf?.dispose(); session.files[index].html?.dispose(); session.files[index].git?.dispose(); session.files[index].terminal?.dispose(); session.files[index].agents?.dispose(); session.files[index].sideChat?.dispose(); session.files.splice(index, 1);
    if(session.splitTab===id)session.splitTab=(session.files[index]||session.files[index-1])?.id||null;
    const wasActive=session.active===id;
    if(wasActive)session.active=fullscreenTab?.id||session.splitTab||(session.files.some(t=>t.id==='files')?'files':'chat');
    if(fullscreenTab&&session.splitTab)session.splitTab=fullscreenTab.id;
    if (this.current !== session) return;
    if (wasActive) this.select(session.active); else this.paint();
  }
  files() {
    const session = this.current; if (!session) return;
    if (!session.files.some(t => t.id === 'files')) {
      const tab = {id: 'files', name: BridgeI18n.t('文件'), body: this.node('div', 'wb-browser')}; session.files.unshift(tab);
      this.directory(session, tab, session.directory);
    }
    this.select('files');
  }
  async locate(session,path) {
    if(session!==this.current)return;
    session.search='';session.hidden=true;
    let tab=session.files.find(t=>t.id==='files');
    if(!tab){tab={id:'files',name:BridgeI18n.t('文件'),body:this.node('div','wb-browser')};session.files.unshift(tab);}
    this.select('files');
    await this.directory(session,tab,path.split('/').slice(0,-1).join('/'));
    while(session===this.current&&Number.isInteger(tab.next)&&!Array.from(tab.list.children).some(row=>row.dataset.path===path)){const next=tab.next;await this.directory(session,tab,session.directory,true);if(tab.next===next)break;}
    if(session!==this.current)return;
    const row=Array.from(tab.list.children).find(row=>row.dataset.path===path);
    if(row){row.classList.add('selected');row.scrollIntoView({block:'nearest'});row.focus({preventScroll:true});}
  }
  newTab() {
    if (!this.current) return;
    const dialog = this.node('dialog', 'picker wb-new-tab'), head = this.node('div', 'picker-head');
    head.append(this.node('h2', '', BridgeI18n.t('新标签页')), this.button('×', () => dialog.close(), BridgeI18n.t('关闭')));
    const choices = this.node('div', 'wb-tab-choices');
    for (const [name, description, action] of [[BridgeI18n.t('文件'), BridgeI18n.t('浏览项目文件、上传与下载'), () => this.files()], ['Git', BridgeI18n.t('历史、暂存、提交与分支管理'), () => this.git()], [BridgeI18n.t('终端'), BridgeI18n.t('运行项目命令、构建与查看输出'), () => this.terminal()], [BridgeI18n.t('侧边聊天'), BridgeI18n.t('继承当前上下文，临时讨论并跨设备接续'), () => this.sideChat('',true)], [BridgeI18n.t('子智能体'), BridgeI18n.t('查看派生任务关系与执行记录'), () => this.agents()]]) {
      const button = this.button('', () => { dialog.close(); action(); }, name);
      button.append(this.node('strong', '', name), this.node('span', '', description));
      if((this.current.provider&&!['codex','deepseek'].includes(this.current.provider)||this.current.provider==='deepseek'&&this.current.access?.canUseSideChat!==true||this.current.access?.canUseSideChat===false)&&['侧边聊天','子智能体'].map(BridgeI18n.t).includes(name)) {button.disabled=true;button.lastChild.textContent=BridgeI18n.t('当前客户端尚未提供此能力');}
      choices.append(button);
    }
    dialog.append(head, choices); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
  }
  git() {
    const session = this.current; if (!session) return;
    if (!session.files.some(tab => tab.id === 'git')) {
      const tab = {id: 'git', name: 'Git', body: this.node('div', 'wb-git')};
      session.files.push(tab); tab.git = new GitPanel(this, session, tab); tab.git.load();
    }
    this.select('git');
  }
  agents() {
    const session=this.current;if(!session)return;
    if(!session.files.some(tab=>tab.id==='agents')) {
      const tab={id:'agents',name:BridgeI18n.t('子智能体'),body:this.node('div','wb-agents')};
      session.files.push(tab);tab.agents=new AgentsPanel(this,session,tab);
    }
    this.select('agents');
  }
  closeReferences(){for(const tab of this.current?.files||[]){tab.sideChat?.references.close();tab.sideChat?.renameDialog?.close();}}
  async refreshSideChats(){
    clearTimeout(this.sideChatTimer);
    const session=this.current;
    if(!session||document.hidden||session.host!=='local'||session.provider&&!['codex','deepseek'].includes(session.provider)||session.provider==='deepseek'&&session.access?.canUseSideChat!==true||session.access?.canUseSideChat===false||this.sessions.get(session.key)!==session)return;
    if(session.sideChatRead&&!session.sideChatRead.signal.aborted)return;
    const controller=session.sideChatRead=new AbortController();
    try{
      const url=session.provider==='deepseek'?'/api/desktop-sessions/deepseek/side-chat?sessionId='+encodeURIComponent(session.id):'/api/sessions/'+session.id+'/side-chat?host='+encodeURIComponent(session.host);
      const state=await this.request(url,undefined,controller.signal);
      if(!controller.signal.aborted&&this.current===session&&!document.hidden&&session.access?.canUseSideChat!==false)this.syncSideChats(session,state.slots);
    }catch(error){
      if(!controller.signal.aborted&&error.status===401)this.onUnauthorized();
      // Keep existing tabs and drafts; the next read can recover a lost connection.
    }finally{
      if(session.sideChatRead===controller){
        session.sideChatRead=null;
        if(this.current===session&&this.sessions.get(session.key)===session&&!document.hidden)this.sideChatTimer=setTimeout(()=>this.refreshSideChats(),3000);
      }
    }
  }
  createSideChat(session,slot='') {
    if(!session||session.access?.canUseSideChat===false||session.provider==='deepseek'&&session.access?.canUseSideChat!==true||session.provider&&!['codex','deepseek'].includes(session.provider))return;
    const id=slot?'sidechat:'+slot:'sidechat';let tab=session.files.find(tab=>tab.id===id);if(tab)return tab;
    const number=session.sideChatSerial=(session.sideChatSerial||0)+1;
    const name=BridgeI18n.t('侧边聊天')+(number>1?' '+number:'');
    tab={id,slot,name,defaultName:name,body:this.node('div','wb-side-content')};
    session.files.push(tab);tab.sideChat=new SideChatPanel(this,session,tab);return tab;
  }
  setSideChatTitle(session,tab,state){
    if(this.sessions.get(session.key)!==session||!session.files.includes(tab)||typeof state.title!=='string')return false;
    if(state.id&&tab.sideChat?.state?.id&&state.id!==tab.sideChat.state.id)return false;
    const revision=state.titleRevision??0;
    if(state.id===tab.titleChild&&revision<(tab.titleRevision??-1))return false;
    if(state.id){tab.titleChild=state.id;tab.titleRevision=revision;}
    const name=state.title||tab.defaultName;
    tab.customTitle=state.title;
    if(tab.name===name)return false;
    tab.name=name;
    tab.sideChat?.updateCaption?.();
    return true;
  }
  syncSideChats(session,slots){
    if(!Array.isArray(slots)||this.sessions.get(session.key)!==session)return;
    let changed=false;for(const row of slots){const slot=row?.slot;if(typeof slot!=='string'||slot&&!/^[0-9a-f-]{36}$/.test(slot))continue;
      const id=slot?'sidechat:'+slot:'sidechat';let tab=session.files.find(tab=>tab.id===id);
      if(!tab){tab=this.createSideChat(session,slot);changed=!!tab||changed;}
      if(tab&&this.setSideChatTitle(session,tab,row))changed=true;
    }
    if(changed&&this.current===session)this.paint();
  }
  sideChat(selectedText='',fresh=false) {
    if(selectedText.length>12000){this.notify(BridgeI18n.t('选中内容过长，请缩小范围后重试'));return;}
    const session=this.current;if(!session||session.access?.canUseSideChat===false)return;
    const tab=this.createSideChat(session,fresh||session.files.some(tab=>tab.sideChat)?uuid():'');if(!tab)return;
    this.select(tab.id);
    if(selectedText)tab.sideChat.quoteSelection(selectedText);
    if(fresh)tab.sideChat.create();
  }
  terminal() {
    const session=this.current;if(!session)return;
    if(!session.files.some(tab=>tab.id==='terminal')) {
      const tab={id:'terminal',name:BridgeI18n.t('终端'),body:this.node('div','wb-terminal')};
      session.files.push(tab);tab.terminal=new TerminalPanel(this,session,tab);
    }
    this.select('terminal');
  }
  async directory(session, tab, path, append = false) {
    tab.controller?.abort(); const controller = tab.controller = new AbortController();
    if (!append) {
      if (session === this.current) this.stopThumbnails();
      session.directory = path; tab.body.replaceChildren();
      const toolbar = this.node('div', 'wb-toolbar');
      const up = this.button('‹', () => this.directory(session, tab, path.split('/').slice(0, -1).join('/')), BridgeI18n.t('上一级目录')); up.disabled = !path;
      const crumb = this.node('div', 'wb-path', path || BridgeI18n.t('项目文件')); if(path)this.raw(crumb);else crumb.dataset.i18nTitle='当前聊天的项目目录';crumb.title = path || BridgeI18n.t('当前聊天的项目目录');
      toolbar.append(up, crumb, this.button('↻', () => this.directory(session, tab, path), BridgeI18n.t('刷新目录')), this.button(BridgeI18n.t('上传'), () => this.uploadDialog(session, tab, path)));
      const filters = this.node('div', 'wb-filters');
      const search = this.node('input'); search.type = 'search'; search.setAttribute("data-i18n-placeholder",'搜索当前目录');search.placeholder = BridgeI18n.t('搜索当前目录'); search.setAttribute("data-i18n-aria-label",'搜索当前目录');search.setAttribute('aria-label', BridgeI18n.t('搜索当前目录')); search.value = session.search;
      const form = this.node('form', 'wb-search'); form.append(search, this.button(BridgeI18n.t('搜索'), () => { session.search = search.value; this.directory(session, tab, path); }));
      form.onsubmit = e => { e.preventDefault(); session.search = search.value; this.directory(session, tab, path); };
      const label = this.node('label'), hidden = this.node('input'); hidden.type = 'checkbox'; hidden.checked = session.hidden;
      hidden.onchange = () => { session.hidden = hidden.checked; this.directory(session, tab, path); }; label.append(hidden, this.node('span', '', '隐藏文件'));
      filters.append(form, label); tab.list = this.node('div', 'wb-file-list'); tab.status = this.node('p', 'wb-status', BridgeI18n.t('正在读取文件…')); tab.status.setAttribute('role', 'status');
      tab.body.append(toolbar, filters, tab.status, tab.list);
    }
    try {
      const url = this.url(session, '', path) + '&hidden=' + session.hidden + '&search=' + encodeURIComponent(session.search) + '&offset=' + (append ? tab.next : 0);
      const result = await this.request(url, undefined, controller.signal);
      if (controller.signal.aborted || !this.sessions.has(session.key)) return;
      session.project = result.project; session.root = result.root; const crumb=tab.body.querySelector('.wb-path');delete crumb.dataset.i18n;crumb.textContent = result.project + (path ? ' / ' + path : '');
      delete tab.status.dataset.i18n;
      tab.status.replaceChildren(...(result.total ? [this.node('span', '', String(result.total)), this.node('span', '', ' 项 · '), this.node('span', '', session.host === 'local' ? '电脑上的项目' : 'SSH 项目')] : [this.node('span', '', '当前目录没有匹配的文件')]));
      tab.body.querySelector('.wb-load-more')?.remove();
      for (const entry of result.entries) {
        const row = this.raw(this.button('', () => { if (entry.kind === 'directory') { session.search = ''; this.directory(session, tab, entry.path); } else this.preview(session, entry); }, entry.name));
        row.dataset.path=entry.path;window.BridgeFileActions?.bindRow(row,this,session,entry);
        row.className = 'wb-file'; row.disabled = entry.kind === 'blocked';
        row.append(this.fileIcon(entry), this.raw(this.node('span', 'wb-file-name', entry.name)), this.node('span', 'wb-file-meta', entry.kind === 'directory' ? BridgeI18n.t('文件夹') : entry.kind === 'blocked' ? BridgeI18n.t('链接或特殊文件') : this.size(entry.size)));
        tab.list.append(row);
      }
      tab.next = result.nextOffset;
      if (tab.next !== null) { const more = this.button(BridgeI18n.t('加载更多'), () => this.directory(session, tab, path, true)); more.className = 'wb-load-more'; tab.body.append(more); }
      if (session === this.current) this.refreshThumbnails();
    } catch (error) { if (!controller.signal.aborted && this.sessions.has(session.key) && error.name !== 'AbortError') { tab.status.textContent=BridgeI18n.t(error.message); tab.status.classList.add('error'); } }
  }
  openPreviewFullscreen(session, tab, content, trigger) {
    if (this.previewFullscreen || session !== this.current || !tab.body.contains(content)) return;
    const documentMode=!!tab.markdown,body=documentMode?this.chat:tab.body,inerted=[];
    const exitButton=documentMode?this.button('退出全屏',()=>this.closePreviewFullscreen()):null;
    if(exitButton){exitButton.className='wb-fullscreen-exit';this.strip.append(exitButton);}
    const focusTarget=exitButton||trigger;
    for (let node = body; node.parentElement; node = node.parentElement) {
      for (const sibling of node.parentElement.children) if (sibling !== node && !sibling.inert) { sibling.inert = true; inerted.push(sibling); }
    }
    const onKeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); this.closePreviewFullscreen(); return; }
      if (event.key !== 'Tab') return;
      const controls = [...body.querySelectorAll('a[href],button,iframe,[tabindex]')].filter(node => !node.hidden && !node.disabled && node.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); focusTarget.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const onFocus = event => { if (!body.contains(event.target)) focusTarget.focus(); };
    this.previewFullscreen = {body, trigger:focusTarget, previewTrigger:trigger, originTrigger:trigger, exitButton, documentMode, tab, session, inerted, onKeydown, onFocus};
    body.classList.add('wb-preview-fullscreen');
    if(documentMode)body.classList.add('wb-document-fullscreen');
    body.setAttribute('role', 'dialog'); body.setAttribute('aria-modal', 'true'); body.setAttribute('aria-label', tab.name);
    this.previewFullscreenLabel(trigger, true);
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('focusin', onFocus, true);
    focusTarget.focus({preventScroll:true});
  }
  syncPreviewFullscreen(tab){
    const state=this.previewFullscreen;if(!state?.documentMode||state.session!==this.current)return;
    const trigger=tab.body.querySelector?.('.wb-preview-expand');
    if(state.previewTrigger&&state.previewTrigger!==trigger)this.previewFullscreenLabel(state.previewTrigger,false);
    state.tab=tab;state.previewTrigger=trigger||null;state.body.setAttribute('aria-label',tab.name);
    if(trigger)this.previewFullscreenLabel(trigger,true);
  }
  closePreviewFullscreen() {
    const state = this.previewFullscreen; if (!state) return;
    this.previewFullscreen = null;
    const {body, trigger, previewTrigger, originTrigger, exitButton, inerted, onKeydown, onFocus} = state;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', onFocus, true);
    body.classList.remove('wb-preview-fullscreen');
    body.classList.remove('wb-document-fullscreen');exitButton?.remove();
    body.removeAttribute('role'); body.removeAttribute('aria-modal'); body.removeAttribute('aria-label');
    for (const node of inerted) node.inert = false;
    if(previewTrigger)this.previewFullscreenLabel(previewTrigger,false);
    const target=previewTrigger?.isConnected?previewTrigger:originTrigger?.isConnected?originTrigger:this.strip?.querySelector?.('[role=tab][aria-selected=true]')||trigger;
    if(target.isConnected)target.focus({preventScroll:true});
  }
  previewFullscreenLabel(button, active) {
    const label = active ? '退出全屏' : '全屏', description = active ? '退出全屏' : '全屏预览';
    button.dataset.i18n = label; button.textContent = BridgeI18n.t(label);
    button.dataset.i18nAriaLabel = description; button.dataset.i18nTitle = description;
    button.setAttribute('aria-label', BridgeI18n.t(description)); button.title = BridgeI18n.t(description);
  }
  markdownTarget(path, reference) {
    // Resolve on the selected workspace, never against the gateway's URL or OS.
    if (!reference || /^[a-z][a-z\d+.-]*:|^\/\//i.test(reference)) return null;
    try {
      const hash = reference.indexOf('#'), fragment = hash < 0 ? undefined : decodeURIComponent(reference.slice(hash + 1));
      const value = decodeURIComponent((hash < 0 ? reference : reference.slice(0, hash)).split('?')[0]);
      if (/[\\:\x00-\x1f\x7f]/.test(value)) return null;
      if (!value) return {path, fragment:fragment ?? ''};
      const parts = value.startsWith('/') ? [] : path.split('/').slice(0, -1);
      for (const part of value.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { if (!parts.length) return null; parts.pop(); }
        else parts.push(part);
      }
      return parts.length ? {path:parts.join('/'), fragment} : null;
    } catch { return null; }
  }
  scrollMarkdown(tab) {
    if (tab.fragment === undefined || !tab.markdown || !this.current?.files.includes(tab) || !this.isVisible(this.current, tab)) return;
    const content = tab.markdown, fragment = tab.fragment;
    delete tab.fragment;
    const heading = [...content.querySelectorAll('[data-markdown-anchor]')].find(node => node.dataset.markdownAnchor === fragment);
    if (!fragment) content.scrollTop = 0;
    else if (heading) content.scrollTop += heading.getBoundingClientRect().top - content.getBoundingClientRect().top - 12;
    else this.notify(BridgeI18n.t('未找到对应章节'));
    this.scrollPositions.set(content, content.scrollTop);
  }
  async preview(session, entry, fragment) {
    if (session !== this.current) return;
    const id = 'file:' + entry.path;
    const existing = session.files.find(t => t.id === id);
    if (existing) { if (fragment !== undefined) existing.fragment = fragment; this.select(id); return; }
    if (session.files.filter(t => t.id.startsWith('file:')).length >= 8) { this.notify(BridgeI18n.t('最多同时打开 8 个文件，请先关闭一个标签')); return; }
    const tab = {id, name: entry.name || entry.path.split('/').pop(), entry, body: this.node('div', 'wb-preview'), fragment}; session.files.push(tab);
    tab.body.append(this.node('p', 'wb-status', BridgeI18n.t('正在读取文件…'))); this.select(id);
    return this.refreshPreview(session, tab);
  }
  async refreshPreview(session, tab) {
    if (session !== this.current || this.sessions.get(session.key) !== session || !session.files.includes(tab) || tab.loading) return;
    const entry = tab.entry, controller = tab.controller = new AbortController();
    tab.loading = true; tab.body.setAttribute('aria-busy', 'true');
    if (tab.refreshButton) tab.refreshButton.disabled = true;
    tab.previewError?.remove(); tab.previewError = null;
    const valid = () => !controller.signal.aborted && this.sessions.get(session.key) === session && session.files.includes(tab);
    try {
      const pdf = /\.pdf$/i.test(tab.name);
      const downloadUrl = this.url(session, 'download', entry.path);
      const result = pdf
        ? {...await this.request(downloadUrl + '&info=1', undefined, controller.signal), kind:'pdf'}
        : await this.request(this.url(session, 'preview', entry.path), undefined, controller.signal);
      if (!valid()) return;
      const previous = tab.previewContent, position = {top:previous?.isConnected ? previous.scrollTop : this.scrollPositions?.get(previous) || previous?.scrollTop || 0, left:previous?.scrollLeft || 0};
      const previousSource = previous?.querySelector?.('.wb-source-body');
      const sourcePosition = {top:previousSource?.scrollTop || 0, left:previousSource?.scrollLeft || 0};
      const wrapped = previous?.querySelector?.('.wb-source')?.dataset.wrap === 'true';
      const restoreFocus = !!tab.refreshButton && document.activeElement === tab.refreshButton;
      if (this.current === session) this.fileSelection?.close();
      tab.pdf?.dispose(); tab.html?.dispose(); tab.pdf = tab.html = tab.markdown = null;
      const head = this.node('div', 'wb-preview-head'), title = this.node('div', 'wb-preview-title'), actions = this.node('div', 'wb-preview-actions');
      title.append(this.raw(this.node('strong', '', result.name)), this.node('small', '', this.size(result.size) + ' · ' + entry.path));
      head.append(title, actions);
      { const download = this.node('a', 'wb-download', '下载'); download.href = pdf && result.size > result.clickDownloadMiB * 1024 * 1024 ? downloadUrl + '&explicit=1' : downloadUrl; download.download = result.name; download.dataset.i18nAriaLabel = '下载文件'; download.setAttribute('aria-label', BridgeI18n.t('下载文件')); actions.append(download); }
      const refresh = tab.refreshButton ||= this.button('刷新', () => this.refreshPreview(session, tab));
      refresh.className = 'wb-preview-refresh'; refresh.disabled = true; actions.append(refresh);
      const content = this.node('div', 'wb-preview-content');
      let modes = null, copyAction = null;
      if (result.kind === 'pdf') {
        tab.pdf = BridgePdfPreview.create({url:downloadUrl, info:result});
        content.classList.add('wb-pdf-content'); content.append(tab.pdf.element);
      } else if (result.kind === 'image') { const image = this.node('img'); image.src = 'data:' + result.mime + ';base64,' + result.data; image.alt = result.name; window.BridgeImageViewer?.registerWorkspaceImage(image, result); content.append(image); }
      else if (result.kind === 'text') {
        if (/\.(md|markdown)$/i.test(result.name)) {
          tab.markdown = content;
          renderMarkdown(content, result.text, [], undefined, {headingAnchors:true, resolveLink:reference => {
            const target = this.markdownTarget(entry.path, reference);
            if (!target) return null;
            return {url:this.url(session, 'preview', target.path) + (target.fragment === undefined ? '' : '#' + encodeURIComponent(target.fragment)), activate:() => {
              if (session === this.current && session.files.includes(tab)) this.preview(session, {path:target.path, name:target.path.split('/').pop()}, target.fragment);
            }};
          }});
        }
        else if (/\.html?$/i.test(result.name)) {
          modes = this.node('div', 'wb-preview-modes');
          const preview = this.button('预览', () => show('preview'));
          const source = this.button('源代码', () => show('source'));
          const copy = this.button('复制', () => window.BridgeClipboard.copy(() => result.text, copy), '复制代码');
          preview.className = source.className = 'wb-preview-mode'; copy.className = 'wb-source-copy';
          modes.append(preview, source); copyAction = copy;
          const show = mode => {
            tab.htmlMode = mode;
            tab.html?.dispose(); tab.html = null;
            preview.setAttribute('aria-pressed', String(mode === 'preview'));
            source.setAttribute('aria-pressed', String(mode === 'source'));
            copy.hidden = mode !== 'source';
            if (mode === 'preview') { tab.html = BridgeHtmlPreview.create({text:result.text, onEscape:() => { if (this.previewFullscreen?.tab === tab) this.closePreviewFullscreen(); }}); content.replaceChildren(tab.html.element); }
            else content.replaceChildren(BridgeSourceView.create({name:result.name, text:result.text}));
          };
          show(tab.htmlMode || 'preview');
        }
        else {
          const copy = this.button('复制', () => window.BridgeClipboard.copy(() => result.text, copy), '复制代码');
          copy.className = 'wb-source-copy'; copyAction = copy;
          content.append(BridgeSourceView.create({name:result.name, text:result.text}));
        }
      } else content.append(this.node('p', 'wb-empty', BridgeI18n.t(result.size > 512 * 1024 ? '文件超过 512 KB，无法在线预览。可下载后打开。' : '此文件不是 UTF-8 文本或可预览图片，可下载后打开。')));
      if (['pdf','image','text'].includes(result.kind) || this.previewFullscreen?.tab === tab) {
        const fullscreen = tab.fullscreenButton ||= this.button('全屏', () => this.previewFullscreen?.tab === tab ? this.closePreviewFullscreen() : this.openPreviewFullscreen(session, tab, tab.previewContent, tab.fullscreenButton), '全屏预览');
        fullscreen.className = 'wb-preview-expand'; actions.append(fullscreen);
        if (this.previewFullscreen?.tab === tab) this.previewFullscreenLabel(fullscreen, true);
      }
      if (copyAction) actions.append(copyAction);
      tab.previewContent = content;
      tab.body.replaceChildren(...(modes ? [head, modes, content] : [head, content]));
      content.scrollTop = position.top; content.scrollLeft = position.left; this.scrollPositions?.set(content, content.isConnected ? content.scrollTop : position.top);
      if (wrapped) content.querySelector?.('.wb-source-wrap')?.click();
      const sourceBody = content.querySelector?.('.wb-source-body');
      if (sourceBody) { sourceBody.scrollTop = sourcePosition.top; sourceBody.scrollLeft = sourcePosition.left; }
      if(result.kind==='text'||result.kind==='pdf'){tab.filePath=entry.path;this.fileSelection?.bindPreview(session,tab,actions);}
      if(this.previewFullscreen?.documentMode&&this.previewFullscreen.tab===tab)this.syncPreviewFullscreen(tab);
      this.scrollMarkdown(tab);
      if (tab.pdf) tab.pdf.load();
      if (restoreFocus && this.isVisible(session, tab)) refresh.focus({preventScroll:true});
    } catch (error) {
      if (error.name !== 'AbortError' && valid()) {
        const failure = tab.previewError = this.node('div', 'wb-preview-error'); failure.setAttribute('role', 'alert');
        failure.append(this.node('p', 'wb-status error', error.message), this.button('重试', () => this.refreshPreview(session, tab)));
        if (tab.previewContent) tab.body.append(failure); else tab.body.replaceChildren(failure);
      }
    } finally {
      tab.loading = false; tab.body.setAttribute('aria-busy', 'false');
      if (tab.refreshButton) tab.refreshButton.disabled = false;
    }
  }
  uploadDialog(session, tab, directory) {
    const dialog = this.node('dialog', 'picker wb-upload'), form = this.node('form');
    const file = this.node('input'); file.type = 'file'; file.required = true; file.setAttribute("data-i18n-aria-label",'选择上传文件');file.setAttribute('aria-label', BridgeI18n.t('选择上传文件'));
    const name = this.node('input'); name.required = true; name.setAttribute("data-i18n-aria-label",'保存文件名');name.setAttribute('aria-label', BridgeI18n.t('保存文件名')); name.setAttribute("data-i18n-placeholder",'保存文件名');name.placeholder = BridgeI18n.t('保存文件名');
    file.onchange = () => { name.value = file.files[0]?.name || ''; };
    const error = this.node('p', 'error'); error.setAttribute('role', 'alert'); const progress = this.node('progress'); progress.max = 100; progress.value = 0; progress.hidden = true;
    const status = this.node('p', 'wb-status'); status.setAttribute('role', 'status');
    const submit = this.node('button', 'primary', BridgeI18n.t('上传到此目录')); submit.type = 'submit';
    const cancel = this.button(BridgeI18n.t('取消'), () => dialog.close()); cancel.className = 'wb-upload-cancel'; const actions = this.node('div', 'wb-upload-actions'); actions.append(cancel, submit);
    form.append(this.node('h2', '', BridgeI18n.t('上传文件')), this.node('p', 'wb-upload-target', BridgeI18n.t('保存到：') + (session.project || BridgeI18n.t('项目')) + '/' + directory), file, name, this.node('p', 'muted', BridgeI18n.t('单个文件最多 20 MB。同名文件不会被覆盖。')), progress, status, error, actions);
    dialog.append(form); document.body.append(dialog);
    dialog.onclose = () => { this.uploadController?.abort(); this.uploadController = null; dialog.remove(); };
    form.onsubmit = async event => {
      event.preventDefault(); const selected = file.files[0]; if (!selected || submit.disabled) return;
      if (selected.size > 20 * 1024 * 1024 || !name.value || /[\\/:\x00-\x1f]/.test(name.value) || ['.', '..'].includes(name.value)) { error.textContent = BridgeI18n.t('请选择不超过 20 MB 的文件，并填写不含路径的文件名'); return; }
      error.textContent = ''; progress.hidden = false; progress.value = 0; submit.disabled = true; file.disabled = name.disabled = true;
      const path = (directory ? directory + '/' : '') + name.value;
      try {
        const result = await this.upload(this.url(session, 'upload', path), selected, value => { progress.value = value; status.textContent = value === 100 ? BridgeI18n.t('正在确认保存结果…') : BridgeI18n.t('正在上传 ') + value + '%'; });
        dialog.close(); this.notify(result.existing ? BridgeI18n.t('同名文件内容一致，已核对保存结果') : BridgeI18n.t('文件已上传到项目目录'));
        if (this.sessions.has(session.key) && session.files.includes(tab) && session.directory === directory) this.directory(session, tab, directory);
      } catch (failure) { error.textContent=BridgeI18n.t(failure.message); status.textContent = ''; }
      finally { submit.disabled = false; file.disabled = name.disabled = false; }
    };
    dialog.showModal();
  }
  upload(url, file, progress) {
    return new Promise((resolve, reject) => {
      const xhr = this.uploadController = new XMLHttpRequest(); xhr.open('POST', url); xhr.timeout = 120000;
      xhr.setRequestHeader('X-CSRF-Token', this.csrf()); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = e => { if (e.lengthComputable) progress(Math.round(e.loaded / e.total * 100)); };
      const uncertain = () => reject(Error(BridgeI18n.t('上传结果未确认，请刷新目录核对，或重试同一文件；不会覆盖已有文件。')));
      xhr.onerror = xhr.ontimeout = xhr.onabort = uncertain;
      xhr.onload = () => { try { const result = JSON.parse(xhr.responseText); if (xhr.status === 401) this.onUnauthorized(); if (xhr.status < 200 || xhr.status >= 300) throw Error(result.error || BridgeI18n.t('上传失败')); resolve(result); } catch (e) { reject(e); } };
      xhr.send(file);
    });
  }
}
