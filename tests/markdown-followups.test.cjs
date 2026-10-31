'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// Only the browser boundary is simulated. Both Markdown parsing and rendering
// below execute the bundled production scripts, including the texmath plugin.
function fixture() {
  class DOMEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.cancelBubble = true; }
  }
  class DOMNode {
    constructor(tag, text = '') {
      this.nodeType = tag === '#text' ? 3 : 1;
      this.tagName = tag === '#text' ? undefined : tag.toUpperCase();
      this.childNodes = []; this.parentNode = null; this.ownerDocument = document;
      this.data = text; this.className = ''; this.dataset = {}; this.attributes = new Map();
      this.listeners = new Map(); this.value = ''; this.maxLength = -1;
      this.disabled = false; this.readOnly = false; this.hidden = false;
    }
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get parentElement() { return this.parentNode; }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) {
      if (this.nodeType === 3) this.data = String(value);
      else this.replaceChildren(document.createTextNode(String(value)));
    }
    // Any attempt to interpret model output as HTML fails this fixture.
    set innerHTML(_value) { throw Error('模型输出不能写入 innerHTML'); }
    insertAdjacentHTML() { throw Error('模型输出不能解释为 HTML'); }
    append(...nodes) {
      for (let node of nodes) {
        if (typeof node === 'string') node = document.createTextNode(node);
        node.remove(); node.parentNode = this; this.childNodes.push(node);
      }
    }
    replaceChildren(...nodes) { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.append(...nodes); }
    remove() {
      if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
    contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value); }
    getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
    matches(selector) {
      return selector.split(',').some(part => {
        const [tag, ...classes] = part.trim().split('.');
        return (!tag || tag === '*' || this.tagName === tag.toUpperCase()) &&
          classes.every(name => this.className.split(/\s+/).includes(name));
      });
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, run) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(run);
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      event.currentTarget = this;
      this['on' + event.type]?.(event);
      for (const run of this.listeners.get(event.type) || []) run(event);
      if (event.bubbles && !event.cancelBubble) this.parentNode?.dispatchEvent(event);
      return !event.defaultPrevented;
    }
    // A detached native button can still receive a programmatic click. The
    // renderer, rather than the fake DOM, must reject its stale callback.
    click() { if (!this.disabled) this.dispatchEvent(new DOMEvent('click', {bubbles:true, cancelable:true, button:0})); }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  const document = {activeElement:null, createElement:tag => new DOMNode(tag), createTextNode:text => new DOMNode('#text', String(text))};
  document.body = document.createElement('body');
  const context = vm.createContext({document, Event:DOMEvent, atob, BridgeI18n:{t:text => text}});
  context.window = context;
  for (const file of ['web/vendor/markdown-it.min.js', 'web/vendor/texmath.js', 'web/shared/markdown.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename:file, displayErrors:false});
  }
  function render(source, options = {}) {
    const root = document.createElement('div'); document.body.append(root);
    context.renderMarkdown(root, source, [], () => '', options);
    return root;
  }
  function composer(value = '') {
    const input = document.createElement('textarea'); input.value = value; document.body.append(input);
    return input;
  }
  function fill(...args) {
    assert.equal(typeof context.ChatFollowups?.fill, 'function', '应提供 window.ChatFollowups.fill');
    return context.ChatFollowups.fill(...args);
  }
  return {context, document, render, composer, fill};
}

const sample = '- :codex-followup[继续明确市场需求标准]{prompt="请继续明确市场需求标准"}';
const buttons = root => root.querySelectorAll('button.chat-followup');

