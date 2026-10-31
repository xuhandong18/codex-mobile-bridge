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
    this.backdrop=document.createElement('button');this.backdrop.type='button';this.backdrop.className='sidebar-backdrop';
    this.backdrop.onclick=()=>this.set(false);root.append(this.backdrop);this.bindEdgeSwipe();
    this.media.addEventListener('change',()=>this.render());document.addEventListener('bridge-language',()=>this.render());this.render();
  }
  isOpen(){return this.preference==='open'||this.preference!=='closed'&&this.media.matches;}
  set(open){this.preference=open?'open':'closed';try{localStorage.setItem('navigation:sidebar',this.preference);}catch{}this.render();}
  drawer(){
    if(this.media.matches)return null;
    return this.root.classList.contains('desktop-mode')?this.root.querySelector('.desktop-sessions.ds-open>.ds-list'):
      this.root.classList.contains('chat-open')?this.root.querySelector('#sidebar'):null;
  }
  bindEdgeSwipe(){
    let gesture=null,suppressUntil=0;
    const selected=()=>!!window.getSelection()?.toString();
    const valid=start=>!this.isOpen()&&this.drawer()===start.drawer&&!document.querySelector('dialog[open]')&&!selected()&&Date.now()-start.time<600;
    this.root.addEventListener('touchstart',event=>{
      gesture=null;const touch=event.touches[0],drawer=this.drawer();
      if(!drawer||this.isOpen()||event.touches.length!==1||touch.clientX<0||touch.clientX>24||selected()||
        document.querySelector('dialog[open]')||event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
      gesture={drawer,id:touch.identifier,x:touch.clientX,y:touch.clientY,time:Date.now()};
      // Reserve the screen edge before nested workbench gestures start.
      event.stopPropagation();
    },{capture:true,passive:true});
    this.root.addEventListener('touchmove',event=>{
      if(!gesture)return;event.stopPropagation();
      const touch=[...event.touches].find(touch=>touch.identifier===gesture.id);
      if(event.touches.length!==1||!touch||!valid(gesture)){gesture=null;return;}
      const dx=touch.clientX-gesture.x,dy=touch.clientY-gesture.y;
      if(dx< -10||Math.abs(dy)>10&&Math.abs(dy)>=Math.abs(dx)){gesture=null;return;}
      if(dx>12&&dx>Math.abs(dy)*1.5&&event.cancelable)event.preventDefault();
    },{capture:true,passive:false});
    this.root.addEventListener('touchend',event=>{
      const start=gesture;gesture=null;if(!start)return;event.stopPropagation();
      if(event.touches.length||!valid(start))return;
      const touch=[...event.changedTouches].find(touch=>touch.identifier===start.id);if(!touch)return;
      const dx=touch.clientX-start.x,dy=touch.clientY-start.y;
      if(dx<50||dx<=Math.abs(dy)*1.5)return;
      if(event.cancelable)event.preventDefault();suppressUntil=Date.now()+400;this.set(true);
    },{capture:true,passive:false});
    this.root.addEventListener('touchcancel',()=>{gesture=null;},{capture:true,passive:true});
    this.root.addEventListener('click',event=>{
      if(Date.now()<suppressUntil){event.preventDefault();event.stopImmediatePropagation();}
    },true);
  }
  render(){
    const open=this.isOpen();this.root.classList.toggle('sidebar-open',open);this.root.classList.toggle('sidebar-closed',!open);
    for(const button of this.buttons){const label=open?'收起导航栏':'打开导航栏';button.title=BridgeI18n.t(label);button.setAttribute('aria-label',button.title);button.setAttribute('aria-expanded',String(open));}
    this.backdrop.setAttribute('aria-label',BridgeI18n.t('收起导航栏'));
  }
}
if(typeof module==='object'&&module.exports)module.exports=BridgeLayout;
