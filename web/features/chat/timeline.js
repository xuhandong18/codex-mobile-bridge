'use strict';
const timelineText=source=>typeof BridgeI18n==='undefined'?source:BridgeI18n.t(source);
const messageSummary=row=>(row.text||row.attachments?.map(item=>(item.name||item.path||item.type||'').replace(/\\/g,'/').split('/').pop()).join('、')||timelineText('消息')).replace(/\s+/g,' ').trim().slice(0,100);

// The navigation directory is independent of the bounded body reading window.
class ChatMessageMap {
  constructor(timeline){
    this.timeline=timeline;this.abort=new AbortController();const signal=this.abort.signal;
    this.root=document.createElement('nav');this.root.className='chat-message-map';this.root.setAttribute('aria-label',timelineText('我的消息导航'));
    this.rail=document.createElement('div');this.rail.className='chat-message-map-rail';
    this.panel=document.createElement('div');this.panel.className='chat-message-map-panel';
    this.list=document.createElement('div');this.list.className='chat-message-map-list';
    this.directoryStatus=document.createElement('button');this.directoryStatus.type='button';this.directoryStatus.className='chat-message-map-status';
    this.directoryStatus.onclick=()=>timeline.loadMessageIndex?.(true);
    this.earlier=document.createElement('button');this.earlier.type='button';this.earlier.className='chat-message-map-earlier';this.earlier.onclick=()=>timeline.loadOlder(100);
    this.panel.append(this.directoryStatus,this.list,this.earlier);this.root.append(this.rail,this.panel);timeline.viewport.parentElement.append(this.root);
    this.root.addEventListener('pointerenter',event=>{if(event.pointerType==='mouse')this.open();},{signal});
    document.addEventListener('pointerdown',event=>{if(!this.root.contains(event.target))this.close();},{signal});
    this.root.addEventListener('keydown',event=>{if(event.key==='Escape'){this.close();document.activeElement?.blur();event.stopPropagation();}},{signal});
    this.list.addEventListener('scroll',()=>this.paint(this.list,44),{passive:true,signal});
    this.rail.addEventListener('scroll',()=>this.paint(this.rail,7),{passive:true,signal});
    this.position=()=>{
      const rect=timeline.viewport.getBoundingClientRect();
      const railHeight=Math.max(0,rect.height-(timeline.railBottomInset||0));
      this.root.hidden=!this.entries?.length&&!timeline.indexBusy&&!timeline.indexError&&!timeline.hasMore;
      this.root.style.top=(rect.top+railHeight/2)+'px';this.root.style.right=Math.max(0,window.innerWidth-rect.right+4)+'px';
      this.root.style.setProperty('--map-right',Math.max(0,window.innerWidth-rect.right+4)+'px');
      this.root.style.setProperty('--map-top',(rect.top+rect.height/2)+'px');
      this.root.style.setProperty('--map-panel-height',Math.max(44,rect.height-16)+'px');
      this.root.style.setProperty('--map-width',Math.max(22,Math.min(280,rect.width-46))+'px');
      this.root.style.setProperty('--map-height',(timeline.railBottomInset?Math.max(7,Math.min(320,railHeight-16)):Math.max(44,Math.min(320,rect.height-80)))+'px');
      if(!rect.width||!rect.height)this.root.hidden=true;
    };
    this.resize=new ResizeObserver(this.position);this.resize.observe(timeline.viewport);window.addEventListener('resize',this.position,{signal});
    window.addEventListener('scroll',this.position,{capture:true,passive:true,signal});this.update();
  }
  open(){this.root.classList.add('is-open');this.paint(this.list,44);}
  close(){this.root.classList.remove('is-open');}
  jump(entry){
    if(this.timeline.navigateMessage){this.timeline.navigateMessage(entry);return;}
    const timeline=this.timeline,node=timeline.nodes.get(entry.rowKey)?.node;if(!node)return;
    timeline.following=false;timeline.viewport.scrollTop+=node.getBoundingClientRect().top-timeline.viewport.getBoundingClientRect().top-12;
    timeline.lastTop=timeline.viewport.scrollTop;timeline.anchor=timeline.capture();this.close();
  }
  paint(root,height){
    const scroll=root.scrollTop||0,entries=this.entries||[],virtual=entries.length>120;
    const first=virtual?Math.max(0,Math.floor((root.scrollTop||0)/height)-8):0;
    const end=virtual?Math.min(entries.length,first+Math.ceil((root.clientHeight||320)/height)+16):entries.length;
    const visible=entries.slice(first,end),keep=new Set(visible.map(entry=>entry.id||entry.rowKey));
    for(const child of [...root.children])if(!keep.has(child.dataset.key))child.remove();
    const buttons=new Map([...root.children].map(child=>[child.dataset.key,child]));
    const spacer=pixels=>{const node=document.createElement('div');node.style.height=pixels+'px';node.style.flex='0 0 '+pixels+'px';node.setAttribute('aria-hidden','true');return node;};
    if(virtual)root.append(spacer(first*height));
    for(let i=first;i<end;i++){
      const entry=entries[i],key=entry.id||entry.rowKey;let button=buttons.get(key);
      if(!button){button=document.createElement('button');button.type='button';button.dataset.key=key;button.append(document.createElement('i'));if(root===this.list)button.append(document.createElement('span'));}
      const label=((entry.order??i)+1)+'. '+entry.summary;
      if(root===this.list)button.lastChild.textContent=label;
      button.setAttribute('aria-label',label);button.title=label;
      button.onclick=()=>{if(root===this.rail)this.open();else{this.jump(entry);button.blur();}};root.append(button);
    }
    if(virtual)root.append(spacer((entries.length-end)*height));
    if(virtual)root.scrollTop=scroll;
    if(!entries.length&&root===this.rail){
      const handle=document.createElement('button');handle.type='button';handle.textContent='⋯';handle.setAttribute('aria-label',timelineText('我的消息导航'));
      handle.onclick=()=>this.open();root.append(handle);
    }
  }
  update(){
    const timeline=this.timeline;
    this.entries=timeline.directoryRows?timeline.directoryRows():[...timeline.rows.values()].map(value=>value.row).filter(row=>row.role==='user'&&!row.isUserContext).sort((a,b)=>a.order-b.order).map((row,i)=>({rowKey:row.key,order:i,summary:messageSummary(row)}));
    this.paint(this.rail,7);this.paint(this.list,44);
    this.directoryStatus.hidden=!timeline.indexBusy&&!timeline.indexError;
    this.directoryStatus.disabled=!!timeline.indexBusy;
    this.directoryStatus.textContent=timelineText(timeline.indexError?'目录加载失败，点击重试':'正在整理消息目录…');
    this.earlier.hidden=!timeline.hasMore||!!timeline.indexReady;this.earlier.disabled=timeline.busy;
    this.earlier.textContent=timelineText('查看更早内容');this.position();
  }
  dispose(){this.abort.abort();this.resize.disconnect();this.root.remove();}
}

