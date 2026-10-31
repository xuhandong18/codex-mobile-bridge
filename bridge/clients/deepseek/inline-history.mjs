// From maxy1817/dsh-inline-edit history.js (MIT). See LICENSE.dsh-inline-edit.
/** Durable metadata on a model-surface replacement; old log records remain auditable. */
export const EDIT_SOURCE = 'dsh-inline-edit';
export const EDIT_NOTICE = 'The previous task message was edited. Its superseded request and responses are no longer part of this context. The updated user request follows.';
export const EDIT_PROJECTION = 'dsh-inline-edit-history';
export const LATEST_PROJECTION = 'dsh-inline-edit-latest';
export function initialEligibility() { return {openTurn:null,seenUser:false,admissions:{},view:{latestSeq:null,excluded:[]}}; }
/** Arrival-time classification survives next-turn queues, refresh and forks.
 * An ordinary queued message can render as 'user', so node.kind alone is not sufficient. */
export function foldEligibility(state,event) {
  if (event.type==='turn/start') return {...state,openTurn:event.data.turn,seenUser:false};
  if (event.type==='turn/end') return {...state,openTurn:null,seenUser:false};
  if (event.type==='agent/inbox/spliced') {
    let admissions=state.admissions;
    for (const message of event.data.inserted??[]) {
      if (message.source?.kind!=='user' || Object.hasOwn(admissions,message.id)) continue;
      if (admissions===state.admissions) admissions={...admissions};
      admissions[message.id]=state.openTurn===null && event.data.target==='next-turn';
    }
    return admissions===state.admissions?state:{...state,admissions};
  }
  if (event.type!=='user/message' || event.data.source?.kind!=='user') return state;
  const supplemental=state.admissions[event.data.id]===false || state.seenUser;
  return {...state,seenUser:true,view:supplemental
    ?{latestSeq:state.view.latestSeq,excluded:[...state.view.excluded,event.seq]}
    :{latestSeq:event.seq,excluded:state.view.excluded}};
}
export function messageEligibility(events) { return events.reduce(foldEligibility,initialEligibility()).view; }
export function isEditMarker(event) {
  const s = event?.data?.source;
  return event?.type === 'user/message' && event.surfaceOp?.op === 'replace'
    && s?.kind === EDIT_SOURCE && s.version === 2
    && Number.isSafeInteger(s.cutoff) && s.cutoff >= 0 && s.cutoff < event.seq;
}
/** Follow exact replacement IDs, including chains produced by older releases.
 * Never infer an association from proximity, text, or the latest marker alone. */
export function replacementChain(events, seq) {
  const chain=[];
  while (events[seq]?.type==='user/message' && events[seq].data.id) {
    const id=events[seq].data.id;
    const marker=events.slice(0,seq).findLast(e=>isEditMarker(e)
      && e.data.source.replacement?.id===id
      && Number.isSafeInteger(e.data.source.targetSeq)
      && e.data.source.targetSeq<e.seq);
    if (!marker) break;
    chain.push(marker);
    seq=marker.data.source.targetSeq;
  }
  return chain;
}
export function foldEdits(state, event) {
  if (!isEditMarker(event)) return state;
  // A later edit of an earlier turn also supersedes previous edit markers.
  const start = event.data.source.cutoff + 1;
  return [...state.filter(range => range.end < start), {start, end:event.seq}];
}
export function editRanges(events) { return events.reduce(foldEdits, []); }
export function isHidden(seq, ranges) {
  return Number.isFinite(seq) && ranges.some(r => seq >= r.start && seq <= r.end);
}
export function filterEntries(entries, nodes, groups, ranges) {
  if (!ranges.length) return entries;
  const visible = entry => !isHidden(nodes.get(entry.key)?.anchorSeq, ranges);
  return entries.flatMap(entry => {
    if (entry.kind === 'node') return visible(entry) ? [entry] : [];
    const group = groups?.groupSource(entry.key).getSnapshot();
    if (!group) return [entry];
    const members = group.members.filter(visible);
    if (!members.length) return [];
    // Entire turns normally disappear together. A mixed group is flattened,
    // keeping only surviving nodes, without mutating native group state.
    return members.length === group.members.length ? [entry] : members;
  });
}