test('历史快捷操作渲染为按钮，仅点击时返回提示词，正文不再暴露标记', () => {
  const {render} = fixture(), received = [];
  const root = render('上一项讨论已完成。\n\n' + sample, {onFollowup:prompt => received.push(prompt)});
  assert.equal(buttons(root).length, 1, '原本显示标记且按钮数量为零的历史消息应生成一个按钮');
  const [button] = buttons(root);
  assert.equal(button.textContent, '继续明确市场需求标准');
  assert.equal(button.type, 'button', '点击快捷操作不能提交所在表单');
  assert.ok(root.textContent.includes('上一项讨论已完成。'));
  assert.ok(!root.textContent.includes(':codex-followup'));
  assert.ok(!root.textContent.includes('prompt='));
  assert.ok(!root.textContent.includes('请继续明确市场需求标准'));
  assert.deepEqual(received, [], '渲染本身不能调用回调');
  button.click();
  assert.deepEqual(received, ['请继续明确市场需求标准']);
});

test('多个按钮各自安全解码 JSON 中文、引号、反斜杠、换行和 Unicode 转义', () => {
  const {render} = fixture(), received = [];
  const source = String.raw`- :codex-followup[查看“结论”]{prompt="中文：\"引号\"，路径 C:\\资料\\报告\n第二行\t\u4e2d"}
- :codex-followup[继续]{prompt="保持 **Markdown** 和 &quot; 原文"}`;
  const root = render(source, {onFollowup:prompt => received.push(prompt)});
  assert.deepEqual(buttons(root).map(button => button.textContent), ['查看“结论”', '继续']);
  for (const button of buttons(root)) button.click();
  assert.deepEqual(received, ['中文："引号"，路径 C:\\资料\\报告\n第二行\t中', '保持 **Markdown** 和 &quot; 原文']);
});

test('标题只作为 textContent，HTML 与 JavaScript 提示词不会成为可执行内容', () => {
  const {context, render} = fixture(), received = [];
  const root = render('- :codex-followup[<img src=x onerror="window.followupInjected=1"> **继续**]{prompt="</script><script>window.followupInjected=2</script>"}',
    {onFollowup:prompt => received.push(prompt)});
  assert.equal(buttons(root).length, 1);
  assert.equal(buttons(root)[0].textContent, '<img src=x onerror="window.followupInjected=1"> **继续**');
  assert.equal(root.querySelectorAll('img,script,iframe,svg,strong').length, 0);
  assert.equal(context.followupInjected, undefined);
  assert.deepEqual(received, []);
  buttons(root)[0].click();
  assert.deepEqual(received, ['</script><script>window.followupInjected=2</script>']);
  assert.equal(context.followupInjected, undefined);
});

test('用户、文件和其他未提供函数回调的上下文保持普通 Markdown', () => {
  const {render} = fixture();
  for (const options of [{}, {onFollowup:null}, {onFollowup:true}, {onFollowup:'不是函数'}, {onFollowup:{}}]) {
    const root = render(sample, options);
    assert.equal(buttons(root).length, 0);
    assert.ok(root.textContent.includes(':codex-followup'));
    assert.ok(root.textContent.includes('prompt='));
  }
});

test('引用块、代码示例及非独立完整列表项不生成快捷按钮', () => {
  const {render} = fixture(), received = [];
  const cases = [
    '> ' + sample,
    '> 外层引用\n>\n>> ' + sample,
    '```markdown\n' + sample + '\n```',
    '    ' + sample,
    '`' + sample + '`',
    sample.replace('- ', ''),
    '说明文字 ' + sample,
    sample.replace('- ', '- 前缀 '),
    sample + ' 后缀说明',
    sample + '\n  同一个列表项还有说明',
    sample + '\n\n  同一个列表项的第二段说明',
    sample + '\n  - 子列表',
    '- ' + sample.slice(2) + ' ' + sample.slice(2),
    String.raw`- \:codex-followup[继续]{prompt="继续"}`,
  ];
  for (const source of cases) {
    const root = render(source, {onFollowup:prompt => received.push(prompt)});
    assert.equal(buttons(root).length, 0, source);
  }
  assert.deepEqual(received, []);
});

