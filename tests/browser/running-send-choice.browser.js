// Isolated fixture only. The driver verifies actual send-request counts.
function checkRunningSendChoiceBrowserState(phase,text){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const dialog=document.getElementById('running-send-dialog');
  if(phase==='open'){
    check(dialog?.open&&dialog.matches(':modal'),'Running Send opens a real modal choice');
    check(dialog.querySelectorAll('[data-send-mode]').length===2,'The popup offers queue and steer explicitly');
    check(document.activeElement?.textContent===BridgeI18n.t('取消'),'Cancel receives focus; Enter cannot silently select a send mode');
    const box=dialog.getBoundingClientRect();
    check(box.left>=0&&box.right<=innerWidth+1&&dialog.scrollWidth<=dialog.clientWidth+1,'The popup fits the viewport without horizontal scrolling');
    check(document.getElementById('message').value===text,'Opening the choice preserves the message draft');
  }else{
    check(!dialog,'Closing or choosing removes the modal');
    check(document.getElementById('message').value===text,phase==='sent'?'Only an accepted submission clears the message':'Cancellation preserves the message draft');
  }
  return checks;
}
