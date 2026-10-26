'use strict';

class MarkdownEditor {
  constructor(workbench, session, tab, result, content, actions, render) {
    Object.assign(this, {workbench, session, tab, content, render, version:result.version});
    this.original = this.normalize(result.text);
    this.history = []; this.future = [];
    const node = (...args) => workbench.node(...args), button = (...args) => workbench.button(...args);
    this.element = node('div', 'wb-md-layout');
    this.editor = node('div', 'wb-md-editor');
    this.input = workbench.raw(node('textarea', 'wb-md-input'));
    this.input.value = this.original; this.input.spellcheck = false;
    this.input.setAttribute('aria-label', BridgeI18n.t('Markdown 编辑内容'));
    this.input.dataset.i18nAriaLabel = 'Markdown 编辑内容';
    this.input.setAttribute('aria-description', BridgeI18n.t('Tab 缩进，Shift+Tab 取消缩进，Esc 后按 Tab 移动焦点。'));
    this.input.setAttribute('autocapitalize', 'off'); this.input.setAttribute('autocomplete', 'off');
    this.snapshot = this.state();
    this.input.addEventListener('beforeinput', () => { this.snapshot = this.state(); });
    this.input.addEventListener('input', () => {
      this.history.push(this.snapshot); this.limitHistory(); this.future = []; this.snapshot = this.state(); this.changed();
    });
    this.input.addEventListener('keydown', event => this.keydown(event));
    this.input.addEventListener('select', () => this.updatePosition());
    this.input.addEventListener('click', () => this.updatePosition());
    this.input.addEventListener('keyup', () => this.updatePosition());
    this.toolbar = node('div', 'wb-md-toolbar'); this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.setAttribute('aria-label', BridgeI18n.t('Markdown 格式工具'));
    this.toolbar.dataset.i18nAriaLabel = 'Markdown 格式工具';
    const tool = (text, label, action) => {
      const control = button(text, action, label);
      control.onpointerdown = event => { if (event.button === 0) event.preventDefault(); };
      this.toolbar.append(control); return control;
    };
    this.undoButton = tool('↶', '撤销', () => this.undo());
    this.redoButton = tool('↷', '重做', () => this.undo(true));
    for (const [label, title, left, right, sample] of [
      ['B', '粗体', '**', '**', '文字'], ['I', '斜体', '*', '*', '文字'], ['S', '删除线', '~~', '~~', '文字'],
      ['<>', '行内代码', '`', '`', '代码'], ['```', '代码块', '\n```\n', '\n```\n', '代码'],
      ['链接', '插入链接', '[', '](https://)', '链接文字'], ['图片', '插入图片', '![', '](https://)', '图片描述'],
      ['表格', '插入表格', '\n| 列 1 | 列 2 |\n| --- | --- |\n| ', ' | 内容 |\n', '内容']
    ]) tool(label, title, () => this.wrap(left, right, sample));
    for (const [label, title, prefix] of [['H1', '一级标题', '# '], ['H2', '二级标题', '## '], ['H3', '三级标题', '### '],
      ['❯', '引用', '> '], ['•', '无序列表', '- '], ['1.', '有序列表', '1. '], ['☑', '任务列表', '- [ ] ']]) {
      tool(label, title, () => this.prefix(prefix));
    }
    tool('查找', '查找与替换', () => this.find());
    tool('复制', '复制 Markdown', () => window.BridgeClipboard.copy(() => this.input.value, this.copyButton));
    this.copyButton = this.toolbar.lastElementChild;
    this.findbar = node('div', 'wb-md-find'); this.findbar.hidden = true;
    const field = label => {
      const input = node('input'); input.type = 'text'; input.placeholder = BridgeI18n.t(label);
      input.dataset.i18nPlaceholder = label; input.dataset.i18nAriaLabel = label; input.setAttribute('aria-label', BridgeI18n.t(label)); return input;
    };
    this.query = field('查找文本'); this.replacement = field('替换为');
    this.query.oninput = () => this.matchCount();
    this.query.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.findNext(event.shiftKey); } if (event.key === 'Escape') this.findbar.hidden = true; };
    this.matches = node('span', 'wb-md-matches'); this.matches.setAttribute('role', 'status');
    this.findbar.append(this.query, this.replacement, button('上一个', () => this.findNext(true)), button('下一个', () => this.findNext()),
      button('替换', () => this.replace()), button('全部替换', () => this.replace(true)), this.matches, button('×', () => {this.findbar.hidden = true; this.input.focus();}, '关闭查找'));
    const footer = node('div', 'wb-md-footer'); this.position = node('span');
    this.status = node('span'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.checkButton = button('核对保存结果', () => this.checkSave()); this.checkButton.hidden = true;
    footer.append(this.position, this.status, this.checkButton);
    this.editor.append(this.toolbar, this.findbar, this.input, footer);
    this.element.append(this.editor, content);
    this.modes = node('div', 'wb-preview-modes'); this.modeButtons = new Map();
    for (const [mode, label] of [['preview', '预览'], ['edit', '编辑'], ['split', '编辑与预览']]) {
      const control = button(label, () => this.show(mode)); control.className = 'wb-preview-mode';
      this.modeButtons.set(mode, control); this.modes.append(control);
    }
    this.saveButton = button('保存', () => this.save(), '保存 Markdown（Ctrl/Cmd+S）');
    this.saveButton.className = 'wb-md-save'; actions.append(this.saveButton);
    this.shortcut = event => {
      if (!event.defaultPrevented && !event.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); this.save();
      }
    };
    tab.body.addEventListener('keydown', this.shortcut);
    this.show(tab.markdownMode || 'preview'); this.changed(false);
  }
  normalize(text) { return text.replace(/\r\n?/g, '\n'); }
  get dirty() { return this.input.value !== this.original; }
  get busy() { return this.saving || this.checking; }
  state() { return {text:this.input.value, start:this.input.selectionStart, end:this.input.selectionEnd}; }
  limitHistory() {
    // Bound both entries and total text, including near-limit documents.
    let bytes = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      bytes += this.history[i].text.length * 2;
      if (bytes > 8 * 1024 * 1024 || this.history.length - i > 100) { this.history.splice(0, i + 1); break; }
    }
  }
  restore(state) { this.input.value = state.text; this.input.setSelectionRange(state.start, state.end); this.snapshot = this.state(); this.changed(); this.input.focus(); }
  undo(redo = false) {
    const source = redo ? this.future : this.history, target = redo ? this.history : this.future;
    if (!source.length) return;
    target.push(this.state()); this.restore(source.pop());
  }
  edit(start, end, text, selectStart = start, selectEnd = start + text.length) {
    this.history.push(this.state()); this.limitHistory(); this.future = [];
    this.input.setRangeText(text, start, end, 'end'); this.input.setSelectionRange(selectStart, selectEnd);
    this.snapshot = this.state(); this.changed(); this.input.focus();
  }
  wrap(left, right, sample) {
    const {text, start, end} = this.state(), selected = text.slice(start, end) || BridgeI18n.t(sample);
    if (start >= left.length && text.slice(start-left.length, start) === left && text.slice(end, end+right.length) === right) {
      this.edit(start-left.length, end+right.length, selected, start-left.length, start-left.length+selected.length);
    } else this.edit(start, end, left+selected+right, start+left.length, start+left.length+selected.length);
  }
  prefix(prefix) {
    const {text, start, end} = this.state(), first = start ? text.lastIndexOf('\n', start - 1) + 1 : 0;
    let last = text.indexOf('\n', end > start && text[end-1] === '\n' ? end-1 : end); if (last < 0) last = text.length;
    const lines = text.slice(first, last).split('\n'), remove = lines.every(line => line.startsWith(prefix));
    const value = lines.map(line => {
      if (remove) return line.slice(prefix.length);
      return prefix + (/^#{1,6} $/.test(prefix) ? line.replace(/^#{1,6}\s+/,'') : line);
    }).join('\n');
    this.edit(first, last, value, first, first+value.length);
  }
  keydown(event) {
    if (event.isComposing) return;
    if (event.key === 'Tab' && this.tabExit) { this.tabExit = false; return; }
    this.tabExit = event.key === 'Escape';
    const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey;
    if (modifier && ['s', 'b', 'i', 'k', 'f', 'h', 'z', 'y'].includes(key)) {
      event.preventDefault();
      if (key === 's') this.save();
      else if (key === 'z' || key === 'y') this.undo(event.shiftKey || key === 'y');
      else if (key === 'f' || key === 'h') this.find();
      else if (key === 'b') this.wrap('**', '**', '文字');
      else if (key === 'i') this.wrap('*', '*', '文字');
      else this.wrap('[', '](https://)', '链接文字');
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.indent(event.shiftKey);
    } else if (event.key === 'Escape' && !this.findbar.hidden) { this.findbar.hidden = true; event.preventDefault(); }
  }
  indent(outdent) {
    const {text,start,end} = this.state();
    if (!outdent && start === end) { this.edit(start,end,'  ',start+2,start+2); return; }
    const first = start ? text.lastIndexOf('\n',start-1)+1 : 0;
    let last = text.indexOf('\n',end > start && text[end-1] === '\n' ? end-1 : end); if (last < 0) last = text.length;
    const lines = text.slice(first,last).split('\n');
    const value = lines.map(line => outdent ? line.replace(/^(?: {1,2}|\t)/,'') : '  '+line).join('\n');
    if (value !== text.slice(first,last)) this.edit(first,last,value,first,first+value.length);
  }
  find() { if (this.mode === 'preview') this.show('edit'); this.findbar.hidden = false; this.query.focus(); this.query.select(); this.matchCount(); }
  matchCount() {
    const query = this.query.value, text = this.input.value; let count = 0, offset = 0;
    if (query) while ((offset = text.indexOf(query, offset)) >= 0) { count++; offset += query.length; }
    this.matches.textContent = count + ' ' + BridgeI18n.t('处匹配');
  }
  findNext(backwards = false) {
    const query = this.query.value; if (!query) return false;
    const text = this.input.value;
    let index = backwards ? (this.input.selectionStart ? text.lastIndexOf(query, this.input.selectionStart-1) : -1) : text.indexOf(query, this.input.selectionEnd);
    if (index < 0) index = backwards ? text.lastIndexOf(query) : text.indexOf(query);
    if (index < 0) { this.matchCount(); return false; }
    this.input.focus(); this.input.setSelectionRange(index, index+query.length); this.updatePosition(); return true;
  }
  replace(all = false) {
    const query = this.query.value; if (!query) return;
    if (all) { const text = this.input.value.split(query).join(this.replacement.value); if (text !== this.input.value) this.edit(0,this.input.value.length,text,0,0); }
    else {
      if (this.input.value.slice(this.input.selectionStart,this.input.selectionEnd) !== query && !this.findNext()) return;
      this.edit(this.input.selectionStart,this.input.selectionEnd,this.replacement.value); this.findNext();
    }
    this.matchCount();
  }
  show(mode) {
    this.mode = this.tab.markdownMode = mode; this.element.dataset.mode = mode;
    this.editor.hidden = mode === 'preview'; this.content.hidden = mode === 'edit';
    for (const [key, control] of this.modeButtons) control.setAttribute('aria-pressed', String(key === mode));
    this.saveButton.hidden = mode === 'preview';
    this.workbench.fileSelection?.close();
    if (mode !== 'edit') this.render(this.input.value);
    if (mode !== 'preview') this.input.focus({preventScroll:true});
  }
  updatePosition() {
    const preceding = this.input.value.slice(0,this.input.selectionStart), lines = preceding.split('\n');
    this.position.textContent = `${BridgeI18n.t('行')} ${lines.length} · ${BridgeI18n.t('列')} ${lines.at(-1).length+1} · ${this.input.value.length} ${BridgeI18n.t('字符')}`;
  }
  message(text) { this.status.dataset.i18n = text; this.status.textContent = BridgeI18n.t(text); }
  updateMetadata(size) {
    const metadata = this.tab.body.querySelector('.wb-preview-title small');
    if (metadata && Number.isFinite(size)) metadata.textContent = this.workbench.size(size) + ' · ' + this.tab.entry.path;
  }
  changed(render = true) {
    clearTimeout(this.renderTimer);
    if (render && this.mode !== 'edit') this.renderTimer = setTimeout(() => { if (!this.disposed) this.render(this.input.value); }, 180);
    this.updatePosition(); this.update();
    if (!this.needsCheck && !this.conflict && !this.busy) this.message(this.dirty ? '有未保存的更改' : '已保存');
    if (!this.findbar.hidden) this.matchCount();
  }
  update() {
    this.saveButton.disabled = !this.dirty || this.busy || this.needsCheck || this.conflict || !this.version;
    this.undoButton.disabled = !this.history.length; this.redoButton.disabled = !this.future.length;
    this.checkButton.hidden = !this.needsCheck; this.checkButton.disabled = this.busy;
    if (this.workbench.current === this.session) {
      for (const group of this.workbench.tabs.children) if (group.dataset.tab === this.tab.id) group.classList.toggle('wb-tab-dirty', this.dirty);
    }
    this.element.setAttribute('aria-busy', String(!!this.busy));
  }
  async save() {
    if (this.saveButton.disabled || this.disposed) return !this.dirty && !this.needsCheck;
    if (new TextEncoder().encode(this.input.value).length > 512 * 1024) {
      this.message('Markdown 文件不能超过 512 KB'); return false;
    }
    const text = this.input.value; this.submitted = text; this.saving = true; this.message('正在保存…'); this.update();
    try {
      const result = await this.workbench.request(this.workbench.url(this.session,'save',this.tab.entry.path), {text,version:this.version});
      if (this.disposed) return false;
      if (result.outcome === 'conflict') {
        this.conflict = true; this.message('文件已被其他地方修改，请复制草稿后刷新文件。'); return false;
      }
      if (result.outcome !== 'saved' || typeof result.version !== 'string') throw Error('Unconfirmed save');
      this.original = text; this.version = result.version; this.updateMetadata(result.size); this.message(this.dirty ? '已保存，仍有新的更改' : '已保存'); return true;
    } catch (error) {
      if (!this.disposed) {
        this.needsCheck = true; this.message('保存结果未确认，草稿已保留，请先核对保存结果。');
        this.workbench.notify(BridgeI18n.t(error.message));
      }
      return false;
    } finally { this.saving = false; if (!this.disposed) this.update(); }
  }
  async checkSave() {
    if (this.busy || !this.needsCheck || this.disposed) return;
    this.checking = true; this.update();
    try {
      const result = await this.workbench.request(this.workbench.url(this.session,'preview',this.tab.entry.path));
      if (this.disposed) return;
      if (result.kind !== 'text' || !result.version) throw Error('No text');
      if (this.normalize(result.text) === this.submitted) {
        this.original = this.submitted; this.version = result.version; this.updateMetadata(result.size); this.message(this.dirty ? '已保存，仍有新的更改' : '已保存');
      } else if (result.version === this.version) this.message('文件仍是原版本，可再次点击保存。');
      else { this.conflict = true; this.message('文件已被其他地方修改，请复制草稿后刷新文件。'); }
      this.needsCheck = false;
    } catch { if (!this.disposed) this.message('暂时无法核对，草稿已保留，请稍后重试。'); }
    finally { this.checking = false; if (!this.disposed) this.update(); }
  }
  async confirmLeave() {
    if (this.busy) { this.workbench.notify(BridgeI18n.t('正在保存或核对文件，请稍候。')); return false; }
    if (!this.dirty && !this.needsCheck) return true;
    if (this.leaveDialog) return false;
    const wb = this.workbench, dialog = this.leaveDialog = wb.node('dialog','picker wb-md-leave');
    dialog.append(wb.node('h2','','有未保存的更改'), wb.raw(wb.node('p','',this.tab.name)), wb.node('p','','关闭或刷新会丢弃当前草稿。'));
    const actions = wb.node('div','picker-actions');
    return new Promise(resolve => {
      let accepted = false;
      const cancel = wb.button('继续编辑', () => dialog.close());
      const discard = wb.button('放弃更改', () => { accepted = true; dialog.close(); });
      const save = wb.button('保存并继续', async () => {
        save.disabled = discard.disabled = true;
        const saved = await this.save(); accepted = saved && !this.dirty;
        dialog.close();
      });
      save.disabled = !!(this.needsCheck || this.conflict || !this.version);
      actions.append(cancel,discard,save); dialog.append(actions);
      dialog.addEventListener('close', () => { this.leaveDialog = null; dialog.remove(); resolve(accepted); }, {once:true});
      document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  dispose() { this.disposed = true; clearTimeout(this.renderTimer); this.tab.body.removeEventListener('keydown',this.shortcut); this.leaveDialog?.close(); }
}
