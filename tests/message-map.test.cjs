const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function directory(entries,rows){
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync('web/features/chat/timeline.js','utf8')+'\nthis.Timeline=ChatTimeline;',context);
  const timeline=Object.create(context.Timeline.prototype);
  timeline.messageIndex=new Map(entries.map(entry=>[entry.id,entry]));
  timeline.rows=new Map(rows.map(row=>[row.key,{row}]));
  return timeline.directoryRows();
}

test('image attachment markup in an older index merges with the same live request',()=>{
  const entry={id:'nav',rowKey:'saved',turnId:'turn',order:0,summary:'Explain the screenshot <image name=[Image #1] path="/fixture/screensh'};
  const row={key:'live',turnId:'turn',order:0,role:'user',text:'Explain the screenshot',attachments:[{type:'localImage',name:'screen.jpg'}]};
  const entries=directory([entry],[row]);
  assert.equal(entries.length,1);
  assert.equal(entries[0].loadedKey,'live');
  assert.equal(entries[0].summary,row.text);
  assert.equal(entries[0].id,'nav');
});

test('identical real submissions remain separate across turns and while the index catches up',()=>{
  const row=(key,turnId,order)=>({key,turnId,order,role:'user',text:'Same question',attachments:[{type:'image',name:'photo.jpg'}]});
  const entry=(id,turnId,order)=>({id,rowKey:'saved:'+id,turnId,order,summary:'Same question'});
  assert.equal(directory([entry('a','first',0),entry('b','second',1)],[row('live-a','first',0),row('live-b','second',1)]).length,2);
  assert.equal(directory([entry('a','first',0)],[row('live-a','first',0),row('new','first',1)]).length,2);
});

test('literal image syntax without an image attachment is not merged with different text',()=>{
  const entry={id:'nav',rowKey:'saved',turnId:'turn',order:0,summary:'Example <image name=[Image #1] path="/fixture/image.jpg">'};
  const row={key:'live',turnId:'turn',order:0,role:'user',text:'Example'};
  assert.equal(directory([entry],[row]).length,2);
});

test('message map opens from the rail, jumps from a summary without intercepting touch and cleans up',()=>{
  class Element {
    constructor(){this.children=[];this.dataset={};this.events={};this.attrs={};this.style={setProperty(){}};this.classes=new Set();this.classList={contains:x=>this.classes.has(x),add:x=>this.classes.add(x),remove:x=>this.classes.delete(x)};}
    append(...items){for(const item of items){item.remove();item.parentElement=this;this.children.push(item);}}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
    get lastChild(){return this.children.at(-1);}
    addEventListener(name,fn){this.events[name]=fn;}
    setAttribute(key,value){this.attrs[key]=value;}
    removeAttribute(key){delete this.attrs[key];}
    getBoundingClientRect(){return {top:50,bottom:350,right:400,width:400,height:300};}
    blur(){}
  }
  const document={createElement:()=>new Element(),addEventListener(){}};
  const context=vm.createContext({document,window:{innerWidth:400,innerHeight:800,addEventListener(){}},AbortController,ResizeObserver:class{observe(){}disconnect(){this.disconnected=true;}}});
  vm.runInContext(fs.readFileSync('web/features/chat/timeline.js','utf8')+'\nthis.MapView=ChatMessageMap;',context);
  const viewport=new Element();viewport.scrollTop=0;new Element().append(viewport);
  const row=(key,order,role='user')=>({row:{key,order,role,text:key}});
  const timeline={viewport,rows:new Map([['context',{row:{key:'context',order:0,role:'user',isUserContext:true,text:'System context'}}],['b',row('b',2)],['reply',row('reply',3,'assistant')],['a',row('a',1)]]),nodes:new Map([['a',{node:new Element()}]]),capture:()=>({key:'a',offset:12}),loadOlder(){},following:true};
  const map=new context.MapView(timeline);
  assert.deepEqual(map.list.children.map(x=>x.dataset.key),['a','b']);
  map.rail.children[0].onclick();assert.equal(map.root.classList.contains('is-open'),true);assert.equal(timeline.following,true);
  map.list.children[0].onclick();assert.equal(timeline.following,false);assert.equal(timeline.anchor.key,'a');
  assert.equal(map.root.classList.contains('is-open'),false);
  assert.equal(map.root.events.pointerdown,undefined,'Touch must not consume the first activation');
  assert.equal(map.root.events.click,undefined,'Click must reach the marker without a second activation');
  timeline.rows.delete('a');map.update();assert.deepEqual(map.list.children.map(x=>x.dataset.key),['b']);
  map.dispose();assert.equal(map.root.parentElement,null);assert.equal(map.abort.signal.aborted,true);
});