test('不完整或无效属性不能产生可操作按钮', () => {
  const {render} = fixture();
  const cases = [
    '- :codex-followup[继续]{prompt="未结束',
    '- :codex-followup[继续]{prompt="缺少右花括号"',
    '- :codex-followup[继续]{prompt=继续}',
    "- :codex-followup[继续]{prompt='继续'}",
    String.raw`- :codex-followup[继续]{prompt="错误\q转义"}`,
    String.raw`- :codex-followup[继续]{prompt="错误\u12转义"}`,
    '- :codex-followup[继续]{prompt="包含"未转义引号"}',
    '- :codex-followup[继续]{prompt="继续" extra="额外属性"}',
    '- :codex-followup[继续]{prompt=null}',
    '- :codex-followup[继续]{prompt=""}',
    '- :codex-followup[]{prompt="继续"}',
    '- :codex-followup[   ]{prompt="继续"}',
  ];
  for (const source of cases) {
    const root = render(source, {onFollowup:() => assert.fail('无效标记不能触发回调')});
    assert.equal(buttons(root).length, 0, source);
  }
});

test('流式更新不会自动填入，重新渲染或移除消息后旧按钮不再触发回调', () => {
  const {context, document} = fixture(), received = [];
  const root = document.createElement('div'); document.body.append(root);
  const options = {onFollowup:prompt => received.push(prompt)};
  for (let index = 0; index < sample.length; index++) {
    root.replaceChildren();
    assert.doesNotThrow(() => context.renderMarkdown(root, sample.slice(0, index), [], undefined, options));
    assert.equal(buttons(root).length, 0, '未完整接收的标记不能成为按钮，长度：' + index);
  }
  root.replaceChildren(); context.renderMarkdown(root, sample, [], undefined, options);
  const oldButton = buttons(root)[0]; assert.ok(oldButton);
  root.replaceChildren(); context.renderMarkdown(root, sample, [], undefined, options);
  const currentButton = buttons(root)[0]; assert.ok(currentButton);
  assert.equal(oldButton.isConnected, false); oldButton.click();
  assert.deepEqual(received, []);
  currentButton.click(); assert.deepEqual(received, ['请继续明确市场需求标准']);
  root.remove(); currentButton.click();
  assert.deepEqual(received, ['请继续明确市场需求标准']);
});

test('长消息预览截到右花括号时不把仍有后续说明的列表项误判为按钮', () => {
  const {context, document} = fixture(), received = [];
  const complete = '前缀...\n\n- :codex-followup[继续]{prompt="继续"} 后面说明';
  const preview = complete.slice(0, complete.indexOf(' 后面说明'));
  const root = document.createElement('div'); document.body.append(root);
  const onFollowup = prompt => received.push(prompt);
  context.renderMarkdown(root, complete, [], undefined, {onFollowup});
  assert.equal(buttons(root).length, 0, '完整正文中的列表项还含有说明，不是独立快捷操作');
  root.replaceChildren();
  context.renderMarkdown(root, preview, [], undefined, {onFollowup, complete:false});
  assert.equal(buttons(root).length, 0, '预览恰好截到右花括号，仍不能确认列表项已经结束');
  assert.ok(root.textContent.includes(':codex-followup'), '未确认的尾部标记应保留为普通文字');
  root.replaceChildren();
  context.renderMarkdown(root, complete, [], undefined, {onFollowup, complete:true});
  assert.equal(buttons(root).length, 0, '补齐后仍有后续说明，不能生成按钮');
  assert.deepEqual(received, [], '预览与补齐过程不能调用快捷操作');
});

test('合法尾部快捷操作仅在正文完整时生成按钮，默认仍按完整正文处理', () => {
  const {render} = fixture(), received = [], onFollowup = prompt => received.push(prompt);
  for (const options of [{onFollowup}, {onFollowup, complete:true}]) {
    const root = render(sample, options);
    assert.equal(buttons(root).length, 1, '默认和 complete:true 均应保留完整正文的尾部按钮');
    assert.equal(buttons(root)[0].textContent, '继续明确市场需求标准');
  }
  const preview = render(sample, {onFollowup, complete:false});
  assert.equal(buttons(preview).length, 0, 'complete:false 的末尾列表项尚未确认关闭');
  assert.deepEqual(received, []);
});

