// Passive Harness history. Tokens identify native records, never filesystem paths.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {isEditMarker} from './inline-history.mjs';
const editRange=e=>[e.data.source.cutoff+1,e.seq];
const inRanges=(seq,ranges)=>ranges.some(([start,end])=>seq>=start&&seq<=end);

export const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const eventOf=record=>record.event||record;
export const textOf=message=>typeof message?.content==='string'?message.content:(message?.content||[]).filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
export const terminal=reason=>reason==='completed'?'completed':['aborted','interrupted'].includes(reason)?'interrupted':['blocked','error','max-tokens','forked'].includes(reason)?'failed':null;
export function lastTurn(records){
  let result={};
  for(const record of records){const e=eventOf(record),d=e.data||{};
    if(!Number.isSafeInteger(d.turn)||d.turn<0)continue;
    if(e.type==='turn/start')result={turnId:String(d.turn),turnStatus:'inProgress'};
    if(e.type==='turn/end'&&terminal(d.reason?.kind))result={turnId:String(d.turn),turnStatus:terminal(d.reason.kind)};
  }return result;
}

export function projectRecords(records,{reference=()=>null}={}){
  const rows=[],turns=[],byTurn=new Map(),boundary=records.map(eventOf).find(e=>['turn/start','turn/end'].includes(e.type));let current=boundary?.type==='turn/end'?String(boundary.data.turn):'history',model='',effort='',firstUser=false;
  const ranges=records.map(eventOf).filter(isEditMarker).map(editRange);
  for(const record of records){
    const e=eventOf(record),d=e.data||{},seq=e.seq;
    if(e.type==='request/header'){model=d.header?.config?.model||'';effort=d.header?.config?.reasoningEffort||'';continue;}
    if(e.type==='turn/start'){current=String(d.turn);firstUser=true;}
    const turnId=String(d.turn??current);let turn=byTurn.get(turnId);
    if(!turn){turn={id:turnId,turnId,status:'inProgress',messages:[]};byTurn.set(turnId,turn);turns.push(turn);}
    if(e.type==='turn/end'){turn.status=terminal(d.reason?.kind)||turn.status;continue;}
    if(inRanges(seq,ranges))continue;
    const msg=d.message||d,parts=typeof msg.content==='string'?[{type:'text',text:msg.content}]:msg.content||[];
    const base={id:String(seq),key:String(seq),order:seq,sourceSeq:seq,nativeMessageId:msg.id,sourceKind:msg.source?.kind,submissionId:msg.source?.kind==='user'?msg.source.rpcId:undefined,turnId,timestamp:e.time??e.timestamp,version:digest(e),model:msg.source?.model||record.presentation?.model||model,effort:record.presentation?.effort||effort};
    const add=row=>{rows.push(row);turn.messages.push(row);};
    if(['user/message','assistant/message'].includes(e.type)){
      const role=e.type.split('/')[0],kind=msg.source?.kind,isUserContext=role==='user'&&!!kind&&kind!=='user';
      const attachments=parts.flatMap((part,index)=>{
        if(!['image','file'].includes(part.type))return [];
        const ref=reference(e,index),name=part.name||part.attachment?.name||(part.type==='image'?'图片':'文件');
        return [{id:ref,type:part.type,name,image:part.type==='image',nativeId:ref,size:part.attachment?.bytes}];
      });
      const reasoning=parts.filter(p=>['reasoning','thinking'].includes(p.type)).map(p=>p.text||p.thinking||'').join('\n');
      if(reasoning)add({...base,id:seq+':reasoning',key:seq+':reasoning',role:'activity',kind:'reasoning',title:'思考摘要',text:reasoning});
      const text=parts.filter(p=>p.type==='text').map(p=>p.text||'').join('\n');
      if(text||attachments.length){
        add({...base,role,text,attachments,...isUserContext?{isUserContext:true}:{},editable:role==='user'&&!isUserContext&&firstUser,forkable:role==='user'&&!isUserContext});
        if(role==='user'&&!isUserContext)firstUser=false;
      }
    }else if(['tool/call','tool/result','todo/write'].includes(e.type)){
      add({...base,role:'activity',kind:e.type,title:d.name||d.toolName||e.type,text:e.type==='tool/result'?textOf(msg)||JSON.stringify(d):JSON.stringify(d)});
    }
  }
  for(const turn of turns)for(const row of turn.messages)row.turnStatus=turn.status;
  return {messages:rows,turns:turns.filter(t=>t.messages.length||t.turnId!=='history')};
}

