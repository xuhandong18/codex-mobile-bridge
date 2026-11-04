'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
function fixture(){
  class Node{
    constructor(tag,text=''){this.tagName=tag.toUpperCase();this.children=[];this.data=text;this.dataset={};}
    append(...nodes){this.children.push(...nodes);}
    get textContent(){return this.data+this.children.map(node=>node.textContent).join('');}
    set textContent(value){this.data=String(value);this.children=[];}
    setAttribute(key,value){this[key]=value;}
    set innerHTML(value){assert.fail('消息不能作为 HTML 执行');}
  }
  const diagrams=[],copied=[],document={createElement:tag=>new Node(tag),createTextNode:text=>new Node('#text',text)};
  const context=vm.createContext({document,atob,BridgeI18n:{t:text=>text}});context.window=context;
  context.BridgeDiagrams={create(value){diagrams.push(value);const card=new Node('section');card.className='diagram-card';return card;}};
  context.BridgeClipboard={copy:async read=>copied.push(await read())};
  for(const name of ['web/vendor/markdown-it.min.js','web/vendor/texmath.js','web/shared/markdown.js'])vm.runInContext(fs.readFileSync(path.join(root,name),'utf8'),context);
  return {diagrams,copied,render(text,options={}){const node=new Node('div');context.renderMarkdown(node,text,[],()=>'',options);return node;}};
}
const fence=(content,marker='```')=>marker+'mermaid\n'+content+'\n'+marker;
const find=(root,predicate)=>root.children.flatMap(node=>[...(predicate(node)?[node]:[]),...find(node,predicate)]);

test('只识别明确的 Mermaid 围栏，普通代码和外层代码示例保持原文',()=>{
  const f=fixture();
  f.render('```js\nconst flowchart="TD";\n```\n\n'+fence('flowchart TD\n A-->B')+'\n\n~~~MERMAID\nsequenceDiagram\n A->>B: 中文\n~~~');
  assert.equal(f.diagrams.length,2);assert.ok(f.diagrams.every(d=>d.closed));
  assert.equal(f.diagrams[0].source,'flowchart TD\n A-->B\n');
  f.render('```text\nflowchart TD\n A-->B\n```\n\n````md\n'+fence('flowchart TD\n A-->B')+'\n````\n\n`mermaid`');
  assert.equal(f.diagrams.length,2);
});
test('流式仅等待未闭合围栏，后续正文仍在生成时前面的完整图表可以绘制',()=>{
  const f=fixture();
  for(const ending of ['','\n','\n``','\n``` extra'])f.render('```mermaid\nflowchart TD\n A-->B'+ending,{complete:false});
  assert.ok(f.diagrams.every(d=>!d.closed));
  for(const source of [fence('flowchart TD\n A-->B'),fence('flowchart TD\n A-->B','~~~~'),'> '+fence('flowchart TD\n A-->B').replaceAll('\n','\n> '),'- 图表\n\n  '+fence('flowchart TD\n A-->B').replaceAll('\n','\n  ')])f.render(source+'\n\n后续文字',{complete:false});
  assert.ok(f.diagrams.slice(4).every(d=>d.closed));
  f.render('````mermaid\nflowchart TD\n A-->B\n```');assert.equal(f.diagrams.at(-1).closed,false,'结束围栏不能比起始围栏短');
});
test('长消息图表和普通代码共用原始代码顺序，复制先取得完整正文',async()=>{
  const f=fixture(),prefix='```js\nfirst()\n```\n\n',short=prefix+'```mermaid\nflowchart TD\n A[截断',full=prefix+fence('flowchart TD\n A[截断后补全]-->B[结束]')+'\n\n```sh\nprintf done\n```';
  let reads=0;
  const node=f.render(short,{complete:false,truncated:true,fullText:async()=>{reads++;return full;}});
  assert.equal(f.diagrams[0].truncated,true);assert.equal(f.diagrams[0].closed,false);assert.equal(f.diagrams[0].canLoad,true);
  const value=await f.diagrams[0].getSource();assert.equal(value.source,'flowchart TD\n A[截断后补全]-->B[结束]\n');assert.equal(value.closed,true);
  await find(node,n=>n.className==='plain code-copy')[0].onclick();assert.deepEqual(f.copied,['first()\n']);assert.equal(reads,2);
  const next=f.render(full);await find(next,n=>n.className==='plain code-copy').at(-1).onclick();assert.equal(f.copied.at(-1),'printf done\n');
});
test('文稿中的图表沿用同一解析和完整源码定位',async()=>{
  const f=fixture(),source=':::writing{variant="standard"}\n'+fence('flowchart TD\n A-->B')+'\n:::\n\n'+fence('sequenceDiagram\n A->>B: 下一张');
  f.render(source,{writingBlocks:true,fullText:async()=>source});assert.equal(f.diagrams.length,2);
  assert.equal((await f.diagrams[0].getSource()).source,'flowchart TD\n A-->B\n');assert.equal((await f.diagrams[1].getSource()).source,'sequenceDiagram\n A->>B: 下一张\n');
});
test('本地依赖完整性与资源加载顺序固定，Mermaid 不直接进入主页面',()=>{
  const assets=require('../web/assets.json'),html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'web/vendor/mermaid/mermaid.min.js'))).digest('hex'),'336df803d87a38b70a01e736e666c8f7601d2ce42f5e47c8fafe5d721074b9a3');
  assert.ok(assets['/markdown.js'].indexOf('shared/diagrams.js')<assets['/markdown.js'].indexOf('shared/markdown.js'));
  assert.ok(!html.includes('/vendor/mermaid/'));assert.ok(fs.readFileSync(path.join(root,'scripts/gateway-resources.json'),'utf8').includes('web/vendor/mermaid/LICENSE'));
});
