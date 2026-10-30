"""Delegate project ownership and sidebar mutations to the running desktop."""
import os
from pathlib import Path
import sys
import time
from contextlib import contextmanager, nullcontext

from bridge.clients.codex.desktop_tools import DesktopTools, ToolError
from bridge.clients.desktop_app import DesktopApp


def canonical(value):
    path = str(Path(value).resolve())
    if os.name == 'nt':
        if path.lower().startswith('\\\\?\\unc\\'):
            path = '\\\\'+path[8:]
        elif path.startswith('\\\\?\\'):
            path = path[4:]
    return Path(path)


def within(folder, root):
    try:
        return canonical(folder).is_relative_to(canonical(root))
    except (OSError, ValueError):
        return False


def local_roots(result):
    hosts = result.get('hosts')
    if not isinstance(hosts, list) or any(not isinstance(h, dict) for h in hosts):
        raise ToolError('无法核验当前聊天的目录权限')
    local = [h for h in hosts if h.get('hostId') == 'local']
    roots = local[0].get('workspaceRoots') if len(local) == 1 else None
    if not isinstance(roots, list) or any(not isinstance(root, str) or not root or not Path(root).is_absolute() for root in roots):
        raise ToolError('无法核验当前聊天的目录权限')
    return roots


def project_rows(native, *, unknown=False):
    rows = native.call('list_projects', {}).get('projects')
    if not isinstance(rows, list) or any(not isinstance(row, dict) or
            any(not isinstance(row.get(key), str) or not row[key] for key in ('projectId', 'label')) or
            row.get('projectKind', 'local') not in ('local', 'remote', 'chatgpt') for row in rows):
        raise ToolError('桌面项目列表无法核验，请检查 Codex 项目列表', unknown=unknown)
    if len({row['projectId'] for row in rows}) != len(rows):
        raise ToolError('桌面项目身份不唯一，请检查 Codex 项目列表', unknown=unknown)
    # Newer desktops include ChatGPT projects without paths and remote projects
    # whose paths belong to another host. Only local projects can verify this write.
    rows = [row for row in rows if row.get('projectKind', 'local') == 'local']
    if any(not isinstance(row.get('path'), str) or not row['path'] or
           row.get('hostId', 'local') != 'local' for row in rows):
        raise ToolError('桌面项目列表无法核验，请检查 Codex 项目列表', unknown=unknown)
    return rows


