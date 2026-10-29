'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function host(platform){
  const context=vm.createContext({navigator:{platform,userAgent:'Mozilla/5.0'}});
  vm.runInContext(fs.readFileSync('web/hosts/environment.js','utf8'),context);
  return vm.runInContext('BridgeHost',context);
}
test('发送快捷键按浏览器所在电脑的平台选择，不受窗口宽度影响',()=>{
  for(const platform of ['MacIntel','Win32','Linux x86_64']){
    const h=host(platform),mac=platform==='MacIntel';
    assert.equal(h.isSendShortcut({key:'Enter',metaKey:true}),mac);
    assert.equal(h.isSendShortcut({key:'Enter',ctrlKey:true}),!mac);
    assert.equal(h.isSendShortcut({key:'Enter'}),false);
    for(const guard of [{isComposing:true},{keyCode:229},{repeat:true},{defaultPrevented:true},{shiftKey:true},{altKey:true}])
      assert.equal(h.isSendShortcut({key:'Enter',metaKey:mac,ctrlKey:!mac,...guard}),false,JSON.stringify(guard));
    assert.equal(h.isSendShortcut({key:'Enter',metaKey:true,ctrlKey:true}),false);
  }
});

test('主聊天、其他客户端和侧边聊天都通过原表单发送，禁用时不提交',()=>{
  for(const [file,marker] of [
    ['web/shell/app.js',"$('message').onkeydown="],
    ['web/features/clients/desktop-sessions.js','this.input.onkeydown='],
    ['web/features/workspace/side-chat.js','this.input.onkeydown=']
  ]){
    const source=fs.readFileSync(file,'utf8'),start=source.indexOf(marker);
    assert.ok(start>=0,file+' 应绑定发送快捷键');
    const line=source.slice(start).split('\n')[0];
    let submissions=0,prevented=0;
    const input={},button={disabled:false},form={requestSubmit:()=>submissions++};
    const nodes={message:input,send:button,composer:form};
    const context=vm.createContext({BridgeHost:host('Win32'),$:id=>nodes[id],input,send:button,sendButton:button,form});
    vm.runInContext(line,context);
    const event={key:'Enter',ctrlKey:true,preventDefault:()=>prevented++};
    const handler=input.onkeydown;
    handler(event);assert.equal(submissions,1,file);assert.equal(prevented,1,file);
    button.disabled=true;handler(event);assert.equal(submissions,1,file+' 禁用发送');
    button.disabled=false;handler({...event,isComposing:true});assert.equal(submissions,1,file+' 输入法保护');
  }
});
