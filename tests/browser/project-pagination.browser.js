// Isolated fixture: project local|fixture has 27 chats, another project fills
// two global metadata pages between its five newest and its older chats.
async function runProjectPaginationBrowserTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const group=key=>[...document.querySelectorAll('.project-group')].find(node=>node.dataset.projectKey===key);
  const count=key=>group(key).querySelectorAll('.session').length;
  const more=key=>group(key).querySelector('.project-load-more');
  check(count('local|fixture')===5&&count('local|other')===5,'Every expanded project initially renders five chats');
  await more('local|fixture').onclick();
  check(count('local|fixture')===15,'One click finds ten older project chats beyond the initial global page');
  check(count('local|other')===5,'Loading one project does not expand another project');
  await loadList(true);
  check(count('local|fixture')===15,'Automatic list refresh preserves the expanded page');
  await more('local|fixture').onclick();
  check(count('local|fixture')===25,'The next click adds exactly ten more chats');
  await more('local|fixture').onclick();
  check(count('local|fixture')===27&&!more('local|fixture'),'The final partial page removes its load-more control');
  const expected=listRows.filter(row=>row.projectKey==='local|fixture').map(row=>row.id);
  const ids=()=>[...group('local|fixture').querySelectorAll('.session')].map(button=>button.dataset.id);
  check(ids().join(',')===expected.join(','),'All loaded project chats stay in recent order');
  await loadList(true);
  check(ids().join(',')===expected.join(','),'A refresh retains recent order across loaded pages');
  return checks;
}
