import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistory,projectRecords,digest} from '../bridge/clients/deepseek/history.mjs';

function fixture(count=450){
  const logs=new Map([['main',[]],['side',[]]]),calls=[];
  const append=(sid,type,data,extra={})=>{const log=logs.get(sid),e={seq:log.length,time:1700000000000+log.length,type,data,...extra};log.push({event:e});return e;};
  for(let n=0;n<count;n++)for(const sid of logs.keys()){
    append(sid,'turn/start',{turn:n});append(sid,'user/message',{id:'u'+n,role:'user',source:{kind:'user'},content:[{type:'text',text:sid+' prompt '+n},...n===2?[{type:'image',attachment:{id:'image-2',name:'photo.png',mediaType:'image/png',bytes:4}},{type:'file',attachment:{id:'file-2',name:'report.pdf',bytes:12}}]:[]]});
    append(sid,'assistant/message',{message:{id:'a'+n,role:'assistant',content:[{type:'text',text:'reply '+n}]}});append(sid,'turn/end',{turn:n,reason:{kind:'completed'}});
  }
  const ctx={sessionController:{projections:async({sessionId})=>({asOfSeq:logs.get(sessionId).length-1}),page:async request=>{
    calls.push(request);let records=logs.get(request.address.sessionId).filter(r=>r.event.seq<=request.throughSeq&&(request.beforeSeq===undefined||r.event.seq<request.beforeSeq));
    // The released endpoint counts messages, retaining intervening boundaries and log-only events.
    let start=records.length,seen=0;while(start>0){start--;if(['user/message','assistant/message'].includes(records[start].event.type)&&++seen>=request.maxMessages)break;}
    return {records:records.slice(start),hasMore:start>0};
  },attachment:async request=>{assert.deepEqual(request,{sessionId:'main',attachmentId:'image-2'});return {attachment:{mediaType:'image/png'},data:'dGVzdA=='};}}};
  const history=createHistory({ctx,token:'test-private-secret',find:async sid=>{assert.ok(logs.has(sid));return {sessionId:sid};}});
  return {logs,append,calls,history};
}
test('native messages preserve one attachment-bearing user row, time, turn and source',()=>{
  const f=fixture(3),result=projectRecords(f.logs.get('main'));
  assert.equal(result.messages.filter(r=>r.role==='user').length,3);const user=result.messages.find(r=>r.id==='9');
  assert.equal(user.attachments.length,2);assert.equal(user.timestamp,1700000000009);assert.equal(user.turnId,'2');assert.equal(user.turnStatus,'completed');assert.equal(user.nativeMessageId,'u2');assert.equal(user.sourceKind,'user');
  assert.equal(result.turns.at(-1).turnId,'2');assert.equal(result.messages.at(-1).text,'reply 2');
});
test('complete directory and bounded navigation use signed per-session cursors',async()=>{
  const f=fixture(),h=f.history,first=await h.directory('main');assert.equal(first.total,450);assert.equal(first.items.length,200);assert.ok(first.nextCursor);
  const second=await h.directory('main',{cursor:first.nextCursor});assert.equal(second.items[0].summary,'main prompt 200');
  const last=await h.directory('main',{cursor:second.nextCursor});assert.equal(last.items.length,50);assert.equal(last.nextCursor,null);
  const recent=await h.window('main',{limit:20});assert.equal(recent.rows.length,20);assert.equal(recent.rows.at(-1).text,'reply 449');assert.ok(recent.hasMore);
  const around=await h.window('main',{around:first.items[2].id,limit:100});assert.ok(around.rows.some(r=>r.text==='main prompt 2'));assert.equal(around.targetKey,'9');assert.ok(around.rows.length<=100);
  await assert.rejects(h.window('side',{around:first.items[2].id}),/不属于/);await assert.rejects(h.directory('side',{cursor:first.nextCursor}),/不属于/);
  const image=around.rows.find(r=>r.id==='9').attachments[0];assert.equal((await h.attachment('main',{reference:image.nativeId})).data,'dGVzdA==');
  await assert.rejects(h.attachment('side',{reference:image.nativeId}),/不属于/);
  assert.ok(f.calls.every(c=>c.maxMessages<=200));
  const oldest=await h.window('main',{around:first.items[0].id,limit:20});assert.equal(oldest.hasMore,false);assert.equal(oldest.before,null);
});
test('injected context is excluded and surface replacements invalidate directories without deleting logs',async()=>{
  const f=fixture(2),h=f.history,original=await h.directory('main');
  f.append('main','user/message',{message:{source:{kind:'skill-invocation'},content:[{type:'text',text:'private injected skill'}]}});
  assert.equal((await h.directory('main')).total,2);
  f.append('main','developer/message',{message:{source:{kind:'compaction'},content:[{type:'text',text:'compressed context'}]}},{surfaceOp:{op:'replace',startSeq:1,endSeq:7},sourceEventSeqs:[1,5]});
  assert.equal((await h.directory('main')).total,2,'context compaction preserves the full human message directory');
  f.append('main','user/message',{source:{kind:'dsh-inline-edit',version:2,cutoff:0},content:[{type:'text',text:'edit notice'}]},{surfaceOp:{op:'replace',startSeq:1,endSeq:7},sourceEventSeqs:[1,2,4,5,6]});
  f.append('main','turn/start',{turn:2});f.append('main','user/message',{source:{kind:'user'},content:[{type:'text',text:'edited input'}]});
  const changed=await h.directory('main',{since:original.tailCursor});assert.equal(changed.reset,true);assert.equal(changed.total,1);assert.equal(changed.items[0].summary,'edited input');
  const old=await h.window('main',{before:(await h.window('main',{limit:1})).before,limit:100});assert.ok(!old.rows.some(r=>r.text==='main prompt 0'));assert.equal(f.logs.get('main')[1].event.data.content[0].text,'main prompt 0');
  await assert.rejects(h.message('main',{key:'1',version:digest(f.logs.get('main')[1].event)}),/已变化/);
});
test('long text is chunked, version checked, and survives only retained windows',async()=>{
  const f=fixture(1),h=f.history,body='正文'.repeat(90000),e=f.append('main','assistant/message',{message:{content:[{type:'text',text:body}]}});
  const page=await h.window('main',{limit:1}),row=page.rows[0];assert.equal(row.text.length,16384);assert.equal(row.truncated,true);
  let text='',offset=0;do{const part=await h.detail('main',{key:page.epoch+'.'+row.key,version:row.version,offset});assert.equal(part.offset,offset);text+=part.text;offset=part.next;}while(offset!==null);assert.equal(text,body);
  e.data.message.content[0].text='changed';await assert.rejects(h.detail('main',{key:row.key,version:row.version,offset:0}),/已变化/);
});
test('backward pagination skips a large replaced suffix and still reaches the original prefix',async()=>{
  const f=fixture(150),h=f.history;
  f.append('main','user/message',{source:{kind:'dsh-inline-edit',version:2,cutoff:239},content:[{type:'text',text:'notice'}]},{surfaceOp:{op:'replace',startSeq:241,endSeq:598},sourceEventSeqs:[241,245]});
  f.append('main','turn/start',{turn:150});f.append('main','user/message',{source:{kind:'user'},content:[{type:'text',text:'new replacement'}]});
  const directory=await h.directory('main');assert.equal(directory.total,61);
  const latest=await h.window('main',{limit:1});assert.equal(latest.rows[0].text,'new replacement');
  const older=await h.window('main',{before:latest.before,limit:20});assert.ok(older.rows.some(r=>r.text==='main prompt 59'));assert.ok(!older.rows.some(r=>r.text==='main prompt 149'));
});