test('正文未完整时，被后续独立普通段落确认闭合的前面按钮仍可点击', () => {
  const {render} = fixture(), received = [];
  for (const source of [sample + '\n\n后续独立普通段落', sample + '\r\n\r\n后续独立普通段落\r\n\r\n']) {
    const root = render(source, {complete:false, onFollowup:prompt => received.push(prompt)});
    assert.equal(buttons(root).length, 1, '后续段落已经确认前面的快捷操作是独立列表项');
    assert.equal(buttons(root)[0].textContent, '继续明确市场需求标准');
    assert.ok(root.textContent.includes('后续独立普通段落'));
    buttons(root)[0].click();
  }
  assert.deepEqual(received, ['请继续明确市场需求标准', '请继续明确市场需求标准']);
});

test('正文未完整时仅隐藏最后未闭合项，同一列表中前面的快捷按钮仍可用', () => {
  const {render} = fixture(), received = [];
  const source = sample + '\n- :codex-followup[查看结论]{prompt="查看结论"}';
  const root = render(source, {complete:false, onFollowup:prompt => received.push(prompt)});
  assert.deepEqual(buttons(root).map(button => button.textContent), ['继续明确市场需求标准']);
  assert.ok(root.textContent.includes(':codex-followup[查看结论]'), '末尾未确认项保留为普通文字');
  assert.deepEqual(received, []);
  buttons(root)[0].click();
  assert.deepEqual(received, ['请继续明确市场需求标准']);
});

test('尾部换行或空白行不能证明未完整正文的最后列表项已经闭合', () => {
  const {render} = fixture();
  for (const suffix of ['\n', '\n\n', '\n\n\n', '\n \t\n  \n', '\r\n\r\n\t \r\n']) {
    const source = '前缀...\n\n' + sample + suffix;
    const onFollowup = () => assert.fail('渲染过程不能调用快捷操作');
    assert.equal(buttons(render(source, {onFollowup, complete:true})).length, 1, '完整正文中的尾部空白不影响合法按钮');
    const preview = render(source, {onFollowup, complete:false});
    assert.equal(buttons(preview).length, 0, '仅有尾部空白不能确认列表项闭合，空白：' + JSON.stringify(suffix));
  }
});

test('空草稿直接填入；已有草稿用一个空行追加，并通知草稿保存和高度更新', () => {
  const {document, composer, fill} = fixture();
  for (const [draft, expected] of [['', '下一步'], ['已有草稿', '已有草稿\n\n下一步'], ['  ', '  \n\n下一步']]) {
    const input = composer(draft), updates = []; input.hidden = true;
    input.addEventListener('input', event => {
      assert.equal(input.hidden, false, 'input 监听器运行前应展开输入区');
      assert.equal(event.bubbles, true);
      updates.push(input.value);
    });
    assert.equal(fill(input, '下一步', {reveal:() => { input.hidden = false; }}), true);
    assert.equal(input.value, expected); assert.deepEqual(updates, [expected]);
    assert.equal(document.activeElement, input);
    assert.equal(input.selectionStart, expected.length); assert.equal(input.selectionEnd, expected.length);
  }
});

test('填入保留附件和文件引用，长度校验包含 quotes.text 生成的完整正文', () => {
  const {composer, fill} = fixture(), input = composer('原草稿');
  const attachments = [{id:'image', name:'图片.png'}], rows = [{path:'/资料.md', text:'引用原文'}];
  input.attachments = attachments;
  const seen = [], quotes = {
    rows,
    text(value) { assert.equal(this, quotes); return value + '\n\n文件：/资料.md\n> 引用原文'; },
    validate(value) { assert.equal(this, quotes); assert.equal(input.value, '原草稿', '先校验，后修改'); seen.push(value); },
  };
  assert.equal(fill(input, '继续', {quotes}), true);
  assert.equal(input.value, '原草稿\n\n继续');
  assert.deepEqual(seen, ['原草稿\n\n继续\n\n文件：/资料.md\n> 引用原文']);
  assert.equal(input.attachments, attachments); assert.deepEqual(attachments, [{id:'image', name:'图片.png'}]);
  assert.equal(quotes.rows, rows); assert.deepEqual(rows, [{path:'/资料.md', text:'引用原文'}]);
});

