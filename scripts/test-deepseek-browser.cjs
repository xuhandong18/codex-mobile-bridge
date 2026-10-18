'use strict';
// Isolated Chromium/DOM regression. Never attaches to an installed client or model.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web'),assets=require('../web/assets.json');
const fixture=fs.readFileSync(path.join(root,'tests/browser/deepseek-personal.browser.js'),'utf8');
const html=fs.readFileSync(path.join(web,'index.html'),'utf8')
  .replace(/<script[^>]+src="\/(?:bootstrap|presentation)\.js[^"]*"[^>]*><\/script>/g,'')
  .replace('</body>','<script src="/fixture.js" defer></script></body>');
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(fixture+'\nwindow.__dshReady=createDeepSeekBrowserFixture();');}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
  let parts=assets[url.pathname];if(!parts&&url.pathname.startsWith('/vendor/')&&!url.pathname.includes('..'))parts=url.pathname.slice(1);
  if(!parts&&/^\/client-icons\/(codex|claude|deepseek)\.png$/.test(url.pathname))parts=url.pathname.slice(1);
  if(!parts){res.writeHead(404);return res.end();}
  parts=[].concat(parts).filter(file=>file!=='shell/app.js');
  res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.png')?'image/png':'application/octet-stream');
  res.end(Buffer.concat(parts.map(file=>fs.readFileSync(path.join(web,file)))));
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true}),results=[];
  try{
    for(const [width,height]of [[1280,900],[390,844],[820,1180],[844,390]]){
      const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.evaluate(()=>window.__dshReady);
      const result=await page.evaluate(()=>runDeepSeekPersonalBrowserTests());assert.deepEqual(errors,[]);results.push({width,height,...result});
      if(process.argv.includes('--screenshots')){fs.mkdirSync(path.join(root,'.tmp'),{recursive:true});await page.screenshot({path:path.join(root,'.tmp',`deepseek-browser-${width}.png`)});}
      await context.close();
    }
    console.log(JSON.stringify({passed:results.reduce((n,r)=>n+r.passed,0),viewports:results},null,2));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
