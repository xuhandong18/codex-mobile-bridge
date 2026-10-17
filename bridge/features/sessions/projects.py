"""Project validation and folder browsing; creation must be owned by the desktop."""
import json
import os
import threading
import uuid
import hashlib
from pathlib import Path
from bridge.features.notifications.channels import read_json, write_json


class Projects:
    def __init__(self, data_dir, native_creator=None):
        self.path = Path(data_dir)/'projects.json'
        self.lock = threading.RLock()
        self.native_creator = native_creator
        self.operations_path = Path(data_dir)/'project-operations.json'
        self.operations = read_json(self.operations_path, {})
        for operation in self.operations.values():
            if operation['status'] in ('pending','creating','assigning','verifying'):
                operation.update(status='unknown', message='上次桌面操作中断，请检查 Codex 项目列表，不要重复创建')

    @property
    def can_create(self):
        return self.native_creator is not None and bool(getattr(self.native_creator, 'available', True))

    def operation(self, identifier):
        with self.lock:
            if identifier not in self.operations:
                raise ValueError('找不到项目创建记录')
            return dict(self.operations[identifier])

    def submit(self, value, native_projects, sections):
        if not isinstance(value, dict):
            raise ValueError('新建项目请求无效')
        try:
            identifier = str(uuid.UUID(value.get('id')))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('项目请求标识无效') from None
        value = {**value, 'id':identifier}
        fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.lock:
            if identifier in self.operations:
                prior = self.operations[identifier]
                if prior['fingerprint'] != fingerprint:
                    raise ValueError('同一个创建请求不能修改内容')
                return dict(prior)
            # Validate synchronously; only the worker can send the native mutation.
            validated = self.create(value, native_projects, sections, validate_only=True)
            target = hashlib.sha256(os.path.normcase(validated['cwd']).encode()).hexdigest()
            for operation in self.operations.values():
                if operation.get('target') == target and operation['status'] != 'failed':
                    raise ValueError('这个目录已有创建请求，请检查 Codex 桌面项目列表，不要重复创建')
            self.operations[identifier] = {'id':identifier, 'fingerprint':fingerprint, 'target':target,
                'status':'pending', 'message':'正在连接 Codex 桌面'}
            write_json(self.operations_path, self.operations)
            threading.Thread(target=self._run, args=(validated,), daemon=True).start()
            return dict(self.operations[identifier])

    def _run(self, value):
        def progress(status, message, project=None):
            with self.lock:
                self.operations[value['id']].update(status=status, message=message)
                if project:
                    self.operations[value['id']]['project'] = project
                write_json(self.operations_path, self.operations)
        try:
            result = self.native_creator(value, progress)
            progress('completed', '项目已由 Codex 桌面创建并保存', result)
        except Exception as exc:
            project = getattr(exc, 'project', None)
            progress('partial' if project else 'unknown' if getattr(exc, 'unknown', False) else 'failed', str(exc), project)

    def rows(self):
        with self.lock:
            if not self.path.exists():
                return []
            try:
                value = json.loads(self.path.read_text(encoding='utf-8'))
                if not isinstance(value, list):
                    raise ValueError()
                return value
            except (OSError, ValueError):
                raise ValueError('项目配置无法读取，请检查网关数据') from None

    @staticmethod
    def directory(value):
        if not isinstance(value, str) or not value.strip() or len(value) > 4096 or '\x00' in value:
            raise ValueError('请选择有效文件夹')
        path = Path(value)
        if not path.is_absolute():
            raise ValueError('请使用文件夹的完整路径')
        try:
            path = path.resolve(strict=True)
            if not path.is_dir():
                raise OSError()
        except (OSError, RuntimeError):
            raise ValueError('文件夹不存在或无法访问') from None
        return path

    def browse(self, value):
        if not value:
            roots = [Path.home(), Path.cwd().anchor]
            if os.name == 'nt':
                roots.extend(Path(letter+':/') for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' if Path(letter+':/').is_dir())
            return {'path':'', 'parent':None, 'directories':[{'name':str(p), 'path':str(p)} for p in dict.fromkeys(map(str, roots))]}
        path = self.directory(value)
        try:
            children = []
            for child in path.iterdir():
                try:
                    if child.is_dir() and not child.is_symlink():
                        children.append({'name':child.name, 'path':str(child)})
                except OSError:
                    continue
            if len(children) > 2000:
                raise ValueError('子文件夹过多，请输入更具体的路径')
        except OSError:
            raise ValueError('没有权限浏览此文件夹') from None
        return {'path':str(path), 'parent':str(path.parent) if path.parent != path else '',
                'directories':sorted(children, key=lambda row:row['name'].casefold())}

    def create(self, value, native_projects, sections, validate_only=False):
        if not self.can_create:
            raise ValueError('尚未接通 Codex 桌面的原生项目创建接口，请先在桌面端添加项目；不会保存为网关项目')
        if not isinstance(value, dict) or set(value)-{'id','name','cwd','sectionId','contextId'} or not {'id','name','cwd','sectionId'} <= set(value):
            raise ValueError('新建项目请求无效')
        try:
            identifier = str(uuid.UUID(value['id']))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('项目请求标识无效') from None
        name = value['name']
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            raise ValueError('请输入 1–120 字的项目名称')
        section = value['sectionId']
        if section is not None and (not isinstance(section, str) or section not in {s['id'] for s in sections}):
            raise ValueError('所选分区已不存在，请刷新后重试')
        cwd = str(self.directory(value['cwd']))
        context = value.get('contextId')
        if context is not None:
            try:
                context = str(uuid.UUID(context))
            except (ValueError, TypeError, AttributeError):
                raise ValueError('项目创建的桌面聊天标识无效') from None
        with self.lock:
            if any(p.get('host') == 'local' and os.path.normcase(p['cwd']) == os.path.normcase(cwd) for p in native_projects):
                raise ValueError('这个文件夹已经关联了项目，请使用已有项目')
            request = {'id':identifier, 'name':name.strip(), 'cwd':cwd, 'sectionId':section}
            if context:
                request['contextId'] = context
            return request if validate_only else self.native_creator(request)
