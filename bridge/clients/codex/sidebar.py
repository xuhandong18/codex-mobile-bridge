"""Native sidebar writes, always followed by native and persisted readback.

project_editor has the Windows helper signature
``(executable, action, verified_native_project, name=None)``. It runs inside
accounts.gate, after DesktopTools.connect has verified the pipe/profile.
"""
import copy
import re
import sys
import time
import uuid

from bridge.clients.codex.desktop_tools import DesktopTools, ToolError
from bridge.clients.codex.projects import canonical
from bridge.clients.desktop_app import DesktopApp


BUILTIN_SECTIONS = frozenset({'pinned', 'orbit', 'agents', 'chats', 'threads', 'projects'})


def local_project_id(target):
    """Saved native IDs include legacy strings as well as UUIDs."""
    if not isinstance(target, str) or not target.startswith('local|'):
        raise ToolError('只能管理本机 Codex 原生项目')
    project_id = target[6:]
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,255}', project_id):
        raise ToolError('本机原生项目标识无效')
    return project_id


def custom_sections(sections, *, native=False):
    if not isinstance(sections, list):
        raise ToolError('桌面分区列表无法核验')
    key = 'sectionId' if native else 'id'
    rows = {}
    for section in sections:
        if not isinstance(section, dict) or not isinstance(section.get(key), str):
            raise ToolError('桌面分区列表格式无法核验')
        section_id = section[key]
        if section_id in BUILTIN_SECTIONS or section.get('builtin') or section.get('type') == 'builtin':
            continue
        if section_id in rows:
            raise ToolError('桌面分区标识重复，无法安全修改顺序')
        rows[section_id] = section
    return rows


