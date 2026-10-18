'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(storage=new Map()){
 const localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
 const context=vm.createContext({localStorage,window:{BridgeRelayBase:'/d/computer-a'},location:{origin:'https://gateway.test'}});
 vm.runInContext(fs.readFileSync('web/features/chat/composer-drafts.js','utf8'),context);
 const Drafts=vm.runInContext('ComposerDrafts',context);return {drafts:new Drafts(),storage};
}
test('unsent text survives page recreation and stays isolated by login, client and host',()=>{
 const a=fixture();a.drafts.bind('login-a');a.drafts.set('codex:local|same','本机未发送');a.drafts.set('codex:ssh|same','远端未发送');a.drafts.set('claude:same','Claude 草稿');
 const b=fixture(a.storage);b.drafts.bind('login-a');assert.equal(b.drafts.get('codex:local|same'),'本机未发送');assert.equal(b.drafts.get('codex:ssh|same'),'远端未发送');assert.equal(b.drafts.get('claude:same'),'Claude 草稿');
 b.drafts.bind('login-b');assert.equal(b.drafts.size,0);b.drafts.bind('login-a');assert.equal(b.drafts.size,3);
 b.drafts.bind('');b.drafts.clear();b.drafts.bind('login-a');assert.equal(b.drafts.size,3);
 b.drafts.forget();assert.equal(fixture(a.storage).drafts.bind('login-a').size,0);
});
test('clearing or sending a draft persists its removal and storage errors preserve in-memory typing',()=>{
 const a=fixture();a.drafts.bind('login');a.drafts.set('claude:chat','draft');a.drafts.delete('claude:chat');assert.equal(fixture(a.storage).drafts.bind('login').size,0);
 a.drafts.set('claude:chat','draft');a.drafts.set('claude:chat','');assert.equal(fixture(a.storage).drafts.bind('login').size,0);
 const context=vm.createContext({localStorage:{getItem(){throw Error('blocked');},setItem(){throw Error('quota');},removeItem(){throw Error('blocked');}},window:{},location:{origin:'https://gateway.test'}});
 vm.runInContext(fs.readFileSync('web/features/chat/composer-drafts.js','utf8'),context);const drafts=vm.runInContext('new ComposerDrafts()',context);drafts.bind('login');drafts.set('codex:local|chat','keep typing');assert.equal(drafts.get('codex:local|chat'),'keep typing');
});
