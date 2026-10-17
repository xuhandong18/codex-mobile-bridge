'use strict';

class SidebarManagementUI {
  constructor({request,dialog,refresh,snapshot,context=()=>null,uuid,notify=()=>{}}){
    Object.assign(this,{request,dialog,refresh,snapshot,context,uuid,notify});
    // Keep uncertain writes locked even if their dialog is closed and reopened.
    this.operations=new Map();
  }

  topActions(openNewProject){
    return [{label:this._t('新建项目'),run:openNewProject},
      {label:this._t('新建分区'),run:()=>this._open({kind:'section',action:'create'})}];
  }

  items(target){
    if(!target?.closest||target.closest('button'))return null;
    const projectSummary=target.closest('summary[data-project-key]');
    const data=this.snapshot()||{};
    if(projectSummary){
      const project=(data.projects||[]).find(row=>row.key===projectSummary.dataset.projectKey);
      if(!project)return [];
      const subject={kind:'project',targetId:project.key,host:project.host};
      const local=project.host==='local';
      const items=[{label:this._t('修改名称'),disabled:!local,run:()=>this._open({...subject,action:'rename'})},
        {label:this._t('移动到分区…'),disabled:!local,run:()=>this._open({...subject,action:'move'})},
        {label:this._t('删除项目'),disabled:!local,run:()=>this._open({...subject,action:'delete'})}];
      if(!local)items.push({label:this._t('远程项目暂不支持侧栏管理。'),disabled:true,run:()=>{}});
      return items;
    }
    const summary=target.closest('.sidebar-section > summary');
    if(!summary)return null;
    const section=this._sections(data).find(row=>row.id===summary.parentElement.dataset.section);
    if(!section)return [];
    const subject={kind:'section',targetId:section.id};
    return [{label:this._t('修改名称'),run:()=>this._open({...subject,action:'rename'})},
      {label:this._t('移动顺序…'),run:()=>this._open({...subject,action:'move'})},
      {label:this._t('删除分区'),run:()=>this._open({...subject,action:'delete'})}];
  }

  _sections(data){
    const order=data.sectionOrder||[];
    const rank=row=>{
      const prefixed=order.indexOf('custom:'+row.id),plain=order.indexOf(row.id);
      return prefixed>=0?prefixed:plain>=0?plain:order.length;
    };
    return (data.sections||[]).filter(row=>typeof row.id==='string'&&row.id.trim()&&
      !['pinned','projects','threads','orbit','agents','chats'].includes(row.id)&&!row.id.startsWith('builtin:')&&row.builtin!==true)
      .sort((a,b)=>rank(a)-rank(b));
  }

  _current(subject,data){
    if(subject.action==='create')return null;
    if(subject.kind==='project'){
      const project=(data.projects||[]).find(row=>row.key===subject.targetId&&row.host===subject.host);
      if(!project)throw Error(this._t('项目已被删除或已变化，请刷新列表。'));
      if(project.host!=='local')throw Error(this._t('远程项目暂不支持侧栏管理。'));
      return project;
    }
    const section=this._sections(data).find(row=>row.id===subject.targetId);
    if(!section)throw Error(this._t('分区已被删除或属于内置分区，无法修改。'));
    return section;
  }

