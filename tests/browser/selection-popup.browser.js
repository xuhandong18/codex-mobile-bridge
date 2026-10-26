// Isolated synthetic quote fixture only; side creation is handled by the mock API.
async function runUnifiedSelectionPopupBrowserTests(gesture='mouse',provider='codex'){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),wb=provider==='codex'?workbench:desktopSessions.workbench,session=wb.current;
  const one=wb.createSideChat(session,uuid()),two=wb.createSideChat(session,uuid());
  await one.sideChat.create();await two.sideChat.create();
  const message=(root,text)=>{const body=document.createElement('div');body.className='message-body';body.textContent=text;root.append(body);return body;};
  const main=message(provider==='codex'?$('messages'):desktopSessions.messages,'The complete main reply'),side=message(one.sideChat.messages,'The complete side reply');
  await wb.preview(session,{name:'demo.js',path:'src/demo.js'});
  const file=session.files.find(tab=>tab.filePath==='src/demo.js'),code=file.body.querySelector('.wb-source-code code');
  const expected=['chat',one.id,two.id,'new-sidechat'];let firstMarkup;
  for(const source of [
    {name:'Main',tab:'chat',node:main,trigger:provider==='codex'?$('selection-button'):desktopSessions.selectionButton,action:provider==='codex'?selectedTextAction:desktopSessions.selectionAction},
    {name:'Side',tab:one.id,node:side,trigger:one.sideChat.selectionButton,action:one.sideChat.selectionAction},
    {name:'File',tab:file.id,node:code,trigger:file.quoteButton,action:wb.fileSelection}
  ]){
    wb.select(source.tab);const range=document.createRange();range.selectNodeContents(source.node);getSelection().removeAllRanges();getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));await wait(200);
    check(!document.querySelector('dialog[open]'),source.name+': selecting text does not open a popup');
    if(gesture==='touch'){
      const native=source.node.dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:'touch'}));
      check(native&&!document.querySelector('dialog[open]'),source.name+': native Copy/Share remains available');
    }else{
      source.node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:2}));
      check(source.node.dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:'mouse',button:2})),source.name+': a desktop right-click keeps the native menu');
      check(!document.querySelector('dialog[open]'),source.name+': a desktop right-click never opens a web picker');
      check(source.node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})),source.name+': a keyboard context menu also remains native');
      check(!document.querySelector('dialog[open]')&&getSelection().toString()===source.node.textContent,source.name+': opening a native menu preserves the complete selection');
    }
    source.action.update();check(!source.trigger.disabled,source.name+': the explicit selection button is available');
    source.trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:gesture,isPrimary:true}));source.trigger.click();
    for(let i=0;!wb.selectionTargets.dialog?.open&&i<100;i++)await wait(20);
    const dialog=wb.selectionTargets.dialog;check(dialog?.open,source.name+': explicit quoting opens the target picker');
    check(document.querySelectorAll('dialog[open]').length===1&&!document.querySelector('.chat-context-menu[open]'),source.name+': no intermediate function menu');
    const targets=[...dialog.querySelectorAll('[data-quote-target]')].map(button=>button.dataset.quoteTarget);
    check(JSON.stringify(targets)===JSON.stringify(expected),source.name+': main, each existing side, and new side are offered');
    const markup=dialog.innerHTML;if(firstMarkup)check(markup===firstMarkup,source.name+': the popup matches the main selection popup exactly');else firstMarkup=markup;
    wb.selectionTargets.close();await wait(30);
    if(gesture==='mouse'){
      getSelection().removeAllRanges();getSelection().addRange(range);source.action.update();
      check(!source.action.bar.hidden,source.name+': a selection has a floating button alternative');
      (source.action.addButton||source.action.button).click();
      for(let i=0;!wb.selectionTargets.dialog?.open&&i<100;i++)await wait(20);
      check(wb.selectionTargets.dialog?.open,source.name+': the floating button opens the shared target picker');
      wb.selectionTargets.close();await wait(30);
    }
  }
  if(provider==='codex'){
    check(!document.querySelector('#composer #notify-button'),'The composer no longer contains the reminder button');
    check(document.querySelector('#chat-details-dialog #notify-button')?.textContent===BridgeI18n.t('聊天通知设置'),'Chat notification settings remain accessible in chat details');
  }
  main.remove();side.remove();return checks;
}
