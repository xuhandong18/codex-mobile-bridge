// Production link rendering and workspace tabs, with synthetic authorized file reads only.
async function runFileLinkBrowserChecks(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const until=async run=>{for(let i=0;i<150;i++){if(run())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('File link fixture timed out');};
  const chat=document.createElement('section');chat.className='chat';
  chat.style.cssText='display:flex;flex-direction:column;width:calc(100vw - 24px);height:calc(100dvh - 24px);margin:12px';
  chat.innerHTML='<header class="chat-head"></header><div class="timeline" tabindex="0"></div><div class="composer"><textarea></textarea></div>';document.body.append(chat);
  const id='11111111-1111-4111-8111-111111111111',host='remote-ssh:file-links',reads=[],notices=[];
  let pending,fail=false;
  const info={name:'guide.md',path:'docs/guide.md',kind:'file',size:32,locatable:true,clickDownloadMiB:20};
  const wb=new Workbench({chat,notify:message=>notices.push(message),request:async value=>{
    const url=new URL(value,location.href);reads.push(url);
    if(url.searchParams.get('info')==='1'){if(pending){const wait=pending;pending=null;return wait;}if(fail)throw Error('Fixture file unavailable');return {...info};}
    if(url.pathname.endsWith('/workspace'))return {root:'/fixture',entries:[{name:'docs',path:'docs',kind:'directory'}],nextOffset:null};
    return {kind:'text',name:'guide.md',size:32,text:'# Direct file link\n\nComplete content.'};
  }});
  const message=document.createElement('div');message.className='message-body';
  const artifact={id:'a'.repeat(64),name:'guide.md',reference:'file:///fixture/docs/guide.md'};
  renderMarkdown(message,'[guide.md]('+artifact.reference+')',[artifact],file=>'/api/sessions/'+id+'/files/'+file.id+'?host='+encodeURIComponent(host));
  chat.querySelector('.timeline').append(message);const anchor=message.querySelector('a');
  const hold=()=>{let resolve,reject;pending=new Promise((done,fail)=>{resolve=done;reject=fail;});return {resolve,reject};};
  const state=()=>wb.current.files.find(tab=>tab.id==='file:docs/guide.md');
  try{
    wb.open(id,host);const session=wb.current,waiting=hold();anchor.click();
    check(!document.querySelector('dialog[open]'),'读取文件信息期间不弹出选择框');
    waiting.resolve({...info});await until(()=>state()?.markdown);
    check(session.active==='file:docs/guide.md'&&state().markdown.textContent.includes('Complete content.'),'聊天文件链接直接打开工作台标签和完整正文');
    check(!document.querySelector('dialog[open]'),'文件打开后不出现打开方式选择框');
    check(reads.length===2&&reads[0].pathname.endsWith('/files/'+artifact.id)&&reads[0].searchParams.get('info')==='1'&&reads[1].pathname.endsWith('/workspace/preview')&&reads.every(url=>url.searchParams.get('host')===host),'元数据和预览保留原聊天的鉴权路由与 SSH 主机');
    const original=state();wb.select('chat');anchor.click();await until(()=>session.active===original.id);
    check(session.files.length===1&&state()===original&&reads.length===3,'再次点击复用原标签，不重复读取预览');
    let direct=false;const download=original.body.querySelector('.wb-download');
    const block=event=>{if(event.target!==download)return;direct=!event.defaultPrevented;event.preventDefault();};
    document.addEventListener('click',block,true);download.click();document.removeEventListener('click',block,true);
    check(direct&&reads.length===3,'文件栏的下载按钮继续交给下载流程');
    wb.select('chat');const side=document.createElement('div');side.className='wb-side-messages';side.append(message.cloneNode(true));chat.append(side);
    side.querySelector('a').click();await until(()=>session.active===original.id);side.remove();
    check(state()===original&&session.files.length===1,'侧边聊天的文件链接使用同一标签页入口');
    wb.select('chat');Object.assign(info,{kind:'directory',path:'docs',name:'docs'});anchor.click();
    await until(()=>session.files.find(tab=>tab.id==='files')?.list?.querySelector('.selected'));
    check(session.active==='files'&&!document.querySelector('dialog[open]'),'文件夹链接直接在文件标签中定位，不弹出选择框');
    Object.assign(info,{kind:'file',path:'docs/guide.md',name:'guide.md'});
    for(const provider of ['claude','deepseek']){
      wb.provider=provider;wb.open('client-file-links','local');
      anchor.href='/api/desktop-sessions/'+provider+'/workspace/download?sessionId=client-file-links&path=docs%2Fguide.md';
      anchor.click();await until(()=>state()?.markdown);
      const last=reads.slice(-2);
      check(last.every(url=>url.pathname.startsWith('/api/desktop-sessions/'+provider+'/workspace/')&&url.searchParams.get('sessionId')==='client-file-links'),'其他客户端文件链接保留原客户端与聊天：'+provider);
    }
    wb.provider=undefined;wb.open(id,host);wb.select('chat');anchor.href='/api/sessions/'+id+'/files/'+artifact.id+'?host='+encodeURIComponent(host);
    info.locatable=false;info.path=null;anchor.click();await until(()=>notices.length===1);
    check(!document.querySelector('dialog[open]')&&notices[0]===BridgeI18n.t('此文件位于聊天项目之外，无法在当前工作台中打开或定位。')&&session.active==='chat','项目外文件保留访问限制并提示原因');
    info.locatable=true;info.path='docs/guide.md';fail=true;anchor.click();await until(()=>notices.length===2);fail=false;
    check(notices[1]===BridgeI18n.t('Fixture file unavailable')&&!document.querySelector('dialog[open]'),'文件读取失败直接提示，不弹出选择框');
    const late=hold();anchor.click();wb.open('22222222-2222-4222-8222-222222222222',host);late.resolve({...info});await new Promise(resolve=>setTimeout(resolve,40));
    check(wb.current.active==='chat'&&wb.current.files.length===0&&notices.length===2,'切换聊天后旧文件信息不会打开标签或提示');
    wb.open(id,host);const lateError=hold();anchor.click();wb.reset();lateError.reject(Error('late failure'));await new Promise(resolve=>setTimeout(resolve,40));
    check(wb.sessions.size===0&&notices.length===2&&!document.querySelector('dialog[open]'),'退出后丢弃旧读取错误');
    return {passed:checks.length,checks};
  }finally{wb.reset();wb.resizeObserver.disconnect();wb.mobileObserver.disconnect();chat.remove();}
}
