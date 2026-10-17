const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('message map orders user markers, jumps on a single click without intercepting touch and cleans up',()=>{
  class Element {
    constructor(){this.children=[];this.dataset={};this.events={};this.attrs={};this.style={setProperty(){}};this.classes=new Set();this.classList={contains:x=>this.classes.has(x),add:x=>this.classes.add(x),remove:x=>this.classes.delete(x)};}
    append(...items){for(const item of items){item.remove();item.parentElement=this;this.children.push(item);}}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null;}
    get lastChild(){return this.children.at(-1);}
    addEventListener(name,fn){this.events[name]=fn;}
    setAttribute(key,value){this.attrs[key]=value;}
    removeAttribute(key){delete this.attrs[key];}
    getBoundingClientRect(){return {top:50,right:400,width:400,height:300};}
    blur(){}
  }
  const document={createElement:()=>new Element(),addEventListener(){}};
  const context=vm.createContext({document,window:{innerWidth:400,addEventListener(){}},AbortController,ResizeObserver:class{observe(){}disconnect(){this.disconnected=true;}}});
  vm.runInContext(fs.readFileSync('web/features/chat/timeline.js','utf8')+'\nthis.MapView=ChatMessageMap;',context);
  const viewport=new Element();viewport.scrollTop=0;new Element().append(viewport);
  const row=(key,order,role='user')=>({row:{key,order,role,text:key}});
  const timeline={viewport,rows:new Map([['b',row('b',2)],['reply',row('reply',3,'assistant')],['a',row('a',1)]]),nodes:new Map([['a',{node:new Element()}]]),capture:()=>({key:'a',offset:12}),loadOlder(){},following:true};
  const map=new context.MapView(timeline);
  assert.deepEqual(map.list.children.map(x=>x.dataset.key),['a','b']);
  map.list.children[0].onclick();assert.equal(timeline.following,false);assert.equal(timeline.anchor.key,'a');
  assert.equal(map.root.events.pointerdown,undefined,'Touch must not consume the first activation');
  assert.equal(map.root.events.click,undefined,'Click must reach the marker without a second activation');
  timeline.rows.delete('a');map.update();assert.deepEqual(map.list.children.map(x=>x.dataset.key),['b']);
  map.dispose();assert.equal(map.root.parentElement,null);assert.equal(map.abort.signal.aborted,true);
});