test('文件引用校验拒绝超长内容时保留原草稿，且不展开、触发事件或改变焦点', () => {
  const {document, composer, fill} = fixture(), input = composer('原草稿'), focused = composer('其他草稿');
  focused.focus(); input.setSelectionRange(1, 2); let reveals = 0, events = 0;
  input.addEventListener('input', () => events++);
  const rejection = Error('文字和文件引用合计过长');
  const quotes = {
    text:value => value + '\n文件引用占用剩余长度',
    validate(value) { assert.equal(value, '原草稿\n\n继续\n文件引用占用剩余长度'); throw rejection; },
  };
  assert.throws(() => fill(input, '继续', {quotes, reveal:() => reveals++}), error => error === rejection);
  assert.equal(input.value, '原草稿'); assert.equal(events, 0); assert.equal(reveals, 0);
  assert.equal(document.activeElement, focused); assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 2);
});

test('没有文件引用时按 maxLength 校验，恰好达到上限可填入，超出则完整保留草稿', () => {
  const {document, composer, fill} = fixture(), input = composer('原稿'); input.maxLength = 6;
  assert.equal(fill(input, '继续'), true); assert.equal(input.value, '原稿\n\n继续');
  const focused = composer(); focused.focus(); input.setSelectionRange(2, 2);
  let events = 0, reveals = 0; input.addEventListener('input', () => events++);
  assert.throws(() => fill(input, '超限', {reveal:() => reveals++}), /过长/);
  assert.equal(input.value, '原稿\n\n继续'); assert.equal(events, 0); assert.equal(reveals, 0);
  assert.equal(document.activeElement, focused); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 2);
  const unlimited = composer(); unlimited.maxLength = -1;
  assert.equal(fill(unlimited, '长'.repeat(100)), true); assert.equal(unlimited.value.length, 100);
});

test('禁用和只读输入框拒绝填入，不进行校验、展开或其他输入副作用', () => {
  const {document, composer, fill} = fixture(), focused = composer('其他草稿'); focused.focus();
  for (const state of ['disabled', 'readOnly']) {
    const input = composer('保留草稿'); input[state] = true; input.setSelectionRange(1, 1);
    input.addEventListener('input', () => assert.fail('不可编辑时不能触发 input'));
    const fail = () => assert.fail('不可编辑时不能校验或展开输入区');
    assert.equal(fill(input, '不得写入', {quotes:{text:fail, validate:fail}, reveal:fail}), false);
    assert.equal(input.value, '保留草稿'); assert.equal(document.activeElement, focused);
    assert.equal(input.selectionStart, 1); assert.equal(input.selectionEnd, 1);
  }
});

test('从实际按钮到输入区只追加草稿，不触发表单提交', () => {
  const {document, render, composer, fill} = fixture(), input = composer('正在编辑');
  const form = document.createElement('form'); document.body.append(form);
  let submits = 0, inputEvents = 0;
  form.addEventListener('submit', () => submits++); input.addEventListener('input', () => inputEvents++);
  const root = render(sample, {onFollowup:prompt => fill(input, prompt)}); form.append(root);
  assert.equal(input.value, '正在编辑'); assert.equal(inputEvents, 0);
  const [button] = buttons(root); assert.ok(button); assert.equal(button.type, 'button'); button.click();
  assert.equal(input.value, '正在编辑\n\n请继续明确市场需求标准'); assert.equal(inputEvents, 1); assert.equal(submits, 0);
});
