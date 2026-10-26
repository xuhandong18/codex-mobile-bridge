'use strict';
// Real production workspace modules with synthetic file data only.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname,'..'), web = path.join(root,'web'), assets = require('../web/assets.json');
const scripts = ['/host.js','/layout.js','/i18n.js','/message-actions.js','/vendor/markdown-it.min.js','/vendor/katex/katex.min.js','/vendor/texmath.js','/markdown.js','/app.js','/file-actions.js','/workbench.js','/fixture.js'];
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench.css"></head><body>'+scripts.map(src=>'<script defer src="'+src+'"></script>').join('')+'</body></html>';
const server = http.createServer((req,res) => {
  const url = new URL(req.url,'http://localhost');
  if (url.pathname === '/') {res.setHeader('Content-Type','text/html');return res.end(html);}
  if (url.pathname === '/fixture.js') {res.setHeader('Content-Type','text/javascript');return res.end(fs.readFileSync(path.join(root,'tests/browser/markdown-edit.browser.js')));}
  let parts = assets[url.pathname] || (['/vendor/markdown-it.min.js','/vendor/katex/katex.min.js','/vendor/texmath.js'].includes(url.pathname) ? url.pathname.slice(1) : null);
  if (!parts) {res.writeHead(404);return res.end();}
  parts = [].concat(parts).filter(file=>file !== 'shell/app.js');
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'application/octet-stream');
  res.end(Buffer.concat(parts.map(file=>fs.readFileSync(path.join(web,file)))));
});
(async () => {
  // Use a high dynamic port; Windows can otherwise assign a Chromium-blocked port.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await new Promise((resolve,reject) => {
        server.once('error',reject);
        server.listen(49152+Math.floor(Math.random()*16384),'127.0.0.1',() => {server.removeListener('error',reject);resolve();});
      });
      break;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  if (!server.listening) throw Error('No available test port');
  let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
    const results = [];
    for (const [width,height] of [[320,780],[390,844],[768,1024],[1024,900],[1440,960],[844,390]]) {
      for (const language of ['zh','en']) {
        const context = await browser.newContext({viewport:{width,height}}), page = await context.newPage(), errors = [];
        page.on('pageerror',error=>errors.push(error.message));
        await page.goto('http://127.0.0.1:'+server.address().port+'/');
        await page.evaluate(language=>BridgeI18n.setLanguage(language),language);
        const result = await page.evaluate(()=>runMarkdownEditBrowserChecks());
        const textarea = page.locator('.wb-md-input'); await textarea.focus();
        await page.keyboard.press('Control+A'); await page.keyboard.insertText('键盘快捷键'); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+B');
        assert.equal(await textarea.inputValue(),'**键盘快捷键**');
        await page.keyboard.press('Control+z'); assert.equal(await textarea.inputValue(),'键盘快捷键');
        await page.keyboard.press('Control+Shift+z'); assert.equal(await textarea.inputValue(),'**键盘快捷键**');
        await page.keyboard.press('Control+s');
        assert.equal(await page.evaluate(()=>markdownFixture.editor.dirty),false);
        await page.keyboard.press('Escape'); await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(()=>document.activeElement === markdownFixture.editor.input),false);
        await page.waitForTimeout(220);
        // Capture the finished layout as well as verifying real keyboard input.
        if (process.argv.includes('--screenshots') && language === 'zh') {
          await page.screenshot({path:path.join(root,'.tmp','markdown-edit-'+width+'.png')});
        }
        assert.deepEqual(errors,[]); results.push({width,height,language,passed:result.passed+5});
        await page.evaluate(()=>{markdownFixture.wb.reset();markdownFixture.chat.remove();}); await context.close();
      }
    }
    console.log(JSON.stringify({passed:results.reduce((sum,result)=>sum+result.passed,0),viewports:results},null,2));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
