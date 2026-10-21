'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ChatDisplaySync}=require('../web/features/settings/chat-display.js');

function gateway(){
  let snapshot={revision:0,settings:{}},writes=0;
  return {get writes(){return writes;},async request(path,body){
    assert.equal(path,'/api/chat-display');
    if(body){writes++;if(body.revision!==snapshot.revision)throw Object.assign(Error('conflict'),{status:409});
      snapshot={revision:snapshot.revision+1,settings:{...snapshot.settings,...body.changes}};}
    return structuredClone(snapshot);
  }};
}
test('a computer disable migrates to the gateway and reaches a separate phone cache',async()=>{
  const server=gateway(),computerChanges=[],phoneChanges=[];
  const computer=new ChatDisplaySync({request:server.request,legacy:{showProcess:false},onChange:value=>computerChanges.push(value)});
  const phone=new ChatDisplaySync({request:server.request,legacy:{showProcess:true},onChange:value=>phoneChanges.push(value)});
  await phone.refresh();await computer.refresh();await phone.refresh();
  assert.equal(phoneChanges.at(-1).showProcess,false);
  await computer.save({showReasoning:false});await phone.refresh();
  assert.equal(phoneChanges.at(-1).showReasoning,false);assert.equal(phoneChanges.at(-1).showProcess,false);
  assert.equal(server.writes,2,'default phone settings cannot overwrite a computer setting');
});
test('old local disables do not overwrite configured gateway values',async()=>{
  const server=gateway();await server.request('/api/chat-display',{revision:0,changes:{showProcess:true}});
  let shown;const phone=new ChatDisplaySync({request:server.request,legacy:{showProcess:false},onChange:value=>shown=value});
  await phone.refresh();assert.equal(shown.showProcess,true);assert.equal(server.writes,1);
});
test('a lost write reply is checked without replay and older reads cannot reverse a newer value',async()=>{
  const server=gateway();let changes,lose=true;
  const sync=new ChatDisplaySync({onChange:value=>changes=value,request:async(path,body)=>{
    const result=await server.request(path,body);if(body&&lose){lose=false;throw Error('connection lost');}return result;
  }});
  await sync.refresh();await sync.save({showProcess:false});
  assert.equal(server.writes,1);assert.equal(changes.showProcess,false);
  sync.accept({revision:0,settings:{showProcess:true}});assert.equal(changes.showProcess,false);
});
test('logout discards reads from an earlier login',async()=>{
  let finish,changes=0;
  const sync=new ChatDisplaySync({request:()=>new Promise(resolve=>finish=resolve),onChange:()=>changes++});
  const pending=sync.refresh();sync.reset();finish({revision:4,settings:{showProcess:false}});await pending;
  assert.equal(changes,0);
});
