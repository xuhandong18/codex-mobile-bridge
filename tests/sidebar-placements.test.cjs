const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context=vm.createContext({});vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8')+'\nthis.Placements=SidebarPlacements;',context);
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
const item=(kind='thread',host='local',id='id')=>({kind,host,id});

test('project and chat placement persist and stay isolated by gateway, host and kind',()=>{
  const saved=storage(),placements=new context.Placements(saved,'gateway|');
  placements.set(item(),'section:work',['work']);
  assert.equal(new context.Placements(saved,'gateway|').resolve(item(),['work']),'section:work');
  for(const other of [item('project'),item('thread','ssh'),item('thread','local','other')])assert.equal(placements.resolve(other,['work']),'home');
  assert.equal(new context.Placements(saved,'other|').resolve(item(),['work']),'home');
});

test('pinning overrides native placement and unpinning restores the prior section',()=>{
  const placements=new context.Placements(storage()),ref=item('project');
  placements.togglePin(ref,['work'],'section:work');assert.equal(placements.resolve(ref,['work'],'section:work'),'pinned');
  placements.togglePin(ref,['work'],'section:work');assert.equal(placements.resolve(ref,['work'],'section:work'),'section:work');
  placements.set(ref,'home',['work'],'section:work');assert.equal(placements.resolve(ref,['work'],'section:work'),'home');
});

test('a natively pinned chat can be unpinned and can return to following native placement',()=>{
  const placements=new context.Placements(storage()),ref=item();
  placements.togglePin(ref,[],'pinned');assert.equal(placements.resolve(ref,[],'pinned'),'home');
  placements.set(ref,'native',[]);assert.equal(placements.resolve(ref,[],'pinned'),'pinned');
});

test('a removed section falls back safely and a stale destination is rejected',()=>{
  const placements=new context.Placements(storage()),ref=item();
  placements.set(ref,'section:work',['work']);assert.equal(placements.resolve(ref,[]),'home');
  assert.throws(()=>placements.set(ref,'section:removed',[]),/分区已变化/);
  placements.togglePin(ref,[]);placements.togglePin(ref,[]);assert.equal(placements.resolve(ref,[]),'home');
});

test('failed storage writes do not report a changed placement',()=>{
  const placements=new context.Placements({getItem:()=>null,setItem(){throw Error('storage denied');}});
  assert.throws(()=>placements.set(item(),'pinned',[]),/storage denied/);
  assert.equal(placements.resolve(item(),[]),'home');
});
