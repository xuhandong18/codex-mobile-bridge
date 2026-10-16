// Call after the isolated fixture's five-second activity poll reflects phase.
function checkSubagentActivityBrowserPhase(phase,id){
  const checks=[],check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
  const button=[...document.querySelectorAll('#sessions .session')].find(node=>node.dataset.id===id);
  const indicator=button?.querySelector('.session-indicator');
  if(['two','one','parent-offline'].includes(phase)){
    check(indicator?.classList.contains('running'),'Running descendants keep the parent sidebar indicator active: '+phase);
    check(indicator?.title==='子代理运行中','The parent tooltip identifies subagent activity: '+phase);
    check(document.getElementById('status').textContent==='子代理运行中','An idle parent heading reflects its running descendants: '+phase);
    check(!button.querySelector('.session-indicator.completed'),'A finished parent turn cannot show completion before its agents finish: '+phase);
  }else if(phase==='unknown'){
    check(indicator?.classList.contains('unknown'),'Missing child state displays unknown rather than completed');
    check(document.getElementById('status').textContent==='运行状态暂不可用','The conversation heading exposes the unavailable activity state');
  }else{
    check(indicator?.classList.contains('completed'),'Completion appears after the final descendant finishes');
    check(!button.querySelector('.session-indicator.running'),'The running indicator clears when the whole subtree is idle');
  }
  return checks;
}
