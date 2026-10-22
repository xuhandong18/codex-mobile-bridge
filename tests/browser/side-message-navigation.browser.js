// Production side-chat rendering and navigation with synthetic history only.
async function runSideMessageNavigationBrowserTests(provider='codex'){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const wb=provider==='codex'?workbench:desktopSessions.workbench,session=wb.current;
  const tab=session.files.find(tab=>tab.id===session.active),panel=tab.sideChat;
  clearTimeout(panel.timer);
  const base={...panel.state,requests:[],submissions:[],status:'idle'},mainInput=wb.fileQuotes.input,mainDraft=mainInput.value;
  const turns=(count,prefix='侧边提问')=>Array.from({length:count},(_,i)=>({turnId:'navigation-'+i,messages:[
    ...(i===0?[{id:'context',role:'user',isUserContext:true,text:'合成上下文，不应出现在导航中'}]:[]),
    {id:'question-'+i,role:'user',text:i===2?'':i===3||i===4?'重复的问题':prefix+' '+i+'\n补充说明',...(i===2?{attachments:[{name:'导航截图.png'}]}:{})},
    {id:'answer-'+i,role:'assistant',phase:'final_answer',text:('第 '+i+' 条回答的内容。').repeat(35)}]}));
  panel.apply({...base,turns:turns(5)});await frame();
  const map=panel.messageMap;
  check(map instanceof ChatMessageMap&&!map.root.hidden,'侧边聊天复用主聊天缩略导航并显示横线');
  check(map.entries.length===5&&map.entries.every(row=>!row.summary.includes('合成上下文')),'导航仅列出本侧边聊天的五次真实发言');
  check(map.entries[2].summary==='导航截图.png','仅有附件的发言使用附件名称作为摘要');
  check(map.entries[3].rowKey!==map.entries[4].rowKey&&map.entries[3].summary===map.entries[4].summary,'内容相同的独立发言保留各自的导航项');
  const originalScroll=panel.messages.scrollTop;
  map.rail.querySelector('button').click();await frame();
  check(map.root.classList.contains('is-open')&&panel.messages.scrollTop===originalScroll,'点击横线只展开摘要列表，不直接跳转');
  const popup=map.panel.getBoundingClientRect(),viewport=panel.messages.getBoundingClientRect(),rail=map.rail.getBoundingClientRect();
  check(Math.abs(popup.top+popup.height/2-viewport.top-viewport.height/2)<2&&popup.right<=rail.left,'导航弹窗位于侧边消息区右侧居中且不遮挡横线');
  const selected=map.entries[1];map.list.querySelectorAll('button')[1].click();await frame();
  const target=()=>panel.messageNodes.find(row=>row.key===selected.rowKey).node;
  const offset=()=>target().getBoundingClientRect().top-panel.messages.getBoundingClientRect().top;
  check(!panel.following&&!map.root.classList.contains('is-open')&&Math.abs(offset()-12)<2,'点击摘要定位对应发言并关闭导航');
  const beforeOffset=offset(),streamed=turns(5);streamed[0].messages.at(-1).text+='较早的回答继续增长。'.repeat(40);
  panel.apply({...base,turns:streamed});await frame();
  check(!panel.following&&Math.abs(offset()-beforeOffset)<2,'新回复及前文高度变化保留阅读位置');
  check(!panel.latestButton.hidden,'查看旧记录时可以主动返回最新内容');
  panel.messages.scrollTop=panel.messages.scrollHeight;panel.messages.dispatchEvent(new Event('scroll'));await frame();
  check(panel.following&&panel.latestButton.hidden,'手动滚到末尾也能恢复跟随回复');
  map.open();map.list.querySelectorAll('button')[1].click();await frame();
  panel.latestButton.click();await frame();
  check(panel.following&&panel.latestButton.hidden&&panel.messages.scrollHeight-panel.messages.clientHeight-panel.messages.scrollTop<2,'返回最新后恢复跟随回复');
  panel.apply({...base,turns:turns(1)});await frame();
  check(map.entries.length===1&&!map.root.hidden,'只有一条发言也有可点击的缩略导航');
  map.rail.querySelector('button').click();map.root.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  check(!map.root.classList.contains('is-open'),'Escape 可以收起侧边导航弹窗');
  map.rail.querySelector('button').click();panel.input.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'touch'}));
  check(!map.root.classList.contains('is-open'),'点击输入区可以收起侧边导航弹窗');
  panel.apply({...base,turns:turns(160)});await frame();map.open();
  check(map.entries.length===160&&map.list.querySelectorAll('button').length<60,'长侧边聊天的导航列表使用虚拟渲染');
  map.list.scrollTop=100000;map.list.dispatchEvent(new Event('scroll'));
  const last=map.list.querySelector('button:last-of-type');last.click();await frame();
  check(!panel.following&&panel.messages.scrollTop>0,'滚动导航可以定位长聊天末尾的发言');
  if(wb.canSplit()){
    if(provider==='codex'){
      chatTimeline.apply({epoch:chatTimeline.epoch,sequence:chatTimeline.sequence+1,rows:[{key:'navigation-main',role:'user',order:0,version:'v1',text:'独立的主聊天发言'}],files:[],hasMore:false,meta:state});
    }
    wb.split(tab.id);await frame();map.position();
    const area=panel.messages.getBoundingClientRect(),sideRail=map.rail.getBoundingClientRect();
    check(wb.splitMode&&sideRail.left>=area.left&&sideRail.right<=area.right,'分屏时导航跟随侧边消息区定位');
    if(provider==='codex')check(!chatTimeline.messageMap.root.hidden&&chatTimeline.messageMap!==map&&chatTimeline.messageMap.entries.every(row=>row.summary!=='侧边提问 0'),'主聊天与侧边聊天各自显示独立导航');
    wb.unsplit();await frame();
  }
  const other=session.files.find(row=>row.sideChat&&row!==tab),otherPanel=other.sideChat;clearTimeout(otherPanel.timer);
  wb.select(other.id);otherPanel.apply({...otherPanel.state,turns:turns(1,'另一侧边聊天'),requests:[]});await frame();
  check(!map.root.isConnected&&!otherPanel.messageMap.root.hidden&&otherPanel.messageMap.entries[0].summary.startsWith('另一侧边聊天'),'切换标签只显示当前侧边聊天的导航');
  wb.select(tab.id);await frame();check(map.root.isConnected&&map.entries.length===160,'切回原标签保留其独立导航目录');
  panel.apply({...base,id:'replacement-child',turns:turns(1)});await frame();
  check(panel.state.id===base.id&&panel.state.expired&&!panel.state.connected&&map.entries.length===160,'服务端聊天身份变化后保留原聊天导航和记录，旧标签变为只读');
  check(mainInput.value===mainDraft,'浏览侧边历史保留主聊天草稿');
  panel.dispose();check(!map.root.isConnected&&map.abort.signal.aborted,'关闭侧边视图释放导航节点及监听');
  return checks;
}