// History and live changes share stable keys, but never share a request queue.
class ChatTimeline {
  constructor({url, request, renderMeta, renderText, status, onAction, canEdit = () => true, elements = {}, active = () => true}) {
    Object.assign(this,{url,request,renderMeta,renderText,status,onAction,canEdit,active});
    this.viewport=elements.viewport||document.getElementById('timeline');
    this.container=elements.container||document.getElementById('messages');
    this.older=elements.older||document.getElementById('older');
    this.newer=elements.newer||document.getElementById('newer');
    this.abort=new AbortController();this.rows=new Map();this.nodes=new Map();this.details=new Map();
    this.files=new Map();this.sequence=-1;this.epoch='';this.before=null;this.hasMore=false;
    this.busy=false;this.generation=0;this.windowRevision=0;this.following=true;this.lastTop=0;this.retryCount=0;
    this.messageIndex=new Map();this.indexBusy=false;this.indexReady=false;this.indexError=false;this.indexRevision='';this.indexTail=null;this.indexUpdated=0;this.indexRetryAt=0;
    this.navigationMode=false;this.navigationRequest=0;this.navigationBusy=false;this.navigationPages=[];this.navigationRetry=null;this.liveCursor=null;this.hasLiveChanges=false;
    this.showReasoning=document.documentElement.dataset.showReasoning!=='false';
    this.showProcess=document.documentElement.dataset.showProcess!=='false';
    this.onScroll=()=>{
      if(!this.viewport.clientHeight)return;
      const upward=this.viewport.scrollTop<this.lastTop;
      // Layout restoration records its own scroll position before dispatch.
      // A later upward movement is the reader's choice, even within that frame.
      if(this.suppress&&!upward)return;
      this.lastTop=this.viewport.scrollTop;this.following=!this.navigationMode&&!upward&&this.atBottom();this.anchor=this.capture();
      if(this.following)this.newer.hidden=true;
      if(this.navigationMode){
        if(this.navigationBusy)return;
        if(upward&&this.hasMore&&this.nearTop())this.pageNavigation('before',true);
        else if(!upward&&this.atBottom()){
          if(this.after)this.pageNavigation('after',true);
          else this.loadLatest();
        }
      }else if(upward&&this.nearTop()&&!this.retryCount)this.loadOlder(100);
    };
    this.viewport.addEventListener('scroll',this.onScroll,{passive:true});
    this.older.onclick=()=>this.sequence<0?this.start():this.loadOlder(this.retryCount||100);
    this.newer.onclick=()=>{if(this.navigationMode){this.loadLatest();return;}this.jumpBottom();this.anchor=this.capture();};
    this.later=document.createElement('button');this.later.type='button';this.later.className='plain timeline-later';this.later.hidden=true;
    this.later.textContent=timelineText('查看后续内容');this.later.onclick=()=>this.pageNavigation('after');this.viewport.append(this.later);
    this.resize=new ResizeObserver(()=>this.restore(this.anchor,this.following));
    this.resize.observe(this.container);
    this.messageMap=new ChatMessageMap(this);
  }
  dispose(){this.navigationRequest++;this.messageMap.dispose();this.abort.abort();clearTimeout(this.startRetry);this.resize.disconnect();this.viewport.removeEventListener('scroll',this.onScroll);this.newer.hidden=true;this.later.remove();}
  directoryRows(){
    const entries=[...this.messageIndex.values()].filter(entry=>!entry.isUserContext).sort((a,b)=>a.order-b.order).map((entry,order)=>({...entry,order})),matched=new Set();
    const byId=new Map(entries.map(entry=>[entry.id,entry])),byKey=new Map(entries.map(entry=>[entry.rowKey,entry])),byText=new Map(),byImageText=new Map();
    const indexText=(map,entry,summary)=>{const key=JSON.stringify([entry.turnId,summary]),list=map.get(key)||[];list.push(entry);map.set(key,list);};
    for(const entry of entries){
      indexText(byText,entry,entry.summary);
      // Older gateways included a truncated image transport label in summaries.
      const label=entry.summary.match(/^([\s\S]*?)\s*<image name=\[Image #\d+\] path="/);
      if(label)indexText(byImageText,entry,label[1].trim());
    }
    const loaded=[...this.rows.values()].map(value=>value.row).filter(row=>row.role==='user'&&!row.isUserContext).sort((a,b)=>a.order-b.order);
    for(const row of loaded){
      const summary=messageSummary(row),textKey=JSON.stringify([row.turnId,summary]);
      const imageText=row.attachments?.some(item=>['image','input_image','localImage'].includes(item.type))?byImageText.get(textKey)||[]:[];
      const sameText=byText.get(textKey)||imageText;
      const candidate=byId.get(row.navigationId)||byKey.get(row.key)||(sameText.length===1?sameText[0]:null);
      const match=candidate&&!matched.has(candidate.id)&&(candidate.summary===summary||imageText.includes(candidate))?candidate:null;
      if(match){matched.add(match.id);match.loadedKey=row.key;match.summary=summary;continue;}
      entries.push({id:row.navigationId||'loaded:'+row.key,rowKey:row.key,turnId:row.turnId,summary,order:entries.length});
    }
    return entries;
  }
  async loadMessageIndex(full=false){
    if(this.indexBusy||this.abort.signal.aborted||this.indexUnsupported)return;
    this.indexBusy=true;this.indexError=false;this.messageMap.update();
    let cursor=null,first=true;
    try{
      do{
        const params={limit:200,...(cursor?{cursor}:!full&&this.indexTail?{since:this.indexTail}:{})};
        const page=await this.read('message-index',params);if(this.abort.signal.aborted)return;
        if(!Array.isArray(page.items)){this.indexUnsupported=true;return;}
        if(first&&(page.reset||this.indexRevision&&page.revision!==this.indexRevision))this.messageIndex.clear();
        this.indexRevision=page.revision;
        for(const entry of page.items)this.messageIndex.set(entry.id,entry);
        cursor=page.nextCursor;this.indexTail=page.tailCursor;this.indexReady=true;first=false;this.messageMap.update();
      }while(cursor&&!this.abort.signal.aborted);
      this.indexUpdated=Date.now();
    }catch(error){if(this.abort.signal.aborted)return;if(error.status===404)this.indexUnsupported=true;else{this.indexError=true;this.indexRetryAt=Date.now()+15000;}}
    finally{this.indexBusy=false;if(!this.abort.signal.aborted)this.messageMap.update();}
  }
  focusMessage(key){
    const node=this.nodes.get(key)?.node;if(!node)return false;
    this.following=false;this.suppress=true;this.viewport.scrollTop+=node.getBoundingClientRect().top-this.viewport.getBoundingClientRect().top-12;
    this.lastTop=this.viewport.scrollTop;this.anchor=this.capture();this.messageMap.close();requestAnimationFrame(()=>this.suppress=false);return true;
  }
  async navigateMessage(entry){
    const ticket=++this.navigationRequest;this.generation++;
    const candidate=this.rows.get(entry.loadedKey||entry.rowKey)?.row;
    const loaded=candidate&&messageSummary(candidate)===entry.summary?candidate.key:[...this.rows.values()].find(value=>value.row.navigationId===entry.id)?.row.key;
    if(loaded&&this.focusMessage(loaded)){this.navigationBusy=false;this.historyStatus();return;}
    if(!entry.id||entry.id.startsWith('loaded:'))return;
    this.navigationBusy=true;this.historyStatus();
    const live=this.liveCursor||{epoch:this.epoch,sequence:this.sequence,start:this.before||''};
    try{
      const page=await this.read('timeline',{around:entry.id,limit:100});
      if(this.abort.signal.aborted||ticket!==this.navigationRequest)return;
      if(!page.navigationWindow||!page.targetKey)throw Error(timelineText('这条消息已变化，请刷新消息目录'));
      this.navigationMode=true;this.navigationRetry=null;this.liveCursor=live;this.following=false;this.apply(page,true);this.focusMessage(page.targetKey);
      this.newer.textContent=timelineText(this.hasLiveChanges?'有新内容 ↓':'返回最新内容 ↓');this.newer.hidden=false;
    }catch(error){if(!this.abort.signal.aborted&&ticket===this.navigationRequest){this.status(error.message);this.loadMessageIndex(true);}}
    finally{if(ticket===this.navigationRequest){this.navigationBusy=false;this.historyStatus();}}
  }
  async pageNavigation(direction,automatic=false){
    const cursor=direction==='before'?this.before:this.after;
    if(!this.navigationMode||!cursor||this.navigationBusy||this.abort.signal.aborted)return;
    if(automatic&&this.navigationRetry===cursor)return;
    this.navigationRetry=null;
    const ticket=++this.navigationRequest;this.navigationBusy=true;this.generation++;this.historyStatus();
    try{
      const page=await this.read('timeline',{[direction]:cursor,limit:100});
      if(this.abort.signal.aborted||ticket!==this.navigationRequest)return;
      this.following=false;this.mergeNavigationPage(page,direction);
    }catch(error){if(!this.abort.signal.aborted&&ticket===this.navigationRequest){this.navigationRetry=cursor;this.status(error.message);}}
    finally{if(ticket===this.navigationRequest){this.navigationBusy=false;this.historyStatus();}}
  }
  mergeNavigationPage(page,direction){
    const anchor=this.capture(),next={before:page.before,after:page.after,keys:page.rows.map(row=>row.key),files:page.files||[]};
    const pages=direction==='before'?[next,...this.navigationPages]:[...this.navigationPages,next];
    // Two adjacent server projections retain continuous reading and valid
    // attachment/detail/action evidence without accumulating the whole chat.
    this.navigationPages=direction==='before'?pages.slice(0,2):pages.slice(-2);
    this.files=new Map(this.navigationPages.flatMap(value=>value.files||[]).map(file=>[file.id,file]));
    const keep=new Set(this.navigationPages.flatMap(value=>value.keys));
    for(const [key,{node}] of this.nodes)if(!keep.has(key)){node.remove();this.nodes.delete(key);this.rows.delete(key);this.details.delete(key);}
    this.apply(page,false,true);
    this.before=this.navigationPages[0].before;this.after=this.navigationPages.at(-1).after;this.hasMore=!!this.before;
    this.historyStatus();this.restore(anchor,false);
  }
  async loadLatest(){
    const ticket=++this.navigationRequest;this.generation++;this.navigationBusy=true;
    try{
      const page=await this.read('timeline',{limit:20});if(this.abort.signal.aborted||ticket!==this.navigationRequest)return;
      this.navigationMode=false;this.navigationRetry=null;this.liveCursor=null;this.hasLiveChanges=false;this.following=true;this.apply(page,true);this.jumpBottom();
    }catch(error){if(!this.abort.signal.aborted&&ticket===this.navigationRequest)this.status(error.message);}
    finally{if(ticket===this.navigationRequest){this.navigationBusy=false;this.historyStatus();}}
  }
  atBottom(){return this.viewport.scrollHeight-this.viewport.scrollTop-this.viewport.clientHeight<110;}
  nearTop(){const nodes=[...this.container.children].filter(n=>!n.hidden);return nodes.length>0&&nodes.slice(0,11).some(n=>n.getBoundingClientRect().bottom>=this.viewport.getBoundingClientRect().top);}
  capture(accept=()=>true){if(!this.viewport.clientHeight)return this.anchor;const top=this.viewport.getBoundingClientRect().top;const nodes=[...this.container.children].filter(n=>!n.hidden&&accept(n));const node=nodes.find(n=>n.getBoundingClientRect().bottom>top)||nodes[nodes.length-1];return node?{key:node.dataset.key,offset:node.getBoundingClientRect().top-top}:null;}
  rowVisible(row){
    if(row.isUserContext)return false;
    if(row.role==='user'||row.role==='error')return true;
    if(row.kind==='reasoning')return this.showProcess&&this.showReasoning&&!!row.text?.trim();
    if(row.role==='activity')return this.showProcess;
    return true;
  }
  setVisibility({showReasoning,showProcess}){
    if(this.showReasoning===showReasoning&&this.showProcess===showProcess)return;
    this.showReasoning=showReasoning;this.showProcess=showProcess;
    const anchor=this.capture(),bottom=this.following;
    for(const [key,{node}] of this.nodes)node.hidden=!this.rowVisible(this.rows.get(key).row);
    this.groupRows();
    this.restore(anchor,bottom);this.fillRecent();
  }
  jumpBottom(){this.viewport.scrollTop=this.viewport.scrollHeight;this.following=true;this.newer.hidden=true;}
  restore(anchor,bottom=false){
    if(this.abort.signal.aborted||!this.viewport.clientHeight)return;
    this.suppress=true;
    const node=anchor&&(this.nodes.get(anchor.key)?.node||this.messageGroups?.get(anchor.key));
    if(bottom)this.jumpBottom();
    else if(node&&!node.hidden)this.viewport.scrollTop+=node.getBoundingClientRect().top-this.viewport.getBoundingClientRect().top-anchor.offset;
    this.lastTop=this.viewport.scrollTop;
    this.anchor=this.capture();
    requestAnimationFrame(()=>this.suppress=false);
  }
  read(action,params={}){return this.request(this.url(action)+'&'+new URLSearchParams(params),undefined,this.abort.signal);}
  async start(){
    if(this.starting||this.abort.signal.aborted)return;
    clearTimeout(this.startRetry);this.starting=true;
    this.older.hidden=false;this.older.disabled=true;this.older.textContent=timelineText('正在读取最近内容…');
    try{
      const page=await this.read('timeline',{limit:20});
      if(this.abort.signal.aborted)return;
      this.apply(page,true);this.loadMessageIndex();this.updates();
      // Give the first 20 records a paint before quietly filling the 100-row window.
      requestAnimationFrame(()=>requestAnimationFrame(()=>this.fillRecent()));
    }catch(e){if(this.abort.signal.aborted)return;this.older.disabled=false;this.older.textContent=timelineText('读取失败，点击重试');this.status(e.message);this.startRetry=setTimeout(()=>this.start(),3000);}
    finally{this.starting=false;}
  }
  fillRecent(){
    if(this.navigationMode||this.navigationBusy)return;
    const filtered=!this.showReasoning||!this.showProcess,target=filtered?20:100;
    const count=[...this.nodes.values()].filter(({node})=>!node.hidden).length;
    if(!this.abort.signal.aborted&&this.rows.size>0&&count<target&&!this.retryCount)this.loadOlder(filtered?100:target-count);
  }
  historyStatus(){this.older.hidden=!this.hasMore;this.older.disabled=this.busy||this.navigationBusy;this.older.textContent=this.busy||this.navigationBusy?timelineText('正在读取更早内容…'):this.retryCount?timelineText('历史加载失败，点击重试'):timelineText('查看更早内容');this.later.hidden=!this.navigationMode||!this.after;this.later.disabled=this.navigationBusy;}
  async loadOlder(count){
    if(this.navigationMode){return this.pageNavigation('before');}
    if(this.navigationBusy)return;
    if(this.busy||!this.hasMore||this.abort.signal.aborted)return;
    const generation=this.generation,before=this.before;
    this.busy=true;this.retryCount=0;this.historyStatus();
    try{
      const page=await this.read('timeline',{before,limit:count});
      if(this.abort.signal.aborted||generation!==this.generation)return;
      if(page.reset||page.epoch!==this.epoch){this.apply(page,true);return;}
      this.apply(page,false,true);
    }catch(e){if(this.abort.signal.aborted||generation!==this.generation)return;this.retryCount=count;}
    finally{this.busy=false;if(!this.abort.signal.aborted){this.historyStatus();this.fillRecent();}}
  }
  apply(page,reset=false,history=false){
    const anchor=this.capture(),bottom=this.following;
    if(reset){this.generation++;this.rows.clear();this.nodes.clear();this.details.clear();this.files.clear();this.container.replaceChildren();this.epoch=page.epoch;this.retryCount=0;this.navigationPages=page.navigationWindow?[{before:page.before,after:page.after,keys:page.rows.map(row=>row.key),files:page.files||[]}]:[];}
    for(const file of page.files||[])this.files.set(file.id,file);
    if((!history&&page.sequence>=this.sequence)||reset){this.sequence=page.sequence;this.meta=page.meta;this.renderMeta({...page.meta,files:[...this.files.values()]});}
    if(!history)this.pendingRequests=!!page.meta.requests?.length;
    let changed=false;
    for(const row of page.rows){
      const previous=this.rows.get(row.key);
      if(previous&&previous.sequence>page.sequence)continue;
      this.rows.set(row.key,{row,sequence:page.sequence,epoch:page.epoch});
      const stamp=JSON.stringify(row),old=this.nodes.get(row.key);
      if(old?.stamp===stamp)continue;
      const open=old?.node.tagName==='DETAILS'&&old.node.open;
      const node=this.renderRow(row,open);node.dataset.key=row.key;
      node.hidden=!this.rowVisible(row);changed=changed||!node.hidden;
      if(old)old.node.replaceWith(node);
      this.nodes.set(row.key,{node,stamp});
    }
    const ordered=[...this.rows.values()].map(x=>x.row).sort((a,b)=>a.order-b.order);
    this.groupRows(ordered);
    if(reset||history){this.before=page.before;this.hasMore=page.hasMore;this.after=page.after||null;this.windowRevision++;}
    this.refreshActions();this.historyStatus();this.restore(anchor,bottom);
    this.messageMap.update();
    if(!this.navigationMode&&!history&&!bottom&&(changed||page.meta.requests?.length)){this.newer.textContent=page.meta.requests?.length?timelineText('有待确认请求 ↓'):timelineText('有新内容 ↓');this.newer.hidden=false;}
    if(reset)requestAnimationFrame(()=>this.fillRecent());
  }
  rowHeading(row){
    if(row.role==='activity')return (row.title||row.kind)+(row.status==='inProgress'?timelineText(' · 进行中'):'');
    if(row.kind==='threadMessage')return timelineText('其他主聊天');
    return row.role==='user'?timelineText('你'):row.role==='error'?timelineText('执行错误'):['CODEX',row.model&&[row.model,row.effort].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  }
  groupRows(ordered=[...this.rows.values()].map(value=>value.row).sort((a,b)=>a.order-b.order)){
    this.messageGroups??=new ChatMessageGroups(this.container);
    this.messageGroups.render(ordered.map(row=>({key:row.key,node:this.nodes.get(row.key).node,message:row,turnId:row.turnId,turnStatus:row.turnStatus})),{showProcess:this.showProcess});
  }
  renderRow(row,open){
    const activity=row.role==='activity',node=document.createElement(activity?'details':'div');
    node.className=activity?'activity timeline-row':'message timeline-row '+row.role;
    // Retain the row key for history cursors without rendering system context.
    if(row.isUserContext)return node;
    const heading=document.createElement(activity?'summary':'span');heading.className=activity?'':'who';
    heading.textContent=this.rowHeading(row);node.append(heading);
    const body=document.createElement(activity?'pre':'div');body.className=activity?'activity-body':'message-body';
    const more=document.createElement('button');more.className='plain detail-more';more.type='button';
    const cached=this.details.get(row.key);
    if(cached&&cached.version!==row.version)this.details.delete(row.key);
    const paint=()=>{
      const detail=this.details.get(row.key),text=detail?.text??row.text;
      body.replaceChildren();if(activity)body.textContent=text;else this.renderText(body,text,[...this.files.values()],()=>this.fullText(row));
      if(activity)body.hidden=!text;
      more.hidden=detail?detail.next===null:!row.truncated;
      more.textContent=detail?timelineText('继续加载正文'):timelineText('展开完整内容');
    };
    const load=async()=>{
      if(more.disabled||this.abort.signal.aborted)return;
      const prior=this.details.get(row.key);if(prior?.next===null)return;
      more.disabled=true;more.textContent=timelineText('正在读取…');
      try{
        const detail=await this.read('detail',{key:this.rowCursor(row),offset:prior?.next||0,version:prior?.version||row.version});
        if(this.abort.signal.aborted||!node.isConnected||this.rows.get(row.key)?.row.version!==detail.version)return;
        for(const file of detail.files||[])this.files.set(file.id,file);
        this.details.set(row.key,{version:detail.version,text:(detail.offset?prior?.text||'':'')+detail.text,next:detail.next});paint();
      }catch(e){if(!this.abort.signal.aborted){more.hidden=false;more.textContent=timelineText('读取失败，点击重试');}}
      finally{more.disabled=false;}
    };
    more.onclick=load;node.append(body,more);paint();
    if(row.role==='user'||row.role==='assistant'){
      const actions=document.createElement('div');actions.className='message-actions';
      const copy=document.createElement('button');copy.type='button';copy.className='plain message-copy';copy.textContent=timelineText('复制');copy.onclick=()=>window.BridgeClipboard?.copy(()=>this.fullText(row),copy);actions.append(copy);node.append(actions);
    }
    if(row.attachments?.length){
      const attachments=document.createElement('div');attachments.className='timeline-attachments';
      for(const item of row.attachments){
        if((item.type==='localImage'||item.type==='image')&&(item.uploadId||item.desktopId)){
          const source=item.uploadId
            ?this.url('uploads/'+encodeURIComponent(item.uploadId)+'/preview')
            :this.url('desktop-images/'+encodeURIComponent(item.desktopId));
          const original=item.uploadId
            ?source+'&variant=original'
            :source;
          const link=document.createElement('a');link.href=original;link.target='_blank';link.rel='noopener';
          link.dataset.imagePreview=original;link.dataset.imageName=item.name||timelineText('图片附件');
          const image=document.createElement('img');image.className='attachment-image';image.alt=item.name||timelineText('图片附件');
          image.loading='lazy';image.decoding='async';image.src=source;
          image.onerror=()=>link.remove();link.append(image);attachments.append(link);
        }
      }
      const attachment=document.createElement('small');attachment.className='muted';
      attachment.textContent=timelineText('附件：')+row.attachments.map(a=>a.name||a.type).join('、');
      attachments.append(attachment);node.append(attachments);
    }
    if(activity){node.open=!!open;node.ontoggle=()=>{if(node.open&&row.truncated&&!this.details.has(row.key))load();};}
    return node;
  }
  rowCursor(row){return (this.rows.get(row.key)?.epoch||this.epoch)+'.'+row.key;}
  async fullText(row){
    const valid=()=>!this.abort.signal.aborted&&this.rows.get(row.key)?.row.version===row.version;
    if(!valid())throw Error(timelineText('消息内容已变化，请重新打开编辑'));
    if(!row.truncated)return row.text;
    let text='',offset=0;
    do{
      const detail=await this.read('detail',{key:this.rowCursor(row),offset,version:row.version});
      if(!valid()||detail.version!==row.version||detail.offset!==offset||detail.key!==row.key)throw Error(timelineText('消息内容已变化，请重新打开编辑'));
      text+=detail.text;
      if(detail.next===null)return text;
      if(detail.next<=offset)throw Error(timelineText('读取完整正文失败，请重试'));
      offset=detail.next;
    }while(true);
  }
  refreshActions(){
    for(const [key,{node}] of this.nodes){
      const row=this.rows.get(key)?.row,bar=node.querySelector('.message-actions');if(!bar||!row)continue;
      if(!this.onAction)continue;
      const actions=new Set();
      const add=(action,label,disabled)=>{actions.add(action);const cls=action==='fork'?'message-fork':'message-edit';let b=bar.querySelector('[data-message-action="'+action+'"]');if(!b){b=document.createElement('button');b.type='button';b.className='plain '+cls;b.dataset.messageAction=action;bar.append(b);}b.textContent=timelineText(label);b.hidden=false;b.disabled=disabled;b.onclick=()=>this.onAction(action,row,this);};
      if(row.editable&&this.canEdit()){
        const latest=this.meta?.latestUserTurnId===row.turnId;
        add('edit','编辑并重新发送',row.turnStatus==='inProgress'||this.meta?.status==='active');
        if(!latest)add('edit-fork','编辑并新建分支',row.turnStatus==='inProgress');
      }
      if(row.forkable&&this.canEdit())add('fork','从这里分支',false);
      for(const button of bar.querySelectorAll('[data-message-action]'))if(!actions.has(button.dataset.messageAction))button.remove();
    }
  }
  relabel(){
    this.refreshActions();
    this.container.querySelectorAll('.message-copy').forEach(n=>n.textContent=timelineText('复制'));
    this.container.querySelectorAll('.code-copy').forEach(n=>n.textContent=timelineText('复制代码'));
    this.historyStatus();
    for(const [key,entry] of this.nodes){
      const row=this.rows.get(key)?.row;if(!row)continue;
      const node=entry.node,heading=node.firstElementChild;
      if(heading)heading.textContent=this.rowHeading(row);
      const more=node.querySelector('.detail-more');
      if(more&&!more.disabled)more.textContent=timelineText(this.details.has(key)?'继续加载正文':'展开完整内容');
      const attachment=node.querySelector('.timeline-attachments small.muted');
      if(attachment)attachment.textContent=timelineText('附件：')+row.attachments.map(a=>a.name||a.type).join('、');
    }
    this.newer.textContent=timelineText(this.pendingRequests?'有待确认请求 ↓':this.navigationMode&&!this.hasLiveChanges?'返回最新内容 ↓':'有新内容 ↓');
    this.later.textContent=timelineText('查看后续内容');this.messageMap.update();
  }
  async updates(){
    while(!this.abort.signal.aborted){
      if(!this.active()){await this.pause(1000);continue;}
      try{
        const generation=this.generation,windowRevision=this.windowRevision;
        const cursor=this.navigationMode?this.liveCursor:{sequence:this.sequence,epoch:this.epoch,start:this.before||''};
        const page=await this.read('changes',{after:cursor.sequence,epoch:cursor.epoch,start:cursor.start});
        if(this.abort.signal.aborted)return;
        if(generation!==this.generation||windowRevision!==this.windowRevision)continue;
        // History may have expanded the window while this poll was in flight.
        // Polls never replace the oldest loaded cursor.
        if(this.navigationMode){
          this.liveCursor={sequence:page.sequence,epoch:page.epoch,start:page.reset?page.before||'':cursor.start};
          this.meta=page.meta;this.renderMeta({...page.meta,files:[...this.files.values()]});
          this.refreshActions();
          if(page.rows.length||page.reset||page.meta.requests?.length){this.hasLiveChanges=true;this.newer.textContent=timelineText(page.meta.requests?.length?'有待确认请求 ↓':'有新内容 ↓');this.newer.hidden=false;}
        }else{this.apply(page,!!page.reset);this.fillRecent();}
        if(!this.indexUnsupported&&Date.now()>=this.indexRetryAt&&Date.now()-this.indexUpdated>15000)this.loadMessageIndex();
        await this.pause(200);
      }catch(e){if(this.abort.signal.aborted)return;this.status(timelineText('重新连接中'));await this.pause(3000);}
    }
  }
  pause(ms){return new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);this.abort.signal.addEventListener('abort',done,{once:true});});}
}
