"""Guarded Windows project-dialog adapter; completion is verified by the caller."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading

from .codex_quit import _snapshot, _check_same, BUDGET
import time


class ProjectUIError(ValueError):
    def __init__(self, message, unknown=False):
        super().__init__(message)
        self.unknown = unknown


def helper_path():
    root = Path(getattr(sys, '_MEIPASS', Path(__file__).resolve().parents[3]/'dist'))
    return root/'client-helpers/codex-project-helper.exe'


def edit_project(executable, action, project, name=None):
    if action not in ('rename','delete'):
        raise ProjectUIError('不支持的项目操作')
    return _project_dialog(executable, action, project, name)


def create_project(executable, name, directory):
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120 or any(ord(c) < 32 for c in name):
        raise ProjectUIError('项目名称无效')
    try:
        path = Path(directory).resolve(strict=True)
        if not Path(directory).is_absolute() or not path.is_dir():
            raise ValueError()
    except (OSError, ValueError, TypeError):
        raise ProjectUIError('项目文件夹不存在或无法访问') from None
    return _project_dialog(executable, 'create', {'label':name, 'path':str(path)})


class ProjectTrustWatcher:
    """One native listener, armed before dispatch and closed with this request."""
    def __init__(self, executable, directory, progress):
        self.executable = Path(executable).resolve()
        self.directory = str(Path(directory).resolve(strict=True))
        self.progress = progress
        self.process = None
        self.reader = None
        self.receipts = queue.Queue()
        self.stopping = threading.Event()

    def _send(self, value):
        self.process.stdin.write(value+'\n')
        self.process.stdin.flush()

    def _read(self):
        try:
            for line in self.process.stdout:
                try:
                    value = json.loads(line)
                    if (not isinstance(value, dict) or value.get('pid') != self.identity['main']
                            or value.get('created') != self.identity['created']
                            or not isinstance(value.get('path'), str)
                            or os.path.normcase(value['path']) != os.path.normcase(self.directory)):
                        raise ValueError('文件夹信任监听回执身份不一致')
                except (ValueError, TypeError):
                    self.receipts.put({'phase':'failed', 'message':'文件夹信任监听回执无法核验，尚未创建项目；请检查 Codex 并更新网关原生组件'})
                    return
                if not self.stopping.is_set() and value.get('phase') in ('manual', 'unknown', 'trusted'):
                    message = ('已自动确认本次文件夹信任提示，正在等待 Codex 保存项目' if value['phase'] == 'trusted'
                               else value.get('message') or '自动信任未完成，请在电脑确认文件夹提示')
                    try:
                        self.progress('creating', message)
                    except Exception:
                        # Persistence failures must not cause another native click.
                        pass
                self.receipts.put(value)
        finally:
            self.receipts.put(None)
            if not self.stopping.is_set():
                try:
                    self.progress('creating', '文件夹信任监听已结束；若仍有提示，请在电脑确认')
                except Exception:
                    pass

    def _expect(self, phase, deadline):
        try:
            value = self.receipts.get(timeout=max(.01, deadline-time.monotonic()))
        except queue.Empty:
            raise ProjectUIError('文件夹信任监听未就绪，尚未创建项目；请检查 Codex 或更新网关组件') from None
        if not value or value.get('phase') != phase:
            raise ProjectUIError((value or {}).get('message') or '文件夹信任监听无法核验，尚未创建项目')

    def __enter__(self):
        deadline = time.monotonic()+15
        try:
            self.identity = _snapshot(self.executable, deadline)
            if not self.identity.get('main'):
                raise ProjectUIError('找不到唯一的 Codex 主窗口，尚未创建项目')
            helper = helper_path()
            if not helper.is_file():
                raise ProjectUIError('缺少文件夹信任组件，请重新构建或安装网关')
            _check_same(_snapshot(self.executable, deadline), self.identity)
            self.process = subprocess.Popen([str(helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
            self.reader = threading.Thread(target=self._read, daemon=True)
            self.reader.start()
            self._send(json.dumps({'action':'watch-trust', 'name':'', 'path':self.directory,
                'pid':self.identity['main'], 'created':self.identity['created'], 'executable':str(self.executable)}, ensure_ascii=False))
            self._expect('ready', deadline)
            self._send('arm')
            self._expect('armed', deadline)
            return self
        except Exception:
            self.close()
            raise

    def close(self):
        self.stopping.set()
        if self.process is not None:
            try:
                self._send('stop')
            except (OSError, ValueError):
                pass
            try:
                self.process.stdin.close()
            except OSError:
                pass
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                # This is our own listener, never a Codex process.
                self.process.kill()
                self.process.wait(timeout=2)
            if self.reader is not None:
                self.reader.join(timeout=2)
            self.process.stdout.close()
            self.process = None

    def __exit__(self, *exc):
        self.close()


def watch_project_trust(executable, directory, progress):
    return ProjectTrustWatcher(executable, directory, progress)


def _project_dialog(executable, action, project, name=None):
    executable, deadline = Path(executable).resolve(), time.monotonic()+(60 if action == 'create' else BUDGET)
    try:
        original = _snapshot(executable, deadline)
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise ProjectUIError('无法核验 Codex 运行实例，尚未修改项目；请在电脑重新打开项目菜单后重试') from exc
    pid = original.get('main')
    if not pid:
        raise ProjectUIError('找不到唯一的 Codex 主窗口，请在电脑打开 Codex')
    helper = helper_path()
    if not helper.is_file():
        raise ProjectUIError('缺少 Codex 原生项目组件，请重新构建或安装网关')
    try:
        _check_same(_snapshot(executable, deadline), original)
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        raise ProjectUIError('Codex 运行实例已变化，尚未修改项目；请刷新后重试') from exc
    payload = {'pid':pid, 'created':original['created'], 'executable':str(executable),
               'action':action, 'name':project['label'], 'newName':name}
    if action == 'create':
        payload['path'] = project['path']
    try:
        result = subprocess.run([str(helper)], input=json.dumps(payload, ensure_ascii=False),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
            timeout=max(1,deadline-time.monotonic()), creationflags=subprocess.CREATE_NO_WINDOW)
    except subprocess.TimeoutExpired as exc:
        raise ProjectUIError('原生项目操作超时，请检查 Codex 侧栏，不要重复操作', unknown=True) from exc
    receipts = []
    for line in result.stdout.splitlines():
        try: receipts.append(json.loads(line))
        except ValueError: continue
    submitted = any(r.get('pid') == pid and r.get('phase') in ('dispatching','submitted','unknown') for r in receipts)
    last = next((r for r in reversed(receipts) if r.get('pid') == pid), {})
    if result.returncode or last.get('phase') != 'submitted':
        raise ProjectUIError(last.get('error') or '原生项目操作回执无法核验，请检查 Codex 侧栏', unknown=submitted or not receipts)
    return {'submitted':True}
