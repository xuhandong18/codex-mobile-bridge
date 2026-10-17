/* Call runMarkdownNavigationChecks() with Markdown, Workbench, source-view,
 * file-actions, i18n and the gateway CSS loaded. Uses only synthetic file reads. */
window.runMarkdownNavigationChecks = async () => {
  const checks = [], check = (name, condition) => { if (!condition) throw Error(name); checks.push(name); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const chat = document.createElement('section'); chat.className = 'chat';
  chat.innerHTML = '<header class="chat-head"></header><div class="timeline" tabindex="0"></div>';
  chat.style.cssText = 'height:560px;width:100%;display:flex;flex-direction:column';
  document.body.append(chat);
  const padding = Array.from({length:35}, (_, i) => '正文段落 ' + i).join('\n\n');
  const texts = {
    'docs/README.md':'# Guide\n\n[本页](#安装) [重复章节](#安装-1) [其他文档](../说明%20v1.md#安装-1) [源码](/src/app.js) [外网](https://example.com/docs) [越界](../../secret.md) [脚本](javascript:alert%281%29)\n\n' + padding + '\n\n## 安装\n\n' + padding + '\n\n## 安装\n\n' + padding,
    '说明 v1.md':'# **使用** Guide!\n\n[返回](docs/README.md#安装)\n\n' + padding + '\n\n## 安装\n\n' + padding + '\n\n## 安装\n\n' + padding,
    'src/app.js':'const example = true;\n'
  };
  const reads = [], notices = []; let release;
  const workbench = new Workbench({chat, notify:message=>notices.push(message), request:async url => {
    const parsed = new URL(url, location.href), path = parsed.searchParams.get('path'); reads.push(parsed);
    if (path === '说明 v1.md') await new Promise(resolve=>{release=resolve;});
    if (!Object.hasOwn(texts, path)) throw Error('Fixture file not found');
    return {kind:'text', name:path.split('/').pop(), size:texts[path].length, text:texts[path]};
  }});
  try {
    workbench.open('11111111-1111-4111-8111-111111111111', 'remote-ssh:fixture');
    const session = workbench.current;
    await workbench.preview(session, {path:'docs/README.md',name:'README.md'}); await settle();
    const source = session.files[0], content = source.markdown;
    if (BridgeLayout.canSplit(chat.clientWidth)) { workbench.split(source.id); await settle(); }
    const link = (tab, label) => [...tab.markdown.querySelectorAll('a')].find(node=>node.textContent === label);
    check('section anchors include Chinese duplicate headings', JSON.stringify([...content.querySelectorAll('[data-markdown-anchor]')].map(node=>node.dataset.markdownAnchor)) === JSON.stringify(['guide','安装','安装-1']));
    link(source, '本页').click(); await settle();
    check('same-document section stays in the same tab and scrolls its reader', session.files.length === 1 && content.scrollTop > 300);
    const first = content.scrollTop; link(source, '重复章节').click(); await settle();
    check('duplicate section links reach the second heading', content.scrollTop > first + 300);
    check('external website keeps a separate browser target', link(source,'外网').target === '_blank' && link(source,'外网').rel === 'noopener noreferrer');
    check('unsafe and out-of-project links cannot be activated', !link(source,'越界') && !link(source,'脚本'));
    source.body.querySelector('.wb-preview-expand').click();await settle();
    check('Markdown fullscreen keeps the real tab strip visible and interactive', workbench.previewFullscreen?.documentMode && !workbench.strip.inert && workbench.strip.getBoundingClientRect().height > 0 && getComputedStyle(chat).position === 'fixed');
    check('fullscreen retains the mounted document reader', source.markdown === content && content.isConnected);
    link(source,'本页').click();await settle();const fullscreenFirst=content.scrollTop;
    link(source,'重复章节').click();await settle();
    const before = content.scrollTop;
    link(source, '其他文档').click();
    check('other file creates a new tab immediately while retaining the source', session.files.length === 2 && session.files[0] === source && session.active === 'file:说明 v1.md');
    check('a linked document keeps fullscreen while loading', workbench.previewFullscreen?.tab === session.files[1] && chat.classList.contains('wb-document-fullscreen'));
    workbench.select(source.id); release(); await settle();
    const destination = session.files[1];
    check('a destination loaded in the background keeps its pending section', destination.fragment === '安装-1' && session.active === source.id && content.scrollTop === before);
    workbench.select(destination.id); await settle();
    check('cross-file section is positioned after selecting the loaded tab', destination.markdown.scrollTop > 500 && destination.fragment === undefined);
    check('loaded destinations use the same fullscreen tab strip', workbench.previewFullscreen?.tab === destination && !workbench.strip.inert && destination.body.querySelector('.wb-preview-expand').textContent === BridgeI18n.t('退出全屏'));
    check('inline formatting and punctuation produce readable heading anchors', destination.markdown.querySelector('h1').dataset.markdownAnchor === '使用-guide');
    link(destination, '返回').click(); await settle();
    check('return links reuse the original tab and locate its section', session.files.length === 2 && session.active === source.id && Math.abs(content.scrollTop - fullscreenFirst) < 2);
    link(source, '源码').click(); await settle();
    check('source file links also open their own workbench tab', session.files.length === 3 && session.active === 'file:src/app.js' && session.files[2].body.querySelector('code').textContent === texts['src/app.js']);
    check('linked source files retain document fullscreen', workbench.previewFullscreen?.tab === session.files[2]);
    check('file reads retain the selected SSH host and authenticated workspace route', reads.length === 3 && reads.every(url=>url.pathname.endsWith('/workspace/preview') && url.searchParams.get('host') === session.host));
    const message = document.createElement('div'); renderMarkdown(message, '[relative](docs/README.md) [section](#安装)');
    check('file navigation permissions do not leak into chat messages', message.querySelectorAll('a').length === 0 && notices.length === 0);
    await workbench.close(session.active);await settle();
    check('closing a fullscreen file keeps the remaining document tabs available', !!workbench.previewFullscreen && session.active.startsWith('file:') && !workbench.strip.inert);
    workbench.select('chat');await settle();
    check('selecting the chat tab exits document fullscreen', !workbench.previewFullscreen && !chat.classList.contains('wb-document-fullscreen'));
    return {passed:checks.length, checks};
  } finally {
    workbench.reset(); workbench.resizeObserver.disconnect(); workbench.mobileObserver.disconnect(); chat.remove();
  }
};
