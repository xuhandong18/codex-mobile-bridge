'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function fixture() {
  class Node {
    constructor(tag, text = '') { this.tagName = tag.toUpperCase(); this.children = []; this.data = text; this.dataset = {}; }
    append(...nodes) { this.children.push(...nodes); }
    get textContent() { return this.data + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this.data = String(value); this.children = []; }
    set innerHTML(value) { assert.fail('不能将模型输出作为 HTML 执行'); }
    setAttribute(name, value) { this[name] = value; }
  }
  const copied = [], document = {createElement:tag => new Node(tag), createTextNode:text => new Node('#text', text)};
  const context = vm.createContext({document, atob, BridgeI18n:{t:text => text}});
  context.window = context;
  context.BridgeClipboard = {copy:async read => copied.push(await read())};
  for (const file of ['web/vendor/markdown-it.min.js', 'web/vendor/texmath.js', 'web/shared/markdown.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, {filename:file, displayErrors:false});
  }
  const render = (text, options = {}) => {
    const root = document.createElement('div');
    context.renderMarkdown(root, text, [], () => '', {writingBlocks:true, ...options});
    return root;
  };
  return {render, copied};
}
const find = (root, predicate) => root.children.flatMap(node => [...(predicate(node) ? [node] : []), ...find(node, predicate)]);
const cards = root => find(root, node => node.className === 'writing-block');
const opening = ':::writing{variant="standard" id="91846"}';

test('截图中的 writing 标记显示为独立文稿，保留 Markdown 内容，复制仅包含正文', async () => {
  const {render, copied} = fixture();
  const content = '请帮我实现一个独立的研究工具。\n\n**工作方式**\n\n1. 保持原系统独立\n2. 由 AI 完成探测与回测';
  const root = render('把下面整段复制到新聊天即可：\n\n' + opening + '\n' + content + '\n:::\n\n文稿之后的说明。');
  assert.equal(cards(root).length, 1, '应识别 writing 容器，而不是直接显示 :::writing');
  assert.ok(!root.textContent.includes(':::'));
  assert.ok(!root.textContent.includes('91846'));
  assert.ok(root.textContent.includes('文稿之后的说明。'));
  assert.ok(find(cards(root)[0], node => node.tagName === 'STRONG').some(node => node.textContent === '工作方式'));
  const button = find(cards(root)[0], node => node.tagName === 'BUTTON')[0];
  assert.equal(button.type, 'button');
  await button.onclick();
  assert.deepEqual(copied, [content]);
});

test('只处理明确启用的助手正文，代码、引用、内联文字和畸形属性保持原文', () => {
  const {render} = fixture(), block = opening + '\n正文\n:::';
  assert.equal(cards(render(block, {writingBlocks:false})).length, 0);
  for (const source of ['```md\n' + block + '\n```', '    ' + block.replaceAll('\n', '\n    '),
    block.split('\n').map(line => '> ' + line).join('\n'), '`' + opening + '`', '示例 ' + opening,
    ':::writing{variant="standard" id="bad\\q"}\n正文\n:::', ':::writing{variant="standard" injected}\n正文\n:::',
    ':::writing{variant="standard" variant="email"}\n正文\n:::', ':::writing{variant="unknown"}\n正文\n:::']) {
    const root = render(source);
    assert.equal(cards(root).length, 0, source);
    assert.ok(root.textContent.includes(':::writing'), source);
  }
});

test('流式和截断正文尚未闭合时显示已有内容，闭合后才能复制', async () => {
  const {render, copied} = fixture();
  for (const suffix of ['', '\n', '\n::', '\n:::writing{']) {
    const root = render(opening + '\n已生成的正文' + suffix, {complete:false});
    assert.equal(cards(root).length, 1);
    assert.ok(root.textContent.includes('已生成的正文'));
    assert.equal(find(root, node => node.tagName === 'BUTTON')[0].disabled, true);
  }
  const root = render(opening + '\n已生成的正文\n:::');
  const button = find(root, node => node.tagName === 'BUTTON')[0];
  assert.equal(button.disabled, false);
  await button.onclick(); assert.deepEqual(copied, ['已生成的正文']);
});

test('同消息中多个文稿独立复制，兼容无空行分隔、CRLF 与邮件标题', async () => {
  const {render, copied} = fixture();
  const root = render('前文\r\n' + opening + '\r\n第一份\r\n:::\r\n后文\r\n:::writing{subject="会议安排" variant="email" id="2"}\r\n第二份\r\n:::');
  assert.equal(cards(root).length, 2);
  assert.ok(cards(root)[1].textContent.includes('会议安排'));
  for (const card of cards(root)) await find(card, node => node.tagName === 'BUTTON')[0].onclick();
  assert.deepEqual(copied, ['第一份', '第二份']);
  assert.ok(root.textContent.includes('前文')); assert.ok(root.textContent.includes('后文'));
});

test('文稿内围栏代码中的三冒号不能提前结束文稿，全文复制与代码复制都按完整正文定位', async () => {
  const {render, copied} = fixture();
  const content = '说明\n\n````md\n::: \n```\n````\n\n~~~text\n:::\n~~~\n\n末段';
  const source = '```js\n前置代码\n```\n\n' + opening + '\n' + content + '\n:::\n\n```js\n后置代码\n```';
  const root = render(source, {fullText:async () => source});
  assert.equal(cards(root).length, 1);
  assert.ok(cards(root)[0].textContent.includes('末段'));
  for (const button of find(root, node => node.tagName === 'BUTTON')) await button.onclick();
  assert.deepEqual(copied, ['前置代码\n', content, '::: \n```\n', ':::\n', '后置代码\n']);
});

test('文稿标题、正文与未知属性不能注入 HTML，也不放宽危险链接或远程图片边界', () => {
  const {render} = fixture();
  const root = render(':::writing{variant="email" subject="<img src=x onerror=alert(1)>" id="unsafe"}\n<script>alert(1)</script>\n\n[危险](javascript:alert%281%29)\n\n![远程](https://example.com/image.png)\n:::');
  assert.equal(cards(root).length, 1);
  assert.equal(find(root, node => ['SCRIPT', 'IMG', 'IFRAME'].includes(node.tagName)).length, 0);
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!find(root, node => node.tagName === 'A').some(node => node.href.startsWith('javascript:')));
});

test('文稿中待复制的快捷操作示例保持正文，不生成聊天操作按钮', () => {
  const {render} = fixture();
  const sample = '- :codex-followup[示例]{prompt="需要复制的内容"}';
  const root = render(opening + '\n' + sample + '\n:::', {onFollowup:() => assert.fail('文稿示例不能填入草稿')});
  assert.ok(cards(root)[0].textContent.includes(':codex-followup'));
  assert.equal(find(root, node => node.className === 'chat-followup').length, 0);
});
