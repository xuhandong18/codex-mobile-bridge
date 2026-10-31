// Actual question prompts, Markdown renderer and file-tab click handling; synthetic files only.
async function runQuestionFileLinkBrowserTests(provider='codex'){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const until=async run=>{for(let i=0;i<150;i++){if(run())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Question file link fixture timed out');};
  const wb=provider==='codex'?workbench:desktopSessions.workbench,session=wb.current;
  const main=provider==='codex'?$('approvals'):desktopSessions.requests;
  const mainLinks=[...main.querySelectorAll('[data-answer-key] a')];
  check(mainLinks.length===2,'主聊天问题中的 Windows 文件引用显示为两个可点击链接');
  check(mainLinks[0].textContent==='设计评审稿'&&mainLinks[1].textContent==='交互原型','问题显示链接标题，不显示 Markdown 标记和磁盘路径');
  const draft=main.querySelector('textarea,input');draft.value='保留尚未提交的回答';
  const option=main.querySelector('select,input[type=radio]'),choice=option.value;
  for(const [index,path] of ['spec.md','prototype.html'].entries()){
    wb.select('chat');mainLinks[index].click();
    await until(()=>session.files.some(tab=>tab.id==='file:'+path&&!tab.loading&&tab.previewContent));
    const tab=session.files.find(tab=>tab.id==='file:'+path);
    check(session.active===tab.id,'点击问题链接打开对应文件标签：'+path);
    check(path.endsWith('.md')?tab.markdown?.textContent.includes('Question file preview'):!!tab.html,'文件进入 Markdown 或 HTML 预览：'+path);
    wb.select('chat');mainLinks[index].click();await until(()=>session.active===tab.id);
    check(session.files.filter(item=>item.id===tab.id).length===1,'再次点击问题链接复用原文件标签：'+path);
  }
  wb.select('chat');
  check(draft.value==='保留尚未提交的回答'&&option.value===choice,'打开文件保留问题答案和选项');
  check(!main.textContent.includes('[设计评审稿]('),'题目正文使用 Markdown 渲染');
  const existing=new Set(session.files);
  wb.sideChat('',true);
  await until(()=>session.files.some(tab=>!existing.has(tab)&&tab.sideChat?.state?.connected&&!tab.sideChat.busy));
  const side=session.files.find(tab=>!existing.has(tab)&&tab.sideChat),panel=side.sideChat;
  wb.select(side.id);await until(()=>panel.approvals.querySelectorAll('[data-answer-key] a').length===2);
  const sideDraft=panel.approvals.querySelector('textarea');sideDraft.value='侧边答案草稿';
  panel.approvals.querySelector('a').click();await until(()=>session.active==='file:spec.md');
  check(session.files.filter(tab=>tab.id==='file:spec.md').length===1,'侧边问题链接打开并复用同一文件标签');
  wb.select(side.id);check(sideDraft.value==='侧边答案草稿','打开侧边问题链接后保留答案草稿');
  wb.select('chat');return checks;
}
