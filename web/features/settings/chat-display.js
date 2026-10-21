'use strict';

class ChatDisplaySync {
  constructor({request,onChange,legacy={}}){Object.assign(this,{request,onChange,legacy});this.generation=0;}
  accept(value){
    if(!value||!Number.isSafeInteger(value.revision)||value.revision<0||!value.settings||typeof value.settings!=='object')return false;
    const settings={};for(const key of ['showReasoning','showProcess'])if(typeof value.settings[key]==='boolean')settings[key]=value.settings[key];
    if(this.snapshot&&value.revision<this.snapshot.revision)return false;
    this.snapshot={revision:value.revision,settings};this.onChange(settings);return true;
  }
  refresh(){
    if(this.pending)return this.pending;
    const generation=this.generation;
    const read=async()=>{
      const value=await this.request('/api/chat-display');if(generation!==this.generation)return;
      if(!this.accept(value))return;
      if(!this.imported){
        this.imported=true;const changes={};
        for(const key of ['showReasoning','showProcess'])if(this.legacy?.[key]===false&&!(key in this.snapshot.settings))changes[key]=false;
        if(Object.keys(changes).length)await this.save(changes);
      }
    };
    const pending=read().finally(()=>{if(this.pending===pending)this.pending=null;});
    this.pending=pending;return pending;
  }
  async save(changes){
    const generation=this.generation;
    if(!this.snapshot)throw Error('对话显示设置尚未读取，请稍后重试。');
    try{
      const value=await this.request('/api/chat-display',{revision:this.snapshot.revision,changes});
      if(generation===this.generation)this.accept(value);
    }catch(error){
      // An unknown write result is read back, never automatically submitted again.
      let confirmed=false;
      try{const value=await this.request('/api/chat-display');if(generation===this.generation){this.accept(value);confirmed=Object.entries(changes).every(([key,value])=>this.snapshot?.settings[key]===value);}}catch{}
      if(!confirmed&&generation===this.generation)throw error;
    }
  }
  reset(){this.generation++;this.snapshot=null;this.pending=null;this.imported=false;}
}
if(typeof module!=='undefined')module.exports={ChatDisplaySync};
