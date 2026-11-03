'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {VersionedReads}=require('../web/features/chat/list-sync.js');
const version='a'.repeat(64);

test('按完整查询缓存版本，未变化的列表保留通知游标且不受页面对象修改影响',async()=>{
  const calls=[];
  const reader=new VersionedReads({request:async(url,body)=>{
    calls.push(url);assert.equal(body,undefined);
    return url.includes('knownVersion=')?{version,unchanged:true,notificationRead:{cursor:9}}:{version,complete:true,sessions:[{id:'chat',title:'Server'}],notificationRead:{cursor:1}};
  }});
  const route='/api/sessions?host=local&q=one&offset=0',first=await reader.read(route);
  first.sessions[0].title='Local change';
  const same=await reader.read(route);
  assert.equal(same.sessions[0].title,'Server');assert.equal(same.notificationRead.cursor,9);
  assert.ok(calls[1].endsWith('knownVersion='+version));
  await reader.read('/api/sessions?host=ssh&q=one&offset=0');
  await reader.read('/api/sessions?host=local&q=one&offset=100');
  assert.ok(!calls[2].includes('knownVersion'));assert.ok(!calls[3].includes('knownVersion'));
});

test('身份清理丢弃旧版本，旧网关和失败响应不能建立条件缓存',async()=>{
  let release,calls=0;
  const reader=new VersionedReads({request:()=>{calls++;return new Promise(resolve=>release=resolve);}});
  const first=reader.read('/api/chat-display');reader.clear();release({version,revision:1,settings:{}});await first;
  const next=reader.read('/api/chat-display');release({revision:2,settings:{}});await next;
  assert.equal(reader.entries.size,0);assert.equal(calls,2);
  reader.request=async()=>({version,complete:false,sessions:[]});await reader.read('/api/sessions');assert.equal(reader.entries.size,0);
});

test('缓存缺失的条件响应只重读一次完整快照，大小和条目数量有上限',async()=>{
  const calls=[];const reader=new VersionedReads({maxEntries:1,request:async url=>{calls.push(url);return calls.length===1?{version,unchanged:true}:{version,sessions:[]};}});
  await reader.read('/api/sessions?host=local');assert.equal(calls.length,2);assert.ok(!calls[1].includes('knownVersion'));
  await reader.read('/api/sessions?host=ssh');assert.equal(reader.entries.size,1);
  const tiny=new VersionedReads({maxBytes:4,request:async()=>({version,sessions:[]})});await tiny.read('/api/sessions');assert.equal(tiny.entries.size,0);
});

test('设置版本未变化时不重新调用界面更新，成功写入后的读回仍采用最新值',async()=>{
  const {ChatDisplaySync}=require('../web/features/settings/chat-display.js');let calls=0,revision=0;
  const sync=new ChatDisplaySync({onChange:()=>calls++,request:async(path,body)=>{if(body)revision++;return {revision,settings:{showProcess:revision>0}};}});
  await sync.refresh();await sync.refresh();assert.equal(calls,1);
  await sync.save({showProcess:true});assert.equal(calls,2);
});

test('设置写回执丢失时，带旧版本的读回能取到新设置且不会重发写入',async()=>{
  const {ChatDisplaySync}=require('../web/features/settings/chat-display.js');let revision=0,writes=0;
  const raw=async(url,body)=>{
    if(body){writes++;revision++;throw Error('reply lost');}
    const current=String(revision).padStart(64,'0');
    return url.includes('knownVersion='+current)?{version:current,unchanged:true}:{version:current,revision,settings:{showProcess:revision===0}};
  };
  const reader=new VersionedReads({request:raw}),sync=new ChatDisplaySync({request:(url,body)=>body===undefined?reader.read(url):raw(url,body),onChange(){}});
  await sync.refresh();await sync.save({showProcess:false});
  assert.equal(sync.snapshot.settings.showProcess,false);assert.equal(writes,1);
});
