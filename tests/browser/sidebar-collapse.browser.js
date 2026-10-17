// Isolated sidebar fixture only: at least one saved project and one custom section.
async function runSidebarCollapseBrowserTests(mode='codex'){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const wait=()=>new Promise(resolve=>setTimeout(resolve,30));
  const groups=()=>[...document.querySelectorAll('#sessions .sidebar-section, #sessions .project-group')];
  const action=label=>[...document.querySelectorAll('.chat-context-menu button')].find(button=>button.textContent===label);
  $('list-mode').value=mode;$('list-mode').dispatchEvent(new Event('change',{bubbles:true}));await wait();
  for(const group of groups())group.open=true;
  await wait();
  check(groups().length>0&&groups().every(group=>group.open),'The fixture starts with expanded groups');
  const project=document.querySelector('#sessions .project-group').dataset.projectKey;
  projectPage(project).limit=15;
  const draft=$('message').value,id=currentId,host=currentHost;
  $('message').value='Keep this draft while collapsing';
  document.querySelector('#sidebar .list-actions-more').click();await wait();
  check(!!action('新建项目')&&!!action('新建分区')&&!!action('已归档'),'The toolbar retains existing actions');
  check(!!action('折叠所有'),'The toolbar menu offers collapse all');
  action('折叠所有').click();await wait();
  check(groups().every(group=>!group.open),'Collapse all closes both sections and nested projects');
  for(const group of groups()){
    const key=group.dataset.projectKey?'group:'+group.dataset.projectKey:'sidebar-section:'+group.dataset.section;
    check(localStorage.getItem(key)==='closed','Collapsed preference is saved for '+key);
  }
  await loadList(true);
  check(groups().every(group=>!group.open),'Metadata refresh retains every collapsed group');
  check(projectPage(project).limit===15,'Collapsing retains project pagination');
  check($('message').value==='Keep this draft while collapsing'&&currentId===id&&currentHost===host,'Collapsing preserves the active chat and draft');
  const group=document.querySelector('#sessions .project-group');group.open=true;await wait();
  await loadList(true);
  check(document.querySelector('#sessions .project-group').open,'A project can be reopened after collapse all');
  check([...document.querySelectorAll('#sessions .sidebar-section')].every(section=>!section.open),'Reopening a project leaves its section closed');
  document.querySelector('#sidebar .list-actions-more').click();await wait();action('折叠所有').click();await wait();
  $('message').value=draft;
  return {checks,mode};
}
