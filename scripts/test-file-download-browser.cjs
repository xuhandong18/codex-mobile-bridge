'use strict';
// Real preview clicks and browser transfers. Native user agents exercise navigation,
// not an installed WebView or the Android/iOS download manager.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'web'), assets = require('../web/assets.json');
const scripts = ['/host.js', '/layout.js', '/i18n.js', '/app.js', '/downloads.js', '/file-actions.js', '/workbench.js', '/fixture.js'];
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench.css"></head><body>' + scripts.map(src=>'<script defer src="' + src + '"></script>').join('') + '</body></html>';
const payload = Buffer.from('synthetic APK download fixture');
let fileSize = 0, requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(root, 'tests/browser/file-download.browser.js'))); }
  if (url.pathname.endsWith('/workspace/download')) {
    requests.push(url);
    // The gateway's ordinary-click policy; real HTTP/path checks live in test_download_ranges.py.
    if (fileSize > 20 * 1024 * 1024 && url.searchParams.get('explicit') !== '1') {
      res.writeHead(400, {'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:'文件超过下载限制'}));
    }
    res.writeHead(200, {'Content-Type':'application/octet-stream', 'Content-Length':payload.length,
      'Content-Disposition':'attachment; filename="app.apk"'});
    return res.end(payload);
  }
  const parts = assets[url.pathname];
  if (!parts) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
  res.end(Buffer.concat([].concat(parts).filter(file=>file !== 'shell/app.js').map(file=>fs.readFileSync(path.join(web, file)))));
});
(async () => {
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
    const results = [];
    for (const host of ['Android', 'iOS', 'browser']) {
      for (const provider of [undefined, 'claude', 'deepseek']) {
        for (const size of [Math.round(219.9 * 1024 * 1024), 1024]) {
          fileSize = size; requests = [];
          const context = await browser.newContext({viewport:{width:390, height:844}, acceptDownloads:true,
            ...(host === 'browser' ? {} : {userAgent:'Mozilla/5.0 BridgeMobile/0.1-' + host})});
          const page = await context.newPage(), errors = [];
          page.on('pageerror', error=>errors.push(error.message));
          await page.goto('http://127.0.0.1:' + server.address().port + '/');
          await page.evaluate(options=>prepareFileDownloadBrowserCheck(options), {provider, size});
          if (host === 'browser') {
            await page.locator('.wb-download').click();
            await page.locator('#download-panel .download-actions button:nth-child(2)').waitFor({state:'visible', timeout:3000});
          }
          const completed = page.waitForEvent('download', {timeout:3000}).catch(()=>null);
          await page.locator(host === 'browser' ? '#download-panel .download-actions button:nth-child(2)' : '.wb-download').click();
          const download = await completed;
          const scenario = JSON.stringify({host, provider:provider || 'codex', size, symptom:'点击下载没有完成传输', requests:requests.map(url=>url.pathname+url.search)});
          assert.ok(download, scenario);
          assert.equal(await download.failure(), null, scenario);
          assert.equal(download.suggestedFilename(), 'app.apk');
          const stream = await download.createReadStream(), chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          assert.deepEqual(Buffer.concat(chunks), payload);
          assert.equal(requests.length, 1);
          const url = requests[0];
          assert.equal(url.searchParams.get('path'), 'build/app.apk');
          if (provider) assert.equal(url.searchParams.get('sessionId'), 'fixture-download');
          else assert.equal(url.searchParams.get('host'), 'local');
          assert.deepEqual(errors, []);
          results.push({host, provider:provider || 'codex', size});
          await context.close();
        }
      }
    }
    console.log(JSON.stringify({passed:results.length, cases:results}, null, 2));
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error); server.close(); process.exitCode = 1;});
