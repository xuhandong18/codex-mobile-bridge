// Run only against a fresh synthetic side-chat gateway; creates no model turns.
async function runSideChatNamesBrowserTests(){
  const wb=window.BridgeWorkbench,session=wb.current,checks=[];
  const check=(ok,label)=>{if(!ok)throw Error(label);checks.push(label);};
  const wait=async run=>{for(let i=0;i<160;i++){if(run())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Side-chat naming fixture timed out');};
  const active=()=>session.files.find(tab=>tab.id===session.active);
  const rename=async(panel,title)=>{
    panel.renameButton.click();const dialog=panel.renameDialog;
    dialog.querySelector('input').value=title;dialog.querySelector('button[type=submit]').click();
    await wait(()=>!dialog.open);
  };
  const create=async tab=>{tab.sideChat.createButton.click();await wait(()=>tab.sideChat.state?.id&&!tab.sideChat.busy);};
  if(!active()?.sideChat)wb.sideChat();const first=active();
  await rename(first.sideChat,'方案讨论');
  check(first.name==='方案讨论'&&!first.sideChat.state?.id,'A side draft can be named without creating a runtime');
  await create(first);check(first.sideChat.state.title==='方案讨论','Creation saves the draft name in shared state');
  first.sideChat.input.value='First side draft';first.sideChat.input.dispatchEvent(new Event('input'));
  first.sideChat.newButton.click();const second=active();
  check(second!==first&&second.slot!==first.slot,'New side chat opens a second independent slot');
  await create(second);await rename(second.sideChat,'验证计划');
  check(second.sideChat.state.title==='验证计划','An existing side chat can be renamed');
  second.sideChat.newButton.click();const third=active();await create(third);await rename(third.sideChat,'保存');
  check(new Set([first,second,third].map(tab=>tab.sideChat.state.id)).size===3,'Three side chats connect to different runtimes');
  const listing=await third.sideChat.request();
  check([first,second,third].every(tab=>listing.slots.some(row=>row.id===tab.sideChat.state.id&&row.title===tab.name)),'Read-only discovery exposes all three names to other devices');
  const language=BridgeI18n.language();BridgeI18n.setLanguage('en');wb.relabel();
  const group=Array.from(wb.tabs.children).find(node=>node.dataset.tab===third.id);
  check(group.querySelector('[role=tab]').textContent==='保存'&&third.sideChat.caption.textContent==='保存','User titles that match UI translations stay literal in English');
  BridgeI18n.setLanguage(language);wb.relabel();
  const revision=third.sideChat.state.titleRevision;
  wb.syncSideChats(session,[{slot:third.slot,id:third.sideChat.state.id,title:'Stale name',titleRevision:revision-1}]);
  check(third.name==='保存','An earlier discovery result cannot undo a rename');
  wb.select(first.id);check(first.sideChat.input.value==='First side draft','Switching among named chats preserves each draft');
  first.sideChat.renameButton.click();const invalid=first.sideChat.renameDialog;
  invalid.querySelector('input').value=' ';invalid.querySelector('button[type=submit]').click();
  check(invalid.open&&!!invalid.querySelector('.error').textContent&&first.name==='方案讨论','Empty titles show a validation error without changing the name');invalid.close();
  check(wb.fileQuotes.input.value==='','Side naming never changes the main draft');
  return checks;
}
