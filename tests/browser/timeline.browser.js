// Run in a gateway browser page with timeline.js loaded. Uses synthetic data only.
async function runTimelineTests() {
  const checks=[];
  function check(value,label){if(!value)throw Error(label);checks.push(label);}
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  async function until(fn){const end=performance.now()+2500;while(!fn()){if(performance.now()>end)throw Error('Timed out waiting for fixture');await frame();}}
  document.getElementById('app').hidden=false;
  document.getElementById('chat').hidden=false;
  document.getElementById('app').classList.add('chat-open');
  const viewport=document.getElementById('timeline');
  viewport.style.cssText='height:400px;flex:none;overflow:auto;width:370px';
  const row=i=>({key:'k'+i,order:i,role:'assistant',version:'v'+i,text:'Record '+i+'\n'+'test paragraph '.repeat(12),
    ...(i===318?{model:'gpt-6-astra',effort:'max'}:i===319?{model:'gemini-pro',effort:'high'}:{})});
  const page=(from,to,sequence=1)=>({rows:Array.from({length:to-from},(_,i)=>row(from+i)),sequence,epoch:'epoch',before:'epoch.k'+from,hasMore:from>0,meta:{requests:[{id:'pending'}]},files:[]});
  const pending=[],requests=[];let meta,signal;
  const request=(url,body,abort)=>{
    signal=abort;
    const u=new URL(url,location.origin);requests.push(u);
    if(u.pathname.endsWith('/changes'))return new Promise((resolve,reject)=>abort.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
    if(!u.searchParams.has('before'))return Promise.resolve(page(300,320));
    return new Promise(resolve=>pending.push({resolve,limit:Number(u.searchParams.get('limit'))}));
  };
  const timeline=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request,renderMeta:v=>meta=v,renderText:(node,text)=>node.textContent=text,status:()=>{}});
  await timeline.start();
  check(timeline.rows.size===20,'First paint has 20 messages');
  check(timeline.nodes.get('k318').node.firstChild.textContent==='CODEX · gpt-6-astra max','Old reply retains its own model and effort');
  check(timeline.nodes.get('k319').node.firstChild.textContent==='CODEX · gemini-pro high','New reply shows its own model and effort');
  check(timeline.nodes.get('k317').node.firstChild.textContent==='CODEX','Missing historical model is not guessed');
  check(meta.requests[0].id==='pending','Approval metadata arrives with first page');
  await until(()=>pending.length===1);
  check(pending[0].limit===80,'Quiet backfill requests only 80 more');
  timeline.loadOlder(100);timeline.loadOlder(100);
  check(pending.length===1,'Only one history request in flight');
  pending.shift().resolve(page(220,300));
  await until(()=>timeline.rows.size===100&&!timeline.busy);await frame();await frame();
  check(timeline.atBottom(),'Backfill preserves bottom position');
  const anchorNode=timeline.nodes.get('k229').node;
  viewport.scrollTop+=anchorNode.getBoundingClientRect().top-viewport.getBoundingClientRect().top+4;
  viewport.dispatchEvent(new Event('scroll'));
  await until(()=>pending.length===1);
  const anchor=timeline.capture();
  check(pending[0].limit===100,'Within 10 records of top prefetches 100');
  pending.shift().resolve(page(120,220));
  await until(()=>timeline.rows.size===200&&!timeline.busy);await frame();
  check(Math.abs(timeline.nodes.get(anchor.key).node.getBoundingClientRect().top-viewport.getBoundingClientRect().top-anchor.offset)<2,'Prepending preserves message and pixel offset');
  const top=viewport.scrollTop;
  timeline.apply({...page(320,321,2),before:undefined,hasMore:undefined});
  check(timeline.rows.size===201,'Live append adds one message');
  check(Math.abs(viewport.scrollTop-top)<2&&!timeline.newer.hidden,'Live reply preserves history reading and shows new content button');
  await frame();await frame();
  const reading=timeline.capture(),readingTop=viewport.scrollTop;
  viewport.style.display='none';
  await frame();await frame();
  viewport.dispatchEvent(new Event('scroll'));
  check(JSON.stringify(timeline.capture())===JSON.stringify(reading),'Hidden workbench chat retains its reading anchor');
  viewport.style.display='';
  await frame();await frame();
  check(Math.abs(viewport.scrollTop-readingTop)<2,'Returning from a file tab preserves the timeline offset');
  const update=row(320);update.text+=' streamed';update.version='streamed';
  timeline.apply({...page(0,0,3),rows:[update]});
  check(timeline.rows.size===201,'Streaming replaces the same message');
  const sequence=timeline.sequence;
  timeline.apply(page(100,120,4),false,true);
  check(timeline.sequence===sequence,'History cannot skip the live update cursor');
  timeline.apply({...page(0,0,2),rows:[row(320)]});
  check(timeline.rows.get('k320').row.version==='streamed','Late responses cannot overwrite newer text');
  timeline.loadOlder(100);await until(()=>pending.length===1);
  timeline.dispose();const size=timeline.rows.size;
  check(signal.aborted,'Switching chat aborts active fetches');
  pending.shift().resolve(page(0,100,5));await frame();
  check(timeline.rows.size===size,'Late history cannot alter a disposed chat');
  timeline.rows.clear();timeline.container.replaceChildren();
  let detailCalls=0,fail=true;
  const tool={...row(0),role:'activity',title:'Tool',truncated:true,text:'Preview'};
  const long={...row(1),truncated:true,text:'Short preview'};
  const detailRequest=async url=>{
    const u=new URL(url,location.origin);
    if(u.pathname.endsWith('/detail')){detailCalls++;return {key:u.searchParams.get('key').split('.').pop(),version:'v1',offset:0,text:'Full body',next:null};}
    if(fail)throw Error('offline');
    return {...page(0,1,4),rows:[tool],hasMore:false};
  };
  const second=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request:detailRequest,renderMeta:()=>{},renderText:(node,text)=>{const p=document.createElement('p');p.textContent=text;node.append(p);},status:()=>{}});
  second.apply({...page(1,2,4),rows:[long]},true);
  await until(()=>second.retryCount>0);
  check(second.older.textContent===timelineText('历史加载失败，点击重试'),'Failed history exposes a retry button');
  fail=false;await second.loadOlder(100);
  check(!second.hasMore&&second.older.hidden,'EOF stops history loading');
  check(detailCalls===0,'Collapsed tool bodies are not fetched');
  const message=second.nodes.get('k1').node;
  message.querySelector('button').click();
  await until(()=>detailCalls===1&&!message.querySelector('button').disabled);
  check(message.querySelectorAll('.message-body p').length===1&&message.textContent.includes('Full body')&&!message.textContent.includes('Short preview'),'Expanding text replaces the preview without duplicating Markdown');
  second.dispose();
  return checks;
}

