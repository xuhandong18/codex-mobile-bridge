'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),assets=require('../web/assets.json');
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><style>
body{margin:0}#app{display:block!important;height:100vh}#chat{display:block!important;width:min(100%,900px);margin:auto;position:relative}
#timeline{display:block!important;box-sizing:border-box;width:100%;height:calc(100vh - 150px);overflow:auto;padding:12px 28px 12px 12px}
#composer{height:140px;background:#eee}#messages .message-body{white-space:pre-wrap}.chat-message-map-panel{box-sizing:border-box}
button[hidden]{display:none!important}.timeline-row{overflow-wrap:anywhere}
</style><div id="app"><section id="chat"><div id="timeline" class="timeline"><button id="older"></button><div id="messages"></div></div>
<button id="newer" class="newer" hidden></button><div id="composer">输入框</div></section></div>
<script src="/timeline.js"></script><script src="/fixture.js"></script><script src="/legacy.js"></script>`;
const server=http.createServer((req,res)=>{
  const p=new URL(req.url,'http://127.0.0.1').pathname;
  if(p==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');res.end(html);return;}
  if(p.startsWith('/fixture/desktop-images/')){res.setHeader('Content-Type','image/png');res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=','base64'));return;}
  const files=p==='/fixture.js'?['tests/browser/message-navigation.browser.js']:p==='/legacy.js'?['tests/browser/timeline.browser.js']:
    assets[p]?[].concat(assets[p]).map(file=>'web/'+file):null;
  if(!files){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',p.endsWith('.css')?'text/css':'text/javascript');res.end(files.map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n'));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;const checks=[],errors=[];
  const check=(ok,label)=>{assert.ok(ok,label);checks.push(label);};
  try{
    browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    for(const width of [390,820,1280]){
      const touch=width<1000,context=await browser.newContext({viewport:{width,height:760},hasTouch:touch}),page=await context.newPage();
      page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
      await page.goto('http://127.0.0.1:'+server.address().port);
      const first=await page.evaluate(()=>setupMessageNavigationFixture());
      check(first.firstRows===20&&first.indexBusy&&first.entryVisible,'工具记录首屏保留目录入口和整理状态 '+width);
      await page.waitForFunction(()=>navigationFixture.timeline.messageIndex.size===5000&&!navigationFixture.timeline.indexBusy);
      const size=await page.evaluate(()=>({body:navigationFixture.timeline.rows.size,markers:document.querySelectorAll('.chat-message-map button').length,
        requests:navigationFixture.requests.filter(r=>r.action==='timeline').length,index:navigationFixture.requests.filter(r=>r.action==='message-index').length}));
      check(size.body<=100&&size.markers<100&&size.requests<=2&&size.index===25,'自动取得5000条目录，正文和目录DOM保持有界 '+width);
      const activate=async selector=>touch?page.locator(selector).tap():page.locator(selector).click();
      await activate('.chat-message-map-rail button[data-key="u0"]');
      await page.waitForFunction(()=>navigationFixture.timeline.navigationMode&&navigationFixture.timeline.nodes.has('q0'));
      check(await page.evaluate(()=>Math.abs(navigationFixture.timeline.nodes.get('q0').node.getBoundingClientRect().top-document.querySelector('#timeline').getBoundingClientRect().top)<80),'单次点击准确跳最早消息 '+width);
      await activate('#messages [data-key="q0"] .message-edit');
      check(await page.evaluate(()=>navigationFixture.actions.some(item=>item.action==='edit-fork'&&item.key==='q0')),'导航定位后的历史提问仍有编辑分支入口 '+width);
      const forward=await page.evaluate(()=>({after:navigationFixture.timeline.after,last:[...navigationFixture.timeline.nodes.keys()].at(-1)}));
      await page.evaluate(()=>{const t=navigationFixture.timeline;t.viewport.scrollTop=t.viewport.scrollHeight;t.viewport.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(after=>navigationFixture.timeline.after!==after&&!navigationFixture.timeline.navigationBusy,forward.after);
      check(await page.evaluate(last=>navigationFixture.timeline.nodes.has(last)&&navigationFixture.timeline.rows.size<=200,forward.last),'向下滚动自动补后续正文并保留相邻内容 '+width);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.evaluate(()=>{const t=navigationFixture.timeline;t.viewport.scrollTop=t.viewport.scrollHeight;t.viewport.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(()=>!navigationFixture.timeline.nodes.has('q0')&&!navigationFixture.timeline.navigationBusy);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.evaluate(()=>{const t=navigationFixture.timeline;t.viewport.scrollTop=0;t.viewport.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(()=>navigationFixture.timeline.nodes.has('q0')&&!navigationFixture.timeline.navigationBusy);
      check(await page.evaluate(()=>navigationFixture.timeline.rows.size<=200),'向上滚动也自动补历史且正文窗口保持有界 '+width);
      await page.evaluate(()=>{const rail=document.querySelector('.chat-message-map-rail');rail.scrollTop=2500*7;rail.dispatchEvent(new Event('scroll'));});
      await activate('.chat-message-map-rail button[data-key="u2500"]');
      await page.waitForFunction(()=>navigationFixture.timeline.nodes.has('q2500')&&!navigationFixture.timeline.navigationBusy);
      check(await page.evaluate(()=>navigationFixture.timeline.rows.size<=100&&!navigationFixture.timeline.rows.has('q0')),'滚动虚拟目录并直接跳中间消息 '+width);
      await page.evaluate(()=>{navigationFixture.timeline.messageMap.root.classList.add('is-open');navigationFixture.timeline.messageMap.paint(navigationFixture.timeline.messageMap.list,44);});
      const bounds=await page.locator('.chat-message-map-panel').boundingBox(),composer=await page.locator('#composer').boundingBox();
      check(bounds.x>=0&&bounds.x+bounds.width<=width+1&&bounds.y+bounds.height<=composer.y+1,'展开目录适配聊天区域和输入框 '+width);
      const count=await page.evaluate(()=>navigationFixture.requests.filter(r=>r.params.around).length);
      await page.evaluate(()=>navigationFixture.timeline.navigateMessage(navigationFixture.timeline.directoryRows().find(e=>e.id==='u2500')));
      check(await page.evaluate(()=>navigationFixture.requests.filter(r=>r.params.around).length)===count,'已加载消息直接定位无需再读正文 '+width);
      const anchor=await page.evaluate(()=>({key:navigationFixture.timeline.capture().key,top:navigationFixture.timeline.viewport.scrollTop}));
      await page.evaluate(()=>navigationFixture.live());
      await page.waitForFunction(()=>navigationFixture.timeline.newer.textContent==='有新内容 ↓');
      check(await page.evaluate(anchor=>navigationFixture.timeline.capture().key===anchor.key&&Math.abs(navigationFixture.timeline.viewport.scrollTop-anchor.top)<2&&!navigationFixture.timeline.nodes.has('new2'),anchor),'实时回复保留历史阅读位置并提示新内容 '+width);
      await activate('#newer');await page.waitForFunction(()=>!navigationFixture.timeline.navigationMode&&!navigationFixture.timeline.navigationBusy);
      check(await page.evaluate(()=>navigationFixture.timeline.atBottom()&&navigationFixture.timeline.rows.size<=100),'点击新内容才返回最新窗口 '+width);
      await page.evaluate(()=>{navigationFixture.hold(3);navigationFixture.hold(4);navigationFixture.timeline.navigateMessage(navigationFixture.entry(3));navigationFixture.timeline.navigateMessage(navigationFixture.entry(4));});
      await page.evaluate(()=>navigationFixture.release(4));await page.waitForFunction(()=>navigationFixture.timeline.nodes.has('q4'));
      await page.evaluate(()=>navigationFixture.release(3));await page.waitForTimeout(80);
      check(await page.evaluate(()=>navigationFixture.timeline.nodes.has('q4')&&navigationFixture.timeline.capture().key==='q4'),'快速连续选择以最后一次点击为准 '+width);
      await page.evaluate(()=>{navigationFixture.hold(4500);navigationFixture.timeline.navigateMessage(navigationFixture.entry(4500));navigationFixture.timeline.navigateMessage(navigationFixture.entry(4));navigationFixture.release(4500);});
      await page.waitForTimeout(80);
      check(await page.evaluate(()=>navigationFixture.timeline.nodes.has('q4')&&!navigationFixture.timeline.nodes.has('q4500')),'点击已加载消息也取消之前的跳转 '+width);
      await page.evaluate(async()=>{navigationFixture.failJump(4300);await navigationFixture.timeline.navigateMessage(navigationFixture.entry(4300));});
      check(await page.evaluate(()=>navigationFixture.timeline.nodes.has('q4')&&navigationFixture.errors.includes('Message window network failure')),'窗口网络失败保留原阅读位置并明确提示 '+width);
      await page.evaluate(()=>navigationFixture.timeline.navigateMessage(navigationFixture.entry(4300)));
      check(await page.evaluate(()=>navigationFixture.timeline.nodes.has('q4300')),'失败后再次选择能够准确重试 '+width);
      await page.evaluate(()=>{navigationFixture.hold(4400);navigationFixture.timeline.navigateMessage(navigationFixture.entry(4400));navigationFixture.timeline.dispose();navigationFixture.release(4400);});
      await page.waitForTimeout(80);
      check(await page.evaluate(()=>!navigationFixture.timeline.nodes.has('q4400')&&!document.querySelector('.chat-message-map')),'切换聊天后丢弃过期回包 '+width);
      await page.evaluate(()=>setupMessageNavigationFixture({count:500,failIndex:true}));
      await page.waitForFunction(()=>navigationFixture.timeline.indexError&&!navigationFixture.timeline.indexBusy);
      check(await page.evaluate(()=>navigationFixture.timeline.messageIndex.size===200),'目录分页失败保留已取得的摘要 '+width);
      await page.evaluate(()=>{navigationFixture.timeline.messageMap.root.classList.add('is-open');});
      await activate('.chat-message-map-status');
      await page.waitForFunction(()=>navigationFixture.timeline.messageIndex.size===500&&!navigationFixture.timeline.indexBusy);
      check(await page.evaluate(()=>!navigationFixture.timeline.indexError),'点击重试自动补齐目录 '+width);
      await page.evaluate(()=>navigationFixture.timeline.navigateMessage(navigationFixture.entry(2)));
      check(await page.evaluate(()=>navigationFixture.timeline.nodes.get('q2').node.textContent.includes('attachment.png')),'纯附件消息有目录摘要并能定位 '+width);
      await page.waitForFunction(()=>navigationFixture.timeline.nodes.get('q2').node.querySelector('img')?.naturalWidth>0);
      check(await page.evaluate(()=>!!navigationFixture.timeline.nodes.get('q2').node.querySelector('a[data-image-preview]')),'导航定位后图片实际加载并保留原图入口 '+width);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.evaluate(()=>{navigationFixture.failPage('after');const t=navigationFixture.timeline;t.viewport.scrollTop=t.viewport.scrollHeight;t.viewport.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(()=>navigationFixture.errors.includes('Page network failure')&&!navigationFixture.timeline.navigationBusy);
      const failedReads=await page.evaluate(()=>navigationFixture.requests.length);
      await page.evaluate(()=>navigationFixture.timeline.viewport.dispatchEvent(new Event('scroll')));
      check(await page.evaluate(()=>navigationFixture.requests.length)===failedReads,'分页失败后不会因滚动事件重复请求 '+width);
      await page.evaluate(()=>navigationFixture.timeline.later.click());
      await page.waitForFunction(()=>navigationFixture.timeline.after!=='nav.w.100'&&!navigationFixture.timeline.navigationBusy);
      check(await page.evaluate(()=>navigationFixture.timeline.nodes.has('q2')),'分页显式重试恢复后仍保留相邻阅读内容 '+width);
      await page.evaluate(()=>navigationFixture.timeline.navigateMessage(navigationFixture.entry(499)));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.evaluate(()=>{const t=navigationFixture.timeline;t.viewport.scrollTop=t.viewport.scrollHeight;t.viewport.dispatchEvent(new Event('scroll'));});
      await page.waitForFunction(()=>!navigationFixture.timeline.navigationMode&&!navigationFixture.timeline.navigationBusy);
      check(await page.evaluate(()=>navigationFixture.timeline.atBottom()),'主动滚到历史末尾自动回到最新内容 '+width);
      await page.evaluate(()=>setupMessageNavigationFixture());
      await page.waitForFunction(()=>navigationFixture.timeline.messageIndex.size===5000&&!navigationFixture.timeline.indexBusy);
      check(await page.evaluate(()=>navigationFixture.timeline.rows.size<=100),'重新打开后恢复完整目录且不加载全部正文 '+width);
      await page.evaluate(()=>navigationFixture.timeline.dispose());
      await page.reload();
      for(const name of ['runTimelineTests','runTimelineVisibilityTests','runReasoningSummaryTests','runQuestionReadingScrollTests']){
        const assertions=await page.evaluate(name=>window[name](),name);check(assertions.length>0,name+' 实际执行 '+assertions.length+' 项 '+width);
      }
      await context.close();
    }
    check(errors.length===0,'浏览器无脚本异常：'+errors.join('; '));
    console.log(JSON.stringify({passed:checks.length,checks},null,2));
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
