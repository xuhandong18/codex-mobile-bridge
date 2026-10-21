'use strict';

// Route explicit quote actions from messages and files to the same draft picker.
class ChatSelectionTargets {
  constructor(workbench){this.workbench=workbench;}
  current(session){const wb=this.workbench;return wb.current===session&&wb.sessions.get(session.key)===session;}
  canCreate(session){return this.current(session)&&(!session.provider||session.provider==='codex'||session.provider==='deepseek'&&session.access?.canUseSideChat===true)&&session.host==='local'&&session.access?.canUseSideChat!==false;}
  targets(session){
    const wb=this.workbench;if(!this.current(session))return [];
    const targets=[{id:'chat',name:BridgeI18n.t('主会话'),quotes:wb.fileQuotes,available:()=>this.current(session)&&wb.canQuoteMain?.()!==false&&session.access?.canSend!==false,
      focus:()=>{wb.select('chat');wb.revealMainComposer?.();}}];
    for(const tab of session.files){const side=tab.sideChat;if(!side||side.disposed)continue;
      targets.push({id:tab.id,name:tab.name,quotes:side.fileQuotes,available:()=>this.current(session)&&session.files.includes(tab)&&!side.disposed&&!side.busy&&!side.pending,
        focus:()=>{wb.select(tab.id);side.collapse(false);side.controls();}});
    }
    if(this.canCreate(session))targets.push({id:'new-sidechat',name:BridgeI18n.t('新建侧边聊天'),available:()=>this.canCreate(session),create:true});
    return targets;
  }
  available(session=this.workbench.current){return !!session&&this.targets(session).some(target=>target.available());}
  addText(text,session=this.workbench.current){
    if(!session)return;
    const quote=text.split('\n').map(line=>'> '+line).join('\n')+'\n\n';
    return this.choose(session,{text:quote});
  }
  choose(session,payload,valid=()=>true,onAdded=()=>{}){
    const wb=this.workbench;if(!this.current(session)||!valid())return;
    this.close();const revision=this.revision,isCurrent=()=>this.revision===revision&&this.current(session)&&valid();
    const append=(quotes,commit=true)=>{
      if(payload.file){if(!commit)return quotes.validate(FileQuoteDrafts.compose(quotes.input.value,[...quotes.rows,payload.file]));return quotes.add(payload.file);}
      const input=quotes.input,value=input.value+(input.value?'\n\n':'')+payload.text;quotes.validate(quotes.text(value));
      if(commit){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));}return true;
    };
    const insert=target=>{
      if(!isCurrent())return false;
      const latest=this.targets(session).find(row=>row.id===target.id&&row.quotes===target.quotes);
      if(!latest?.available())return false;
      let newSide;
      if(latest.create){
        // Validate before opening a tab so an oversized quote leaves no empty tab.
        const empty={input:{value:'',maxLength:20000},rows:[],validate:FileQuoteDrafts.prototype.validate,text:FileQuoteDrafts.prototype.text};append(empty,false);
        const tab=wb.createSideChat(session,uuid());if(!tab)return false;
        newSide=tab.sideChat;
        target=this.targets(session).find(row=>row.id===tab.id);
      }
      if(!append(target.quotes))return false;
      this.close();window.getSelection()?.removeAllRanges();wb.closePreviewFullscreen();onAdded();target.focus();target.quotes.input.focus();newSide?.create();return true;
    };
    const targets=this.targets(session);if(targets.length===1){try{insert(targets[0]);}catch(error){wb.notify(error.message);}return;}
    wb.closePreviewFullscreen();
    const dialog=this.dialog=wb.node('dialog','picker file-quote-target'),head=wb.node('div','picker-head');
    head.append(wb.node('h2','','添加到哪个聊天？'),wb.button('关闭',()=>dialog.close(),'关闭'));
    const list=wb.node('div','file-quote-targets');
    for(const target of targets){const button=wb.raw(wb.button(target.name,()=>{try{insert(target);}catch(error){wb.notify(error.message);}},target.name));button.dataset.quoteTarget=target.id;button.disabled=!target.available();list.append(button);}
    dialog.append(head,list);dialog.addEventListener('close',()=>{dialog.remove();if(this.dialog===dialog)this.dialog=null;},{once:true});document.body.append(dialog);dialog.showModal();
  }
  close(){this.revision=(this.revision||0)+1;const dialog=this.dialog;this.dialog=null;dialog?.close();}
}
