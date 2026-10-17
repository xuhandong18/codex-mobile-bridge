// Run on the isolated navigation fixture, never on real chats.
async function runNavigationPreferenceBrowserTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const project=document.querySelector('[data-section="projects"]');check(!!project,'projects section exists');
  project.open=false;await new Promise(resolve=>setTimeout(resolve,30));
  listRows[0].title+=' refreshed';renderList();check(!document.querySelector('[data-section="projects"]').open,'collapsed section survives a list redraw');
  const group=document.querySelector('.project-group');group.open=false;await new Promise(resolve=>setTimeout(resolve,30));
  listRows[0].title+=' again';renderList();check(!document.querySelector('.project-group').open,'collapsed project survives a list redraw');
  const settings=newChatSettings;
  await openNewChat();for(let i=0;settings.loading&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));
  settings.model.value='fixture-model';settings.fillEfforts('high');settings.permission.value='ask';settings.remember(settings.value());
  $('new-chat-dialog').close();await openNewChat();for(let i=0;settings.loading&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,20));
  check(settings.model.value==='fixture-model'&&settings.effort.value==='high'&&settings.permission.value==='ask','new-chat model, effort and permissions survive reopening');$('new-chat-dialog').close();
  await openChat(listRows[0].id,listRows[0].host);$('message').value='keep this draft';$('message').oninput();
  const node=document.querySelector('#messages .message-body');check(!!node,'message text exists');
  const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);selectedTextAction.update();
  check(!selectedTextAction.trigger.disabled,'selection enables explicit chat actions');
  const text=selection.toString();selectedTextAction.trigger.click();[...document.querySelector('.chat-context-menu').querySelectorAll('button')].find(button=>button.textContent===BridgeI18n.t('在侧边聊天中了解更多')).click();await new Promise(resolve=>setTimeout(resolve,30));
  const side=workbench.current.files.find(tab=>tab.id==='sidechat');check(side.sideChat.input.value.includes(text),'side chat receives selected text as a draft');
  check($('message').value==='keep this draft','side chat preserves the main draft');
  return checks;
}

async function runSelectionActionBrowserTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const wait=()=>new Promise(resolve=>setTimeout(resolve,220));
  workbench.select('chat');
  const body=document.querySelector('#messages .message-body');
  const select=node=>{const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));};
  select(body);await wait();
  document.getElementById('timeline').dispatchEvent(new Event('scroll'));await wait();
  check(!selectedTextAction.trigger.disabled,'Explicit selection actions remain usable after Android selection scrolls the page');
  const native=window.BridgeSelection.capture();
  check(native.add&&native.explain&&typeof native.token==='string','Native selection menu receives supported actions and a selection token');
  const selected=body.textContent;
  getSelection().removeAllRanges();document.dispatchEvent(new Event('selectionchange'));await wait();
  const original=$('message').value;
  check(window.BridgeSelection.run('add',native.token)===true,'Native action retains the captured selection when Android clears its handles');
  check($('message').value.includes(selected)&&$('message').value.startsWith(original),'Add to chat appends a quote and retains the existing draft');
  check(window.BridgeSelection.run('add',native.token)===false,'A consumed native selection cannot be added twice');
  const activity=document.createElement('details');activity.className='activity timeline-row';activity.open=true;
  const text=document.createElement('pre');text.className='activity-body';text.textContent='Public activity summary';activity.append(text);$('messages').append(activity);
  select(text);await wait();
  check(selectedTextAction.selected()==='Public activity summary','Displayed activity text can be selected for follow-up questions');
  const summary=window.BridgeSelection.capture();
  check(window.BridgeSelection.run('explain',summary.token)===true,'Native learn-more action opens a quoted side-chat draft');
  check(workbench.current.files.find(tab=>tab.id==='sidechat').sideChat.input.value.includes(text.textContent),'Side chat receives the selected activity text');
  workbench.select('chat');select(body);const stale=window.BridgeSelection.capture();
  select(text);check(window.BridgeSelection.run('add',stale.token)===false,'An older menu cannot quote a newer, different selection');
  select(body);const current=window.BridgeSelection.capture();
  activity.remove();
  const previous=currentId;currentId='22222222-2222-4222-8222-222222222222';
  check(window.BridgeSelection.run('add',current.token)===false,'A selection from a different chat cannot change the current draft');selectedTextAction.update();currentId=previous;
  select(body);selectedTextAction.update();check(!selectedTextAction.trigger.disabled,'A stale native menu cannot disable explicit actions in the next chat');
  getSelection().removeAllRanges();selectedTextAction.update();
  return checks;
}
