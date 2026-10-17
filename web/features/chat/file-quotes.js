'use strict';

// Keep excerpt drafts separate from the editable text; expand only at submission.
class FileQuoteDrafts {
  constructor({input,onChange=()=>{}}){
    Object.assign(this,{input,onChange});this.states=new Map();this.key=null;this.rows=[];
    this.root=document.createElement('div');this.root.className='file-quote-list';this.root.hidden=true;
    input.before(this.root);
  }
  static compose(text,rows){
    const quotes=rows.map(row=>'文件：'+row.path+(row.host&&row.host!=='local'?'\n主机：'+row.host:'')+'\n'+row.text.split(/\r\n|\r|\n/).map(line=>'> '+line).join('\n'));
    return [text,...quotes].filter(Boolean).join('\n\n');
  }
  read(key){
    if(!this.states.has(key)){
      let rows=[];try{rows=JSON.parse(sessionStorage.getItem('file-quotes:'+key)||'[]');}catch{}
      this.states.set(key,Array.isArray(rows)?rows.filter(row=>row&&typeof row.id==='string'&&typeof row.path==='string'&&typeof row.text==='string'):[]);
    }
    return this.states.get(key);
  }
  open(key){this.close();this.key=key;this.rows=this.read(key);this.render();}
  reset(){this.close();this.key=null;this.rows=[];this.states.clear();this.render();}
  text(raw=this.input.value){return FileQuoteDrafts.compose(raw,this.rows);}
  validate(text=this.text()){
    if(this.input.maxLength>0&&text.length>this.input.maxLength)throw Error(BridgeI18n.t('文字和文件引用合计过长，请缩小选区或删除部分引用'));
    return text;
  }
  add(quote){
    if(!this.key)return false;
    this.validate(FileQuoteDrafts.compose(this.input.value,[...this.rows,quote]));
    this.rows.push({...quote,id:uuid()});this.save(this.key);this.render();this.onChange();return true;
  }
  save(key){
    const rows=this.read(key);
    try{if(rows.length)sessionStorage.setItem('file-quotes:'+key,JSON.stringify(rows));else sessionStorage.removeItem('file-quotes:'+key);}catch{}
  }
  clear(key,ids){
    const rows=this.read(key);rows.splice(0,rows.length,...rows.filter(row=>!ids.includes(row.id)));this.save(key);
    if(key===this.key){this.close();this.rows=rows;this.render();this.onChange();}
  }
  forget(matches){
    const keys=new Set(this.states.keys());
    for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(key?.startsWith('file-quotes:'))keys.add(key.slice(12));}
    for(const key of keys)if(matches(key)){this.states.delete(key);sessionStorage.removeItem('file-quotes:'+key);}
    if(this.key&&matches(this.key)){this.close();this.key=null;this.rows=[];this.render();}
  }
  close(){this.dialog?.close();this.dialog=null;}
  render(){
    this.root.replaceChildren();this.root.hidden=!this.rows.length;
    for(const row of this.rows){
      const button=document.createElement('button');button.type='button';button.className='file-quote-chip';
      const icon=document.createElement('span');icon.className='file-quote-icon';icon.textContent='❞';icon.setAttribute('aria-hidden','true');
      const name=document.createElement('span');name.textContent=row.name||row.path.split(/[\\/]/).pop();
      button.append(icon,name);button.title=row.path;button.setAttribute('aria-label',BridgeI18n.t('查看文件引用')+'：'+(row.name||row.path));
      button.onclick=()=>this.details(row);this.root.append(button);
    }
  }
  details(row){
    if(!this.rows.includes(row))return;this.close();
    const dialog=this.dialog=document.createElement('dialog');dialog.className='picker file-quote-details';
    const head=document.createElement('div');head.className='picker-head';
    const title=document.createElement('h2');title.dataset.i18n='文件引用';title.textContent=BridgeI18n.t('文件引用');
    const control=(label,run,cls='plain')=>{const node=document.createElement('button');node.type='button';node.dataset.i18n=label;node.textContent=BridgeI18n.t(label);node.className=cls;node.onclick=run;return node;};
    const close=control('关闭',()=>dialog.close(),'icon-button');head.append(title,close);
    const path=document.createElement('p');path.className='file-quote-path';path.textContent=row.path;
    const text=document.createElement('pre');text.className='file-quote-text';text.textContent=row.text;
    const remove=control('删除引用',()=>{this.clear(this.key,[row.id]);},'plain file-quote-remove');
    dialog.append(head,path);if(row.host&&row.host!=='local'){const host=document.createElement('p');host.textContent=BridgeI18n.t('主机')+'：'+row.host;dialog.append(host);}dialog.append(text,remove);
    dialog.addEventListener('close',()=>{dialog.remove();if(this.dialog===dialog)this.dialog=null;},{once:true});
    document.body.append(dialog);dialog.showModal();
  }
}
