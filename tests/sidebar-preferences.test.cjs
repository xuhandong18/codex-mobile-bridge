const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const ctx=vm.createContext({});
vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8')+'\nthis.types={SidebarPreferences,SidebarProjectPins,SidebarItemOrder,SidebarPlacements};',ctx);
const plain=value=>JSON.parse(JSON.stringify(value));
function storage(){const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key),get length(){return data.size;},key:index=>[...data.keys()][index]};}
function server(){
  const state={revision:0,fields:{}},posts=[];
  const request=async(_path,body)=>{
    if(body){
      posts.push(plain(body));
      if(body.changes.some(row=>(state.fields[row.key]?.version||0)!==row.version))throw Object.assign(Error('conflict'),{status:409});
      for(const row of body.changes)state.fields[row.key]={value:plain(row.value),version:row.version+1};
      state.revision++;
    }
    return plain(state);
  };
  return {request,state,posts};
}
function device(shared,{prefix='gateway',legacy=storage(),request=shared.request}={}){
  const prefs=new ctx.types.SidebarPreferences({request,prefix,legacyStorage:legacy}),{keys}=prefs;
  return {prefs,legacy,pins:new ctx.types.SidebarProjectPins(prefs.storage,keys.pins),order:new ctx.types.SidebarItemOrder(prefs.storage,keys.order),placements:new ctx.types.SidebarPlacements(prefs.storage,keys.placement)};
}
const ref={kind:'project',host:'local',id:'local|p'};

test('independent devices recover project pins, sibling order and section placement after refresh',async()=>{
  const shared=server(),a=device(shared),b=device(shared);
  await Promise.all([a.prefs.refresh(),b.prefs.refresh()]);
  await a.prefs.change(()=>a.pins.toggle('local|p','chat'));
  await a.prefs.change(()=>a.order.move('work',['local|a','local|p'],'local|p','local|a'));
  await a.prefs.change(()=>a.placements.set(ref,'section:work',['work']));
  await b.prefs.refresh();
  assert.equal(b.pins.read('local|p').has('chat'),true);
  assert.deepEqual(Array.from(b.order.sort('work',['local|a','local|p'])),['local|p','local|a']);
  assert.equal(b.placements.resolve(ref,['work']),'section:work');
  const cold=device(shared,{prefix:'different-access-url'});await cold.prefs.refresh();
  assert.equal(cold.pins.read('local|p').has('chat'),true,'Gateway identity comes from the service, not the browser URL');
  await b.prefs.change(()=>b.pins.toggle('local|p','chat'));await a.prefs.refresh();
  assert.equal(a.pins.read('local|p').has('chat'),false);
});

test('concurrent independent pins merge and queued local toggles keep their order',async()=>{
  const shared=server(),a=device(shared),b=device(shared);
  await Promise.all([a.prefs.change(()=>a.pins.toggle('local|p','a')),b.prefs.change(()=>b.pins.toggle('ssh|p','a'))]);
  await Promise.all([a.prefs.change(()=>a.pins.toggle('local|p','b')),a.prefs.change(()=>a.pins.toggle('local|p','b'))]);
  await a.prefs.refresh();assert.deepEqual([...a.pins.read('local|p')],['a']);assert.deepEqual([...a.pins.read('ssh|p')],['a']);
});

test('legacy preferences import once, without overriding shared values or deletion records',async()=>{
  const shared=server(),legacy=storage();
  legacy.setItem('gateway|project-pins',JSON.stringify([['local|p','chat']]));
  legacy.setItem('gateway|section-project-order:work',JSON.stringify(['local|p','local|a']));
  legacy.setItem('gateway|sidebar-placement:'+JSON.stringify(['project','local','local|p']),JSON.stringify({target:'pinned',previous:'section:work'}));
  const a=device(shared,{legacy});await a.prefs.refresh();assert.equal(shared.posts.length,1);
  await a.prefs.change(()=>a.pins.toggle('local|p','chat'));
  await a.prefs.change(()=>a.placements.set(ref,'native',['work']));
  const stale=device(shared,{legacy:storage()});
  stale.legacy.setItem('gateway|project-pins',JSON.stringify([['local|p','chat']]));
  stale.legacy.setItem('gateway|sidebar-placement:'+JSON.stringify(['project','local','local|p']),JSON.stringify({target:'pinned'}));
  await stale.prefs.refresh();assert.equal(stale.pins.read('local|p').size,0);assert.equal(stale.placements.resolve(ref,['work']),'home');
  const restarted=device(shared,{legacy});await restarted.prefs.refresh();
  assert.equal(shared.posts.length,3,'No writes on reopen or stale-device migration');
});

