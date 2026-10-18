'use strict';
// Local unsent text is scoped to the authenticated gateway session. It is never sent automatically.
class ComposerDrafts extends Map {
  constructor(){super();this.scope='';}
  bind(identity){
    super.clear();this.scope=identity?'bridge-composer-drafts:'+JSON.stringify([window.BridgeRelayBase||location.origin,identity]):'';
    if(this.scope)try{
      const rows=JSON.parse(localStorage.getItem(this.scope)||'[]');
      if(Array.isArray(rows))for(const row of rows)if(Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&typeof row[1]==='string')super.set(row[0],row[1]);
    }catch{}
    return this;
  }
  persist(){if(this.scope)try{if(this.size)localStorage.setItem(this.scope,JSON.stringify([...this]));else localStorage.removeItem(this.scope);}catch{}}
  set(key,value){if(!value){this.delete(key);return this;}super.set(key,value);this.persist();return this;}
  delete(key){const removed=super.delete(key);if(removed)this.persist();return removed;}
  clear(){super.clear();this.persist();}
  forget(){this.clear();this.scope='';}
}
