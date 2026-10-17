"""Guarded Windows project-dialog adapter; completion is verified by the caller."""
import json
from pathlib import Path
import subprocess
import sys

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
