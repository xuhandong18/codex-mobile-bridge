"""Validate sidebar commands and retain receipts; Codex owns native mutations.

``await SidebarManagement(bridge).submit(body)`` queues one synchronous executor
call. ``operation(id)`` is a read-only poll. An injected executor implements
``execute(body, progress)`` (or is a callable with that signature).
Synchronous HTTP handlers may use ``asyncio.run(manager.submit(body))``; the
native worker is independent of that short-lived event loop.
"""
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import threading
import uuid

from bridge.features.notifications.channels import read_json, write_json
from bridge.clients.codex.sidebar import BUILTIN_SECTIONS, local_project_id


TERMINAL = frozenset({'completed', 'failed', 'unknown'})


def identifier(value, label):
    if not isinstance(value, str):
        raise ValueError(label + '必须是 UUID')
    try:
        return str(uuid.UUID(value))
    except ValueError:
        raise ValueError(label + '必须是 UUID') from None


def validate(body):
    """An action accepts exactly its own fields, plus an optional contextId."""
    if not isinstance(body, dict):
        raise ValueError('侧栏管理请求必须是对象')
    kind, action = body.get('kind'), body.get('action')
    fields = {
        ('section', 'create'): {'name'},
        ('section', 'rename'): {'targetId', 'name'},
        ('section', 'move'): {'targetId', 'beforeId'},
        ('section', 'delete'): {'targetId', 'confirmed'},
        ('project', 'rename'): {'targetId', 'name'},
        ('project', 'move'): {'targetId', 'sectionId'},
        ('project', 'delete'): {'targetId', 'confirmed'},
    }
    if not isinstance(kind, str) or not isinstance(action, str):
        raise ValueError('侧栏对象类型或操作无效')
    if (kind, action) == ('project', 'create'):
        raise ValueError('新建项目请使用现有的原生项目创建接口，并选择文件夹')
    required = fields.get((kind, action))
    if required is None:
        raise ValueError('不支持的侧栏对象类型或操作')
    required = required | {'id', 'kind', 'action'}
    if not required <= body.keys() or body.keys() - required - {'contextId'}:
        raise ValueError('侧栏管理请求字段与操作不匹配')
    value = dict(body)
    value['id'] = identifier(body['id'], '操作标识')
    if 'contextId' in value:
        value['contextId'] = identifier(value['contextId'], '桌面聊天标识')
    if 'name' in value:
        name = value['name']
        if (not isinstance(name, str) or not name.strip() or len(name) > 120
                or not all(c.isprintable() for c in name)):
            raise ValueError('请输入 1–120 字的单行名称')
    if 'targetId' in value:
        target = value['targetId']
        if not isinstance(target, str) or not target:
            raise ValueError('侧栏目标标识无效')
        if kind == 'project':
            local_project_id(target)
        elif target in BUILTIN_SECTIONS:
            raise ValueError('内置分区不能改名、移动或删除')
    for field in ('sectionId', 'beforeId'):
        if field in value and value[field] is not None:
            if not isinstance(value[field], str) or not value[field]:
                raise ValueError('分区标识必须是字符串或 null')
    if 'beforeId' in value and value['beforeId'] == value['targetId']:
        raise ValueError('分区不能移动到自身之前')
    if action == 'delete' and value['confirmed'] is not True:
        raise ValueError('删除操作必须明确确认 confirmed=true；移除项目会保留文件和聊天')
    return value


