// Adapted from maxy1817/dsh-inline-edit current.js (MIT). See LICENSE.dsh-inline-edit.
import { Buffer } from 'node:buffer';
import {randomUUID} from 'node:crypto';
const createUserMessage=value=>({id:randomUUID(),role:'user',...value});
import { EDIT_SOURCE, EDIT_NOTICE, editRanges, isHidden, isEditMarker,messageEligibility,replacementChain } from './inline-history.mjs';
const fail = code => { const e = new Error(code); e.editCode = code; throw e; };
export function currentBoundary(session, seq) {
  const events = session.snapshotEvents(), target = events[seq];
  if (session.header.origin === 'subagent') fail('subagent');
  if (target?.type !== 'user/message' || target.data.source?.kind !== 'user'
    || isHidden(seq,editRanges(events))) fail('stale');
  const nodes = session.surface.nodes;
  let offset = nodes.indexOf(seq);
  if (offset < 0) fail('compacted');
  const eligibility=messageEligibility(events);
  if (eligibility.excluded.includes(seq)) fail('supplemental');
  // The gateway supports an earlier ordinary turn too: replace its whole
  // remaining surface and admit just the edited input. Never replay later users.
  // Mirror Chat's durable-source associations, not its client-only labels:
  // recalls attach to the immediately preceding event; skills attach to every
  // direct message in the context-transparent batch before the response.
  const sourceOf = e => e?.type === 'user/message' ? e.data.source
    : e?.type === 'developer/message' ? e.data.message.source : undefined;
  if (sourceOf(events[seq + 1])?.kind === 'session-reference') fail('unsupported');
  const boundaries = new Set(['assistant/message','tool/result','turn/start','turn/end','step/start','step/end','system/message']);
  for (const direction of [-1,1]) {
    for (let i=seq+direction; i>=0 && i<events.length; i+=direction) {
      const e=events[i];
      if (boundaries.has(e.type)) break;
      if (sourceOf(e)?.kind === 'skill-invocation') fail('unsupported');
    }
  }
  let start = seq - 1;
  while (start >= 0 && events[start].type !== 'turn/start') {
    if (['user/message','assistant/message','turn/end','tool/result'].includes(events[start].type)) fail('steeringCurrent');
    start--;
  }
  if (start < 1) fail('unsupported');
  let cutoff=start-1;
  for (const marker of replacementChain(events,seq)) {
    const markerOffset=nodes.indexOf(marker.seq);
    if (markerOffset<0) continue;
    // Remove the previous recovery payload too, not just its visible request.
    offset=Math.min(offset,markerOffset);
    cutoff=Math.min(cutoff,marker.data.source.cutoff);
  }
  return {atSeq:cutoff, tail:events.length - 1, nodes:nodes.slice(offset)};
}
function idle(agent) {
  if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) fail('running');
}
async function resolve(ctx, id) {
  const result = await ctx.sessionController.resolveAgent(id);
  if (!result.agent) fail('notReady');
  return result.agent;
}
export async function planCurrent(ctx, input) {
  const agent = await resolve(ctx,input.sourceId); idle(agent);
  return currentBoundary(agent.session,input.seq);
}
/** All async validation precedes one synchronous reset/queue critical section. */
export async function editCurrent(ctx, input, requestSignal) {
  if (!input || typeof input.sourceId!=='string' || !Number.isSafeInteger(input.seq)
    || !Number.isSafeInteger(input.tail) || typeof input.requestId!=='string'
    || !/^[a-f0-9-]{36}$/i.test(input.requestId)) fail('unsupported');
  const agent = await resolve(ctx,input.sourceId), session=agent.session;
  const previous = session.snapshotEvents().find(e=>isEditMarker(e) && e.data.source.sessionId===agent.id && e.data.source.requestId===input.requestId);
  if(previous) fail('currentUncertain'); // A persisted replacement is evidence for inspection, never permission to replay.

  idle(agent);
  try {
    return await agent.runMaintenance(async signal=>{
      const check = () => {
        signal.throwIfAborted(); requestSignal.throwIfAborted();
        if (ctx.agents.get(agent.id)!==agent) fail('notReady');
        idle(agent);
        if (session.snapshotEvents().length - 1 !== input.tail) fail('stale');
      };
      check();
      const plan=currentBoundary(session,input.seq), target=session.snapshotEvents()[input.seq];
      const parts=input.content;
      if (!Array.isArray(parts) || !parts.length || parts.length>33) fail('unsupported');
      let chars=0, count=0, total=0, imageBytes=0, imageCount=0;
      const receipts=[], originalIndices=new Set(), proposed=[], uploads=[], originals=[];
      const model=await ctx.llm.resolveModelInfo(agent.options.provider,agent.options.model);
      if (!model) fail('notReady');
      // Resolve the complete proposal and all cheap constraints before storage.
      const limits=ctx.attachments.imageLimits;
      for (const part of parts) {
        check();
        if (!part || typeof part!=='object') fail('unsupported');
        if (part.type==='text' && typeof part.text==='string') {
          chars+=part.text.length; if (chars>200000) fail('tooLong');
          proposed.push({type:'text',text:part.text}); continue;
        }
        let block, size, mediaType;
        if (part.type==='original' && Number.isSafeInteger(part.index) && !originalIndices.has(part.index)) {
          originalIndices.add(part.index); block=target.data.content[part.index];
          if (!['file','image'].includes(block?.type) || !block.attachment) fail('unsupported');
          originals.push(block); size=block.attachment.bytes; mediaType=block.attachment.mediaType;
          if (block.type==='image' && limits) {
            const {width,height}=block.attachment;
            if (width>limits.maxImageDimension || height>limits.maxImageDimension
              || width*height>limits.maxImagePixels) fail('imageSize');
          }
        } else if (part.type==='file' && typeof part.receiptId==='string' && !receipts.includes(part.receiptId)) {
          const attachment=ctx.fileUploads.resolve(agent,part.receiptId);
          if (!attachment) fail('fileUpload'); receipts.push(part.receiptId);
          block={type:'file',attachment}; size=attachment.bytes;
        } else if (part.type==='image' && typeof part.data==='string') {
          if (part.data.length>Math.ceil(20*1024*1024/3)*4) fail('imageSize');
          const bytes=Buffer.from(part.data,'base64');
          if (!bytes.length || bytes.toString('base64')!==part.data) fail('unsupported');
          block={type:'image',data:part.data,mediaType:part.mediaType,...(typeof part.name==='string'?{name:part.name}:{})};
          uploads.push(block); size=bytes.length; mediaType=part.mediaType;
        } else fail('unsupported');
        if (!Number.isSafeInteger(size) || size<0) fail('unsupported');
        if (size>64*1024*1024) fail('fileSize'); total+=size; count++;
        if (block.type==='image') {
          imageBytes+=size; imageCount++;
          if (model.inputModalities && !model.inputModalities.includes('image')) fail('imageModel');
          if (limits && (size>limits.maxImageBytes || !limits.mediaTypes.includes(mediaType))) fail('imageSize');
        }
        if (count>32 || total>128*1024*1024 || imageBytes>20*1024*1024
          || (limits && (imageCount>limits.maxImagesPerMessage || imageBytes>limits.maxMessageImageBytes))) fail('totalSize');
        proposed.push(block);
      }
      if (!count && !proposed.some(p=>p.type==='text' && p.text.trim())) fail('empty');
      if (JSON.stringify(proposed)===JSON.stringify(target.data.content)) fail('unchanged');
      for (const block of originals) {
        check();
        if (block.type==='image') await ctx.attachments.readImage(block.attachment,signal);
        else for await (const _ of ctx.attachments.readFileStream(block.attachment,signal)) { check(); }
      }
      check();
      // One host batch: its decoder validates every image before publishing any.
      // Reused images are already durable and counted above; never re-save them.
      const admitted=uploads.length ? await ctx.attachments.admitPromptContent(uploads) : [];
      let next=0;
      const content=proposed.map(block=>block.type==='image' && !block.attachment ? admitted[next++] : block);
      // Normalization can change encoded sizes. Enforce final-reference budgets too.
      total=0; imageBytes=0;
      for (const block of content) {
        if (!block.attachment) continue;
        const size=block.attachment.bytes;
        if (size>64*1024*1024) fail('fileSize');
        total+=size;
        if (block.type==='image') imageBytes+=size;
      }
      if (total>128*1024*1024 || imageBytes>20*1024*1024
        || (limits && imageBytes>limits.maxMessageImageBytes)) fail('totalSize');
      check();
      const message=createUserMessage({content,source:{kind:'user',rpcId:input.requestId}});
      const binding=ctx.fileUploads.bindPrompt(agent,receipts,input.requestId);
      try {
        check();
        // A producer-owned user context is valid during maintenance. A developer
        // message is not: released V4 requires it to belong to an OPEN step.
        // The short notice is intentional (empty user turns are not portable
        // across model providers). It also holds the durable recovery payload.
        session.append('user/message',createUserMessage({content:[{type:'text',text:EDIT_NOTICE}],source:{
          kind:EDIT_SOURCE,version:2,sessionId:agent.id,requestId:input.requestId,targetSeq:input.seq,
          cutoff:plan.atSeq,replacement:message,
        }}),{surfaceOp:{op:'replace',startSeq:plan.nodes[0],endSeq:plan.nodes.at(-1)},sourceEventSeqs:plan.nodes});
        agent.followup(message);
        binding.commit();
        return {sessionId:agent.id,accepted:true};
      } finally { binding[Symbol.dispose](); }
    });
  } catch(error) {
    // Once the durable replacement exists, even a tagged error (including a
    // reentrant listener failure) cannot truthfully report an untouched edit.
    if (session.snapshotEvents().some(e=>isEditMarker(e) && e.data.source.sessionId===agent.id && e.data.source.requestId===input.requestId)) fail('currentUncertain');
    if (error.editCode) throw error;
    fail('currentFailed');
  }
}
