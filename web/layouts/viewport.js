'use strict';

// Screen and pane sizes are independent of the browser or native App host.
const BridgeLayout=Object.freeze({
  isCompactViewport:width=>width===undefined?matchMedia('(max-width:720px)').matches:width<=720,
  canSplit:width=>width>=720,
  prefersTouchInput:()=>matchMedia('(pointer:coarse)').matches,
});

// Keep the user's navigation choice across chats, providers and viewport changes.
class SidebarNavigation {
  constructor(root){
    this.root=root;this.media=matchMedia('(min-width:721px)');this.buttons=[];
    try{this.preference=localStorage.getItem('navigation:sidebar');}catch{}
    for(const head of root.querySelectorAll('.list-heading,.chat-head')){
      const button=document.createElement('button');button.type='button';button.className='icon-button sidebar-toggle';
      button.innerHTML='<svg class="header-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v16H3zM9 4v16"/></svg>';
      button.onclick=()=>this.set(!this.isOpen());head.prepend(button);this.buttons.push(button);
    }
    this.media.addEventListener('change',()=>this.render());document.addEventListener('bridge-language',()=>this.render());this.render();
  }
  isOpen(){return this.preference==='open'||this.preference!=='closed'&&this.media.matches;}
  set(open){this.preference=open?'open':'closed';try{localStorage.setItem('navigation:sidebar',this.preference);}catch{}this.render();}
  render(){
    const open=this.isOpen();this.root.classList.toggle('sidebar-open',open);this.root.classList.toggle('sidebar-closed',!open);
    for(const button of this.buttons){const label=open?'收起导航栏':'打开导航栏';button.title=BridgeI18n.t(label);button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded',String(open));}
  }
}
if(typeof module==='object'&&module.exports)module.exports=BridgeLayout;
