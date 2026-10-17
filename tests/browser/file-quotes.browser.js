// Run on the isolated file-quote fixture, never on a user's real session.
async function runFileQuoteBrowserTests(gesture='mouse'){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const waitFor=async test=>{for(let i=0;i<120;i++){if(test())return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('File quote fixture timed out');};
  const wb=workbench,first=currentId,quoteText='const value = "<literal>";\n'+Array.from({length:50},(_,i)=>'  selected line '+i).join('\n');
  const preview=async()=>{await wb.preview(wb.current,{name:'demo.js',path:'src/demo.js'});};
  const select=()=>{const code=wb.panel.querySelector('.wb-source-code code'),range=document.createRange();range.selectNodeContents(code);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return code;};
  const menu=async()=>{
    const code=select();
    if(gesture==='touch'){
      await new Promise(resolve=>setTimeout(resolve,200));const button=wb.current.files.find(tab=>tab.filePath==='src/demo.js').quoteButton;
      check(!button.disabled,'The file header offers an explicit selection quote action');button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerType:'touch',isPrimary:true,pointerId:51}));button.click();return;
    }else code.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:80,clientY:120}));
    await waitFor(()=>!!wb.fileSelection.menu.menu?.open);
    check(wb.fileSelection.menu.menu.textContent.includes('引用到聊天'),'Selection exposes a file quote action');
    wb.fileSelection.menu.menu.querySelector('button').click();
  };
  const chooseMain=async()=>{await waitFor(()=>!!document.querySelector('.file-quote-target[open]'));document.querySelector('.file-quote-target[open] [data-quote-target=chat]').click();};
  $('message').value='已有草稿';$('message').oninput();await preview();await menu();await chooseMain();
  await waitFor(()=>wb.fileQuotes.rows.length===1);
  check(!document.querySelector('.file-quote-target[open]'),'Choosing the main draft closes the unified target picker');
  check($('message').value==='已有草稿','Adding a file excerpt preserves editable draft text');
  check(wb.fileQuotes.rows[0].path==='D:\\fixture\\project\\src\\demo.js','The excerpt uses the full native file path');
  check(wb.fileQuotes.rows[0].text===quoteText,'The source selection excludes line numbers and preserves whitespace');
  const chip=wb.fileQuotes.root.querySelector('button');check(chip.textContent.includes('demo.js')&&chip.textContent.length<40,'A long excerpt occupies a compact file tag');
  chip.click();const detail=wb.fileQuotes.dialog,rect=detail.getBoundingClientRect();
  check(detail.querySelector('pre').textContent===quoteText,'Clicking the tag reveals the complete literal selected text');
  check(rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,'The detail dialog fits the current viewport');
  check(detail.scrollHeight<=detail.clientHeight+1,'The detail text scrolls inside the dialog');
  detail.querySelector('.file-quote-remove').click();check(wb.fileQuotes.rows.length===0&&$('message').value==='已有草稿','Deleting a tag removes only its excerpt');
  await preview();await menu();await chooseMain();await waitFor(()=>wb.fileQuotes.rows.length===1);
  const oldKey=wb.fileQuotes.key;await openChat('22222222-2222-4222-8222-222222222222');await waitFor(()=>state?.connected);
  check(wb.fileQuotes.rows.length===0,'A different conversation has no excerpts from the first chat');
  await openChat(first);await waitFor(()=>state?.connected);check(wb.fileQuotes.key===oldKey&&wb.fileQuotes.rows.length===1,'Returning to the first chat restores its excerpt');
  wb.sideChat();const side=wb.current.files.find(tab=>tab.sideChat).sideChat;await waitFor(()=>side.state?.id);
  await preview();await menu();await waitFor(()=>!!document.querySelector('.file-quote-target[open]'));
  let target=document.querySelector('.file-quote-target[open]');check(target.querySelectorAll('[data-quote-target]').length===3,'The target picker offers main, existing side and new side drafts');
  target.querySelector('[data-quote-target="sidechat"]').click();await waitFor(()=>side.fileQuotes.rows.length===1);
  check(wb.fileQuotes.rows.length===1&&side.input.value==='','Choosing the side composer keeps its excerpt separate from the main draft');
  side.fileQuotes.root.querySelector('button').click();side.fileQuotes.dialog.querySelector('.file-quote-remove').click();
  check(side.fileQuotes.rows.length===0&&wb.fileQuotes.rows.length===1,'Deleting a side excerpt leaves the main excerpt intact');
  await preview();await menu();await waitFor(()=>!!document.querySelector('.file-quote-target[open]'));
  target=document.querySelector('.file-quote-target[open]');target.querySelector('[data-quote-target="sidechat"]').click();await waitFor(()=>side.fileQuotes.rows.length===1);
  await side.send();check(side.fileQuotes.rows.length===0,'Accepted side submission clears its excerpt');
  wb.select('chat');$('message').value='';await $('composer').onsubmit({preventDefault(){}});
  check(wb.fileQuotes.rows.length===0,'A quote-only main submission clears after acceptance');
  await openChat(first);await waitFor(()=>state?.connected);check(!$('message').value&&!wb.fileQuotes.rows.length,'Accepted content does not reappear when the chat is reopened');
  return {checks,text:quoteText};
}
