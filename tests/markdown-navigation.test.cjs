'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const context = vm.createContext({BridgeI18n:{t:text=>text}});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/features/workspace/workbench.js'), 'utf8'), context);
const Workbench = vm.runInContext('Workbench', context), workbench = Object.create(Workbench.prototype);
const target = value => JSON.parse(JSON.stringify(workbench.markdownTarget('docs/guide/README.md', value)));

test('Markdown file links resolve relative to the document, with decoded paths and sections', () => {
  assert.deepEqual(target('../%E8%AF%B4%E6%98%8E%20v1.md#%E5%AE%89%E8%A3%85'), {path:'docs/说明 v1.md', fragment:'安装'});
  assert.deepEqual(target('../../README.md'), {path:'README.md'});
  assert.deepEqual(target('/src/app.js'), {path:'src/app.js'});
  assert.deepEqual(target('./next.markdown?plain=1#api-reference'), {path:'docs/guide/next.markdown', fragment:'api-reference'});
  assert.deepEqual(target('#当前章节'), {path:'docs/guide/README.md', fragment:'当前章节'});
  assert.deepEqual(target('#'), {path:'docs/guide/README.md', fragment:''});
});

test('Markdown navigation cannot become an external request or escape the workspace', () => {
  for (const value of ['../../../secret.md', '%2e%2e/%2e%2e/%2e%2e/secret.md', '/../../secret.md',
    '//server/share', 'file:///D:/secret.md', 'D:/secret.md', 'https://example.com', 'javascript:alert(1)',
    '..%5csecret.md', 'foo%3abar.md', 'bad%00.md', 'bad%7f.md', 'bad%xx.md', 'file.md#%xx']) {
    assert.equal(target(value), null, value);
  }
});

test('an already-open destination keeps the original tab and receives the latest section during loading', async () => {
  const source = {id:'file:README.md'}, destination = {id:'file:docs/guide.md'};
  const session = {files:[source,destination]}, selected = [];
  Object.assign(workbench, {current:session, select:id=>selected.push(id)});
  await workbench.preview(session, {path:'docs/guide.md'}, '安装');
  await workbench.preview(session, {path:'docs/guide.md'}, '安装-1');
  assert.equal(session.files.length, 2);
  assert.equal(session.files[0], source);
  assert.equal(destination.fragment, '安装-1');
  assert.deepEqual(selected, ['file:docs/guide.md','file:docs/guide.md']);
  await workbench.preview({files:[]}, {path:'other.md'});
  assert.equal(selected.length, 2);
});

test('section positioning waits for its tab to be visible and preserves the resulting reading position', () => {
  const heading = {dataset:{markdownAnchor:'安装'}, getBoundingClientRect:()=>({top:310})};
  const content = {scrollTop:40, querySelectorAll:()=>[heading], getBoundingClientRect:()=>({top:100})};
  const tab = {id:'file:guide.md', markdown:content, fragment:'安装'}, session = {files:[tab], active:'chat'};
  const notices = [];
  Object.assign(workbench, {current:session, canSplit:()=>false, scrollPositions:new WeakMap(), notify:text=>notices.push(text)});
  workbench.scrollMarkdown(tab);
  assert.equal(tab.fragment, '安装'); assert.equal(content.scrollTop, 40);
  session.active = tab.id; workbench.scrollMarkdown(tab);
  assert.equal(content.scrollTop, 238); assert.equal(workbench.scrollPositions.get(content), 238);
  assert.equal(tab.fragment, undefined);
  tab.fragment = 'missing'; workbench.scrollMarkdown(tab);
  assert.deepEqual(notices, ['未找到对应章节']); assert.equal(content.scrollTop, 238);
  tab.fragment = ''; workbench.scrollMarkdown(tab); assert.equal(content.scrollTop, 0);
});
