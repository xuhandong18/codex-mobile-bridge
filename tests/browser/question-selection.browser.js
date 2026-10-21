// Production question cards with synthetic requests only; never submits an answer.
async function runQuestionSelectionBrowserTests(provider='codex'){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const waitFor=async run=>{for(let i=0;i<120;i++){if(run())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Question selection fixture timed out');};
  const wb=provider==='codex'?workbench:desktopSessions.workbench,session=wb.current;
  const main=provider==='codex'?selectedTextAction:desktopSessions.selectionAction;
  const trigger=provider==='codex'?$('selection-button'):desktopSessions.selectionButton;
  const groups=()=>[...wb.mainPane.querySelectorAll('[data-answer-key]')];
  const select=node=>{document.activeElement?.blur();const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));};
  const prompt=group=>group.querySelector('legend')||group.firstChild;
  const choose=async(action,button,target,mouse=false)=>{
    await waitFor(()=>!button.disabled);check(!button.disabled,'选中的问题文字自动启用选区操作');
    if(mouse){
      const snapshot=action.capture(),node=snapshot.input||snapshot.range.startContainer.parentElement;
      node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse',button:2}));
      check(!node.dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:'mouse',button:2})),'电脑右键问题选区直接打开统一引用目标框');
    }else{button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch',isPrimary:true}));button.click();}
    await waitFor(()=>wb.selectionTargets.dialog?.open);
    wb.selectionTargets.dialog.querySelector('[data-quote-target="'+target+'"]').click();
  };
  await waitFor(()=>groups().length===2);wb.select('chat');
  select(prompt(groups()[0]));await waitFor(()=>!trigger.disabled);
  check(!trigger.disabled,'问题框中的题目文字可以使用选区操作');
  await choose(main,trigger,'chat',innerWidth>=1200);
  check(wb.fileQuotes.input.value.includes('> 希望先解释哪个处理方案？'),'题目文字引用到主聊天草稿');
  const mainDraft=wb.fileQuotes.input.value;
  wb.sideChat('',true);await waitFor(()=>session.files.some(tab=>tab.sideChat?.state?.connected&&!tab.sideChat.busy));
  const side=session.files.find(tab=>tab.sideChat),panel=side.sideChat;
  wb.select('chat');select(prompt(groups()[1]));await choose(main,trigger,side.id);
  check(panel.input.value.includes('> 需要进一步说明的细节是什么？')&&wb.fileQuotes.input.value===mainDraft,'问题文字可以引用到已有侧边聊天且保留主草稿');
  wb.select('chat');select(prompt(groups()[0]));await choose(main,trigger,'new-sidechat');
  const fresh=session.files.find(tab=>tab.sideChat&&tab!==side);
  await waitFor(()=>fresh?.sideChat.state?.connected&&!fresh.sideChat.busy);
  check(fresh.sideChat.input.value.includes('> 希望先解释哪个处理方案？')&&fresh.sideChat.landing.hidden,'问题文字可以直接新建侧边聊天并保留引用');
  wb.select('chat');
  const answer=groups()[1].querySelector('textarea,input');answer.value='保留前文，需要解释的回答，保留后文';answer.focus();answer.setSelectionRange(5,12);await waitFor(()=>!trigger.disabled);
  check(!trigger.disabled,'问题框中已填写的回答也能使用选区操作');
  const selectedAnswer=answer.value.slice(5,12);await choose(main,trigger,side.id);
  check(panel.input.value.includes('> '+selectedAnswer)&&answer.value==='保留前文，需要解释的回答，保留后文','只引用选中的回答片段并保留完整答案');
  if(provider==='deepseek'){
    wb.select('chat');const option=groups()[0].querySelector('.ds-answer-option');select(option);await choose(main,trigger,'chat');
    check(wb.fileQuotes.input.value.includes('先解释 — 说明各个步骤'),'问题选项及说明可以引用');
    check(!option.querySelector('input').checked,'引用选项文字不会选择或提交该选项');
  }
  wb.select('chat');select(prompt(groups()[0]));const hiddenMain=main.captureNative();wb.select(side.id);
  check(!main.activate('add',hiddenMain.token),'主聊天隐藏后不能消费其中的问题选区');
  wb.select(side.id);const sideGroup=panel.approvals.querySelector('[data-answer-key]');select(prompt(sideGroup));panel.selectionAction.update();main.update();
  check(!panel.selectionButton.disabled&&trigger.disabled,'侧边问题文字只启用对应侧边聊天的选区操作');
  await choose(panel.selectionAction,panel.selectionButton,'chat');
  check(wb.fileQuotes.input.value.includes('> 希望先解释哪个处理方案？'),'侧边问题文字可以引用回主聊天');
  wb.select(side.id);const sideAnswer=panel.approvals.querySelectorAll('[data-answer-key]')[1].querySelector('textarea');
  sideAnswer.value='侧边问题的回答片段';sideAnswer.focus();sideAnswer.setSelectionRange(0,4);panel.selectionAction.update();
  const captureNative=()=>provider==='codex'?BridgeSelection.capture():panel.selectionAction.captureNative();
  const runNative=token=>provider==='codex'?BridgeSelection.run('add',token):panel.selectionAction.activate('add',token);
  const native=captureNative();check(native.add,'原生选区入口识别问题回答片段');
  sideAnswer.setSelectionRange(0,0);sideAnswer.blur();getSelection().removeAllRanges();
  check(runNative(native.token),'原生菜单清除选区后仍可消费已捕获的回答片段');
  await waitFor(()=>wb.selectionTargets.dialog?.open);wb.selectionTargets.dialog.querySelector('[data-quote-target="'+fresh.id+'"]').click();
  check(fresh.sideChat.input.value.includes('> 侧边问题'),'侧边回答片段可以引用到另一侧边聊天');
  wb.select(side.id);sideAnswer.focus();sideAnswer.setSelectionRange(0,4);const stale=captureNative();sideAnswer.value='已经修改的回答';
  check(!runNative(stale.token),'回答被修改后拒绝旧的选区凭证');
  sideAnswer.blur();getSelection().removeAllRanges();panel.input.focus();panel.input.setSelectionRange(0,4);panel.selectionAction.update();
  check(panel.selectionButton.disabled,'普通聊天输入区不会被误当作问题选区');
  panel.input.blur();getSelection().removeAllRanges();select(prompt(sideGroup));const removed=panel.selectionAction.captureNative();sideGroup.remove();
  check(!panel.selectionAction.activate('add',removed.token),'问题卡片移除后不能引用旧选区');
  return checks;
}