class NativeSidebar:
    def __init__(self, bridge, project_editor=None, *, verify_timeout=10, poll_interval=.2):
        self.bridge = bridge
        self.project_editor = project_editor
        self.verify_timeout = verify_timeout
        self.poll_interval = poll_interval

    @property
    def available(self):
        return sys.platform == 'win32' and self.bridge.host == 'local'

    def context(self, value):
        store = self.bridge.store
        if value.get('contextId'):
            rows = [store.get(value['contextId'])]
        else:
            rows = store.list(limit=100, source='desktop')
        for row in rows:
            if row.get('origin') != 'desktop' or row.get('host', 'local') != 'local':
                continue
            try:
                return str(uuid.UUID(row['id']))
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
        raise ToolError('请先打开或选择一个本机 Codex 桌面聊天作为侧栏操作上下文')

    def _editor(self):
        if self.project_editor is not None:
            if callable(self.project_editor):
                return self.project_editor
            raise ToolError('尚未接通原生项目改名和移除组件；请在 Codex 桌面操作')
        if sys.platform == 'win32':
            try:
                from bridge.platforms.windows.projects import edit_project
                return edit_project
            except ImportError as exc:
                raise ToolError('尚未安装原生项目改名和移除组件；请在 Codex 桌面操作') from exc
        raise ToolError('当前系统尚不支持原生项目改名和移除')

    @staticmethod
    def _projects(native):
        rows = native.call('list_projects', {}).get('projects')
        if not isinstance(rows, list) or any(not isinstance(p, dict) for p in rows):
            raise ToolError('原生项目列表无法核验')
        ids = [p.get('projectId') for p in rows]
        if any(not isinstance(p, str) for p in ids) or len(ids) != len(set(ids)):
            raise ToolError('原生项目标识无法核验')
        return rows

    @staticmethod
    def _project(value, sidebar, native_projects):
        target = value['targetId']
        project_id = local_project_id(target)
        saved = next((p for p in sidebar['projects'] if p.get('key') == target and p.get('host') == 'local'), None)
        row = next((p for p in native_projects if p.get('projectId') == project_id), None)
        if (not saved or not row or row.get('projectKind') != 'local'
                or not isinstance(row.get('label'), str) or not isinstance(row.get('path'), str)
                or not row['path'] or row['label'] != saved.get('name')
                or not saved.get('cwd') or canonical(row['path']) != canonical(saved['cwd'])):
            raise ToolError('原生项目的标识、名称或路径与当前配置不一致，请刷新后重试')
        return row

    def execute(self, value, progress):
        if not self.available:
            raise ToolError('当前环境不支持本机 Windows Codex 原生侧栏管理')
        gate = getattr(self.bridge.accounts, 'gate', None)
        if gate is None:
            raise ToolError('无法取得账号操作锁，未发送侧栏操作')
        with gate:
            return self._execute(value, progress)

    def _execute(self, value, progress):
        bridge = self.bridge
        context_id = self.context(value)
        executable = bridge.accounts.index.get('desktopExecutable') or DesktopApp.scan(
            bridge.catalog_reader.executable, bridge.codex_home)
        saved_projects = bridge.hosts.projects()
        project_ids = {p['key'].split('|', 1)[1] for p in saved_projects
                       if p.get('host') == 'local' and p.get('key', '').startswith('local|')}
        if not project_ids:
            raise ToolError('当前配置没有可用于核验桌面管道的本机原生项目')
        native = DesktopTools.connect(executable, context_id, project_ids)
        attempted, using_editor = False, False
        try:
            sidebar = bridge.hosts.sidebar()
            sections = custom_sections(sidebar['sections'])
            threads = native.call('list_threads', {'limit': 1})
            native_sections = custom_sections(threads.get('sections'), native=True)
            if set(native_sections) != set(sections):
                raise ToolError('原生分区与当前配置不一致，请刷新后重试')
            kind, action = value['kind'], value['action']
            target = value.get('targetId')
            if kind == 'section' and action != 'create' and target not in sections:
                raise ToolError('所选自定义分区已不存在或属于内置分区')
            destination = value.get('sectionId', value.get('beforeId'))
            if destination is not None:
                if kind == 'section' and (destination not in sections or destination == target):
                    raise ToolError('分区移动位置无效，请刷新后重试')
                if kind == 'project' and destination not in sections and destination not in {'pinned', 'threads'}:
                    raise ToolError('所选分区已不存在，请刷新后重试')
                if kind == 'project' and not any(s.get('sectionId') == destination for s in threads['sections']):
                    raise ToolError('原生目标分区已不存在，请刷新后重试')
            project = None
            editor = None
            if kind == 'project':
                rows = self._projects(native)
                project = self._project(value, sidebar, rows)
                if action in ('rename', 'delete'):
                    same_name = [p for p in rows if p.get('projectKind') == 'local'
                                 and isinstance(p.get('label'), str)
                                 and p['label'].casefold() == project['label'].casefold()]
                    if len(same_name) != 1:
                        raise ToolError('存在多个同名本机项目，原生窗口无法唯一定位；请先在桌面区分名称')
                    if action == 'rename' and any(p.get('projectKind') == 'local'
                            and p.get('projectId') != project['projectId']
                            and isinstance(p.get('label'), str)
                            and p['label'].casefold() == value['name'].casefold() for p in rows):
                        raise ToolError('新名称与另一个本机项目相同，请使用不同名称')
                    editor = self._editor()
            if action == 'delete' and value.get('confirmed') is not True:
                raise ToolError('删除操作必须明确确认 confirmed=true')
            order = list(native_sections)
            if kind == 'section':
                if action == 'create':
                    method, arguments = 'create_sidebar_section', {'name': value['name']}
                elif action == 'rename':
                    method, arguments = 'rename_sidebar_section', {'sectionId': target, 'name': value['name']}
                elif action == 'delete':
                    method, arguments = 'delete_sidebar_section', {'sectionId': target}
                elif action == 'move':
                    order.remove(target)
                    order.insert(len(order) if destination is None else order.index(destination), target)
                    method, arguments = 'reorder_sidebar_sections', {'sectionIds': order}
                else:
                    raise ToolError('不支持的分区操作')
            elif kind == 'project' and action == 'move':
                method, arguments = 'move_project_to_sidebar_section', {
                    'projectId': project['projectId'], 'sectionId': destination}
            elif editor is None:
                raise ToolError('不支持的项目操作；新建项目请使用原生项目创建接口')
            if editor is None and method not in DesktopTools.METHODS:
                raise ToolError('当前桌面工具白名单尚未开放该侧栏操作，请更新网关后重试')
            progress('applying', '正在由 Codex 桌面保存侧栏变更')
            attempted = True
            using_editor = editor is not None
            if editor is not None:
                editor(executable, action, copy.deepcopy(project), name=value.get('name'))
                using_editor = False
                result = {}
            else:
                result = native.call(method, arguments)
            if kind == 'section' and action == 'create':
                target = result.get('sectionId')
                if not isinstance(target, str) or not target or target in sections or target in BUILTIN_SECTIONS:
                    raise ToolError('原生新建分区标识无法核验', unknown=True)
            progress('verifying', '正在核对原生列表和 Codex 保存结果')
            return self._verify(native, value, target, sections, order, project)
        except Exception as exc:
            if attempted:
                # The window helper explicitly distinguishes pre-dispatch
                # failures. Tool failures after dispatch remain uncertain.
                unknown = getattr(exc, 'unknown', True) if using_editor else True
                raise ToolError(str(exc) or '侧栏操作结果未知，请检查 Codex，不要重复操作', unknown=unknown) from exc
            raise
        finally:
            native.close()

    def _verify(self, native, value, target, sections, order, project):
        kind, action = value['kind'], value['action']
        expected_ids = set(sections)
        if kind == 'section' and action == 'create':
            expected_ids.add(target)
        if kind == 'section' and action == 'delete':
            expected_ids.remove(target)
        deadline = time.monotonic() + self.verify_timeout
        while True:
            # Poll only reads. Neither a stale snapshot nor a read exception
            # causes any mutation, helper invocation or reconnection to replay.
            rows = self._projects(native) if kind == 'project' else None
            threads = native.call('list_threads', {'limit': 1})
            current = custom_sections(threads.get('sections'), native=True)
            sidebar = self.bridge.hosts.sidebar()
            persisted = custom_sections(sidebar['sections'])
            matches = set(current) == expected_ids == set(persisted)
            saved = None
            if kind == 'section':
                if action in ('create', 'rename'):
                    row = current.get(target, {})
                    matches = matches and row.get('name', row.get('label')) == value['name']
                    matches = matches and persisted.get(target, {}).get('name') == value['name']
                elif action == 'move':
                    matches = matches and list(current) == order and list(persisted) == order
                saved = persisted.get(target)
            else:
                native_row = next((p for p in rows if p.get('projectId') == project['projectId']), None)
                saved = next((p for p in sidebar['projects'] if p.get('key') == target), None)
                if action == 'delete':
                    matches = matches and native_row is None and saved is None
                else:
                    name = value['name'] if action == 'rename' else project['label']
                    matches = matches and bool(native_row and saved
                        and native_row.get('projectKind') == 'local'
                        and native_row.get('label') == name and saved.get('name') == name
                        and saved.get('host') == 'local' and native_row.get('path') and saved.get('cwd')
                        and canonical(native_row['path']) == canonical(project['path']) == canonical(saved['cwd']))
                    if action == 'move':
                        item = 'codex:project:' + project['projectId']
                        membership = [s.get('sectionId') for s in threads['sections'] if item in s.get('itemKeys', [])]
                        destination = value['sectionId']
                        persisted_membership = [s for s, row in persisted.items() if item in row.get('itemKeys', [])]
                        matches = matches and membership == [destination or 'threads']
                        matches = matches and persisted_membership == ([destination] if destination in persisted else [])
                        matches = matches and (project['projectId'] in sidebar.get('pinnedProjectIds', [])) == (destination == 'pinned')
            if matches:
                result = {'targetId': target,
                          'message': '项目已从 Codex 移除，文件和聊天均保留' if kind == 'project' and action == 'delete'
                                     else '侧栏变更已由 Codex 保存并核验'}
                if saved is not None:
                    result['section' if kind == 'section' else 'project'] = saved
                return result
            if time.monotonic() >= deadline:
                raise ToolError('Codex 侧栏写入结果尚未同步或无法核验，请检查桌面侧栏，不要重复操作', unknown=True)
            time.sleep(self.poll_interval)