async function runTimelineVisibilityTests() {
  const checks=[];
  document.getElementById('messages').replaceChildren();
  const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  const rows=[
    {key:'user',role:'user',kind:'userMessage',text:'User message'},
    {key:'reasoning',role:'activity',kind:'reasoning',text:'Reasoning summary'},
    {key:'command',role:'activity',kind:'commandExecution',text:'Command output'},
    {key:'tool',role:'activity',kind:'storedToolEvent',text:'Tool output'},
    {key:'files',role:'activity',kind:'fileChange',text:'File changes'},
    {key:'progress',role:'assistant',kind:'agentMessage',phase:'commentary',text:'Progress update'},
    {key:'final',role:'assistant',kind:'agentMessage',phase:'final_answer',text:'Final reply\n'+('Reply text '.repeat(250))},
    {key:'legacy',role:'assistant',kind:'agentMessage',text:'Reply without a phase'},
    {key:'error',role:'error',text:'Execution failed'},
  ].map((row,order)=>({...row,order,version:'v1'}));
  let requested=0,meta;
  const page=(items,sequence=1,hasMore=false)=>({rows:items,sequence,epoch:'visibility',before:'visibility.'+items[0]?.key,hasMore,meta:{requests:[{id:'pending'}]},files:[]});
  const timeline=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request:async()=>{requested++;return page(rows);},renderMeta:value=>meta=value,renderText:(node,text)=>node.textContent=text,status:()=>{}});
  const visible=()=>[...timeline.container.children].filter(node=>!node.hidden).map(node=>node.dataset.key);
  timeline.setVisibility({showReasoning:true,showProcess:true});
  timeline.apply(page(rows),true);await frame();
  check(visible().length===9,'Default display retains all message categories');
  timeline.details.set('command',{version:'v1',text:'Command output',next:null});
  timeline.nodes.get('command').node.open=true;
  timeline.setVisibility({showReasoning:false,showProcess:true});
  check(!visible().includes('reasoning')&&visible().includes('command'),'Reasoning can be hidden independently');
  timeline.setVisibility({showReasoning:true,showProcess:false});
  check(visible().includes('reasoning')&&!visible().includes('progress')&&!visible().includes('command'),'Activity filter includes tools and commentary but retains reasoning');
  timeline.setVisibility({showReasoning:false,showProcess:false});
  check(JSON.stringify(visible())===JSON.stringify(['user','final','legacy','error']),'Reply view retains user text, final replies, unknown-phase replies and errors');
  check(meta.requests[0].id==='pending'&&timeline.pendingRequests,'Pending user requests remain available');
  timeline.viewport.scrollTop=timeline.nodes.get('final').node.offsetTop+20;
  timeline.following=false;timeline.newer.hidden=true;
  const anchor=timeline.capture();
  timeline.apply({...page([{...rows[2],version:'v2',text:'Streaming command output'}],2),meta:{requests:[]}});
  check(timeline.nodes.get('command').node.hidden&&timeline.newer.hidden,'Hidden streaming activity stays hidden without a new-content alert');
  check(timeline.capture()?.key===anchor?.key,'Hidden updates preserve the reading anchor');
  timeline.apply(page([{...rows[6],version:'v2',text:rows[6].text+'\nLive reply'}],3));
  check(!timeline.nodes.get('final').node.hidden&&!timeline.newer.hidden,'Streaming reply remains visible and signals new content');
  timeline.setVisibility({showReasoning:true,showProcess:true});
  check(visible().length===9&&timeline.nodes.get('command').node.open,'Restoring activity preserves its expansion state');
  timeline.dispose();
  timeline.container.replaceChildren();
  const backfill=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request:async()=>{requested++;return page(rows);},renderMeta:()=>{},renderText:(node,text)=>node.textContent=text,status:()=>{}});
  backfill.setVisibility({showReasoning:false,showProcess:false});requested=0;
  backfill.apply(page([{...rows[2],key:'latest-command',order:20}],4,true),true);
  for(let i=0;i<10&&(!requested||backfill.busy);i++)await frame();
  check(requested===1&&!backfill.nodes.get('final').node.hidden,'A page of hidden activity backfills earlier replies');
  check(!backfill.hasMore,'Filtered history still stops at the end');
  backfill.dispose();
  const empty=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request:async()=>page([{key:'empty-image',role:'activity',kind:'imageView',title:'图片预览',text:'',order:0,version:'v1',truncated:false}],1),renderMeta:()=>{},renderText:(node,text)=>node.textContent=text,status:()=>{}});
  empty.apply(page([{key:'empty-image',role:'activity',kind:'imageView',title:'图片预览',text:'',order:0,version:'v1',truncated:false}],1),true);
  const emptyBody=empty.nodes.get('empty-image').node.querySelector('.activity-body');
  check(emptyBody.hidden&&getComputedStyle(emptyBody).display==='none','Empty image preview body does not reserve space');
  empty.dispose();
  return checks;
}

