'use strict';

class FileSelectionAction {
  constructor(workbench){
    this.workbench=workbench;
    this.touchSelecting=window.matchMedia?.('(any-pointer: coarse)').matches===true;
    this.bar=document.createElement('div');this.bar.className='selection-actions file-selection-actions';this.bar.hidden=true;this.bar.setAttribute('role','toolbar');
    this.button=document.createElement('button');this.button.type='button';this.button.className='selection-more';this.button.dataset.i18n='引用到聊天';this.button.textContent=BridgeI18n.t('引用到聊天');
    this.bar.append(this.button);workbench.chat.append(this.bar);
    this.bar.onpointerdown=event=>event.preventDefault();this.button.onclick=()=>this.add(this.capture());
    const update=()=>{clearTimeout(this.timer);this.timer=setTimeout(()=>this.update(),160);};
    document.addEventListener('selectionchange',update);document.addEventListener('scroll',update,true);window.addEventListener('resize',update);
    document.addEventListener('pointerdown',event=>{if(event.pointerType==='touch'||event.pointerType==='pen')this.touchSelecting=true;else if(event.pointerType==='mouse'&&(!window.matchMedia?.('(any-pointer: coarse)').matches||event.button===2))this.touchSelecting=false;if(this.touchSelecting)this.bar.hidden=true;},{passive:true,capture:true});
    window.visualViewport?.addEventListener('resize',update);window.visualViewport?.addEventListener('scroll',update);
    this.menu=new ChatContextMenu(workbench.chat,target=>{
      const selection=this.capture();if(!selection||!selection.content.contains(target))return [];
      workbench.closePreviewFullscreen();
      return [{label:'引用到聊天',run:()=>this.add(selection)}];
    },{label:'文件引用',touch:false});
  }
  bindPreview(session,tab,actions){
    const button=tab.quoteButton=this.workbench.button('引用选区',()=>{const selection=this.triggerSnapshot||this.capture();this.triggerSnapshot=null;if(selection?.session===session&&selection.tab===tab)this.add(selection);},'引用选中文字');
    button.className='wb-preview-quote';button.disabled=true;
    button.onpointerdown=event=>{if(event.button>0)return;const selection=this.capture();this.triggerSnapshot=selection?.session===session&&selection.tab===tab?selection:null;if(this.triggerSnapshot)event.preventDefault();};
    actions.append(button);
  }
  capture(){
    const wb=this.workbench,session=wb.current,selection=window.getSelection();
    if(!session||!selection?.rangeCount||selection.isCollapsed||wb.chat.hidden||document.querySelector('dialog[open]'))return null;
    const range=selection.getRangeAt(0),start=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
    const content=start?.closest('.wb-preview-content');if(!content||!content.contains(range.endContainer))return null;
    const tab=session.files.find(tab=>tab.filePath&&tab.body.contains(content));
    if(!tab||!wb.isVisible(session,tab)||!wb.chat.contains(content)||!this.targets(session).some(target=>target.available()))return null;
    // Exclude preview chrome, source line numbers and non-text file previews.
    const code=content.querySelector('.wb-source-code code');
    if(code&&(!code.contains(range.startContainer)||!code.contains(range.endContainer)))return null;
    if(!code&&!tab.markdown&&!tab.pdf)return null;
    const text=selection.toString();if(!text.trim())return null;
    return {session,tab,content,text,context:session.key,range:range.cloneRange(),rect:range.getBoundingClientRect()};
  }
  targets(session){
    return this.workbench.selectionTargets.targets(session);
  }
  update(){
    const selection=this.capture();
    for(const tab of this.workbench.current?.files||[])if(tab.quoteButton)tab.quoteButton.disabled=selection?.tab!==tab;
    this.bar.hidden=this.touchSelecting||!selection;if(this.bar.hidden)return;
    const viewport=window.visualViewport,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight;
    this.bar.style.left=Math.max(left+8,Math.min(selection.rect.left,left+width-this.bar.offsetWidth-8))+'px';
    this.bar.style.top=Math.max(top+8,Math.min(selection.rect.bottom+8,top+height-this.bar.offsetHeight-8))+'px';
  }
  async add(selection){
    if(!selection)return;const wb=this.workbench,{session,tab,text}=selection;
    const valid=()=>wb.current===session&&wb.sessions.get(session.key)===session&&session.files.includes(tab);
    if(!valid())return;this.bar.hidden=true;
    try{
      let root=session.root;
      if(!root){const result=await wb.request(wb.url(session));root=result.root;if(valid())session.root=root;}
      if(!valid())return;
      const path=ChatReferencePicker.fileItems({root,entries:[{name:tab.name,path:tab.filePath,kind:'file'}]},session.cwd).items[0].value;
      if(!path)throw Error(BridgeI18n.t('当前会话未提供可访问的项目完整目录'));
      const quote={path,name:tab.name,text,host:session.host};
      wb.selectionTargets.choose(session,{file:quote},valid,()=>{this.menu.suppressUntil=0;});
    }catch(error){wb.notify(error.message);}
  }
  close(){this.bar.hidden=true;this.menu.menu?.close();this.workbench.selectionTargets.close();}
}
