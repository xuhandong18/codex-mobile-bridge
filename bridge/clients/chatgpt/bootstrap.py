"""Stage-one verification. Never quits, restarts, or retries a desktop launch."""
import os
import socket
import subprocess
import time
from pathlib import Path

from bridge.clients.chatgpt.connection import ProbeConnection
from bridge.clients.chatgpt.installation import inspect_installation
from bridge.clients.codex.desktop_tools import DesktopTools
from bridge.clients.codex.remote import AppHosts
from bridge.clients.desktop_app import DesktopApp
from bridge.features.sessions.store import SessionStore
from bridge.platforms.windows.chatgpt import read_snapshot, verify_debugger


class ProbeBlocked(ValueError):
    def __init__(self, message, *, state='blocked'):
        super().__init__(message)
        self.state = state


def choose_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def existing_binding(executable):
    snapshot = read_snapshot(executable)
    rows = snapshot.get('processes')
    if rows == [] and snapshot.get('allPids') == []:
        raise ProbeBlocked('原桌面程序尚未运行', state='stopped')
    if not isinstance(rows, list) or len(rows) != 1 or rows[0].get('commandKnown') is not True:
        raise ProbeBlocked('无法确认唯一的原桌面主进程')
    port = rows[0].get('port')
    if port is None:
        raise ProbeBlocked('原桌面尚未启用调试连接；请等所有任务空闲并正常退出后，再运行受控启动验证',
                           state='restart-required')
    return verify_debugger(executable, port)


def launch_if_stopped(executable, codex_home, *, timeout=20):
    installation = inspect_installation(executable)
    snapshot = read_snapshot(installation.executable)
    if snapshot.get('allPids') != []:
        raise ProbeBlocked('原桌面或其子进程仍在运行，或进程清单无法确认；没有启动第二份程序')
    port = choose_port()
    home = Path(codex_home).resolve()
    if not home.is_dir():
        raise ProbeBlocked('原 Codex 数据目录不存在；不能创建另一份账号环境')
    profile_context(home)
    environment = {**os.environ, 'CODEX_HOME': str(home)}
    environment.pop('ELECTRON_RUN_AS_NODE', None)
    DesktopApp(installation.executable, home).launch(
        arguments=(f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1'),
        cwd=home, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0),
        close_fds=True)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            return verify_debugger(installation.executable, port)
        except ValueError:
            time.sleep(.25)
    raise ProbeBlocked('启动后的本机监听未通过身份核验；没有重试启动或退出原桌面')


def profile_context(codex_home):
    projects = {p['key'].split('|', 1)[1] for p in AppHosts(codex_home).projects() if p['host'] == 'local'}
    contexts = SessionStore(codex_home).list(limit=1, source='desktop')
    if not projects or not contexts:
        raise ProbeBlocked('缺少原桌面项目与聊天上下文，无法核验原配置')
    return contexts[0]['id'], projects


def verify_profile(executable, codex_home):
    context, projects = profile_context(codex_home)
    client = DesktopTools.connect(executable, context, projects, timeout=10)
    client.close()


async def probe(executable, codex_home, *, thread_id=None, refresh=False, target_id=None):
    installation = inspect_installation(executable)
    try:
        verify_profile(executable, codex_home)
    except (OSError, ValueError, RuntimeError) as exc:
        raise ProbeBlocked('原桌面配置尚未通过现有命名管道核验') from exc
    binding = existing_binding(executable)
    def verify():
        return verify_debugger(executable, binding.port, expected=binding)
    client = await ProbeConnection.connect(installation, binding, verify=verify, target_id=target_id)
    try:
        snapshot = await client.snapshot(thread_id, refresh=refresh)
    finally:
        await client.close()
    verify()
    thread = snapshot.get('thread') or {}
    route = snapshot.get('route')
    background = isinstance(route, str) and bool(route) and thread_id is not None and thread_id not in route
    passed = bool(refresh and background and thread.get('accountVerified') is True)
    return {'state': 'verified' if passed else 'incomplete', 'version': installation.version,
            'runtimeGatePassed': passed, 'desktopStillRunning': True, 'backgroundRead': background,
            'snapshot': snapshot}
