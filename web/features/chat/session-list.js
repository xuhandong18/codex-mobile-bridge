'use strict';

// A local display preference. The original desktop project and thread stay put.
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
  togglePin(item,sections,native='home'){
    const current=this.resolve(item,sections,native),previous=this.read(item)?.previous;
    this.set(item,current==='pinned'&&previous!=='pinned'&&this.valid(previous,sections)?previous:current==='pinned'?'home':'pinned',sections,native);
  }
}
