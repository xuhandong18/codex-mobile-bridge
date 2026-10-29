'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../bridge/clients/chatgpt/probe.js'), 'utf8');
const threadId = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const state = {account:'account-fixture', user:'user-fixture', refreshes:0,
    route:{pathname:'/threads/another-task', key:'route-key'}, cacheId:threadId};
  const initial = Object.fromEntries(['ler','uer','c0n','Xkn','tdn','dXt'].map(key => [key, key]));
  const scope = {
    get(key, value) {
      return ({ler:state.account, uer:state.user, c0n:{isCapable:true}, Xkn:state.route, tdn:value})[key];
    },
    query:{snapshot() { return {refetch:async() => { state.refreshes++; state.afterRefresh?.(); }}; }},
    queryClient:{getQueryState() { return {status:'success', fetchStatus:'idle', dataUpdatedAt:100,
      data:{conversation_id:state.cacheId, update_time:50, title:'private', preview:'private', mapping:{private:true}}}; }},
  };
  initial.rrt = () => {
    const account = state.account;
    return () => { if (state.account !== account) throw Error('account_changed'); };
  };
  const load = async url => url.includes('primary') ? {Jp:{scope}} : initial;
  const run = vm.runInNewContext(source, {location:{protocol:'app:',host:'-'},
    document:{baseURI:'app://-/index.html'}, window:{codexWindowType:'primary'},
    URL, TextEncoder, crypto:webcrypto});
  const request = {modules:{primary:'assets/primary.js', initial:'assets/initial.js'}, threadId, refresh:false};
  return {state, request, load, run};
}

test('cache observation exports only metadata and an opaque account key', async() => {
  const f = fixture();
  const result = await f.run(f.request, f.load);
  assert.equal(f.state.refreshes, 0);
  assert.equal(result.thread.accountVerified, false);
  assert.equal(result.mutationVerified, false);
  assert.match(result.accountKey, /^[0-9a-f]{64}$/);
  for (const hidden of ['private','account-fixture','user-fixture','mapping','preview']) {
    assert.equal(JSON.stringify(result).includes(hidden), false);
  }
});

test('explicit passive refresh can confirm cache identity without navigation', async() => {
  const f = fixture();
  const result = await f.run({...f.request, refresh:true}, f.load);
  assert.equal(f.state.refreshes, 1);
  assert.equal(result.thread.accountVerified, true);
  assert.equal(result.route, '/threads/another-task');
});

test('account or route changes during the query invalidate its response', async() => {
  for (const change of [state => { state.account='other'; }, state => { state.route={pathname:'/changed',key:'other'}; }]) {
    const f = fixture();
    f.state.afterRefresh = () => change(f.state);
    await assert.rejects(f.run({...f.request, refresh:true}, f.load), /account_changed|context_changed/);
  }
});

test('a mismatched cached conversation and an arbitrary module path are rejected', async() => {
  const f = fixture();
  f.state.cacheId = 'another-id';
  await assert.rejects(f.run(f.request, f.load), /cache_id_mismatch/);
  await assert.rejects(f.run({...f.request, modules:{primary:'https://other/script.js'}}, f.load), /invalid_module/);
});
