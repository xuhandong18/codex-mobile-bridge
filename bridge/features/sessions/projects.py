"""Project validation and scoped folder creation; the desktop owns project records."""
import json
import os
import re
import threading
import uuid
import hashlib
import secrets
import time
from contextlib import nullcontext
from pathlib import Path
from bridge.features.notifications.channels import read_json, write_json
from bridge.features.workspace.workspace import Workspace


class Projects:
    def __init__(self, data_dir, native_creator=None):
        self.path = Path(data_dir)/'projects.json'
        self.lock = threading.RLock()
        self.native_creator = native_creator
        self.directory_selections = {}
        self.operations_path = Path(data_dir)/'project-operations.json'
        self.operations = read_json(self.operations_path, {})
        for operation in self.operations.values():
            if operation['status'] in ('pending','creating','assigning','verifying'):
                operation.update(status='unknown', message='上次桌面操作中断，请检查 Codex 项目列表，不要重复创建')
        self.directory_operations_path = Path(data_dir)/'project-directory-operations.json'
        self.directory_operations = read_json(self.directory_operations_path, {})
        interrupted = False
        for operation in self.directory_operations.values():
            if operation['status'] in ('pending', 'creating'):
                operation.update(status='unknown', message='上次文件夹创建中断，请先核对实际目录，不要重复创建')
                interrupted = True
        if interrupted:
            write_json(self.directory_operations_path, self.directory_operations)

    @staticmethod
    def _directory_receipt(operation):
        result = {key:operation[key] for key in ('id', 'status', 'message')}
        if 'directory' in operation:
            result['directory'] = dict(operation['directory'])
        return result

    def directory_operation(self, identifier, owner=None):
        try:
            identifier = str(uuid.UUID(identifier))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('文件夹请求标识无效') from None
        with self.lock:
            if identifier not in self.directory_operations:
                raise ValueError('找不到文件夹创建记录')
            if self.directory_operations[identifier].get('owner') not in (None, owner):
                raise PermissionError('此文件夹创建记录不属于当前登录')
            return self._directory_receipt(self.directory_operations[identifier])

    def _select_directory(self, parent, owner):
        identity = Workspace(parent).directory_identity()
        now = time.monotonic()
        with self.lock:
            self.directory_selections = {key:value for key,value in self.directory_selections.items() if value['expires'] > now}
            while len(self.directory_selections) >= 256:
                self.directory_selections.pop(next(iter(self.directory_selections)))
            token = secrets.token_hex(32)
            self.directory_selections[token] = {'parent':parent, 'owner':owner, 'identity':identity, 'expires':now+600}
            return token

    def _directory_selection(self, value, owner):
        selection = self.directory_selections.get(value['selectionId'])
        if (not owner or not selection or selection['owner'] != owner or selection['parent'] != value['parent']
                or selection['expires'] <= time.monotonic()):
            raise PermissionError('文件夹选择已失效，请刷新父目录后重新创建')
        return dict(selection)

    @staticmethod
    def _directory_request(value):
        if (not isinstance(value, dict) or set(value)-{'id', 'parent', 'name', 'contextId', 'selectionId'}
                or not {'id', 'parent', 'name'} <= set(value)):
            raise ValueError('新建文件夹请求无效')
        result = dict(value)
        if 'selectionId' in value and (not isinstance(value['selectionId'], str) or not re.fullmatch(r'[a-f0-9]{64}', value['selectionId'])):
            raise ValueError('文件夹选择标识无效，请刷新父目录后重新创建')
        for key in ('id', 'contextId'):
            if key == 'contextId' and key not in value:
                continue
            try:
                result[key] = str(uuid.UUID(value[key]))
            except (ValueError, TypeError, AttributeError):
                raise ValueError('文件夹请求或桌面聊天标识无效') from None
        parent = value['parent']
        if (not isinstance(parent, str) or not parent.strip() or len(parent) > 4096
                or any(ord(c) < 32 or ord(c) == 127 for c in parent)
                or any(part in ('.', '..') for part in re.split(r'[/\\]', parent))):
            raise ValueError('请选择已存在文件夹的完整路径，不含路径穿越')
        path = Path(parent)
        if not path.is_absolute():
            raise ValueError('请使用父文件夹的完整路径')
        if os.name == 'nt' and (parent.replace('/', '\\').startswith(('\\\\?\\', '\\\\.\\'))
                or any(part.endswith((' ', '.')) or ':' in part for part in path.parts[1:])):
            raise ValueError('父文件夹路径包含不支持的系统别名')
        Workspace.directory_name(value['name'])
        return result

    def submit_directory(self, value, owner=None):
        value = self._directory_request(value)
        identifier = value['id']
        fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        # Directory targets have their own ledger; creating a project from this
        # folder later must remain independent of the filesystem operation.
        with self.lock:
            if identifier in self.directory_operations:
                prior = self.directory_operations[identifier]
                if prior.get('owner') not in (None, owner):
                    raise PermissionError('此文件夹创建记录不属于当前登录')
                if prior['fingerprint'] != fingerprint:
                    raise ValueError('同一个文件夹创建请求不能修改内容')
                return self._directory_receipt(prior)
            if not self.can_create_directory:
                raise ValueError('尚未接通 Codex 桌面的原生目录授权接口，请先在桌面端创建文件夹')
            selection = self._directory_selection(value, owner) if 'selectionId' in value else None
            # Resolve only the existing parent for target identity (including
            # Windows short-name aliases). The worker still walks the original
            # path without following links; this is not an authorization check.
            parent = Path(value['parent']).resolve()
            target = hashlib.sha256(os.path.normcase(str(parent / value['name'])).encode()).hexdigest()
            if any(op.get('target') == target and op['status'] != 'failed' for op in self.directory_operations.values()):
                raise ValueError('这个文件夹已有创建请求，请先核对实际目录，不要重复创建')
            self.directory_operations[identifier] = {'id':identifier, 'fingerprint':fingerprint, 'target':target,
                'status':'pending', 'message':'正在核验所选父文件夹' if selection else '正在核验 Codex 桌面目录权限'}
            if selection:
                self.directory_operations[identifier]['owner'] = owner
            # No filesystem mutation can start until the pending receipt is saved.
            write_json(self.directory_operations_path, self.directory_operations)
            threading.Thread(target=self._run_directory, args=(value, selection), daemon=True).start()
            return self._directory_receipt(self.directory_operations[identifier])

    def _directory_progress(self, identifier, status, message, directory=None):
        with self.lock:
            operation = self.directory_operations[identifier]
            operation.update(status=status, message=message)
            if directory is not None:
                operation['directory'] = directory
            write_json(self.directory_operations_path, self.directory_operations)

    def _run_directory(self, value, selection=None):
        attempted = False
        directory = None
        try:
            # A browser selection authorizes one-level mkdir only under that
            # exact parent, bound to this login and its observed directory identity.
            # Legacy callers retain the native chat-root authorization path.
            scope = nullcontext(selection['parent']) if selection else self.native_creator.directory_scope(value)
            with scope as root:
                workspace = Workspace(root)
                try:
                    relative = Path(value['parent']).relative_to(workspace.root).as_posix()
                except ValueError:
                    raise PermissionError('父文件夹不在已获准的真实目录内') from None
                if relative == '.':
                    relative = ''
                self._directory_progress(value['id'], 'creating', '正在创建文件夹')
                attempted = True
                directory = workspace.mkdir(relative, value['name'], expected_parent=selection['identity']) if selection else workspace.mkdir(relative, value['name'])
                directory['parent'] = value['parent']
            self._directory_progress(value['id'], 'completed', '文件夹已创建', directory)
        except Exception as exc:
            # These errors prove mkdir was refused. Other failures after entry
            # may have happened after the write, including receipt persistence.
            refused = isinstance(exc, (FileExistsError, FileNotFoundError, NotADirectoryError, PermissionError, ValueError))
            unknown = directory is not None or attempted and (getattr(exc, 'unknown', False) or not refused)
            message = ('文件夹创建结果尚未确认，请先核对实际目录，不要重复创建' if unknown else
                       '同名文件或文件夹已存在，不会覆盖' if isinstance(exc, FileExistsError) else
                       str(exc) or '文件夹创建失败')
            try:
                self._directory_progress(value['id'], 'unknown' if unknown else 'failed', message)
            except OSError:
                # The durable pending/creating entry also becomes unknown after
                # restart. Do not expose a retryable result on persistence loss.
                with self.lock:
                    self.directory_operations[value['id']].update(status='unknown',
                        message='文件夹回执无法保存，请先核对实际目录，不要重复创建')

    @property
    def can_create(self):
        return self.native_creator is not None and bool(getattr(self.native_creator, 'available', True))

    @property
    def can_create_directory(self):
        return self.can_create and callable(getattr(self.native_creator, 'directory_scope', None))

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

    def browse(self, value, owner=None):
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
        result = {'path':str(path), 'parent':str(path.parent) if path.parent != path else '',
                  'directories':sorted(children, key=lambda row:row['name'].casefold())}
        if owner and self.can_create_directory:
            result['selectionId'] = self._select_directory(str(path), owner)
        return result

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


class SelectedDirectories(Projects):
    """Folder-only service for clients without Codex's native directory grants."""
    @property
    def can_create_directory(self):
        return True

    def submit_directory(self, value, owner=None):
        if not isinstance(value, dict) or 'selectionId' not in value:
            raise PermissionError('请先浏览并选择父文件夹后再创建')
        return super().submit_directory(value, owner)
