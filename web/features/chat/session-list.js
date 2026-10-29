'use strict';

function sidebarSections(metadata,translate){
  const custom=metadata.sections||[],order=metadata.sectionOrder||[];
  const sections=[{id:'pinned',name:translate('置顶')},...custom,{id:'projects',name:translate('项目')},{id:'threads',name:translate('聊天')}];
  const rank=section=>{const index=order.indexOf(custom.includes(section)?'custom:'+section.id:section.id);return index<0?order.length:index;};
  return sections.sort((a,b)=>rank(a)-rank(b));
}

// Display preferences; production uses SidebarPreferences.storage below.
class SidebarItemOrder {
  constructor(storage=localStorage,prefix='sidebar-item-order:'){this.storage=storage;this.prefix=prefix;}
  read(project){
    try{const ids=JSON.parse(this.storage.getItem(this.prefix+project)||'[]');return Array.isArray(ids)?[...new Set(ids.filter(id=>typeof id==='string'))]:[];}catch{return [];}
  }
  sort(project,ids){
    const saved=this.read(project),known=new Set(saved),visible=new Set(ids);
    return [...ids.filter(id=>!known.has(id)),...saved.filter(id=>visible.has(id))];
  }
  move(project,ids,id,before){
    if(!ids.includes(id)||before!==null&&!ids.includes(before)||id===before)return false;
    const order=ids.filter(value=>value!==id),index=before===null?order.length:order.indexOf(before);
    order.splice(index,0,id);
    if(order.every((value,index)=>value===ids[index]))return false;
    const saved=this.read(project),visible=new Set(ids),known=new Set(saved);
    const combined=[...ids.filter(value=>!known.has(value)),...saved];let next=0;
    const result=combined.map(value=>visible.has(value)?order[next++]:value);
    this.storage.setItem(this.prefix+project,JSON.stringify(result.slice(0,2000)));
    return true;
  }
}

// Project pins leave the original desktop project and thread unchanged.
class SidebarProjectPins {
  constructor(storage=localStorage,key='sidebar-project-pins'){this.storage=storage;this.key=key;}
  entries(){
    try{
      const value=JSON.parse(this.storage.getItem(this.key)||'[]');
      return Array.isArray(value)?value.filter(row=>Array.isArray(row)&&row.length===2&&row.every(value=>typeof value==='string'&&value.length>0)):[];
    }catch{return [];}
  }
  read(project){return new Set(this.entries().filter(row=>row[0]===project).map(row=>row[1]));}
  toggle(project,id){
    const rows=this.entries(),pinned=rows.some(row=>row[0]===project&&row[1]===id);
    this.storage.setItem(this.key,JSON.stringify(pinned?rows.filter(row=>row[0]!==project||row[1]!==id):[...rows,[project,id]]));
  }
}

class SidebarPlacements {
  constructor(storage=localStorage,prefix='sidebar-placement:'){this.storage=storage;this.prefix=prefix;}
  key(item){
    if(!['project','thread'].includes(item.kind)||typeof item.host!=='string'||!item.host||typeof item.id!=='string'||!item.id)throw Error('无效的侧栏条目');
    return this.prefix+JSON.stringify([item.kind,item.host,item.id]);
  }
  valid(target,sections){return target==='home'||target==='pinned'||typeof target==='string'&&target.startsWith('section:')&&sections.includes(target.slice(8));}
  read(item){
    try{const value=JSON.parse(this.storage.getItem(this.key(item))||'null');return value&&typeof value==='object'&&!Array.isArray(value)?value:null;}catch{return null;}
  }
  resolve(item,sections,native='home'){
    const target=this.read(item)?.target;
    return this.valid(target,sections)?target:this.valid(native,sections)?native:'home';
  }
  set(item,target,sections,native='home'){
    const key=this.key(item);
    if(target==='native'){this.storage.removeItem(key);return;}
    if(!this.valid(target,sections))throw Error('分区已变化，请重新选择。');
    const current=this.resolve(item,sections,native),prior=this.read(item);
    const previous=target==='pinned'?(current==='pinned'?prior?.previous||'home':current):undefined;
    this.storage.setItem(key,JSON.stringify({target,...(previous?{previous}:{})}));
  }
  pinTarget(item,sections,native='home'){
    const current=this.resolve(item,sections,native),previous=this.read(item)?.previous;
    return current==='pinned'&&previous!=='pinned'&&this.valid(previous,sections)?previous:current==='pinned'?'home':'pinned';
  }
  togglePin(item,sections,native='home'){
    this.set(item,this.pinTarget(item,sections,native),sections,native);
  }
}

