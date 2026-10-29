'use strict';

// The sidebar and creation picker share section identities and display ordering.
class SidebarProjectGroups {
  static sections(metadata){
    return sidebarSections(metadata,text=>BridgeI18n.t(text));
  }
  static group(projects,metadata,destination,itemOrder){
    const sections=this.sections(metadata),groups=new Map(sections.map(section=>[section.id,{...section,projects:[]}]));
    const nativeId=project=>project.key.slice(project.key.indexOf('|')+1),rank=(keys,id)=>{const i=keys.indexOf(id);return i<0?keys.length:i;};
    const ordered=[...projects].sort((a,b)=>rank(metadata.projectOrder||[],nativeId(a))-rank(metadata.projectOrder||[],nativeId(b)));
    for(const project of ordered){
      const target=destination(project),id=target.startsWith('section:')?target.slice(8):target==='pinned'?'pinned':'projects';
      (groups.get(id)||groups.get('projects')).projects.push(project);
    }
    for(const group of groups.values()){
      group.projects.sort((a,b)=>rank(group.itemKeys||[],'codex:project:'+nativeId(a))-rank(group.itemKeys||[],'codex:project:'+nativeId(b)));
      const byKey=new Map(group.projects.map(project=>[project.key,project]));
      group.projects=itemOrder.sort(group.id,[...byKey.keys()]).map(key=>byKey.get(key));
    }
    return [...groups.values()].filter(group=>group.projects.length);
  }
  static host(project){return project.host==='local'?BridgeI18n.t('此电脑'):project.hostLabel||project.host;}
  static filter(groups,query){
    query=query.trim().toLocaleLowerCase();
    return groups.map(group=>({...group,projects:group.projects.filter(project=>!query||[group.name,project.name,project.cwd,project.host,this.host(project)].join(' ').toLocaleLowerCase().includes(query))})).filter(group=>group.projects.length);
  }
}

class NewChatProjectPicker {
  constructor(select){
    this.select=select;this.groups=[];this.options=[];
    const node=(tag,className='',text)=>{const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;};
    this.node=node;this.root=node('div','nc-project-picker');
    this.button=node('button','nc-project-trigger');this.button.type='button';this.button.id='new-chat-project-button';
    this.button.setAttribute('aria-expanded','false');this.button.setAttribute('aria-controls','new-chat-project-panel');
    this.panel=node('div','nc-project-panel');this.panel.id='new-chat-project-panel';this.panel.hidden=true;
    this.query=node('input','nc-project-search');this.query.type='search';this.query.autocomplete='off';
    this.list=node('div','nc-project-list');this.list.setAttribute('role','listbox');this.list.setAttribute('aria-label',BridgeI18n.t('项目与运行主机'));
    this.empty=node('p','muted nc-project-empty');this.panel.append(this.query,this.list,this.empty);this.root.append(this.button,this.panel);
    const label=select.closest('label');label.htmlFor=this.button.id;label.classList.add('nc-project-label');select.hidden=true;select.tabIndex=-1;label.after(this.root);
    this.button.onclick=()=>this.panel.hidden?this.open():this.close();this.query.oninput=()=>this.render();
    this.root.addEventListener('keydown',event=>this.keydown(event));
    this.root.addEventListener('focusout',event=>{if(this.keyboardNavigation&&event.relatedTarget&&!this.root.contains(event.relatedTarget))this.close(false);});
    document.addEventListener('pointerdown',()=>{this.keyboardNavigation=false;});
    // Closing an inline list on pointerdown would move the clicked form control
    // before pointerup, swallowing the user's click as the dialog shrinks.
    document.addEventListener('click',event=>{if(!this.root.contains(event.target))this.close(false);});
    select.closest('dialog').addEventListener('close',()=>this.close(false));
  }
  setGroups(groups,independent){this.groups=groups;this.independent=independent;this.sync();this.render();}
  sync(){
    const project=this.groups.flatMap(group=>group.projects).find(project=>project.key===this.select.value);
    const name=this.node('strong','',project?.name||BridgeI18n.t(this.select.value==='local|independent'?'不选择项目':'请选择项目'));
    const host=this.node('span','nc-project-host',project?SidebarProjectGroups.host(project):BridgeI18n.t('此电脑'));
    this.button.replaceChildren(name,host,this.node('span','nc-project-chevron','⌄'));this.button.disabled=this.select.disabled;
  }
  open(){
    if(this.button.disabled)return;
    this.query.value='';this.panel.hidden=false;this.button.setAttribute('aria-expanded','true');this.render();this.query.focus();
  }
  close(focus=true){
    const opened=!this.panel.hidden;this.panel.hidden=true;this.button.setAttribute('aria-expanded','false');
    if(opened&&focus)this.button.focus();
  }
  choose(key){
    if(this.select.disabled)return;
    this.select.value=key;this.select.dispatchEvent(new Event('change',{bubbles:true}));this.sync();this.close();
  }
  render(){
    const t=text=>BridgeI18n.t(text),query=this.query.value.trim().toLocaleLowerCase();
    this.query.placeholder=t('搜索项目、目录或主机');this.query.setAttribute('aria-label',this.query.placeholder);this.list.setAttribute('aria-label',t('项目与运行主机'));
    this.list.replaceChildren();this.options=[];
    const option=(project,parent)=>{
      const button=this.node('button','nc-project-option');button.type='button';button.dataset.key=project.key;button.setAttribute('role','option');button.setAttribute('aria-selected',String(this.select.value===project.key));button.tabIndex=-1;
      const title=this.node('span','nc-project-title');title.append(this.node('strong','',project.name),this.node('span','nc-project-host',SidebarProjectGroups.host(project)));
      const path=project.cwd||t('在此电脑创建独立聊天');button.append(title,this.node('small','nc-project-path',path));button.title=[project.name,SidebarProjectGroups.host(project),path].join('\n');
      button.onclick=()=>this.choose(project.key);parent.append(button);this.options.push(button);
    };
    if(this.independent&&(!query||[t('不选择项目'),t('此电脑'),t('独立聊天')].join(' ').toLocaleLowerCase().includes(query)))option({key:'local|independent',host:'local',name:t('不选择项目')},this.list);
    for(const group of SidebarProjectGroups.filter(this.groups,query)){
      const section=this.node('section','nc-project-group');section.setAttribute('role','group');section.setAttribute('aria-label',group.name);section.dataset.section=group.id;
      const heading=this.node('h3','nc-project-heading',group.name);heading.append(this.node('span','',String(group.projects.length)));section.append(heading);
      for(const project of group.projects)option(project,section);this.list.append(section);
    }
    this.empty.textContent=t('没有找到项目');this.empty.hidden=!!this.options.length;
    (this.options.find(button=>button.getAttribute('aria-selected')==='true')||this.options[0])?.setAttribute('tabindex','0');
  }
  keydown(event){
    this.keyboardNavigation=event.key==='Tab';
    if(event.isComposing||event.keyCode===229)return;
    if(event.key==='Escape'&&!this.panel.hidden){event.preventDefault();event.stopPropagation();this.close();return;}
    if(event.target===this.query&&event.key==='Enter'){event.preventDefault();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||this.panel.hidden)return;
    if(event.target===this.query&&!['ArrowDown','ArrowUp'].includes(event.key))return;
    event.preventDefault();const index=this.options.indexOf(document.activeElement),length=this.options.length;
    const next=event.key==='Home'?0:event.key==='End'?length-1:event.key==='ArrowDown'?(index+1)%length:(index<0?length:index)-1;
    this.options[(next+length)%length]?.focus();
  }
}
