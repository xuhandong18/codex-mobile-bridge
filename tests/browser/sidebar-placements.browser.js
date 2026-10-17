// Isolated sidebar fixture only: multiple project chats and a "planning" section.
async function runSidebarPlacementBrowserTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const wait=()=>new Promise(resolve=>setTimeout(resolve,30));
  const section=id=>document.querySelector('[data-section="'+id+'"]');
  const project=()=>document.querySelector('.project-group[data-project-key="local|fixture"]');
  const menuButton=label=>[...document.querySelectorAll('.chat-context-menu button')].find(button=>button.textContent===label);
  const rightClick=node=>node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:150}));
  rightClick(project().querySelector('summary'));
  check(!!menuButton('置顶')&&!!menuButton('移动到分区…'),'Right-clicking a project opens pin and section actions');
  menuButton('置顶').click();await wait();
  check(section('pinned').contains(project()),'A project moves to pinned immediately');
  rightClick(project().querySelector('summary'));menuButton('取消置顶').click();await wait();
  check(section('projects').contains(project()),'Unpinning restores the original project location');
  rightClick(project().querySelector('summary'));menuButton('移动到分区…').click();await wait();
  let dialog=document.querySelector('.sidebar-placement-dialog[open]'),select=dialog.querySelector('select');
  check(!!select.querySelector('option[value="section:planning"]'),'The popup offers the available custom section');
  select.value='section:planning';dialog.querySelector('form').requestSubmit();await wait();
  check(section('planning').contains(project()),'The project moves into the chosen section');
  const row=project().querySelector('.session'),id=row.dataset.id;
  rightClick(row);menuButton('置顶').click();await wait();
  let pinnedRow=section('pinned').querySelector('.session[data-id="'+id+'"]');
  check(!!pinnedRow,'A chat can be pinned independently of its project');
  rightClick(pinnedRow);menuButton('取消置顶').click();await wait();
  check(project().querySelector('.session[data-id="'+id+'"]'),'Unpinning returns the chat to its original project');
  rightClick(project().querySelector('.session[data-id="'+id+'"]'));menuButton('移动到分区…').click();await wait();
  dialog=document.querySelector('.sidebar-placement-dialog[open]');dialog.querySelector('select').value='section:planning';dialog.querySelector('form').requestSubmit();await wait();
  check([...section('planning').children].some(node=>node.dataset.id===id),'A chat can move directly to a section without changing its project metadata');
  await loadList(true);
  check(section('planning').contains(project())&&[...section('planning').children].some(node=>node.dataset.id===id),'Native list refresh retains both local project and chat placement');
  return {checks,id};
}
