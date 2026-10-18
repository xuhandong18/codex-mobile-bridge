'use strict';
// Runs only synthetic file previews. No installed client, model, or user file access.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..'), web = path.join(root, 'web'), assets = require('../web/assets.json');
const fixture = fs.readFileSync(path.join(root, 'tests/browser/file-refresh.browser.js'), 'utf8');
const scripts = ['/host.js', '/layout.js', '/i18n.js', '/vendor/markdown-it.min.js', '/vendor/katex/katex.min.js', '/vendor/texmath.js', '/markdown.js', '/app.js', '/vendor/prism/source-view.min.js', '/source-view.js', '/pdf-preview.js', '/html-preview.js', '/workbench.js', '/fixture.js'];
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workbench.css"></head><body>' + scripts.map(src=>'<script defer src="' + src + '"></script>').join('') + '</body></html>';
const csp = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
let pdfRevision = 1;
function pdfBytes() {
  const stream = 'BT /F1 20 Tf 50 740 Td (PDF revision ' + pdfRevision + ') Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let text = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset=>String(offset).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(text);
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'); res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
  if (url.pathname === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fixture); }
  if (url.pathname === '/fixture/pdf-revision') { pdfRevision = Number(url.searchParams.get('value')); return res.end('ok'); }
  if (url.pathname.startsWith('/api/sessions/') && url.pathname.endsWith('/workspace/download') && url.searchParams.get('path') === 'document.pdf') {
    const bytes = pdfBytes(); res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Length', bytes.length); return res.end(bytes);
  }
  if (url.pathname === '/html-preview-shell') { res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', csp); return res.end(fs.readFileSync(path.join(web, 'features/workspace/html-preview-shell.html'))); }
  let parts = assets[url.pathname];
  if (!parts && url.pathname.startsWith('/vendor/') && !url.pathname.includes('..')) parts = url.pathname.slice(1);
  if (!parts) { res.writeHead(404); return res.end(); }
  parts = [].concat(parts).filter(file=>file !== 'shell/app.js');
  res.setHeader('Content-Type', /\.m?js$/.test(url.pathname) ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(Buffer.concat(parts.map(file=>fs.readFileSync(path.join(web, file)))));
});
(async () => {
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {})});
    const results = [];
    for (const [width, height] of [[1280,900], [390,844], [820,1180], [844,390]]) {
      for (const language of ['zh', 'en']) {
        const context = await browser.newContext({viewport:{width, height}}), page = await context.newPage(), errors = [];
        page.on('pageerror', error=>errors.push(error.message));
        await page.goto('http://127.0.0.1:' + server.address().port + '/');
        await page.evaluate(language=>BridgeI18n.setLanguage(language), language);
        if (process.argv.includes('--screenshots')) await page.exposeFunction('captureFileRefresh', async () => {
          fs.mkdirSync(path.join(root, '.tmp'), {recursive:true});
          await page.screenshot({path:path.join(root, '.tmp', 'file-refresh-' + width + '-' + language + '.png')});
        });
        const result = await page.evaluate(()=>runFileRefreshBrowserChecks()); assert.deepEqual(errors, []);
        results.push({width, height, language, ...result}); await context.close();
      }
    }
    console.log(JSON.stringify({passed:results.reduce((sum, result)=>sum + result.passed, 0), viewports:results}, null, 2));
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error); server.close(); process.exitCode = 1;});