async function runReasoningSummaryTests() {
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
  document.getElementById('messages').replaceChildren();
  let calls=0;
  const timeline=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',
    request:async url=>{
      calls++;
      const key=new URL(url,location.origin).searchParams.get('key').split('.').pop();
      return {key,version:'public',text:'Complete public summary',offset:0,next:null};
    },renderMeta:()=>{},renderText:(node,text)=>node.textContent=text,status:()=>{}});
  const row=(key,text='',extra={})=>({key,order:0,role:'activity',kind:'reasoning',title:'思考摘要',version:'empty',text,truncated:false,...extra});
  const page=(rows,sequence=1)=>({epoch:'summary',sequence,rows,meta:{requests:[]},hasMore:false});
  timeline.apply(page([row('empty')]),true);
  const empty=timeline.nodes.get('empty').node;
  check(empty.hidden,'Reasoning records without a public summary are hidden');
  check(calls===0,'An explicitly empty summary does not issue a pointless detail request');
  timeline.apply(page([row('pending','',{order:1,status:'inProgress'})],2));
  const pending=timeline.nodes.get('pending').node;
  check(pending.hidden,'Active reasoning records remain hidden until a public summary arrives');
  timeline.apply(page([row('empty','Public preview',{version:'public',truncated:true})],3));
  await frame();await frame();
  const updated=timeline.nodes.get('empty').node;
  check(!updated.hidden,'A later public summary makes the existing record visible');
  updated.querySelector('summary').click();await frame();await frame();
  check(updated.querySelector('.activity-body').textContent==='Complete public summary','A later public summary becomes visible and loads its full text');
  check(calls===1&&updated.querySelector('.detail-more').hidden,'A public summary loads once and hides its completed load button');
  timeline.dispose();
  return checks;
}

