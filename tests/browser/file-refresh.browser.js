/* runFileRefreshBrowserChecks() uses only synthetic sessions and file reads.
 * The driver serves the real HTML shell, PDF.js and a changing one-page PDF. */
window.runFileRefreshBrowserChecks = async () => {
  const checks = [], check = (name, condition) => { if (!condition) throw Error(name); checks.push(name); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const until = async predicate => { for (let i = 0; i < 250; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error('Timed out waiting for file preview'); };
  const chat = document.createElement('section'); chat.id = 'chat'; chat.className = 'chat';
  chat.style.cssText = 'display:flex;flex-direction:column;width:calc(100vw - 24px);height:calc(100dvh - 24px);margin:12px';
  chat.innerHTML = '<header class="chat-head"></header><div class="timeline" tabindex="0"></div><div class="composer"><textarea></textarea></div>';
  document.body.append(chat);
  const paragraphs = Array.from({length:80}, (_, i) => 'Paragraph ' + i).join('\n\n');
  const revisions = new Map(), reads = [], htmlMessages = [], htmlImages = [];
  const receive = event => {
    if (event.data?.type === 'fixture-html-revision') htmlMessages.push({revision:event.data.revision, source:event.source});
    if (event.data?.type === 'fixture-html-image') htmlImages.push({revision:event.data.revision, source:event.source});
  };
  window.addEventListener('message', receive);
  let failure = '', pause;
  const hold = path => {
    let resolve, reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    pause = {path, promise}; return {resolve, reject};
  };
  const wb = new Workbench({chat, notify:message=>{throw Error(message);}, request:async (url, body, signal) => {
    const parsed = new URL(url, location.href), path = parsed.searchParams.get('path'); reads.push({parsed, body, signal});
    if (pause?.path === path) { const waiting = pause; pause = null; await waiting.promise; }
    if (failure === path) throw Error('Fixture file unavailable');
    const revision = revisions.get(path) || 1, name = path.split('/').pop();
    if (/\.pdf$/.test(name)) return {name, size:1000, clickDownloadMiB:20};
    if (/\.png$/.test(name)) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
      const context = canvas.getContext('2d'); context.fillStyle = revision === 1 ? 'red' : 'blue'; context.fillRect(0, 0, 2, 2);
      return {kind:'image', name, size:revision, mime:'image/png', data:canvas.toDataURL().split(',')[1]};
    }
    if (/\.bin$/.test(name)) return {kind:'binary', name, size:revision};
    const text = /\.html$/.test(name)
      ? '<h1>HTML revision ' + revision + '</h1><script>parent.postMessage({type:"fixture-html-revision",revision:' + revision + '},"*")<\/script>'
        + `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6CysAAAAASUVORK5CYII=" onload="parent.postMessage({type:'fixture-html-image',revision:${revision}},'*')">`
        + '<!--' + 'x'.repeat(1024 * 1024) + '-->'
      : /\.js$/.test(name) ? '// revision ' + revision + '\n' + Array.from({length:200}, (_, i) => 'const row' + i + ' = "' + 'x'.repeat(100) + '";').join('\n')
      : '# Markdown revision ' + revision + '\n\n' + paragraphs;
    return {kind:'text', name, size:text.length, text};
  }});
  const open = async path => { await wb.preview(wb.current, {path, name:path.split('/').pop()}); return wb.current.files.find(tab=>tab.id === 'file:' + path); };
  const refresh = tab => wb.refreshPreview(wb.current, tab);
  const control = (tab, cls) => tab.body.querySelector('.' + cls);
  const visible = node => node && getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().width > 0;
  try {
    wb.open('11111111-1111-4111-8111-111111111111', 'remote-ssh:refresh-fixture');
    const session = wb.current, md = await open('docs/readme.md'); await settle();
    check('Markdown offers a visible enabled refresh control', visible(md.refreshButton) && !md.refreshButton.disabled);
    const originalBody = md.body, originalContent = md.markdown;
    originalContent.scrollTop = 240; const top = originalContent.scrollTop;
    const delayed = hold('docs/readme.md'), count = reads.length;
    revisions.set('docs/readme.md', 2); const loading = md.refreshButton.onclick();
    check('refresh keeps the old content visible while its read is pending', md.markdown === originalContent && md.refreshButton.disabled && md.body.getAttribute('aria-busy') === 'true');
    await refresh(md); check('duplicate refresh does not issue another read', reads.length === count + 1);
    delayed.resolve(); await loading; await settle();
    check('refresh replaces Markdown with the new revision in the same tab', session.files.length === 1 && session.files[0] === md && md.body === originalBody && md.markdown.textContent.includes('revision 2'));
    check('refresh retains the Markdown reading position', top > 0 && Math.abs(md.markdown.scrollTop - top) < 2);
    check('refresh clears its busy state', !md.refreshButton.disabled && md.body.getAttribute('aria-busy') === 'false');
    control(md, 'wb-preview-expand').click(); revisions.set('docs/readme.md', 3); await refresh(md);
    check('Markdown remains fullscreen after refresh', wb.previewFullscreen?.tab === md && chat.classList.contains('wb-document-fullscreen') && control(md, 'wb-preview-expand').textContent === BridgeI18n.t('退出全屏'));
    check('refresh remains visible inside fullscreen', visible(md.refreshButton));
    wb.closePreviewFullscreen();
    failure = 'docs/readme.md'; const retained = md.markdown; await refresh(md);
    check('a failed refresh retains readable content and offers retry', md.markdown === retained && retained.isConnected && !!control(md, 'wb-preview-error') && !md.refreshButton.disabled);
    failure = ''; revisions.set('docs/readme.md', 4); await control(md, 'wb-preview-error').querySelector('button').onclick();
    check('retry refreshes the same tab and clears its error', md.markdown.textContent.includes('revision 4') && !control(md, 'wb-preview-error') && session.files[0] === md);

    const html = await open('page.html');
    await until(()=>htmlMessages.some(message=>message.revision === 1));
    await until(()=>htmlImages.some(message=>message.revision === 1 && message.source === html.body.querySelector('iframe')?.contentWindow));
    check('HTML above the text limit renders embedded images inside the isolated preview', !!html.html && html.htmlMode === 'preview');
    const firstFrame = html.body.querySelector('iframe');
    revisions.set('page.html', 2); await refresh(html);
    await until(()=>htmlMessages.some(message=>message.revision === 2 && message.source === html.body.querySelector('iframe')?.contentWindow));
    check('HTML refresh reruns the new document in a fresh isolated iframe', !firstFrame.isConnected && html.body.querySelector('iframe').getAttribute('sandbox') === 'allow-scripts');
    control(html, 'wb-preview-modes').children[1].click(); revisions.set('page.html', 3); await refresh(html);
    check('HTML retains source mode and shows its updated source', html.htmlMode === 'source' && !html.html && html.body.querySelector('code').textContent.includes('HTML revision 3') && control(html, 'wb-preview-modes').children[1].getAttribute('aria-pressed') === 'true');
    control(html, 'wb-preview-expand').click(); const fullscreenButton = html.fullscreenButton;
    revisions.set('page.html', 4); await refresh(html);
    check('HTML source fullscreen keeps its controls and mode during refresh', wb.previewFullscreen?.body === html.body && html.fullscreenButton === fullscreenButton && fullscreenButton.isConnected && visible(html.refreshButton) && html.htmlMode === 'source');
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    check('Escape still closes fullscreen after refresh', !wb.previewFullscreen && !html.body.classList.contains('wb-preview-fullscreen'));
    control(html, 'wb-preview-modes').children[0].click();
    await until(()=>htmlMessages.some(message=>message.revision === 4));
    if (window.captureFileRefresh) await window.captureFileRefresh();

    const source = await open('src/demo.js'); await settle();
    check('file toolbar actions stay within the viewport in either language', [...control(source, 'wb-preview-actions').children].every(node=>node.getBoundingClientRect().right <= innerWidth));
    control(source, 'wb-source-wrap').click(); source.previewContent.scrollTop = 300;
    const sourceTop = source.previewContent.scrollTop; revisions.set('src/demo.js', 2); await refresh(source);
    check('source files refresh their highlighted code', source.body.querySelector('code').textContent.startsWith('// revision 2'));
    check('source refresh retains wrapping and reading position', control(source, 'wb-source').dataset.wrap === 'true' && Math.abs(source.previewContent.scrollTop - sourceTop) < 2);
    const image = await open('image.png'), oldImage = image.body.querySelector('img').src;
    control(image, 'wb-preview-expand').click(); revisions.set('image.png', 2); await refresh(image);
    check('image refresh replaces its actual image data', image.body.querySelector('img').src !== oldImage);
    check('image fullscreen retains an available refresh control', wb.previewFullscreen?.tab === image && visible(image.refreshButton));
    wb.closePreviewFullscreen();

    await fetch('/fixture/pdf-revision?value=1'); const pdf = await open('document.pdf');
    await until(()=>pdf.body.querySelector('.wb-pdf-text')?.textContent.includes('PDF revision 1'));
    const oldPdf = pdf.pdf, oldCanvas = pdf.body.querySelector('canvas');
    await fetch('/fixture/pdf-revision?value=2'); await refresh(pdf);
    await until(()=>pdf.body.querySelector('.wb-pdf-text')?.textContent.includes('PDF revision 2'));
    check('PDF refresh destroys the old reader and displays the updated PDF', pdf.pdf !== oldPdf && !oldCanvas.isConnected && !!pdf.body.querySelector('canvas'));
    check('PDF refresh rereads authenticated download metadata', reads.filter(read=>read.parsed.searchParams.get('path') === 'document.pdf').length === 2 && reads.filter(read=>read.parsed.searchParams.get('path') === 'document.pdf').every(read=>read.parsed.searchParams.get('info') === '1'));
    const binary = await open('bundle.bin'); revisions.set('bundle.bin', 2); await refresh(binary);
    check('download-only file tabs also offer refresh', visible(binary.refreshButton) && control(binary, 'wb-preview-title').textContent.includes('2 B'));
    await open('spare.md'); const closingRead = hold('closing.md'), pendingOpen = wb.preview(session, {path:'closing.md', name:'closing.md'});
    const closing = session.files.find(tab=>tab.id === 'file:closing.md');
    wb.select(md.id); const eight = session.files.length; await refresh(md);
    check('refresh still works at the eight-file limit without reordering tabs', eight === 8 && session.files.length === 8 && session.files[0] === md && session.active === md.id);
    await wb.close(closing.id); closingRead.reject(Error('late closed read')); await pendingOpen;
    check('closing aborts the pending file read and ignores late failures', closing.controller.signal.aborted && !session.files.includes(closing) && !control(closing, 'wb-preview-error'));
    failure = 'failed.md'; await open('failed.md'); const failed = session.files.at(-1);
    check('an initially failed file read offers retry in its original tab', !!control(failed, 'wb-preview-error') && !failed.previewContent);
    failure = ''; await control(failed, 'wb-preview-error').querySelector('button').onclick();
    check('retrying the initial read does not close or duplicate its tab', session.files.at(-1) === failed && failed.markdown.textContent.includes('revision 1') && !control(failed, 'wb-preview-error'));
    await wb.close(failed.id); wb.select(md.id);

    const backgroundRead = hold('docs/readme.md'); revisions.set('docs/readme.md', 5); const pendingRefresh = refresh(md);
    wb.open('22222222-2222-4222-8222-222222222222', session.host); const other = wb.current;
    backgroundRead.resolve(); await pendingRefresh;
    check('finishing a refresh never switches the current chat or its tabs', wb.current === other && other.active === 'chat' && other.files.length === 0 && md.markdown.textContent.includes('revision 5'));
    wb.open(session.id, session.host); await settle();
    check('returning to a file refreshed in the background retains its reading position', Math.abs(md.markdown.scrollTop - top) < 2);
    wb.open(other.id, other.host);
    const beforeHiddenRefresh = reads.length; await wb.refreshPreview(session, md);
    check('a stale refresh action cannot start reads in another session', reads.length === beforeHiddenRefresh);
    check('SSH refresh reads retain the original host and workspace route', reads.every(read=>read.parsed.pathname.includes('/api/sessions/' + session.id + '/workspace/') && read.parsed.searchParams.get('host') === session.host && read.body === undefined));

    wb.provider = 'claude'; wb.open('client-fixture', 'local');
    const client = await open('page.html'); control(client, 'wb-preview-modes').children[1].click(); await refresh(client);
    const clientReads = reads.slice(-2);
    check('other clients refresh through their own session endpoint', clientReads.every(read=>read.parsed.pathname === '/api/desktop-sessions/claude/workspace/preview' && read.parsed.searchParams.get('sessionId') === 'client-fixture'));
    const resetRead = hold('page.html'), pendingReset = refresh(client), retainedBody = client.previewContent;
    wb.reset(); resetRead.reject(Error('late reset read')); await pendingReset;
    check('logout/reset aborts pending refresh and ignores late failures', client.controller.signal.aborted && wb.sessions.size === 0 && client.previewContent === retainedBody && !control(client, 'wb-preview-error'));
    return {passed:checks.length, checks};
  } finally {
    wb.reset(); wb.resizeObserver.disconnect(); wb.mobileObserver.disconnect(); chat.remove();
    window.removeEventListener('message', receive);
  }
};
