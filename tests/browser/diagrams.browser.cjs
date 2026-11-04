'use strict';
// 由 test-chat-followups-browser.cjs --diagrams 在合成网关的真实生产页面中执行。
const assert=require('node:assert/strict'),path=require('node:path');
const flow=`flowchart TD
    A[你提供 spec／PRD、项目位置和授权范围] --> B[检查项目现状与开发环境]
    B --> C[建立基线、明确要求和完成条件]
    C --> D[设计接口、拆分任务与依赖]
    D --> E[auto agent 安排开发聊天]
    E --> F[按适用框架技能实现、测试和评审]
    F --> G{要求是否满足<br/>结果是否有效}
    G -- 否 --> H[补齐、修复或处理阻塞]
    H --> F
    G -- 是 --> I[排队集成并执行整合后检查]
    I --> J{PRD 完成条件是否全部满足}
    J -- 否 --> D
    J -- 是 --> K[交付成果、说明和证据]
    K --> L[回收符合条件的任务工作区]`;
const sequence='sequenceDiagram\n    用户->>网关: 读取聊天\n    网关-->>用户: 返回历史';
const fence=source=>'```mermaid\n'+source+'\n```';
const clipboard=async page=>(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n');
async function copyCard(page,card,text){
  const button=card.locator('.diagram-copy');await button.click();
  await button.evaluate(node=>!node.disabled?null:new Promise(resolve=>{const observer=new MutationObserver(()=>{if(!node.disabled){observer.disconnect();resolve();}});observer.observe(node,{attributes:true,attributeFilter:['disabled']});}));
  assert.equal(await clipboard(page),text);
}
const messages=[{key:'diagrams',role:'assistant',kind:'agentMessage',text:fence(flow)+'\n\n```js\nconsole.log("普通代码");\n```\n\n'+fence(sequence)}];
const longCases=[{key:'truncated-diagram',preview:'合成长消息\n\n```mermaid\nflowchart TD\n A[完整中文开始] --> B[截断',suffix:'后补全的结束节点]\n```'}];
const imageReady=async card=>{
  await card.locator('img').waitFor({state:'attached',timeout:35000});
  await card.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0?null:new Promise((resolve,reject)=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',()=>reject(Error('SVG 图片加载失败')),{once:true});}));
};
const svg=card=>card.locator('img').evaluate(image=>new TextDecoder().decode(Uint8Array.from(atob(image.src.split(',')[1]),c=>c.charCodeAt(0))));

async function run({page,context,base,width,theme,test,open,selectMain,selectSide,longSession,first,errors,external,screenshots}){
  const suffix=width+' / '+theme,root=page.locator('#messages');
  const card=root.locator('.diagram-card').first();
  page.setDefaultTimeout(10000);
  await test('截图流程图真实绘制、中文节点与普通代码混排 '+suffix,async()=>{
    await imageReady(card);await imageReady(root.locator('.diagram-card').nth(1));
    const content=await svg(card);
    const stats=await page.evaluate(content=>{const doc=new DOMParser().parseFromString(content,'image/svg+xml');return {nodes:doc.querySelectorAll('.node').length,text:doc.documentElement.textContent,active:doc.querySelectorAll('foreignObject,script,a,image').length};},content);
    assert.equal(stats.nodes,12);assert.equal(stats.active,0);
    assert.ok(stats.text.includes('要求是否满足')&&stats.text.includes('结果是否有效')&&stats.text.includes('回收符合条件'));
    assert.ok(!stats.text.includes('<br/>'),'节点换行不能显示为 HTML 原码');
    assert.equal(await root.locator('.diagram-card').count(),2);
    assert.ok((await root.locator('.code-block').allTextContents()).some(text=>text.includes('console.log("普通代码")')));
    assert.equal(await page.evaluate(()=>typeof window.mermaid),'undefined','Mermaid 不能在主页面执行');
    assert.equal(await page.locator('iframe.diagram-renderer-frame').count(),1);
    assert.equal(await card.locator('.diagram-viewport').evaluate(node=>node.clientHeight<=360),true);
  });
  await test('图表切换、原始源码真实复制与页面边界 '+suffix,async()=>{
    await card.locator('.diagram-source').click();await card.locator('pre').waitFor({state:'visible'});
    assert.equal(await card.locator('pre').textContent(),flow+'\n');
    await copyCard(page,card,flow+'\n');
    await card.locator('.diagram-graph').click();assert.equal(await card.locator('pre').isVisible(),false);
    const bounds=await card.boundingBox(),parent=await root.boundingBox();
    assert.ok(bounds.x>=parent.x-1&&bounds.x+bounds.width<=parent.x+parent.width+1,'卡片不得横向撑破聊天区');
    assert.equal(await card.locator('.diagram-expand').isVisible(),true);
    if(screenshots)await card.screenshot({path:path.join(screenshots,'diagram-'+width+'-'+theme+'.png')});
  });
  await test('大图缩放、拖动、实际大小、适应屏幕与阅读位置 '+suffix,async()=>{
    const enlarge=card.locator('.diagram-enlarge');await enlarge.scrollIntoViewIfNeeded();
    const before=await root.evaluate(node=>node.scrollTop);await enlarge.click();
    const dialog=page.locator('#image-preview-dialog');await dialog.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('#image-preview-dialog img')?.naturalWidth>0&&document.querySelector('#image-preview-zoom-in')?.disabled===false);
    await page.locator('#image-preview-zoom-in').click();
    assert.equal(await page.locator('#image-preview-scale').textContent(),'125%');
    const content=page.locator('.image-preview-content'),area=await content.boundingBox();
    const transform=await dialog.locator('img').evaluate(node=>node.style.transform);
    await page.mouse.move(area.x+area.width/2,area.y+area.height/2);await page.mouse.down();await page.mouse.move(area.x+area.width/2,area.y+area.height/2+60,{steps:5});await page.mouse.up();
    await page.waitForFunction(prior=>document.querySelector('#image-preview-dialog img').style.transform!==prior,transform);
    await page.locator('#image-preview-reset').click();
    assert.equal(await dialog.locator('img').evaluate(node=>Math.abs(node.getBoundingClientRect().width-node.naturalWidth)<2),true,'重置应恢复实际大小');
    await page.locator('#image-preview-fit').click();await page.waitForFunction(()=>document.querySelector('#image-preview-scale').textContent==='100%');
    if(width<1280){
      // 真实 Chromium 触屏事件，验证两指缩放和触摸取消的清理。
      const cdp=await context.newCDPSession(page),x=Math.round(area.x+area.width/2),y=Math.round(area.y+area.height/2);
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:x-35,y,id:1},{x:x+35,y,id:2}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-70,y,id:1},{x:x+70,y,id:2}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForFunction(()=>parseInt(document.querySelector('#image-preview-scale').textContent)>150);
      await cdp.detach();
    }
    await page.locator('#image-preview-close').click();await dialog.waitFor({state:'hidden'});
    assert.ok(Math.abs(await root.evaluate(node=>node.scrollTop)-before)<2,'关闭大图必须保留阅读位置');
    assert.equal(await enlarge.evaluate(node=>document.activeElement===node),true,'焦点应返回放大按钮');
    await card.locator('.diagram-expand').click();await dialog.waitFor({state:'visible'});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  });
  await test('侧边聊天、Claude 和 DeepSeek 使用同一图表交互 '+suffix,async()=>{
    await selectSide(page);
    const side=page.locator('.wb-side-messages:visible .diagram-card').first();await imageReady(side);
    await copyCard(page,side,flow+'\n');
    for(const provider of ['claude','deepseek']){
      await open(page,first,provider);await selectMain(page,'desktop');
      const diagram=page.locator('.ds-messages .diagram-card').first();await imageReady(diagram);
      await diagram.locator('.diagram-source').click();assert.equal(await diagram.locator('pre').textContent(),flow+'\n');
    }
    await open(page,first);await selectMain(page,'main');await imageReady(root.locator('.diagram-card').first());
    // 相同历史重复刷新不会累积卡片或沙箱。
    await page.evaluate(()=>chatTimeline.apply({epoch:chatTimeline.epoch,sequence:chatTimeline.sequence,meta:chatTimeline.meta,rows:[...chatTimeline.rows.values()].map(entry=>entry.row),files:[],hasMore:false}));
    assert.equal(await root.locator('.diagram-card').count(),2);assert.equal(await page.locator('iframe.diagram-renderer-frame').count(),1);
  });
  await test('流式围栏闭合、无标记和外层代码示例 '+suffix,async()=>{
    const result=await page.evaluate(async()=>{
      document.querySelector('#diagram-test-host')?.remove();
      const host=document.createElement('div');host.id='diagram-test-host';document.body.append(host);
      const render=text=>{host.replaceChildren();renderMarkdown(host,text,[],()=>'',{complete:false});};
      render('```mermaid\nflowchart TD\n A --> B');await new Promise(resolve=>setTimeout(resolve,100));
      const pending=!host.querySelector('img')&&host.textContent.includes('等待代码完整');
      render('```mermaid\nflowchart TD\n A --> B\n```\n\n仍在生成后续文字');
      return {pending};
    });
    assert.equal(result.pending,true);await imageReady(page.locator('#diagram-test-host .diagram-card'));
    const count=await page.evaluate(()=>{const host=document.querySelector('#diagram-test-host');host.replaceChildren();renderMarkdown(host,'```text\nflowchart TD\nA-->B\n```\n\n````md\n```mermaid\nflowchart TD\nA-->B\n```\n````');return host.querySelectorAll('.diagram-card').length;});
    assert.equal(count,0);await page.locator('#diagram-test-host').evaluate(node=>node.remove());
    await page.evaluate(()=>{const host=document.createElement('div');host.id='diagram-test-host';document.body.append(host);renderMarkdown(host,'```mermaid\nflowchart TD\n A-->B');});
    const final=page.locator('#diagram-test-host .diagram-card');await final.locator('pre').waitFor({state:'visible'});
    assert.ok((await final.innerText()).includes('尚未闭合'));await copyCard(page,final,'flowchart TD\n A-->B');
    await page.locator('#diagram-test-host').evaluate(node=>node.remove());
  });
  await test('长消息先补全再绘图，复制取得完整源码 '+suffix,async()=>{
    await open(page,longSession);const pending=root.locator('.diagram-card');
    await pending.waitFor({state:'attached'});assert.equal(await pending.locator('img').count(),0);
    await pending.locator('.diagram-retry').click();await imageReady(pending);
    await copyCard(page,pending,'flowchart TD\n A[完整中文开始] --> B[截断后补全的结束节点]\n');
    await open(page,first);await selectMain(page,'main');
  });
  await test('语法错误、配置注入和恶意 HTML 均安全回退 '+suffix,async()=>{
    const sources=['not-a-valid-diagram\n A[未闭合 --> B',
      '%%{init: {"securityLevel":"loose","themeCSS":"body{background:url(https://evil.invalid/leak)}"}}%%\nflowchart TD\n A-->B',
      '---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\n A-->B',
      'flowchart TD\n A["<img src=https://evil.invalid/leak onerror=alert(1)>恶意文字"] --> B[结束]\n click A "https://evil.invalid/click"',
      'flowchart TD\n A[开始] --> B[结束]\n classDef evil fill:red,background-image:url(https://evil.invalid/css);\n class A evil'];
    await page.evaluate(sources=>{document.querySelector('#diagram-test-host')?.remove();const host=document.createElement('div');host.id='diagram-test-host';document.body.append(host);for(const source of sources)renderMarkdown(host,'```mermaid\n'+source+'\n```');},sources);
    const cards=page.locator('#diagram-test-host .diagram-card');
    await cards.nth(0).locator('pre').waitFor({state:'visible',timeout:35000});
    assert.ok((await cards.nth(0).innerText()).includes('图表加载失败'));
    for(const i of [1,2]){assert.ok((await cards.nth(i).innerText()).includes('不支持的配置'));assert.equal(await cards.nth(i).locator('img').count(),0);}
    await page.waitForFunction(()=>{const card=document.querySelectorAll('#diagram-test-host .diagram-card')[3];return card.querySelector('img')?.complete||card.querySelector('pre:not([hidden])');});
    if(await cards.nth(3).locator('img').count()){
      const rendered=await svg(cards.nth(3));assert.ok(!rendered.includes('<image')&&!rendered.includes('<script')&&!rendered.includes('<a '));
    }else assert.ok((await cards.nth(3).innerText()).includes('图表加载失败'));
    await page.waitForFunction(()=>{const card=document.querySelectorAll('#diagram-test-host .diagram-card')[4];return card.querySelector('img')?.complete||card.querySelector('pre:not([hidden])');});
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    await page.locator('#diagram-test-host').evaluate(node=>node.remove());
  });
  await test('主题切换后重新绘图 '+suffix,async()=>{
    const current=root.locator('.diagram-card').first();await imageReady(current);const before=await current.locator('img').getAttribute('src');
    await page.evaluate(()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark');
    await page.waitForFunction(before=>document.querySelector('#messages .diagram-card img')?.src!==before,before);
    await imageReady(current);assert.notEqual(await current.locator('img').getAttribute('src'),before);
  });
  await test('英文界面按钮和图表预览无横向溢出 '+suffix,async()=>{
    await page.evaluate(()=>{BridgeI18n.setLanguage('en');BridgeI18n.apply();});
    const current=root.locator('.diagram-card').first();assert.equal(await current.locator('.diagram-copy').textContent(),'Copy source');
    const bounds=await current.boundingBox(),parent=await root.boundingBox();assert.ok(bounds.x+bounds.width<=parent.x+parent.width+1);
    await current.locator('.diagram-enlarge').click();await page.locator('#image-preview-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#image-preview-reset').textContent(),'Reset');
    const controls=await page.locator('.image-preview-controls').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));assert.ok(controls.scroll<=controls.width,'英文大图工具栏不能超出屏幕');
    if(width===390){
      await page.setViewportSize({width:320,height:900});
      await page.waitForFunction(()=>{const node=document.querySelector('.image-preview-controls');return node.scrollWidth<=node.clientWidth;});
      await page.setViewportSize({width,height:900});
    }
    await page.locator('#image-preview-close').click();await page.evaluate(()=>{BridgeI18n.setLanguage('zh');BridgeI18n.apply();});
  });
  await test('原有图片缩放与注册边界回归 '+suffix,async()=>{
    const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=innerWidth*2;canvas.height=(innerHeight-200)*2;canvas.getContext('2d').fillRect(0,0,canvas.width,canvas.height);return canvas.toDataURL('image/png').split(',')[1];});
    const pattern='**/uploads/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/preview*';
    await page.route(pattern,route=>route.fulfill({status:200,contentType:'image/png',body:Buffer.from(png,'base64')}));
    await page.addScriptTag({url:base+'/image-zoom-fixture.js'});
    const checks=await page.evaluate(()=>runImageZoomTests());assert.ok(checks.length>=25,'必须实际运行图片查看器的交互断言');
    assert.equal(await page.locator('#image-preview-reset').isVisible(),false,'普通图片不应出现图表的重置按钮');
    await page.unroute(pattern);
  });
  await test('依赖加载失败保留源码并允许显式重试 '+suffix,async()=>{
    const fresh=await context.newPage();
    await fresh.route('**/vendor/mermaid/mermaid.min.js',route=>route.fulfill({status:503,body:'fixture failure'}));
    await fresh.goto(base);await fresh.waitForFunction(()=>listReadFinished);await open(fresh);await selectMain(fresh,'main');
    const broken=fresh.locator('#messages .diagram-card').first();await broken.locator('pre').waitFor({state:'visible'});
    assert.ok((await broken.innerText()).includes('图表加载失败'));assert.ok((await broken.locator('pre').textContent()).includes('你提供'));
    await fresh.unroute('**/vendor/mermaid/mermaid.min.js');await broken.locator('.diagram-retry').click();await imageReady(broken);
    await fresh.close();
  });
}
module.exports={messages,longCases,run};