// Keep the synchronous list readers while committing changes to the gateway.
// Local storage is read only for a one-time import, never as shared authority.
class SidebarPreferences {
  constructor({request,legacyStorage=localStorage,prefix,onChange=()=>{}}){
    Object.assign(this,{request,legacyStorage,prefix,onChange});
    this.keys={pins:prefix+'|project-pins',order:prefix+'|section-project-order:',placement:prefix+'|sidebar-placement:'};
    this.marker=prefix+'|sidebar-preferences-imported-v1';
    this.generation=0;this.queue=Promise.resolve();this.reset();
    this.storage={getItem:key=>this._get(key),setItem:(key,value)=>this._stage(key,JSON.parse(value)),removeItem:key=>this._stage(key,null)};
  }
  reset(){this.generation++;this.fields={};this.cache=new Map();this.revision=-1;this.loading=null;this.imported=false;}
  _apply(snapshot,generation){
    if(generation!==this.generation)return;
    if(!snapshot||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!snapshot.fields||typeof snapshot.fields!=='object'||Array.isArray(snapshot.fields))throw Error('侧栏设置同步失败，请刷新后重试。');
    if(snapshot.revision<this.revision)return;
    const changed=snapshot.revision!==this.revision;
    this.fields=snapshot.fields;this.cache.clear();this.revision=snapshot.revision;
    if(changed)this.onChange();
  }
  _field(key){
    if(key.startsWith(this.keys.order))return JSON.stringify(['order',key.slice(this.keys.order.length)]);
    if(key.startsWith(this.keys.placement))return JSON.stringify(['placement',...JSON.parse(key.slice(this.keys.placement.length))]);
    throw Error('无效的侧栏设置');
  }
  _value(key){return this.staged?.has(key)?this.staged.get(key):this.fields[key]?.value;}
  _get(key){
    if(!this.staged&&this.cache.has(key))return this.cache.get(key);
    let result;
    if(key===this.keys.pins){
      const rows=[];
      for(const field of new Set([...Object.keys(this.fields),...(this.staged?.keys()||[])])){
        const parts=JSON.parse(field);
        if(parts[0]==='pin'&&this._value(field)===true)rows.push(parts.slice(1));
      }
      result=JSON.stringify(rows);
    }else result=JSON.stringify(this._value(this._field(key))??null);
    if(!this.staged)this.cache.set(key,result);
    return result;
  }
  _changes(key,value){
    if(key!==this.keys.pins)return [[this._field(key),value]];
    if(!Array.isArray(value)||value.some(row=>!Array.isArray(row)||row.length!==2||!row.every(part=>typeof part==='string'&&part)))throw Error('无效的项目内置顶');
    const desired=new Set(value.map(row=>JSON.stringify(['pin',...row]))),changes=[];
    const current=JSON.parse(this._get(this.keys.pins));
    for(const row of current){const field=JSON.stringify(['pin',...row]);if(!desired.has(field))changes.push([field,false]);}
    for(const field of desired)if(this._value(field)!==true)changes.push([field,true]);
    return changes;
  }
  _stage(key,value){
    if(!this.staged)throw Error('请等待侧栏设置同步后重试。');
    for(const [field,next] of this._changes(key,value))this.staged.set(field,next);
  }
  async refresh(){
    if(this.loading)return this.loading;
    const generation=this.generation;
    const loading=(async()=>{
      this._apply(await this.request('/api/sidebar-preferences'),generation);
      if(generation!==this.generation)return;
      if(!this.imported){this.imported=true;await this._import(generation);}
    })();
    this.loading=loading;
    try{await loading;}finally{if(this.loading===loading)this.loading=null;}
  }
  async receive(snapshot){
    const generation=this.generation;
    this._apply(snapshot,generation);
    if(!this.imported){this.imported=true;await this._import(generation);}
  }
  async _import(generation){
    const storage=this.legacyStorage,changes=new Map();
    try{
      if(storage.getItem(this.marker))return;
      const pins=new SidebarProjectPins(storage,this.keys.pins).entries();
      for(const row of pins)changes.set(JSON.stringify(['pin',...row]),true);
      for(let i=0;i<storage.length;i++){
        const key=storage.key(i);
        try{
          if(key?.startsWith(this.keys.order))changes.set(this._field(key),new SidebarItemOrder(storage,this.keys.order).read(key.slice(this.keys.order.length)));
          else if(key?.startsWith(this.keys.placement)){
            const value=JSON.parse(storage.getItem(key));
            if(value&&typeof value==='object'&&(['home','pinned'].includes(value.target)||typeof value.target==='string'&&value.target.startsWith('section:')))changes.set(this._field(key),value);
          }
        }catch{/* Ignore corrupt legacy entries, as the original readers did. */}
      }
      // Mark before dispatch. A lost import receipt must never replay a write.
      storage.setItem(this.marker,'1');
    }catch{return;}
    let missing=[...changes].filter(([key])=>!Object.hasOwn(this.fields,key)).map(([key,value])=>({key,value,version:0}));
    while(missing.length){
      if(generation!==this.generation)return;
      const batch=missing.slice(0,1000);
      try{this._apply(await this.request('/api/sidebar-preferences',{changes:batch}),generation);missing=missing.slice(batch.length);}
      catch(error){
        this._apply(await this.request('/api/sidebar-preferences'),generation);
        if(error.status!==409)throw Error('原设备侧栏设置的同步结果尚未确认，请刷新核对。');
        // A 409 confirms the entire batch was rejected. Import only keys that
        // still do not exist; never replace the other device's saved settings.
        const remaining=missing.filter(row=>!Object.hasOwn(this.fields,row.key));
        if(remaining.length===missing.length)throw error;
        missing=remaining;
      }
    }
  }
  change(edit){
    const generation=this.generation;
    const task=this.queue.catch(()=>{}).then(async()=>{
      if(generation!==this.generation)throw Error('登录状态已变化，请刷新后重试。');
      if(this.revision<0)await this.refresh();
      if(generation!==this.generation)throw Error('登录状态已变化，请刷新后重试。');
      this.staged=new Map();let result,changes;
      try{
        result=edit();
        changes=[...this.staged].filter(([key,value])=>!Object.hasOwn(this.fields,key)||JSON.stringify(this.fields[key].value)!==JSON.stringify(value))
          .map(([key,value])=>({key,value,version:this.fields[key]?.version||0}));
      }finally{this.staged=null;}
      if(!changes.length)return result;
      try{this._apply(await this.request('/api/sidebar-preferences',{changes}),generation);}
      catch(error){
        // Reconcile with reads only, including when the save succeeded but its
        // HTTP response was lost. Never repeat this POST automatically.
        try{this._apply(await this.request('/api/sidebar-preferences'),generation);}catch{}
        if(generation!==this.generation)throw error;
        if(changes.every(row=>this.fields[row.key]?.version===row.version+1&&JSON.stringify(this.fields[row.key].value)===JSON.stringify(row.value)))return result;
        if(error.status)throw error;
        throw Error('侧栏设置保存结果尚未确认，请刷新核对后再操作。');
      }
      return result;
    });
    this.queue=task;return task;
  }
}
