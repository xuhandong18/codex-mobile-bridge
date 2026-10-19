'use strict';
// The driver supplies only synthetic APIs and executes trusted touch gestures separately.
window.prepareWorkbenchSwipeChecks=async provider=>{
  const wb=window.swipeWorkbench=provider==='codex'?workbench:desktopSessions.workbench;
  const session=wb.current;
  const first=wb.createSideChat(session);
  wb.git();wb.agents();
  const second=wb.createSideChat(session,'00000000-0000-4000-8000-000000000002');
  await wb.preview(session,{name:'fixture.txt',path:'fixture.txt'});
  const third=wb.createSideChat(session,'00000000-0000-4000-8000-000000000003');
  // A terminal stand-in avoids starting a process; its exclusion uses the real tab order and DOM.
  const terminal={id:'terminal:fixture',name:'终端',body:wb.node('div','wb-terminal')};
  terminal.body.append(wb.node('textarea'));session.files.push(terminal);
  const fourth=wb.createSideChat(session,'00000000-0000-4000-8000-000000000004');
  for(const tab of [first,second,third,fourth]){
    await tab.sideChat.load();tab.sideChat.input.value='保留草稿 '+tab.id;tab.sideChat.input.oninput();
  }
  const main=wb.mainPane.querySelector('.composer textarea');main.value='主会话草稿';main.dispatchEvent(new Event('input',{bubbles:true}));
  wb.select('chat');
  return {first:first.id,second:second.id,third:third.id,fourth:fourth.id,file:'file:fixture.txt',terminal:terminal.id};
};

window.runWorkbenchSwipeEdgeChecks=()=>{
  const wb=swipeWorkbench,session=wb.current,checks=[];
  const check=(label,ok)=>{if(!ok)throw Error(label);checks.push(label);};
  const touch=(target,type,points,changed=points)=>{
    const make=point=>new Touch({identifier:point.id??1,target,clientX:point.x,clientY:point.y});
    const event=new TouchEvent(type,{bubbles:true,cancelable:true,touches:points.map(make),changedTouches:changed.map(make)});
    target.dispatchEvent(event);return event;
  };
  const start=target=>touch(target,'touchstart',[{x:220,y:80}]);
  const end=target=>touch(target,'touchend',[],[{x:100,y:80}]);
  const swipe=target=>{start(target);touch(target,'touchmove',[{x:100,y:80}]);end(target);};
  const form=wb.mainPane.querySelector('.composer'),input=form.querySelector('textarea');
  const reset=()=>{window.getSelection().removeAllRanges();input.blur();wb.select('chat');};
  reset();start(input);touch(input,'touchmove',[{x:217,y:110}]);end(input);
  check('纵向滚动不切换',session.active==='chat');
  start(input);touch(input,'touchmove',[{x:100,y:80},{id:2,x:200,y:100}]);end(input);
  check('多指滑动不切换',session.active==='chat');
  start(input);touch(input,'touchcancel',[]);end(input);
  check('取消手势不切换',session.active==='chat');
  start(input);touch(input,'touchend',[],[{x:195,y:80}]);
  check('轻点和短距离移动不切换',session.active==='chat');
  start(input);touch(input,'touchend',[],[{x:100,y:200}]);
  check('斜向拖动不切换',session.active==='chat');
  input.focus();input.setSelectionRange(0,3);swipe(input);
  check('输入框选字时不切换',session.active==='chat');reset();
  const dialog=document.createElement('dialog');document.body.append(dialog);dialog.showModal();swipe(input);
  check('弹窗打开时不切换',session.active==='chat');dialog.close();dialog.remove();
  swipe(wb.mainPane.querySelector('.timeline'));
  check('主聊天消息区域不切换',session.active==='chat');
  const side=session.files.find(tab=>tab.sideChat);wb.select(side.id);swipe(side.sideChat.messages);
  check('侧边聊天消息区域不切换',session.active===side.id);
  reset();start(input);wb.select('git');end(input);
  check('手势期间换标签后不再切换',session.active==='git');
  reset();start(input);const previous=wb.current;wb.current={...session,files:[]};end(input);
  check('手势期间换聊天后旧手势失效',wb.current.active==='chat');wb.current=previous;reset();
  wb.select('git');const git=session.files.find(tab=>tab.id==='git');
  const scroll=wb.node('pre','swipe-scroll','x'.repeat(400));scroll.style.cssText='overflow-x:auto;max-width:100%;white-space:pre';git.body.append(scroll);
  const editor=wb.node('textarea','swipe-editor');git.body.append(editor);swipe(scroll);
  check('Git 横向滚动区域保留原操作',session.active==='git'&&scroll.scrollWidth>scroll.clientWidth);
  swipe(wb.panel.querySelector('.swipe-editor'));
  check('Git 文本编辑不切换',session.active==='git');
  const range=document.createRange();range.selectNodeContents(wb.panel.querySelector('.wb-git-heading'));window.getSelection().addRange(range);swipe(wb.panel.firstElementChild);
  check('Git 选中文字时不切换',session.active==='git');window.getSelection().removeAllRanges();
  // A recognised swipe must not turn into a click on Send, a Git action, or an agent card.
  reset();let clicks=0;const button=form.querySelector('button[type=submit]');
  const onClick=()=>clicks++;button.addEventListener('click',onClick);swipe(button);
  const click=new MouseEvent('click',{bubbles:true,cancelable:true});button.dispatchEvent(click);button.removeEventListener('click',onClick);
  check('横滑后的点击被拦截，不触发发送',click.defaultPrevented&&clicks===0);
  check('切换保留主会话草稿',input.value==='主会话草稿');
  check('切换保留所有侧边草稿',session.files.filter(tab=>tab.sideChat).every(tab=>tab.sideChat.input.value==='保留草稿 '+tab.id));
  scroll.remove();editor.remove();reset();return checks;
};
