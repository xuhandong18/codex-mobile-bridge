// Synthetic chat and file-preview fixture only. Touch events emulate selection timing.
async function runSelectionGestureBrowserTests(){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const chooseRange=(node,partial=false)=>{const range=document.createRange();range.selectNodeContents(node);if(partial){const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT),text=walker.nextNode();range.setEnd(text,Math.min(5,text.length));}getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));return range;};
  const rectFor=node=>{const range=document.createRange();range.selectNodeContents(node);return [...range.getClientRects()].find(rect=>rect.width>0&&rect.height>0);};
  const pointer=(node,type,rect)=>node.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerType:'touch',isPrimary:true,pointerId:42,clientX:rect.left+2,clientY:rect.top+2}));
  const exercise=async(node,label,menu,action)=>{
    getSelection().removeAllRanges();const rect=rectFor(node);pointer(node,'pointerdown',rect);
    await wait(100);chooseRange(node,true);await wait(550);
    const native=pointer(node,'contextmenu',rect);
    check(!menu()?.open,label+': initial selection never opens the custom menu');
    check(native,label+': the first native selection menu remains available');
    check([...document.querySelectorAll('.selection-actions')].every(bar=>bar.hidden),label+': custom toolbars stay hidden while selecting');
    pointer(node,'pointerup',rect);const range=chooseRange(node),text=getSelection().toString();await wait(180);
    check(getSelection().toString()===text,label+': the selection can expand to all requested text');
    pointer(node,'pointerdown',rect);await wait(100);chooseRange(node,true);await wait(550);
    check(!menu()?.open,label+': changing the selection cancels a pending long press');pointer(node,'pointerup',rect);
    getSelection().removeAllRanges();getSelection().addRange(range);const full=getSelection().toString(),fullRect=[...range.getClientRects()].find(box=>box.width>0&&box.height>0);
    pointer(node,'pointerdown',fullRect);await wait(650);
    check(!menu()?.open,label+': repeated long presses never open a web menu');
    check(pointer(node,'contextmenu',fullRect),label+': the repeated native Copy/Share menu remains available');pointer(node,'pointerup',fullRect);
    check(node.dispatchEvent(new PointerEvent('contextmenu',{bubbles:true,cancelable:true,pointerType:'mouse',button:-1,clientX:fullRect.left+2,clientY:fullRect.top+2})),label+': Android selection-handle mouse events remain native');
    check(!menu()?.open,label+': adjusting a native handle cannot open a web dialog');
    const trigger=label==='File'?workbench.current.files.find(tab=>tab.filePath==='src/demo.js').quoteButton:$('selection-button');
    check(!trigger.disabled,label+': explicit selection action is available outside the selected text');
    trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch',isPrimary:true,pointerId:43}));trigger.click();
    await wait(80);
    check(!!document.querySelector('.file-quote-target[open]'),label+': an explicit add offers the unified target picker');
    document.querySelector('.file-quote-target[open] [data-quote-target=chat]').click();await wait(80);
    return full;
  };
  await workbench.preview(workbench.current,{name:'demo.js',path:'src/demo.js'});
  const code=workbench.panel.querySelector('.wb-source-code code');
  const fileText=await exercise(code,'File',()=>document.querySelector('.file-quote-target[open]'),'引用到聊天');
  check(workbench.fileQuotes.rows.length===1,'An older gateway can add a file excerpt');
  check(workbench.fileQuotes.rows[0].path==='D:/fixture/project/src/demo.js','The current chat directory supplies the missing absolute root');
  check(workbench.fileQuotes.rows[0].text===fileText,'The file tag retains the fully expanded selection');
  const body=document.createElement('div');body.className='message-body';body.textContent='A complete chat reply with several selectable words.\nThe final line must also be quoted.';$('messages').append(body);
  $('message').value='Original draft';const messageText=await exercise(body,'Message',()=>[...document.querySelectorAll('.chat-context-menu[open]')].at(-1),'添加到会话');
  check($('message').value.includes(messageText.split('\n').map(line=>'> '+line).join('\n')),'Chat actions add the complete selected reply');
  check($('message').value.startsWith('Original draft'),'Chat quoting preserves existing draft text');
  const activity=document.createElement('pre');activity.className='activity-body';activity.textContent='Public tool output\nwith a selectable continuation.';$('messages').append(activity);
  const activityText=await exercise(activity,'Activity',()=>[...document.querySelectorAll('.chat-context-menu[open]')].at(-1),'添加到会话');
  check($('message').value.includes(activityText.split('\n').map(line=>'> '+line).join('\n')),'Activity actions quote the fully selected output');
  body.remove();activity.remove();return {checks};
}