  _t(source,values={}){
    const text=typeof BridgeI18n!=='undefined'&&typeof BridgeI18n.t==='function'?BridgeI18n.t(source):source;
    return text.replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match);
  }

  _node(tag,text='',className=''){
    const node=document.createElement(tag);node.textContent=text;node.className=className;return node;
  }

  _open(subject){
    let data,current;
    try{data=this.snapshot()||{};current=this._current(subject,data);}
    catch(error){this.notify(error.message);return null;}
    const {kind,action,targetId}=subject,project=kind==='project';
    const title=action==='create'?'新建分区':action==='rename'?(project?'修改项目名称':'修改分区名称'):
      action==='move'?(project?'移动项目':'移动分区顺序'):(project?'删除项目':'删除分区');
    const dialog=this.dialog(this._t(title)),form=this._node('form'),error=this._node('p','','error');
    error.setAttribute('role','status');error.setAttribute('aria-live','polite');
    const fields=[];
    const field=(caption,tag)=>{
      const label=this._node('label',this._t(caption)),input=this._node(tag);
      input.setAttribute('aria-label',this._t(caption));label.append(input);form.append(label);fields.push(input);return input;
    };
    const option=(label,value)=>{
      const node=this._node('option',label);node.value=value;return node;
    };
    let name,select;
    if(current)form.append(this._node('p',current.name||targetId,'muted'));
    if(action==='create'||action==='rename'){
      name=field(project?'项目名称':'分区名称','input');name.name='name';name.required=true;name.maxLength=120;
      name.value=current?.name||'';
      if(project){
        form.append(this._node('p',this._t('仅修改项目名称，关联目录保持不变，保留现有聊天。'),'muted'));
        if(current.cwd)form.append(this._node('p',this._t('关联目录：{cwd}',{cwd:current.cwd}),'muted'));
      }
    }else if(action==='move'){
      const sections=this._sections(data);
      select=field(project?'所属分区':'移动到','select');select.name=project?'sectionId':'beforeId';
      if(project){
        select.append(option(this._t('不属于分区'),''),option(this._t('置顶'),'pinned'));
        for(const section of sections)select.append(option(section.name,section.id));
        const itemKey='codex:project:'+targetId.slice(targetId.indexOf('|')+1);
        select.value=sections.find(section=>(section.itemKeys||[]).includes(itemKey))?.id||'';
        form.append(this._node('p',this._t('项目只能属于一个分区；移动保留关联目录、文件和聊天。'),'muted'));
      }else{
        for(const section of sections)if(section.id!==targetId)select.append(option(this._t('在“{name}”之前',{name:section.name}),section.id));
        select.append(option(this._t('末尾'),''));
        select.value=sections[sections.findIndex(section=>section.id===targetId)+1]?.id||'';
        form.append(this._node('p',this._t('调整分区的排列顺序，不会将分区嵌套到其他分区。'),'muted'));
      }
    }else{
      form.append(this._node('p',this._t(project?
        '确认删除项目“{name}”？仅移除项目记录，保留关联目录、所有文件和聊天。':
        '确认删除分区“{name}”？保留其中的项目和聊天，它们将回到普通列表。',{name:current.name})));
    }
    if(project&&(action==='rename'||action==='delete'))form.append(this._node('p',this._t('请保持电脑上的 Codex 打开，操作时会短暂显示原生项目窗口。'),'muted'));
    const actions=this._node('div','','actions');
    const submit=this._node('button',this._t(action==='delete'?'删除':action==='create'?'创建分区':'保存'),'primary');
    const cancel=this._node('button',this._t('取消'),'secondary');
    submit.type='submit';cancel.type='button';cancel.onclick=()=>dialog.close();
    actions.append(submit,cancel);form.append(error,actions);dialog.append(form);
    const key=JSON.stringify([kind,action,targetId??null]);
    let busy=false,locked=false,finished=false;
    const disable=value=>{for(const node of [...fields,submit])node.disabled=value;};
    const block=operation=>{
      if(!operation||!['pending','unknown'].includes(operation.status))return false;
      locked=true;disable(true);
      error.textContent=operation.status==='unknown'?operation.message:
        this._t('已有同类操作正在处理中，请等待结果后重新打开表单。');
      return true;
    };
    block(this.operations.get(key));
    form.onsubmit=async event=>{
      event.preventDefault();
      if(busy||locked||finished||!dialog.open||block(this.operations.get(key)))return;
      let body;
      try{
        const latest=this.snapshot()||{};
        this._current(subject,latest);
        body={kind,action};
        if(targetId!==undefined)body.targetId=targetId;
        if(name){
          const value=name.value.trim();
          if(!value||value.length>120)throw Error(this._t('名称不能为空，且不能超过 120 个字符。'));
          body.name=value;
        }
        if(select){
          const value=select.value||null,sections=this._sections(latest);
          if(value!==null&&!(project&&value==='pinned')&&
            (!sections.some(section=>section.id===value)||!project&&value===targetId)){
            throw Error(this._t('目标分区已被删除或不可用，请重新选择。'));
          }
          body[project?'sectionId':'beforeId']=value;
        }
        const contextId=this.context();
        if(typeof contextId==='string'&&contextId)body.contextId=contextId;
        if(action==='delete')body.confirmed=true;
        body.id=this.uuid();
        if(typeof body.id!=='string'||!body.id)throw Error(this._t('无法生成操作编号，请重新打开表单。'));
      }catch(failure){error.textContent=failure.message;return;}

      busy=true;disable(true);error.textContent=this._t('正在等待侧栏操作完成…');
      const operation={id:body.id,status:'pending',message:error.textContent};
      this.operations.set(key,operation);
      const unknown=message=>{
        operation.status='unknown';
        operation.message=(message?message+'；':'')+this._t('操作结果未知，已禁用提交。请刷新列表并核对桌面结果，不要重复操作。');
        block(operation);
      };
      let result;
      try{
        result=await this.request('/api/sidebar-management',body);
        for(;;){
          if(!result||result.id!==body.id||typeof result.status!=='string'||!result.status){
            throw Error(this._t('操作回执无效，无法确认结果'));
          }
          if(['completed','failed','unknown'].includes(result.status))break;
          operation.message=result.message||this._t('正在等待侧栏操作完成…');error.textContent=operation.message;
          await new Promise(resolve=>setTimeout(resolve,1000));
          result=await this.request('/api/sidebar-operations?id='+encodeURIComponent(body.id));
        }
      }catch(failure){unknown(failure.message);busy=false;return;}

      busy=false;
      if(result.status==='unknown'){unknown(result.message);return;}
      this.operations.delete(key);
      if(result.status==='failed'){
        error.textContent=result.message||this._t('操作失败，请检查后手动提交。');disable(false);return;
      }
      finished=true;
      if(dialog.open)dialog.close();
      try{
        await this.refresh(body);
        this.notify(result.message||this._t(action==='delete'?(project?'项目已删除，文件和聊天已保留':'分区已删除，项目和聊天已保留'):
          action==='create'?'分区已创建':action==='rename'?'名称已修改':'侧栏顺序或归属已更新'));
      }catch(failure){this.notify(this._t('操作已完成，但列表刷新失败：{message}。请手动刷新列表。',{message:failure.message}));}
    };
    dialog.showModal();
    if(!locked)name?.focus();
    return dialog;
  }
}

globalThis.SidebarManagementUI=SidebarManagementUI;
