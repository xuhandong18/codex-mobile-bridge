// Loaded by Harness's native client-module system, alongside the existing Host plugin.
window.__ModuleLoader__.load({id:'codex-mobile-desktop',factory:function(){
  return {inject:['uiSession','sessions','remote'],apply(ctx){
    const markers=new Map(),ui=ctx.uiSession;
    const stamp=value=>typeof value==='number'&&Number.isFinite(value)?value:Date.parse(value);
    const flush=()=>{
      let changed=false;const rows=ctx.sessions.list.getSnapshot().byId;
      for(const [id,marker] of markers){
        const row=rows[id];if(!row)continue;
        const current=stamp(row.updatedAt),seen=stamp(marker.updatedAt);
        if(!Number.isFinite(current)||!Number.isFinite(seen))continue;
        if(current>seen){markers.delete(id);continue;}
        if(row.running||ui.running.get(id))continue;
        if(ui.completionUnread.delete(id))changed=true;
      }
      if(changed)ui.publishStatus();
    };
    ctx.effect(()=>{
      const dispose=ctx.remote.$on('codex-mobile/read-state',marker=>{
        if(typeof marker?.sessionId!=='string'||!['completed','failed','interrupted'].includes(marker.turnStatus)||!Number.isFinite(stamp(marker.updatedAt)))return;
        markers.set(marker.sessionId,marker);if(markers.size>512)markers.delete(markers.keys().next().value);flush();
      });
      const status=ui.sessionStatus.subscribe(flush),list=ctx.sessions.list.subscribe(flush);
      return ()=>{dispose();status();list();markers.clear();};
    });
  }};
}});
