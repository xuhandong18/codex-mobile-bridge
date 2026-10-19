const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync('web/features/chat/session-list.js','utf8')+'\nthis.Order=SidebarItemOrder;this.Pins=SidebarProjectPins;',context);
function storage(){const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
const ids=value=>Array.from(value);

test('project order persists across controller recreation and keeps other hosts and projects separate',()=>{
  const saved=storage(),order=new context.Order(saved,'gateway|');
  assert.equal(order.move('local|p',['a','b','c'],'c','a'),true);
  assert.deepEqual(ids(new context.Order(saved,'gateway|').sort('local|p',['a','b','c'])),['c','a','b']);
  for(const key of ['local|q','ssh|p'])assert.deepEqual(ids(order.sort(key,['a','b','c'])),['a','b','c']);
  assert.deepEqual(ids(new context.Order(saved,'other-gateway|').sort('local|p',['a','b','c'])),['a','b','c']);
});

test('new conversations are visible before the remembered order',()=>{
  const order=new context.Order(storage());order.move('p',['a','b'],'b','a');
  assert.deepEqual(ids(order.sort('p',['new','a','b'])),['new','b','a']);
});

test('moving a filtered subset preserves unloaded conversations',()=>{
  const order=new context.Order(storage());order.move('p',['a','b','c','d'],'b','a');
  order.move('p',['a','d'],'d','a');
  assert.deepEqual(ids(order.sort('p',['a','b','c','d'])),['b','d','c','a']);
});

test('cross-project or stale targets cannot change the order',()=>{
  const order=new context.Order(storage());
  assert.equal(order.move('p',['a','b'],'foreign','a'),false);
  assert.equal(order.move('p',['a','b'],'a','foreign'),false);
  assert.equal(order.move('p',['a','b'],'a','a'),false);
  assert.deepEqual(ids(order.sort('p',['a','b'])),['a','b']);
});

test('a blocked preference write is surfaced instead of claiming it was saved',()=>{
  const order=new context.Order({getItem:()=>null,setItem(){throw Error('storage denied');}});
  assert.throws(()=>order.move('p',['a','b'],'b','a'),/storage denied/);
});

test('project pins persist independently of chat moves, other projects, hosts and gateways',()=>{
  const saved=storage(),pins=new context.Pins(saved,'gateway|pins'),order=new context.Order(saved,'gateway|order');
  order.move('local|p',['a','b'],'b','a');pins.toggle('local|p','a');pins.toggle('local|p','b');
  assert.deepEqual([...new context.Pins(saved,'gateway|pins').read('local|p')],['a','b']);
  assert.deepEqual(ids(order.sort('local|p',['a','b'])),['b','a']);
  for(const project of ['local|q','ssh|p'])assert.equal(pins.read(project).size,0);
  assert.equal(new context.Pins(saved,'other|pins').read('local|p').size,0);
  pins.toggle('local|p','a');assert.deepEqual([...pins.read('local|p')],['b']);
});

test('invalid saved pins are ignored and a denied write leaves the previous pins intact',()=>{
  const saved=storage();saved.setItem('pins','[["p","a"],null,["p"],["p",1],{},["p","b"]]');
  const pins=new context.Pins(saved,'pins');assert.deepEqual([...pins.read('p')],['a','b']);
  const blocked=new context.Pins({getItem:saved.getItem,setItem(){throw Error('storage denied');}},'pins');
  assert.throws(()=>blocked.toggle('p','a'),/storage denied/);assert.deepEqual([...blocked.read('p')],['a','b']);
});

test('confirmed created rows survive an older list response, then yield to the authoritative row',()=>{
  const source=fs.readFileSync('web/shell/app.js','utf8');
  const row={id:'created',host:'local',title:'Created',access:{source:'desktop'}};
  const ctx=vm.createContext({createdChats:new Map([['local|created',row]])});
  vm.runInContext(source.slice(source.indexOf('function mergeCreatedChats('),source.indexOf('function sidebarEntry(')),ctx);
  assert.deepEqual(ids(ctx.mergeCreatedChats([],'local','',false,'all')).map(row=>row.id),['created']);
  for(const args of [['ssh','',false,'all'],['local','search',false,'all'],['local','',true,'all'],['local','',false,'cli']])assert.equal(ctx.mergeCreatedChats([],...args).length,0);
  const fresh={...row,title:'Authoritative title'};
  assert.equal(ctx.mergeCreatedChats([fresh],'local','',false,'all')[0].title,'Authoritative title');
  assert.equal(ctx.createdChats.size,0);
});
