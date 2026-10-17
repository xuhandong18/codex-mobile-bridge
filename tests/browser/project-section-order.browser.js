// Isolated fixture only: planning and pinned each contain three projects.
async function runProjectSectionOrderBrowserTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const wait=()=>new Promise(resolve=>setTimeout(resolve,30));
  const root=id=>document.querySelector('[data-section="'+id+'"]');
  const keys=id=>[...root(id).children].filter(node=>node.dataset.projectKey).map(node=>node.dataset.projectKey);
  const fixedSlots=id=>[...root(id).children].map((node,index)=>node.dataset.projectKey?null:[index,node.dataset.id||node.tagName]).filter(Boolean);
  const menu=key=>{const node=[...document.querySelectorAll('.project-group')].find(node=>node.dataset.projectKey===key);node.querySelector('summary').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:150}));};
  const action=label=>[...document.querySelectorAll('.chat-context-menu button')].find(button=>button.textContent===label);
  const unchanged=keys('projects'),pinned=keys('pinned'),slots=fixedSlots('planning');
  menu('local|b');check(!!action('上移')&&!!action('下移'),'Project popup offers up and down controls');action('下移').click();await wait();
  check(keys('planning').join(',')==='local|fixture,local|c,local|b','Moving down reorders only sibling projects');
  check(JSON.stringify(fixedSlots('planning'))===JSON.stringify(slots),'Directly assigned chat rows retain their slots');
  check(keys('pinned').join(',')===pinned.join(',')&&keys('projects').join(',')===unchanged.join(','),'Other sections retain their order');
  menu('local|b');check(action('下移').disabled,'The last project cannot move down');action('取消').click();await wait();
  menu('local|fixture');check(action('上移').disabled,'The first project cannot move up');action('取消').click();await wait();
  await loadList(true);check(keys('planning').join(',')==='local|fixture,local|c,local|b','Refreshing the native list retains section project order');
  menu('local|r');action('上移').click();await wait();
  check(keys('pinned').join(',')==='local|r,local|q,local|s','Pinned projects can also move up');
  check(keys('planning').join(',')==='local|fixture,local|c,local|b','Pinned ordering does not overwrite custom-section ordering');
  return {checks,planning:keys('planning'),pinned:keys('pinned')};
}
