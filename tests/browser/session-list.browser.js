// Run only on the isolated session-list fixture with multiple project chats.
async function runSessionListBrowserTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const buttons=()=>[...document.querySelector('.project-group').children].filter(node=>node.classList.contains('session'));
  check(buttons().length>=2,'A project contains multiple conversations');
  const first=buttons()[0],id=first.dataset.id;
  first.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:150,cancelable:true}));
  const down=[...document.querySelectorAll('.chat-context-menu button')].find(button=>button.textContent==='在项目中下移');
  check(!!down&&!down.disabled,'Project context menu offers moving down');down.click();
  await new Promise(resolve=>setTimeout(resolve,20));
  check(buttons()[1].dataset.id===id,'Moving down changes the actual project order');
  await loadList(true);
  check(buttons()[1].dataset.id===id,'A background list refresh preserves manual order');
  await openChat(buttons()[0].dataset.id,buttons()[0].dataset.host);
  const title='根据首条消息生成的标题';renderState({...state,title});
  check(document.getElementById('chat-title').textContent===title,'Live metadata updates the conversation heading');
  check([...document.querySelectorAll('#sessions .session')].find(button=>button.dataset.id===currentId).querySelector('strong').textContent===title,'Live metadata updates the sidebar title immediately');
  renderState({...state,title:'未命名聊天'});
  check(document.getElementById('chat-title').textContent===title,'An older live snapshot cannot replace a known title with a placeholder');
  return checks;
}