test('a stale read arriving after a successful save cannot roll settings back',async()=>{
  const shared=server(),a=device(shared);await a.prefs.refresh();
  const old=plain(shared.state),generation=a.prefs.generation;
  await a.prefs.change(()=>a.pins.toggle('local|p','chat'));
  a.prefs._apply(old,generation);assert.equal(a.pins.read('local|p').has('chat'),true);
});

test('explicitly following native placement prevents a later old-device import',async()=>{
  const shared=server(),a=device(shared);await a.prefs.change(()=>a.placements.set(ref,'native',[]));
  const legacy=storage();legacy.setItem('gateway|sidebar-placement:'+JSON.stringify(['project','local','local|p']),JSON.stringify({target:'pinned'}));
  const old=device(shared,{legacy});await old.prefs.refresh();
  assert.equal(old.placements.resolve(ref,[]),'home');assert.equal(shared.posts.length,1);
});

test('simultaneous legacy imports keep each devices unique settings',async()=>{
  const shared=server(),first=storage(),second=storage();
  first.setItem('gateway|project-pins',JSON.stringify([['local|p','common'],['local|p','first']]));
  second.setItem('gateway|project-pins',JSON.stringify([['local|p','common'],['local|p','second']]));
  const a=device(shared,{legacy:first}),b=device(shared,{legacy:second});
  await Promise.all([a.prefs.refresh(),b.prefs.refresh()]);await a.prefs.refresh();
  assert.deepEqual([...a.pins.read('local|p')].sort(),['common','first','second']);
});

test('a conflicting placement is read back without replaying the write',async()=>{
  const shared=server();let race=false;
  const a=device(shared,{request:async(path,body)=>{
    if(body&&race){race=false;await shared.request(path,{changes:[{...plain(body.changes[0]),value:{target:'section:other'}}]});}
    return shared.request(path,body);
  }});
  await a.prefs.refresh();race=true;
  await assert.rejects(a.prefs.change(()=>a.placements.set(ref,'section:work',['work','other'])),/conflict/);
  assert.equal(shared.posts.length,2);assert.equal(a.placements.resolve(ref,['work','other']),'section:other');
});

test('lost save responses are reconciled using reads and never sent twice',async()=>{
  const shared=server(),a=device(shared,{request:async(path,body)=>{const result=await shared.request(path,body);if(body)throw Error('connection lost');return result;}});
  await a.prefs.change(()=>a.pins.toggle('local|p','chat'));
  assert.equal(shared.posts.length,1);assert.equal(a.pins.read('local|p').has('chat'),true);
});

test('failed saves leave the confirmed UI unchanged and do not replay on refresh',async()=>{
  const shared=server();let writes=0;
  const a=device(shared,{request:async(path,body)=>{if(body){writes++;throw Error('offline');}return shared.request(path);}});
  await assert.rejects(a.prefs.change(()=>a.pins.toggle('local|p','chat')),/保存结果尚未确认/);
  assert.equal(a.pins.read('local|p').size,0);await a.prefs.refresh();assert.equal(writes,1);
});

test('an uncertain legacy import is not automatically replayed after reload',async()=>{
  const shared=server(),legacy=storage();legacy.setItem('gateway|project-pins',JSON.stringify([['local|p','chat']]));let writes=0;
  const a=device(shared,{legacy,request:async(path,body)=>{if(body){writes++;throw Error('offline');}return shared.request(path);}});
  await assert.rejects(a.prefs.refresh(),/同步结果尚未确认/);
  const next=device(shared,{legacy});await next.prefs.refresh();assert.equal(writes,1);assert.equal(shared.posts.length,0);
});

test('logout discards delayed reads and queued writes from the previous login',async()=>{
  const shared=server();let release;
  const a=device(shared,{request:()=>new Promise(resolve=>release=resolve)});
  const pending=a.prefs.refresh();a.prefs.reset();release({revision:10,fields:{[JSON.stringify(['pin','local|p','chat'])]:{value:true,version:1}}});await pending;
  assert.equal(a.pins.read('local|p').size,0);
  const queued=a.prefs.change(()=>a.pins.toggle('local|p','chat'));a.prefs.reset();await assert.rejects(queued,/登录状态已变化/);
});
