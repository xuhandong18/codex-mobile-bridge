'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
  constructor(tag,className='',text=''){Object.assign(this,{tagName:tag,className,textContent:text,children:[]});}
  append(node){if(node.parentElement)node.parentElement.children.splice(node.parentElement.children.indexOf(node),1);this.children.push(node);node.parentElement=this;}
  querySelector(selector){return this.children.find(node=>selector.startsWith('.')?node.className.split(' ').includes(selector.slice(1)):node.tagName===selector)||this.children.map(node=>node.querySelector(selector)).find(Boolean)||null;}
}
function fixture(){
  const context=vm.createContext({document:{createElement:tag=>new Element(tag)}});
  vm.runInContext(fs.readFileSync('web/features/chat/message-groups.js','utf8'),context);
  return vm.runInContext('ChatMessageGroups',context);
}
test('秒、毫秒和 ISO 原始时间显示一致，不采用页面刷新时刻',()=>{
  const Groups=fixture(),stamp='2026-10-23T01:02:03.456Z',date=new Date(stamp);
  const pad=value=>String(value).padStart(2,'0');
  const expected=`10-23 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  for(const timestamp of [stamp,date.getTime(),date.getTime()/1000,String(date.getTime())]){
    const node=new Element('article');Groups.decorateTime(node,{role:'assistant',timestamp});
    const time=node.querySelector('time');assert.equal(time.dateTime,stamp);assert.equal(time.textContent,expected);
    assert.equal(time.title,'2026-'+expected);
  }
});
test('消息时间在复制、编辑和分支按钮后；反复更新不重复添加时间',()=>{
  const Groups=fixture(),node=new Element('article'),bar=new Element('div','message-actions');node.append(bar);
  bar.append(new Element('button','','复制'));
  const message={role:'user',timestamp:'2026-10-23T01:02:03Z'};
  Groups.decorateTime(node,message);bar.append(new Element('button','','编辑并重新发送'));
  Groups.decorateTime(node,message);Groups.decorateTime(node,message);
  assert.deepEqual(bar.children.map(node=>node.tagName),['button','button','time']);
  assert.equal(bar.children[1].textContent,'编辑并重新发送');
});
test('命令、工具、文件和公开思考摘要各自在折叠标题后显示时间',()=>{
  const Groups=fixture();
  for(const kind of ['commandExecution','mcpToolCall','fileChange','reasoning']){
    const node=new Element('details'),summary=new Element('summary','',kind);node.append(summary);
    Groups.decorateTime(node,{role:'activity',kind,timestamp:'2026-10-23T01:02:03Z'});
    assert.equal(summary.children[0].tagName,'time');assert.equal(summary.textContent,kind);
    assert.equal(node.querySelector('.message-actions'),null);
  }
});
test('旧记录缺失时间和无效时间均不显示伪造时间',()=>{
  const Groups=fixture();
  for(const timestamp of [undefined,null,'',0,-1,'not-a-date',Infinity]){
    const node=new Element('article');Groups.decorateTime(node,{role:'assistant',timestamp});
    assert.equal(node.children.length,0);
  }
});