async function runQuestionReadingScrollTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const viewport=document.getElementById('timeline'),container=document.getElementById('messages');
  container.replaceChildren();viewport.style.height='400px';
  const questions=document.createElement('div');questions.id='question-scroll-fixture';
  container.after(questions);
  const timeline=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request:async()=>({}),
    renderMeta:meta=>{
      const card=document.createElement('section');card.className='approval';
      const heading=document.createElement('h3');heading.textContent='Codex 需要你的回复';
      const label=document.createElement('label');label.textContent=meta.requests[0].question;
      const input=document.createElement('textarea');input.rows=8;label.append(input);card.append(heading,label);questions.replaceChildren(card);
    },renderText:(node,text)=>node.textContent=text,status:()=>{}});
  const page=sequence=>({epoch:'question-scroll',sequence,rows:sequence===1?Array.from({length:20},(_,i)=>({key:'read-'+i,order:i,role:'assistant',version:'v1',text:'资料 '+i+' 参考内容 '.repeat(25)})):[],
    files:[],before:null,hasMore:false,meta:{requests:[{id:'question',question:'请选择下一步操作。'.repeat(sequence+2)}]}});
  try{
    timeline.apply(page(1),true);await frame();
    check(timeline.atBottom(),'问题框首次出现时可以跟随到末尾');
    // A real upward gesture can arrive during the frame used to restore layout.
    timeline.restore(timeline.capture(),true);viewport.scrollTop-=50;viewport.dispatchEvent(new Event('scroll'));
    check(!timeline.following,'向上移动不足底部阈值也立即停止跟随');
    viewport.scrollTop-=600;viewport.dispatchEvent(new Event('scroll'));
    const anchor=timeline.capture(),top=viewport.scrollTop;
    for(let sequence=2;sequence<=5;sequence++){timeline.apply(page(sequence));await frame();}
    check(timeline.capture()?.key===anchor.key&&Math.abs(viewport.scrollTop-top)<2,'问题框反复刷新时保留用户正在阅读的资料位置');
    check(!timeline.following,'问题框和消息布局变化不会重新开启自动跟随');
    timeline.newer.click();await frame();
    check(timeline.following&&timeline.atBottom(),'用户主动返回最新内容后才恢复跟随');
  }finally{timeline.dispose();questions.remove();}
  return checks;
}
