'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('list filters follow the selected label and language',()=>{
  const events={},documentEvents={};
  const measure={style:{},textContent:'',getBoundingClientRect(){return {width:this.textContent.length*8};}};
  const select=text=>({style:{},selectedOptions:[{textContent:text}],getBoundingClientRect(){return {width:parseInt(this.style.width,10)}}});
  const surface=select('All'),mode=select('Recent');
  const toolbar={querySelector:()=>null,querySelectorAll:()=>[surface,mode],addEventListener(name,fn){events[name]=fn;}};
  const context=vm.createContext({document:{createElement:()=>measure,body:{append(){}},addEventListener(name,fn){documentEvents[name]=fn;}},window:{addEventListener(){}},getComputedStyle:()=>({font:'12px sans-serif',letterSpacing:'normal'}),requestAnimationFrame:fn=>fn()});
  vm.runInContext(fs.readFileSync('web/features/clients/client-navigation.js','utf8'),context);
  vm.runInContext('bindChatListToolbar(toolbar)',Object.assign(context,{toolbar}));
  assert.equal(mode.style.width,'78px');assert.equal(surface.style.width,'54px');
  mode.selectedOptions[0].textContent='Project';events.change();assert.equal(mode.style.width,'86px');
  mode.selectedOptions[0].textContent='按项目';documentEvents['bridge-language']();assert.equal(mode.style.width,'54px');
});
