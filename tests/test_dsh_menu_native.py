"""Exercise Harness's Chromium caption menu and native popup on an inactive desktop."""
import base64
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from test_codex_native_quit import InactiveDesktop, created_filetime

ROOT = Path(__file__).resolve().parents[1]

MAIN = r'''
const {app,BrowserWindow,Menu,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const base=path.join(__dirname,'../..'),state=JSON.parse(fs.readFileSync(path.join(base,'scenario.json')));
app.setPath('userData',path.join(base,'fixture-profile'));
app.commandLine.appendSwitch('force-renderer-accessibility');
app.commandLine.appendSwitch('disable-gpu');
let window,quitting=false;
app.on('before-quit',()=>{
  if(!quitting){quitting=true;fs.writeFileSync(path.join(base,'quit.txt'),'normal teardown');}
});
app.whenReady().then(async()=>{
  window=new BrowserWindow({width:640,height:480,show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs')}});
  window.setMenu(null);
  ipcMain.on('caption-menu',()=>{
    const items=[{role:'quit',label:state.mode==='chinese'?'退出':'Exit'}];
    if(state.mode==='duplicate')items.push({label:'Exit',click:()=>fs.writeFileSync(path.join(base,'wrong-exit.txt'),'unexpected')});
    Menu.buildFromTemplate(items).popup({window,x:10,y:35});
  });
  await window.loadFile(path.join(__dirname,'index.html'));
  window.showInactive();
  if(state.mode==='dialog')window.setEnabled(false);
  fs.writeFileSync(path.join(base,'ready.json'),JSON.stringify({pid:process.pid}));
  const timer=setInterval(()=>{
    if(fs.existsSync(path.join(base,'cleanup.txt'))){clearInterval(timer);app.exit(0);}
  },100);
  setTimeout(()=>app.exit(0),25000).unref();
});
'''

HTML = '''<!doctype html><html><body>
<div role="menubar" aria-label="Application menu">
<button role="menuitem" aria-haspopup="menu" onclick="window.fixture.open()">Application</button>
</div></body></html>'''
PRELOAD = "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixture',{open:()=>ipcRenderer.send('caption-menu')});"


@unittest.skipUnless(sys.platform == 'win32', 'Windows native menu fixture')
class DshNativeMenuQuitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        candidates = [ROOT/'node_modules/electron/dist/electron.exe',
                      Path.home()/'AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe']
        override = os.environ.get('CMB_TEST_ELECTRON_EXECUTABLE')
        if override:
            candidates.insert(0, Path(override))
        source = next((path for path in candidates if path.is_file()), None)
        if source is None:
            raise unittest.SkipTest('An existing Electron runtime is required for the isolated menu fixture')
        (ROOT/'.tmp').mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix='dsh-native-menu-', dir=ROOT/'.tmp')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder = Path(cls.temp.name)
        # Copy only the Electron runtime. No installed app resources, profile,
        # credentials or Harness code enter this independent synthetic app.
        for item in source.parent.iterdir():
            if item.is_file() and (item == source or item.suffix in ('.dll', '.pak', '.dat', '.bin')):
                shutil.copy2(item, cls.folder/item.name)
        locales = cls.folder/'locales'; locales.mkdir()
        for name in ('en-US.pak', 'zh-CN.pak'):
            if (source.parent/'locales'/name).is_file():
                shutil.copy2(source.parent/'locales'/name, locales/name)
        cls.executable = cls.folder/source.name
        package = cls.folder/'resources/app'; package.mkdir(parents=True)
        (package/'package.json').write_text(json.dumps({'name': 'dsh-menu-fixture', 'main': 'main.cjs'}))
        for name, value in [('main.cjs', MAIN), ('preload.cjs', PRELOAD), ('index.html', HTML)]:
            (package/name).write_text(value, encoding='utf-8')

    def run_scenario(self, mode='normal', changed=False):
        from bridge.platforms.windows.dsh_quit import DESKTOP_QUIT_SCRIPT
        folder = self.folder
        for name in ('ready.json', 'quit.txt', 'cleanup.txt', 'wrong-exit.txt'):
            (folder/name).unlink(missing_ok=True)
        (folder/'scenario.json').write_text(json.dumps({'mode': mode}))
        (folder/'resources/app/index.html').write_text(
            HTML.replace('>Application<', '>应用<') if mode == 'chinese' else HTML, encoding='utf-8')
        desktop = InactiveDesktop()
        try:
            fixture, pid = desktop.start([self.executable, '--no-sandbox'], folder/'fixture.log', folder)
            deadline = time.monotonic()+12
            while not (folder/'ready.json').exists() and time.monotonic() < deadline:
                time.sleep(.05)
            self.assertTrue((folder/'ready.json').exists(), (folder/'fixture.log').read_text(errors='replace'))
            self.assertEqual(json.loads((folder/'ready.json').read_bytes())['pid'], pid)
            environment = {'CMB_DSH_GUI_PID': str(pid), 'CMB_DSH_GUI_CREATED': str(created_filetime(pid)+(1 if changed else 0)),
                           'CMB_DSH_GUI_EXE': str(self.executable)}
            powershell = Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
            with patch.dict(os.environ, environment):
                helper, _ = desktop.start([powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(DESKTOP_QUIT_SCRIPT.encode('utf-16le')).decode()], folder/'helper.log', folder)
            code = desktop.wait(helper, 18)
            log = (folder/'helper.log').read_text('utf-8-sig', errors='replace')
            if mode in ('normal', 'chinese') and not changed:
                self.assertEqual(code, 0, log)
                self.assertTrue((folder/'quit.txt').is_file(), log)
                self.assertEqual(desktop.wait(fixture, 4), 0)
                receipts = [json.loads(line) for line in log.splitlines() if line.startswith('{')]
                self.assertEqual(sum(row.get('quitPhase') == 'dispatching' for row in receipts), 1)
            else:
                self.assertNotEqual(code, 0, log)
                expected = '进程已变化' if changed else '原生窗口' if mode == 'dialog' else '不唯一'
                self.assertIn(expected, log)
                self.assertNotIn('dispatching', log)
                self.assertFalse((folder/'quit.txt').exists())
                self.assertFalse((folder/'wrong-exit.txt').exists())
        finally:
            (folder/'cleanup.txt').write_text('fixture cleanup')
            if 'fixture' in locals():
                desktop.wait(fixture, 8)
            desktop.close()

    def test_normal_menu_runs_application_teardown_once(self):
        self.run_scenario()

    def test_chinese_caption_and_native_exit_menu(self):
        self.run_scenario('chinese')

    def test_duplicate_exit_is_not_invoked(self):
        self.run_scenario('duplicate')

    def test_disabled_main_window_keeps_confirmation_for_user(self):
        self.run_scenario('dialog')

    def test_replaced_process_identity_is_rejected(self):
        self.run_scenario(changed=True)