export function createHistory({ctx,token,find}){
  const indexes=new Map(),pending=new Map(),windows=new Map(),visibility=new Map();
  const sign=(sid,value)=>createHmac('sha256',token).update(sid+'\0'+value).digest('hex').slice(0,32);
  const seal=(sid,value)=>value+'.'+sign(sid,value);
  const open=(sid,value)=>{
    if(typeof value!=='string'||value.length>512)throw Error('历史标识无效');
    const at=value.lastIndexOf('.'),plain=value.slice(0,at),a=Buffer.from(value.slice(at+1)),b=Buffer.from(sign(sid,plain));
    if(a.length!==b.length||!timingSafeEqual(a,b))throw Error('历史标识不属于当前聊天');return plain;
  };
  const reference=(sid,e,index)=>seal(sid,'a.'+e.seq+'.'+index+'.'+digest(e).slice(0,24));
  const cut=async row=>{const p=await ctx.sessionController.projections({sessionId:row.sessionId},new AbortController().signal);return p?.asOfSeq??row.projections?.asOfSeq??0;};
  const page=async(sid,through,before,limit=100)=>{
    await find(sid);const read=ctx.sessionController.page;
    const result=await read.call(ctx.sessionController,{address:{kind:'session',sessionId:sid},throughSeq:through,...before==null?{}:{beforeSeq:before},maxMessages:Math.min(200,Math.max(1,limit))},AbortSignal.timeout(10000));
    return {...result,records:(result.records||[]).filter(r=>Number.isSafeInteger(eventOf(r).seq))};
  };
  async function index(sid){
    const row=await find(sid),through=await cut(row),prior=indexes.get(sid);
    if(prior?.cut===through)return prior;
    if(pending.has(sid)){await pending.get(sid);return index(sid);}
    const task=(async()=>{
      const reusable=prior&&through>=prior.cut,entries=reusable?new Map(prior.entries.map(e=>[e.seq,e])):new Map();
      let before,replacement=reusable?prior.replacement:0,complete=false;const ranges=reusable?[...prior.ranges]:[];
      for(let n=0;n<1000;n++){
        const got=await page(sid,through,before,200),batch=got.records.map(eventOf);
        for(const e of [...batch].reverse()){
          if(reusable&&e.seq<=prior.cut)continue;
          if(isEditMarker(e)){replacement=Math.max(replacement,e.seq);ranges.push(editRange(e));for(const seq of entries.keys())if(inRanges(seq,ranges))entries.delete(seq);}
          const p=e.data?.message||e.data,source=p?.source;
          if(e.type!=='user/message'||inRanges(e.seq,ranges)||source?.kind&&source.kind!=='user')continue;
          const summary=(textOf(p)||(p.content||[]).filter(x=>['file','image'].includes(x.type)).map(x=>x.name||x.attachment?.name||(x.type==='image'?'图片':'文件')).join('、')||'消息').replace(/\s+/g,' ').slice(0,100);
          entries.set(e.seq,{seq:e.seq,summary,version:digest(e),timestamp:e.time??e.timestamp});
        }
        if(!got.hasMore||!batch.length||reusable&&batch[0].seq<=prior.cut){complete=true;break;}
        const next=batch[0].seq;if(before!==undefined&&next>=before)throw Error('原生历史分页没有前进');before=next;
      }
      if(!complete)throw Error('历史目录尚未整理完成，请稍后重试');
      const result={cut:through,replacement,ranges,revision:digest([sid,replacement]).slice(0,20),entries:[...entries.values()].sort((a,b)=>a.seq-b.seq)};
      indexes.delete(sid);indexes.set(sid,result);if(indexes.size>8)indexes.delete(indexes.keys().next().value);return result;
    })();pending.set(sid,task);
    try{return await task;}finally{if(pending.get(sid)===task)pending.delete(sid);}
  }
  const nav=(sid,state,e)=>'nav.'+seal(sid,state.revision+'.'+e.seq);
  const navSeq=(sid,state,value)=>{
    const [revision,seq]=open(sid,String(value).replace(/^nav\./,'')).split('.');
    if(revision!==state.revision||!/^\d+$/.test(seq))throw Error('历史已变化，请刷新消息目录');return Number(seq);
  };
  const cursor=(sid,state,seq)=>'nav.'+seal(sid,state.revision+'.'+seq);
  async function directory(sid,body={}){
    const state=await index(sid),limit=Math.min(200,Math.max(1,Number(body.limit)||200));let start=0,reset=false;
    const value=body.cursor||body.since;
    if(value)try{start=navSeq(sid,state,value);}catch(error){if(body.cursor)throw error;reset=true;}
    const items=state.entries.slice(start,start+limit).map((e,i)=>({id:nav(sid,state,e),rowKey:String(e.seq),summary:e.summary,order:start+i,timestamp:e.timestamp}));
    return {items,revision:state.revision,status:'ready',complete:true,total:state.entries.length,reset,nextCursor:start+limit<state.entries.length?cursor(sid,state,start+limit):null,tailCursor:cursor(sid,state,state.entries.length)};
  }
  async function window(sid,body={},meta={}){
    const row=await find(sid),through=await cut(row),limit=Math.min(100,Math.max(1,Number(body.limit)||100));
    let state,anchor,lower,upper=through,before;
    if(body.around||String(body.before||body.after||'').startsWith('nav.')){
      state=await index(sid);anchor=navSeq(sid,state,body.around||body.before||body.after);
      if(body.before)before=anchor;
      else {lower=body.after?anchor:undefined;const pos=state.entries.findIndex(e=>e.seq>=anchor),later=state.entries[Math.max(0,pos)+20];upper=later?.seq??through;}
    }else if(body.before){const decoded=open(sid,body.before);if(!/^b\.\d+$/.test(decoded))throw Error('历史游标无效');before=Number(decoded.slice(2));}
    let raw=[],hasEarlier=false;const knownRanges=[...(visibility.get(sid)||[]),...(indexes.get(sid)?.ranges||[])];
    for(let n=0;n<100;n++){
      const got=await page(sid,upper,before,limit),batch=got.records;raw.unshift(...batch);hasEarlier=!!got.hasMore;
      knownRanges.push(...batch.map(eventOf).filter(isEditMarker).map(editRange));
      const visible=projectRecords(raw.filter(r=>!inRanges(eventOf(r).seq,knownRanges))).messages.some(r=>!r.isUserContext);
      if(!batch.length||!body.around&&!body.after&&visible||eventOf(batch[0]).seq<=(lower??anchor)||!got.hasMore)break;
      let next=eventOf(batch[0]).seq;for(const [start,end] of knownRanges)if(next>=start&&next<=end)next=Math.min(next,start);
      if(before!==undefined&&next>=before)throw Error('原生历史分页没有前进');before=next;
    }
    const ranges=[...(visibility.get(sid)||[]),...(indexes.get(sid)?.ranges||[]),...raw.map(eventOf).filter(isEditMarker).map(editRange)];
    const unique=[...new Map(ranges.map(r=>[r.join(':'),r])).values()];visibility.set(sid,unique);if(visibility.size>8)visibility.delete(visibility.keys().next().value);
    const projection=projectRecords(raw.filter(r=>!inRanges(eventOf(r).seq,unique)),{reference:(e,i)=>reference(sid,e,i)});let rows=projection.messages;
    if(lower!==undefined)rows=rows.filter(r=>r.sourceSeq>lower);
    if(body.around){const at=rows.findIndex(r=>r.sourceSeq===anchor);if(at<0)throw Error('此消息已变化，请刷新目录');rows=rows.slice(Math.max(0,at-20),Math.max(0,at-20)+limit);}
    else if(body.after)rows=rows.slice(0,limit);else rows=rows.slice(-limit);
    // Keep complete native event groups at the boundaries (text and reasoning share a seq).
    const keys=new Set(rows.map(r=>r.sourceSeq));rows=projection.messages.filter(r=>keys.has(r.sourceSeq)&&(lower===undefined||r.sourceSeq>lower));
    const first=rows[0]?.sourceSeq??eventOf(raw[0]||{}).seq??0,last=rows.at(-1)?.sourceSeq??first;
    const epoch=digest([sid,state?.revision||indexes.get(sid)?.revision||'live']).slice(0,20),all=new Map(projection.messages.map(r=>[r.key,{...r,text:undefined}]));
    const windowKey=digest([epoch,first,last,through]).slice(0,20),kept=windows.get(sid)||new Map();
    kept.set(windowKey,all);while(kept.size>2)kept.delete(kept.keys().next().value);windows.set(sid,kept);if(windows.size>8)windows.delete(windows.keys().next().value);
    const activeIndex=state||indexes.get(sid),hasLater=upper<through||projection.messages.some(r=>r.sourceSeq>last);
    let bytes=0;rows=rows.map(r=>{const full=r.text||'',text=full.slice(0,Math.max(0,Math.min(16384,524288-bytes)));bytes+=text.length;return {...r,text,truncated:text.length<full.length,window:windowKey,historyBefore:seal(sid,'b.'+r.sourceSeq),historyAfter:activeIndex?cursor(sid,activeIndex,r.sourceSeq):null,navigationId:state&&state.entries.find(e=>e.seq===r.sourceSeq)?nav(sid,state,state.entries.find(e=>e.seq===r.sourceSeq)):undefined};});
    hasEarlier=hasEarlier||projection.messages.some(r=>r.sourceSeq<first);
    return {rows,messages:rows,turns:projection.turns.map(t=>({...t,messages:rows.filter(r=>r.turnId===t.turnId)})).filter(t=>t.messages.length),epoch,sequence:through,meta,hasMore:hasEarlier,before:hasEarlier?(state?cursor(sid,state,first):seal(sid,'b.'+first)):null,after:hasLater&&activeIndex?cursor(sid,activeIndex,last):null,...state?{navigationWindow:true,targetKey:body.around?String(anchor):undefined}:{},historyComplete:!hasEarlier};
  }
  async function detail(sid,body){
    const key=String(body.key||'').split('.').at(-1),saved=[...(windows.get(sid)?.values()||[])].map(rows=>rows.get(key)).find(Boolean);
    if(!saved||saved.version!==body.version)throw Error('历史窗口已过期，请重新定位消息');
    if(inRanges(saved.sourceSeq,[...(visibility.get(sid)||[]),...(indexes.get(sid)?.ranges||[])]))throw Error('消息已变化');
    const raw=(await page(sid,saved.sourceSeq,undefined,1)).records.find(r=>eventOf(r).seq===saved.sourceSeq);
    if(!raw||digest(eventOf(raw))!==saved.version)throw Error('消息已变化');
    const full=projectRecords([raw]).messages.find(r=>r.key===key)?.text||'',offset=Math.max(0,Number(body.offset)||0),text=full.slice(offset,offset+65536);
    return {key,version:saved.version,offset,text,next:offset+text.length<full.length?offset+text.length:null};
  }
  async function message(sid,body){
    const key=String(body.key||'').split('.').at(-1),seq=Number(key),state=await index(sid),entry=state.entries.find(e=>e.seq===seq);
    if(!entry||body.version!==entry.version)throw Error('消息已变化，请重新打开编辑');
    // Exact target lookup is independent of whether it is currently in the latest body window.
    const raw=(await page(sid,seq,undefined,1)).records.find(r=>eventOf(r).seq===seq);
    if(!raw||digest(eventOf(raw))!==entry.version)throw Error('消息已变化');
    return {event:eventOf(raw),cut:state.cut};
  }
  async function attachment(sid,body){
    const [kind,seq,index,hash]=open(sid,body.reference).split('.');if(kind!=='a'||!/^\d+$/.test(seq)||!/^\d+$/.test(index))throw Error('附件引用无效');
    const raw=(await page(sid,Number(seq),undefined,1)).records.find(r=>eventOf(r).seq===Number(seq)),e=raw&&eventOf(raw);
    if(!e||digest(e).slice(0,24)!==hash)throw Error('附件记录已变化');
    const part=(e.data?.message||e.data)?.content?.[Number(index)];if(part?.type!=='image')throw Error('此附件不能预览');
    if(part.attachment){const value=await ctx.sessionController.attachment({sessionId:sid,attachmentId:part.attachment.id});return {data:value.data,mime:value.attachment?.mediaType||part.attachment.mediaType,name:part.name||part.attachment.name||'图片'};}
    if(typeof part.data!=='string'||part.data.length>140*1024*1024)throw Error('图片已不可用');return {data:part.data,mime:part.mediaType,name:part.name||'图片'};
  }
  return {page,cut,window,directory,detail,message,attachment,project:(sid,records)=>projectRecords(records,{reference:(e,i)=>reference(sid,e,i)}),clear:()=>{indexes.clear();windows.clear();visibility.clear();}};
}
