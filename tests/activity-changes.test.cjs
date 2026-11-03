'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ActivityChanges}=require('../web/features/chat/activity.js');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const scope={local:['chat']},streamId='a'.repeat(32);
const reply=(changes={})=>({streamId,cursor:0,reset:false,hosts:{},...changes});
function fixture(){
  const reads=[],pauses=[],changes=[];
  const sync=new ActivityChanges({
    request:(path,body,signal)=>new Promise((resolve,reject)=>{reads.push({path,body,signal,resolve,reject});signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true});}),
    pause:(ms,signal)=>new Promise(resolve=>{pauses.push({ms,resolve});signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();}),
    onChange:(hosts,reset)=>changes.push({hosts,reset})
  });
  return {sync,reads,pauses,changes};
}

test('单一游标长轮询只交付增量，空闲响应不会触发状态查询',async t=>{
  const f=fixture();t.after(()=>f.sync.stop());f.sync.setScope(scope);
  assert.equal(f.reads[0].path,'/api/activity/changes');
  f.reads[0].resolve(reply({reset:true}));await tick();
  assert.deepEqual(f.changes,[{hosts:scope,reset:true}]);
  f.pauses[0].resolve();await tick();
  assert.equal(f.reads[1].body.after,0);
  f.reads[1].resolve(reply({cursor:1,hosts:{local:['chat']}}));await tick();
  assert.deepEqual(f.changes.at(-1),{hosts:{local:['chat']},reset:false});
  f.pauses[1].resolve();await tick();f.reads[2].resolve(reply({cursor:1}));await tick();
  assert.equal(f.changes.length,2);assert.equal(f.pauses.at(-1).ms,1000,'异常即时空响应需要限速');
});

test('滚动改变订阅时保持一条请求，使用原游标补取新增范围',async t=>{
  const f=fixture();t.after(()=>f.sync.stop());f.sync.setScope(scope);
  f.reads[0].resolve(reply({reset:true}));await tick();f.pauses[0].resolve();await tick();
  f.sync.setScope({local:['chat','new']});
  assert.equal(f.reads.length,2);assert.equal(f.reads[1].signal.aborted,false);
  f.reads[1].resolve(reply({cursor:9,hosts:{local:['chat']}}));await tick();
  assert.equal(f.reads[2].body.after,0,'新增范围不能从旧范围的晚到游标之后开始，避免漏事件');
  assert.deepEqual(f.reads[2].body.hosts,{local:['chat','new']});
  assert.equal(f.changes.length,1,'旧范围响应不交付给新范围');
});

test('旧网关接口缺失或无效响应自动停用通知，重置身份后可重新探测',async()=>{
  for(const error of [{status:404},{status:405},{status:501},null]){
    const f=fixture();f.sync.setScope(scope);
    if(error)f.reads[0].reject(error);else f.reads[0].resolve({});
    await tick();assert.equal(f.sync.unsupported,true);assert.equal(f.pauses.length,0);
    f.sync.setScope(scope);assert.equal(f.reads.length,1);
    f.sync.reset();f.sync.setScope(scope);assert.equal(f.reads.length,2);f.sync.stop();await tick();
  }
});

test('网络失败退避，隐藏导航与身份切换立即取消请求且丢弃旧回复',async()=>{
  const f=fixture();f.sync.setScope(scope);f.reads[0].reject(Error('offline'));await tick();
  assert.equal(f.pauses[0].ms,1000);f.pauses[0].resolve();await tick();
  f.reads[1].reject(Error('offline'));await tick();assert.equal(f.pauses[1].ms,2000);
  f.sync.setScope({});await tick();assert.equal(f.sync.task,null);
  f.sync.setScope(scope);const old=f.reads.at(-1);f.sync.reset();
  old.resolve(reply({reset:true,hosts:scope}));await tick();
  assert.equal(f.changes.length,0);
});

test('订阅排序稳定且有界，可见范围的输入优先于五百条以后的隐藏项',t=>{
  const f=fixture();t.after(()=>f.sync.stop());
  f.sync.setScope({local:['z-visible',...Array.from({length:510},(_,i)=>'a-'+i),'z-visible']});
  assert.equal(f.reads[0].body.hosts.local.length,500);
  assert.ok(f.reads[0].body.hosts.local.includes('z-visible'));
  f.sync.setScope({local:[...f.reads[0].body.hosts.local].reverse()});
  assert.equal(f.reads.length,1);
});
