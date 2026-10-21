// Synthetic API, production ChatTimeline and real browser layout. No native client.
function setupCompactMessageNavigationFixture({count=1,contexts=false,userSuffix='',image=false}={}) {
  window.navigationFixture?.timeline.dispose();
  document.getElementById('messages').replaceChildren();
  const contextTexts=[
    '# AGENTS.md instructions for /fixture\n<INSTRUCTIONS>'+('Project rules. '.repeat(800))+'</INSTRUCTIONS>',
    '<skill>\n<name>fixture-skill</name>\n<path>/fixture/SKILL.md</path>\nSkill instructions\n</skill>',
    '<subagent_notification>\n{"agent_id":"fixture","status":{"completed":"Agent result"}}\n</subagent_notification>',
    '<environment_context><cwd>/fixture</cwd></environment_context>',
  ],requests=[],rendered=[];
  const rows=[...(contexts?contextTexts.map((text,i)=>({key:'context'+i,role:'user',kind:'userMessage',isUserContext:true,
    text:text.slice(0,8000),truncated:text.length>8000})):[]),
    ...Array.from({length:count},(_,i)=>({key:'q'+i,role:'user',kind:'userMessage',text:'Question '+i+userSuffix,editable:true,
      ...(image?{attachments:[{type:'image',name:'screen.jpg',desktopId:'a'.repeat(64)}]}:{})})),
    {key:'answer',role:'assistant',kind:'agentMessage',phase:'final_answer',text:'Answer'}
  ].map((row,order)=>({...row,order,turnId:'turn',version:'v1'}));
  const page={epoch:'compact',sequence:1,rows,files:[],hasMore:false,before:null,meta:{requests:[],latestUserTurnId:'turn'}};
  const timeline=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request:async url=>{
    const u=new URL(url,location.origin),action=u.pathname.split('/').pop();requests.push(action);
    if(action==='timeline'&&u.searchParams.has('around'))return {...page,epoch:'history',sequence:2,navigationWindow:true,targetKey:'q0'};
    throw Error('Unexpected fixture request: '+url);
  },renderMeta:()=>{},renderText:(node,text)=>{rendered.push(text);node.textContent=text;},status:()=>{}});
  timeline.apply(page,true);
  window.navigationFixture={timeline,requests,rendered,contextTexts,rows,page};
}

async function setupMessageNavigationFixture({count=5000,failIndex=false}={}) {
  window.navigationFixture?.timeline.dispose();
  document.getElementById('messages').replaceChildren();
  const requests=[],errors=[],actions=[],held=new Map(),brokenJumps=new Set(),brokenPages=new Set();let indexFailure=failIndex,liveResolve,sequence=1;
  const entry=i=>({id:'u'+i,rowKey:'q'+i,turnId:'t'+i,summary:i===2?'attachment.png':'Question '+i,order:i});
  const row=position=>{
    const i=Math.floor(position/2),user=position%2===0;
    return {key:(user?'q':'a')+i,order:position,role:user?'user':'assistant',kind:user?'userMessage':'agentMessage',
      turnId:'t'+i,navigationId:user?'u'+i:undefined,version:'v1',editable:user,forkable:!user,turnStatus:'completed',
      text:user?(i===2?'':'Question '+i):('Answer '+i+' paragraph '.repeat(35)),
      ...(user&&i===2?{attachments:[{type:'image',name:'attachment.png',desktopId:'a'.repeat(64)}]}:{})};
  };
  const windowPage=(start,limit=100,target=null)=>{
    const end=Math.min(count*2,start+limit);
    return {epoch:'window'+start,sequence,rows:Array.from({length:end-start},(_,i)=>row(start+i)),files:[],
      before:start?'nav.w.'+start:null,after:end<count*2?'nav.w.'+end:null,hasMore:start>0,
      meta:{requests:[],latestUserTurnId:'t'+(count-1),status:'idle'},navigationWindow:true,targetKey:target===null?null:'q'+target};
  };
  const request=async(url,body,signal)=>{
    const u=new URL(url,location.origin),action=u.pathname.split('/').pop(),p=u.searchParams;requests.push({action,params:Object.fromEntries(p)});
    if(action==='message-index'){
      if(!p.get('cursor'))await new Promise(resolve=>setTimeout(resolve,40));
      const from=Number(p.get('cursor')||p.get('since')||0),end=Math.min(count,from+200);
      if(from===200&&indexFailure){indexFailure=false;throw Error('Index network failure');}
      return {revision:'fixture',items:Array.from({length:end-from},(_,i)=>entry(from+i)),status:'ready',complete:true,total:count,
        nextCursor:end<count?String(end):null,tailCursor:String(end)};
    }
    if(action==='changes'){
      if(Number(p.get('after'))<sequence)return {epoch:'live',sequence,rows:[{key:'new'+sequence,order:21000+sequence,role:'assistant',text:'New live reply',version:'v1'}],meta:{requests:[]}};
      return new Promise((resolve,reject)=>{
        liveResolve=resolve;signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
      });
    }
    if(action==='timeline'&&p.has('around')){
      const i=Number(p.get('around').slice(1)),value=windowPage(Math.max(0,i*2-6),100,i);
      if(brokenJumps.delete(i))throw Error('Message window network failure');
      if(held.has(i))return new Promise(resolve=>held.set(i,()=>resolve(value)));
      return value;
    }
    if(action==='timeline'&&(p.get('before')?.startsWith('nav.')||p.has('after'))){
      if(brokenPages.delete(p.has('after')?'after':'before'))throw Error('Page network failure');
      const position=Number((p.get('before')||p.get('after')).split('.').pop());
      return p.has('after')?windowPage(position):windowPage(Math.max(0,position-100),Math.min(position,100));
    }
    if(action==='timeline'){
      const end=p.has('before')?Number(p.get('before').split('.').pop()):20000,start=end-Number(p.get('limit'));
      return {epoch:'live',sequence,rows:Array.from({length:end-start},(_,i)=>({key:'tool'+(start+i),order:start+i,
        version:'v1',role:'activity',kind:'storedToolEvent',title:'Recent tool',text:'Recent tool record'})),
        before:'live.'+start,hasMore:true,files:[],meta:{requests:[]}};
    }
    throw Error('Unexpected fixture request: '+url);
  };
  const timeline=new ChatTimeline({url:action=>'/fixture/'+action+'?host=local',request,
    renderMeta:()=>{},renderText:(node,text)=>node.textContent=text,status:message=>errors.push(message),onAction:(action,row)=>actions.push({action,key:row.key})});
  window.navigationFixture={timeline,requests,errors,actions,entry,
    failPage:direction=>brokenPages.add(direction),
    failJump:i=>brokenJumps.add(i),
    hold:i=>held.set(i,null),release:i=>{const resolve=held.get(i);if(typeof resolve!=='function')throw Error('No pending jump '+i);held.delete(i);resolve();},
    live:()=>{if(!liveResolve)throw Error('No live poll');const resolve=liveResolve;liveResolve=null;sequence++;
      resolve({epoch:'live',sequence,rows:[{key:'new'+sequence,order:21000+sequence,role:'assistant',text:'New live reply',version:'v1'}],meta:{requests:[]}});}};
  await timeline.start();
  return {firstRows:timeline.rows.size,indexBusy:timeline.indexBusy,entryVisible:!timeline.messageMap.root.hidden};
}
