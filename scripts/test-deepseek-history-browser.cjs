'use strict';
// Isolated native event producer + production history module + real browser DOM.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const html=fs.readFileSync(path.join(web,'index.html'),'utf8').replace(/<script[^>]+src="\/(?:bootstrap|presentation)\.js[^"]*"[^>]*><\/script>/g,'').replace('</body>','<script src="/fixture.js" defer></script></body>');
(async()=>{
  const {createHistory,lastTurn}=await import(pathToFileURL(path.join(root,'bridge/clients/deepseek/history.mjs')));
  const log=new Map(),slots=new Map(),uploads=new Map(),pendingAcks=new Map();let queue=[],unknownNext=false,acknowledged=false;
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLQAAAAASUVORK5CYII=';
  function reset(){log.clear();slots.clear();uploads.clear();pendingAcks.clear();unknownNext=false;acknowledged=false;queue=[{id:'native-queue',submissionId:'native-request',text:'排队消息'}];
    for(const sid of ['main','side-a','side-b']){const events=[];log.set(sid,events);for(let n=0;n<260;n++){
      const append=(type,data)=>events.push({event:{seq:events.length,time:1700000000000+events.length,type,data}});
      append('turn/start',{turn:n});append('user/message',{id:sid+'-u'+n,role:'user',source:{kind:'user'},content:[{type:'text',text:sid+' prompt '+n},...n===2?[{type:'image',attachment:{id:'image-2',name:'photo.png',bytes:70,mediaType:'image/png'}},{type:'file',attachment:{id:'file-2',name:'report.pdf',bytes:12}}]:[]]});
      append('assistant/message',{message:{id:sid+'-a'+n,content:[{type:'text',text:'reply '+n}]}});append('turn/end',{turn:n,reason:{kind:'completed'}});
    }}
    slots.set('11111111-1111-4111-8111-111111111111',{id:'side-a',title:'侧边甲',closed:false});slots.set('22222222-2222-4222-8222-222222222222',{id:'side-b',title:'侧边乙',closed:false});
  }
  reset();
  const caps={historyNavigation:true,messageActions:false,sideChat:true,attachments:true,fileAttachments:true,queue:true,steer:true,models:true,permissions:true,workModes:true,goal:true};
  const questions=[{id:'review',question:'请审阅计划',detail:'# 完整计划\n\n'+('计划步骤\n'.repeat(500))+'\n完整计划最后一步',intent:{kind:'plan-review',approve:'Approve',callId:'call-1'},options:[{label:'Approve'},{label:'Keep planning'}]}];
  const meta=sid=>{const session={id:sid,title:sid==='main'?'主聊天':sid==='side-a'?'侧边甲':'侧边乙',cwd:'/fixture',backend:'deepseek',mode:'desktop',status:'idle',runtimeKnown:true,model:'fixture/model',updatedAt:1700000000000,...lastTurn(log.get(sid)),requests:[{id:'review-request',needsInput:true,tool:'提问',input:{questions}}],recovery:{enabled:true}};return {...session,session,capabilities:caps,connected:true,requests:session.requests,latestUserTurnId:'259'};};
  const history=createHistory({token:'isolated-browser-secret',find:async sid=>{if(!log.has(sid))throw Error('wrong session');return {sessionId:sid};},ctx:{sessionController:{projections:async({sessionId})=>({asOfSeq:log.get(sessionId).length-1}),page:async r=>{let records=log.get(r.address.sessionId).filter(x=>x.event.seq<=r.throughSeq&&(r.beforeSeq===undefined||x.event.seq<r.beforeSeq));let i=records.length,n=0;while(i>0){i--;if(['user/message','assistant/message'].includes(records[i].event.type)&&++n>=r.maxMessages)break;}return {records:records.slice(i),hasMore:i>0};},attachment:async()=>({attachment:{mediaType:'image/png'},data:png})}}});
  const detail=async(sid,body)=>({...meta(sid),...await history.window(sid,body,meta(sid)),queue:sid==='main'?queue:[]});
  const server=http.createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://127.0.0.1'),query=Object.fromEntries(url.searchParams),action=url.pathname.split('/').at(-1);let body={};
    if(req.method==='POST'){const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);body=req.headers['content-type']?.includes('application/json')?JSON.parse(bytes):{bytes};}
    const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(url.pathname==='/fixture-unknown'){unknownNext=true;return json({ok:true});}
    if(url.pathname==='/fixture-ack'){acknowledged=true;return json({ok:true});}
    if(url.pathname==='/fixture-append'){
      const events=log.get(query.sessionId),turn=Number(lastTurn(events).turnId)+1;
      for(const [type,data]of [['turn/start',{turn}],['user/message',{id:'new-user',source:{kind:'user'},content:[{type:'text',text:'new prompt'}]}],['assistant/message',{message:{content:[{type:'text',text:'new reply'}]}}],['turn/end',{turn,reason:{kind:'completed'}}]])events.push({event:{seq:events.length,time:Date.now(),type,data}});
      return json({ok:true});
    }
    if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,'tests/browser/deepseek-history.browser.js'),'utf8')+'\nwindow.__ready=runDeepSeekHistoryBrowserTests();');}
    if(url.pathname==='/'){reset();history.clear();res.setHeader('Content-Type','text/html');return res.end(html);}
    if(url.pathname.startsWith('/api/desktop-sessions/deepseek/')){
      const sid=body.sessionId||query.sessionId;
      if(action==='list')return json({connected:true,sessions:[meta('main').session],capabilities:caps,projects:[]});
      if(['detail','timeline','changes'].includes(action)){if(action==='changes')await new Promise(r=>setTimeout(r,150));return json({...await detail(sid,query),reset:action==='changes'});}
      if(action==='message-index')return json(await history.directory(sid,query));
      if(action==='attachment'){const value=await history.attachment(sid,query),bytes=Buffer.from(value.data,'base64');res.setHeader('Content-Type',value.mime);return res.end(bytes);}
      if(action==='side-chat'){
        const slot=query.slot||'',entry=slots.get(slot)||[...slots.values()].find(e=>e.id===query.archiveId),summaries=[...slots].filter(([,e])=>!e.closed).map(([slot,e])=>({slot,id:e.id,title:e.title,titleRevision:1}));
        if(query.history)return json({items:[...slots].map(([slot,e])=>({slot,id:e.id,title:e.title,archiveId:e.id,live:!e.closed,ended:e.closed})),nextOffset:null});
        if(body.action==='close'){assert.equal(body.id,entry.id);entry.closed=true;return json({status:'accepted',closed:true});}
        if(body.action==='send'){assert.equal(body.id,entry.id);for(const id of body.attachments||[])assert.equal(uploads.get(id).sid,entry.id);if(unknownNext){unknownNext=false;pendingAcks.set(entry.id,body.submissionId);return json({status:'unknown'});}return json({status:body.mode==='queue'?'queued':'accepted'});}
        if(query.action==='message-index')return json(await history.directory(entry.id,query));
        if(query.action==='message-detail')return json(await history.detail(entry.id,query));
        if(!entry)return json({id:null,connected:false,turns:[],requests:[],slots:summaries});
        return json({...await detail(entry.id,query),id:entry.id,slot,archiveId:entry.closed?entry.id:undefined,readOnly:entry.closed,slots:summaries,submissions:acknowledged&&pendingAcks.has(entry.id)?[{id:pendingAcks.get(entry.id),status:'accepted'}]:[],requests:entry.closed?[]:[{id:'review-request',method:'tool/requestUserInput',supported:true,params:{questions}}]});
      }
      if(action==='queue'){queue=[];return json({status:'accepted'});}
      if(action==='uploads'){uploads.set(query.id,{sid,name:query.name});return json({id:query.id,name:query.name,size:body.bytes.length,scope:sid});}
      if(action==='send'){for(const id of body.attachments||[])assert.equal(uploads.get(id).sid,sid);return json({status:'accepted'});}
      if(action==='workspace')return json({root:'/fixture',entries:[]});
      return json({status:'accepted',options:[],models:[],skills:[]});
    }
    let parts=assets[url.pathname];if(!parts&&url.pathname.startsWith('/vendor/')&&!url.pathname.includes('..'))parts=url.pathname.slice(1);
    if(!parts&&/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(url.pathname))parts=url.pathname.slice(1);
    if(!parts){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'image/png');res.end(Buffer.concat([].concat(parts).filter(f=>f!=='shell/app.js').map(f=>fs.readFileSync(path.join(web,f)))));
  }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true}),results=[];
  try{for(const [width,height]of [[390,844],[844,390],[820,1180],[1280,900]]){const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);const result=await page.evaluate(()=>window.__ready);assert.deepEqual(errors,[]);results.push({width,height,...result});await context.close();}console.log(JSON.stringify({passed:results.reduce((n,r)=>n+r.passed,0),viewports:results},null,2));}
  finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