class NativeProjects:
    def __init__(self, bridge, project_creator=None):
        self.bridge = bridge
        self.project_creator = project_creator

    @property
    def available(self):
        return sys.platform == 'win32' and self.bridge.host == 'local'

    def context(self, value, *, require_directory=True):
        identifier = value.get('contextId')
        if identifier:
            row = self.bridge.store.get(identifier)
            if row.get('origin') != 'desktop' or row.get('host', 'local') != 'local':
                raise ToolError('请先选择一个本机 Codex 桌面聊天，再创建项目')
            return row['id']
        rows = self.bridge.store.list(limit=100, source='desktop')
        local = [r for r in rows if r.get('origin') == 'desktop' and r.get('host', 'local') == 'local']
        row = next((r for r in local if within(value['cwd'], r.get('cwd') or '/invalid')), None)
        if row is None and not require_directory:
            row = next(iter(local), None)
        if not row:
            raise ToolError('请先打开一个关联目录的本机 Codex 桌面聊天，再创建项目' if require_directory else '请先在 Codex 桌面打开一个本机聊天，再创建项目')
        return row['id']

    @contextmanager
    def directory_scope(self, value):
        """Keep current native directory authorization stable until mkdir finishes."""
        if not self.available:
            raise ToolError('当前环境不支持本机 Codex 原生目录授权')
        gate = getattr(self.bridge.accounts, 'gate', None)
        if gate is None:
            raise ToolError('无法取得账号操作锁，未创建文件夹')
        with gate:
            bridge = self.bridge
            context_id = self.context({'cwd':value['parent'], **({'contextId':value['contextId']} if 'contextId' in value else {})})
            executable = bridge.accounts.index.get('desktopExecutable') or DesktopApp.scan(bridge.catalog_reader.executable, bridge.codex_home)
            native = DesktopTools.connect(executable, context_id,
                {p['key'].split('|', 1)[1] for p in bridge.hosts.projects() if p['host'] == 'local'})
            try:
                roots = local_roots(native.call('list_hosts', {}))
                allowed = [canonical(root) for root in roots if within(value['parent'], root)]
                if not allowed:
                    raise ToolError('所选文件夹不在当前聊天已获准的目录内，请先在 Codex 桌面添加该目录')
                yield max(allowed, key=lambda root: len(root.parts))
            finally:
                native.close()

    def __call__(self, value, progress):
        with getattr(self.bridge.accounts, 'gate', nullcontext()):
            return self._create(value, progress)

    def _create(self, value, progress):
        bridge = self.bridge
        context_id = self.context(value, require_directory=False)
        executable = bridge.accounts.index.get('desktopExecutable') or DesktopApp.scan(bridge.catalog_reader.executable, bridge.codex_home)
        native = DesktopTools.connect(executable, context_id,
                                      {p['key'].split('|', 1)[1] for p in bridge.hosts.projects() if p['host'] == 'local'})
        project = None
        creation_sent = False
        try:
            roots = local_roots(native.call('list_hosts', {}))
            scoped = any(within(value['cwd'], root) for root in roots)
            # Recheck the section immediately before the first native write.
            if value['sectionId'] is not None and value['sectionId'] not in {s['id'] for s in bridge.hosts.sidebar()['sections']}:
                raise ToolError('所选分区已不存在，请刷新后重试')
            if scoped:
                progress('creating', '请在 Codex 桌面确认文件夹信任提示；已有权限时会直接创建')
                creation_sent = True
                result = native.call('create_project', {'name':value['name'], 'sources':[value['cwd']], 'host':{'type':'local'}}, timeout=300)
            else:
                rows = project_rows(native)
                if any(row.get('path') and canonical(row['path']) == canonical(value['cwd']) for row in rows):
                    raise ToolError('这个文件夹已经关联了项目，请使用已有项目')
                creator = self.project_creator
                if creator is None:
                    from bridge.platforms.windows.projects import create_project
                    creator = create_project
                progress('creating', '正在由 Codex 原生窗口创建项目，请留意电脑上的确认提示')
                creation_sent = True
                try:
                    receipt = creator(executable, value['name'], value['cwd'])
                except Exception as exc:
                    raise ToolError(str(exc), unknown=getattr(exc, 'unknown', True)) from exc
                if not isinstance(receipt, dict) or receipt.get('submitted') is not True:
                    raise ToolError('原生创建回执无法核验，请检查 Codex 项目列表，不要重复创建', unknown=True)
                progress('creating', '正在等待 Codex 保存项目，请在电脑上确认文件夹信任提示')
                deadline = time.monotonic()+300
                while True:
                    rows = project_rows(native, unknown=True)
                    matches = [row for row in rows if row.get('path') and canonical(row['path']) == canonical(value['cwd']) and row.get('label') == value['name']]
                    if len(matches) == 1:
                        result = {'projectId':matches[0]['projectId'], 'rootPaths':[matches[0]['path']]}
                        break
                    if len(matches) > 1 or time.monotonic() >= deadline:
                        raise ToolError('桌面创建结果无法核验，请检查 Codex 项目列表，不要重复创建', unknown=True)
                    time.sleep(.2)
            identifier = result.get('projectId')
            roots = result.get('rootPaths')
            if not isinstance(identifier, str) or not isinstance(roots, list) or len(roots) != 1 or not isinstance(roots[0], str) or canonical(roots[0]) != canonical(value['cwd']):
                raise ToolError('桌面创建结果无法核验，请检查 Codex 项目列表，不要重复创建', unknown=True)
            rows = project_rows(native, unknown=True)
            row = next((p for p in rows if p.get('projectId') == identifier), None)
            if not row or row.get('label') != value['name'] or not row.get('path') or canonical(row['path']) != canonical(value['cwd']):
                raise ToolError('桌面项目尚未核验，请检查 Codex 项目列表，不要重复创建', unknown=True)
            project = {'key':'local|'+identifier, 'host':'local', 'hostLabel':'此电脑', 'name':row['label'], 'cwd':row['path']}
            progress('assigning', '正在由 Codex 保存项目的分区归属', project)
            native.call('move_project_to_sidebar_section', {'projectId':identifier, 'sectionId':value['sectionId']})
            sections = native.call('list_threads', {'limit':1}).get('sections', [])
            actual = [s.get('sectionId') for s in sections if 'codex:project:'+identifier in s.get('itemKeys', [])]
            expected = value['sectionId'] or 'threads'
            if actual != [expected]:
                raise ToolError('项目已创建，但分区归属尚未核验，请在 Codex 桌面检查')
            progress('verifying', '正在等待桌面保存结果供网关读取', project)
            deadline = time.monotonic()+10
            while time.monotonic() < deadline:
                sidebar = bridge.hosts.sidebar()
                saved = next((p for p in sidebar['projects'] if p['key'] == project['key']), None)
                saved_sections = [s['id'] for s in sidebar['sections'] if 'codex:project:'+identifier in s['itemKeys']]
                if saved and saved_sections == ([] if value['sectionId'] is None else [value['sectionId']]):
                    return saved
                time.sleep(.2)
            raise ToolError('项目已创建，桌面保存状态尚未同步，请刷新列表或在 Codex 桌面检查')
        except Exception as exc:
            if creation_sent and not isinstance(exc, ToolError):
                error = ToolError('桌面操作结果尚未确认，请检查 Codex 桌面项目列表，不要重复创建', unknown=True)
                if project:
                    error.project = project
                raise error from exc
            if project:
                exc.project = project
            raise
        finally:
            native.close()