class SidebarManagement:
    def __init__(self, bridge, executor=None):
        self.bridge = bridge
        if executor is None:
            from bridge.clients.codex.sidebar import NativeSidebar
            executor = NativeSidebar(bridge)
        self.executor = executor
        self.path = Path(bridge.data_dir) / 'sidebar-operations.json'
        self.lock = threading.RLock()
        self.operations = read_json(self.path, {})
        if (not isinstance(self.operations, dict)
                or any(not isinstance(row, dict) or not isinstance(row.get('fingerprint'), str)
                       for row in self.operations.values())):
            raise ValueError('侧栏操作记录损坏，请检查网关数据；不会重新发送操作')
        changed = False
        for row in self.operations.values():
            if row.get('status') not in TERMINAL:
                row.update(status='unknown', message='上次侧栏操作中断，结果未知；请检查 Codex 侧栏，不要重复操作')
                changed = True
        if changed:
            write_json(self.path, self.operations)

    @staticmethod
    def _public(row):
        return copy.deepcopy({k: v for k, v in row.items() if k not in ('fingerprint', 'resource')})

    def operation(self, operation_id):
        operation_id = identifier(operation_id, '操作标识')
        with self.lock:
            if operation_id not in self.operations:
                raise ValueError('找不到侧栏操作记录')
            return self._public(self.operations[operation_id])

    async def submit(self, body, preferences=None):
        # Validation and disk IO must not block the API event loop. Once queued,
        # client cancellation does not cancel or replay the native write.
        return await asyncio.to_thread(self._submit, copy.deepcopy(body), preferences)

    def _submit(self, body, preferences=None):
        value = validate(body)
        fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        operation_id = value['id']
        with self.lock:
            prior = self.operations.get(operation_id)
            if prior is not None:
                if prior['fingerprint'] != fingerprint:
                    raise ValueError('同一个操作标识不能修改请求内容')
                return self._public(prior)
            if not bool(getattr(self.executor, 'available', True)):
                raise ValueError('当前环境不支持 Codex 原生侧栏管理；请在本机 Windows Codex 桌面操作')
            self._validate_targets(value)
            resource = value['kind'] + ':' + value.get('targetId', 'create:' + value.get('name', '').strip())
            if any(row.get('resource') == resource and row.get('status') not in ('completed', 'failed')
                   for row in self.operations.values()):
                raise ValueError('这个侧栏对象已有未确认操作，请检查 Codex 侧栏，不要重复操作')
            row = {'id': operation_id, 'kind': value['kind'], 'action': value['action'],
                   'fingerprint': fingerprint, 'resource': resource,
                   'status': 'pending', 'message': '正在连接并核验 Codex 桌面'}
            if 'targetId' in value:
                row['targetId'] = value['targetId']
            placement = None
            if preferences is not None and value['kind'] == 'project':
                key = json.dumps(['placement', 'project', 'local', value['targetId']], separators=(',', ':'))
                version = preferences.read()['fields'].get(key, {}).get('version', 0)
                placement = preferences, key, version
            self.operations[operation_id] = row
            try:
                write_json(self.path, self.operations)
            except Exception:
                del self.operations[operation_id]
                raise
            receipt = self._public(row)
            try:
                threading.Thread(target=self._run, args=(value, placement), daemon=True).start()
            except Exception:
                row.update(status='failed', message='无法启动侧栏操作，尚未发送到 Codex')
                write_json(self.path, self.operations)
                raise
            return receipt

    def _validate_targets(self, value):
        sidebar = self.bridge.hosts.sidebar()
        custom = {s['id'] for s in sidebar['sections']
                  if s['id'] not in BUILTIN_SECTIONS and not s.get('builtin')}
        if value['kind'] == 'section' and value['action'] != 'create' and value['targetId'] not in custom:
            raise ValueError('所选自定义分区已不存在，请刷新后重试')
        if value['kind'] == 'project':
            if not any(p.get('key') == value['targetId'] and p.get('host') == 'local'
                       for p in sidebar['projects']):
                raise ValueError('所选本机原生项目已不存在，请刷新后重试')
        destination = value.get('sectionId', value.get('beforeId'))
        allowed = custom | ({'pinned', 'threads'} if value['kind'] == 'project' else set())
        if destination is not None and destination not in allowed:
            raise ValueError('所选分区已不存在或不可移动，请刷新后重试')

    def _run(self, value, placement=None):
        def progress(status, message, details=None):
            if status in TERMINAL:
                raise ValueError('执行器只能报告进度，完成状态由操作回执保存')
            with self.lock:
                row = self.operations[value['id']]
                row.update(status=status, message=message)
                if details is not None:
                    row['details'] = copy.deepcopy(details)
                write_json(self.path, self.operations)

        try:
            request = {**value}
            if 'name' in request:
                request['name'] = request['name'].strip()
            execute = self.executor if callable(self.executor) else self.executor.execute
            result = execute(request, progress)
            if not isinstance(result, dict):
                raise ValueError('原生侧栏执行器未返回可核验的结果')
            if placement is not None:
                # Finish the shared display update even if the submitting page
                # closed. A concurrent explicit placement wins over this reset.
                preferences, key, version = placement
                preferences.save({'changes': [{'key': key, 'value': None, 'version': version}]})
            update = {k: copy.deepcopy(v) for k, v in result.items()
                      if k not in ('id', 'kind', 'action', 'fingerprint', 'resource', 'status')}
            update.update(status='completed', message=result.get('message') or '侧栏变更已由 Codex 保存并核验')
        except Exception as exc:
            # NativeSidebar upgrades post-dispatch failures to ToolError with
            # unknown=True. Ordinary preflight business validation is failed.
            update = {'status': 'unknown' if getattr(exc, 'unknown', not isinstance(exc, ValueError)) else 'failed',
                      'message': str(exc) or '原生操作结果未知，请检查 Codex 侧栏，不要重复操作'}
        with self.lock:
            self.operations[value['id']].update(update)
            write_json(self.path, self.operations)
