'use strict';
// Production preview and click handlers; only the file metadata is synthetic.
window.prepareFileDownloadBrowserCheck = async ({provider, size}) => {
  const chat = document.createElement('section'); chat.className = 'chat';
  chat.style.cssText = 'display:flex;flex-direction:column;width:calc(100vw - 24px);height:calc(100dvh - 24px);margin:12px';
  chat.innerHTML = '<header class="chat-head"></header><div class="timeline" tabindex="0"></div><div class="composer"><textarea></textarea></div>';
  document.body.append(chat);
  const wb = new Workbench({chat, notify:message=>{throw Error(message);}, request:async () => ({
    kind:'binary', name:'app.apk', size
  })});
  wb.provider = provider;
  wb.open(provider ? 'fixture-download' : '11111111-1111-4111-8111-111111111111', 'local');
  await wb.preview(wb.current, {name:'app.apk', path:'build/app.apk'});
  const link = chat.querySelector('.wb-download');
  if (!link || link.download !== 'app.apk') throw Error('APK preview must offer a download');
};
