'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../web/shell/app.js'),'utf8');
const requestSource=source.slice(source.indexOf('async function rawApi('),source.indexOf('const versionedReads='));

const html=(status=502)=>new Response('<!DOCTYPE html><html>private proxy error</html>',{status,headers:{'Content-Type':'text/html'}});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture(responses,{holdTimers=false}={}){
  const calls=[],delays=[],timers=new Map(),ctx={csrf:'test-csrf',Blob,DOMException,t:value=>value,hostUrl:value=>value,authLost(){ctx.authLostCount++;},authLostCount:0,
    setTimeout(fn,delay){delays.push(delay);const id=delays.length;if(!holdTimers)timers.set(id,setImmediate(fn));return id;},
    clearTimeout(id){clearImmediate(timers.get(id));timers.delete(id);},
    fetch:async(url,options)=>{calls.push({url,options});const next=responses.shift();if(next instanceof Error)throw next;assert.ok(next,'请求次数超出预期');return next;}};
  vm.createContext(ctx);vm.runInContext(requestSource,ctx);
  return {ctx,calls,delays};
}

test('启动读取遇到 HTML 错误页时，不向用户暴露 JSON 解析异常',async()=>{
  const f=fixture([html(),html(),html()]);
  await assert.rejects(f.ctx.rawApi('/api/sessions'),error=>{
    assert.doesNotMatch(error.message,/Unexpected token|DOCTYPE|not valid JSON/);
    assert.equal(error.status,502);
    assert.match(error.message,/网关|连接/);
    assert.doesNotMatch(error.message,/private proxy error/);
    return true;
  });
  assert.equal(f.calls.length,3);
  assert.deepEqual(f.delays,[300,600]);
});

test('启动读取在 HTML 错误页后恢复，保留请求地址、凭据和缓存策略',async()=>{
  for(const status of [200,502,503,504]){
    const f=fixture([html(status),json({sessions:[{id:'fixture'}]})]);
    assert.equal((await f.ctx.rawApi('/api/sessions?host=local')).sessions[0].id,'fixture');
    assert.equal(f.calls.length,2);
    for(const call of f.calls){assert.equal(call.url,'/api/sessions?host=local');assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.cache,'no-store');assert.equal(call.options.body,undefined);}
  }
});

test('第二次读取仍异常时，可以在最后一次有界读取中恢复',async()=>{
  const f=fixture([html(),html(504),json({authenticated:true,csrf:'fixture'})]);
  assert.equal((await f.ctx.rawApi('/api/auth')).authenticated,true);
  assert.equal(f.calls.length,3);
});

test('重试沿用最初解析的主机地址，不跟随页面切换到另一台电脑',async()=>{
  const f=fixture([html(),json({sessions:[]})]);let host='first';
  f.ctx.hostUrl=url=>{const result='/'+host+url;host='other';return result;};
  await f.ctx.rawApi('/api/sessions');
  assert.deepEqual(f.calls.map(call=>call.url),['/first/api/sessions','/first/api/sessions']);
});

test('已经取消的读取不会再发出请求',async()=>{
  const f=fixture([]),controller=new AbortController();controller.abort();
  await assert.rejects(f.ctx.rawApi('/api/sessions',undefined,controller.signal),error=>error.name==='AbortError');
  assert.equal(f.calls.length,0);
});

test('登录失效即使返回 HTML 也清理登录状态，且不重试',async()=>{
  const f=fixture([html(401)]);
  await assert.rejects(f.ctx.rawApi('/api/sessions'),error=>error.status===401&&/登录/.test(error.message));
  assert.equal(f.ctx.authLostCount,1);assert.equal(f.calls.length,1);assert.deepEqual(f.delays,[]);
});

test('非临时 HTTP 错误和重定向的 HTML 响应不重试',async()=>{
  for(const status of [400,403,404,429,500]){
    const f=fixture([html(status)]);
    await assert.rejects(f.ctx.rawApi('/api/sessions'),error=>error.status===status&&!/Unexpected token/.test(error.message));
    assert.equal(f.calls.length,1);
  }
  const response=html(200);Object.defineProperty(response,'redirected',{value:true});
  const f=fixture([response]);await assert.rejects(f.ctx.rawApi('/api/auth'));assert.equal(f.calls.length,1);
});

test('发送、审批、停止、登录和配对遇到异常响应均不自动重放',async()=>{
  for(const url of ['/api/sessions/fixture/send','/api/sessions/fixture/respond','/api/sessions/fixture/stop','/api/login','/api/pair']){
    const f=fixture([html()]);
    await assert.rejects(f.ctx.rawApi(url,{id:'operation'}),error=>error.status===502&&/结果.*确认/.test(error.message));
    assert.equal(f.calls.length,1);assert.deepEqual(f.delays,[]);
    assert.equal(f.calls[0].options.method,'POST');assert.equal(f.calls[0].options.headers['X-CSRF-Token'],'test-csrf');
    assert.equal(f.calls[0].options.body,JSON.stringify({id:'operation'}));
  }
});

test('正常 JSON 业务错误保留错误说明、状态码及登录限制，不改变原有重试语义',async()=>{
  for(const status of [401,403,404,429,503]){
    const f=fixture([json({error:'业务错误',loginStatus:{blocked:true}},status)]);
    await assert.rejects(f.ctx.rawApi('/api/auth'),error=>error.message==='业务错误'&&error.status===status&&error.loginStatus.blocked);
    assert.equal(f.ctx.authLostCount,status===401?1:0);assert.equal(f.calls.length,1);
  }
});

test('重试等待时取消请求，立即结束且不发出后续读取',async()=>{
  const f=fixture([html()],{holdTimers:true}),controller=new AbortController();
  const pending=f.ctx.rawApi('/api/sessions',undefined,controller.signal);
  const rejected=assert.rejects(pending,error=>error.name==='AbortError');
  await new Promise(setImmediate);assert.deepEqual(f.delays,[300]);controller.abort();await rejected;
  assert.equal(f.calls.length,1);
});

test('读取响应体被取消或网络失败时，不当作 JSON 异常重试',async()=>{
  for(const error of [new DOMException('cancelled','AbortError'),new TypeError('network interrupted')]){
    const f=fixture([{status:200,ok:true,json:async()=>{throw error;}}]);
    await assert.rejects(f.ctx.rawApi('/api/sessions'),result=>result===error);
    assert.equal(f.calls.length,1);
  }
});
