"""Restricted app-tool protocol. No arbitrary RPC or automatic write retries."""
import json
import queue
import struct
import threading
import time
import uuid

from bridge.clients.codex.transport import connect_stream


class ToolError(ValueError):
    def __init__(self, message, *, unknown=False):
        super().__init__(message)
        self.unknown = unknown


class DesktopTools:
    METHODS = {'list_hosts', 'list_projects', 'list_threads', 'create_project', 'move_project_to_sidebar_section',
               'create_sidebar_section', 'rename_sidebar_section', 'delete_sidebar_section', 'reorder_sidebar_sections'}
    MAX_FRAME = 8 * 1024 * 1024

    def __init__(self, stream, context_id):
        self.stream, self.context_id = stream, context_id
        self.messages = queue.Queue()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        def exact(size):
            data = bytearray()
            while len(data) < size:
                part = self.stream.recv(size-len(data))
                if not part:
                    raise OSError('Desktop disconnected')
                data.extend(part)
            return data
        try:
            while True:
                size = struct.unpack('<I', exact(4))[0]
                if not 0 < size <= self.MAX_FRAME:
                    raise ValueError('Invalid desktop frame size')
                value = json.loads(exact(size))
                if not isinstance(value, dict):
                    raise ValueError('Invalid desktop frame')
                self.messages.put(value)
        except Exception:
            self.messages.put(None)

    def call(self, name, arguments, *, timeout=15):
        if name not in self.METHODS:
            raise ToolError('不支持的桌面工具')
        identifier = str(uuid.uuid4())
        value = {'jsonrpc':'2.0', 'id':identifier, 'method':'tools/call', 'params':{
            'namespace':'codex_app', 'tool':name, 'arguments':arguments, 'callerSource':'codex',
            'hostId':'local', 'threadId':self.context_id, 'turnId':'project-'+str(uuid.uuid4()), 'callId':identifier}}
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        try:
            self.stream.sendall(struct.pack('<I', len(data))+data)
            deadline = time.monotonic()+timeout
            while True:
                response = self.messages.get(timeout=max(.01, deadline-time.monotonic()))
                if response is None:
                    raise OSError('Desktop disconnected')
                if response.get('id') == identifier:
                    break
                if time.monotonic() >= deadline:
                    raise queue.Empty()
        except (OSError, queue.Empty) as exc:
            raise ToolError('桌面操作结果尚未确认，请检查 Codex 桌面项目列表，不要重复创建', unknown=True) from exc
        result = response.get('result')
        if not isinstance(result, dict):
            raise ToolError('桌面工具返回异常，请检查 Codex 桌面项目列表', unknown=True)
        content = next((p.get('text') for p in result.get('contentItems', []) if p.get('type') == 'inputText'), None)
        if result.get('success') is not True:
            if isinstance(content, str) and 'workspaceRoots' in content:
                raise ToolError('所选文件夹不在当前聊天已获准的目录内，请先在 Codex 桌面添加该目录')
            # The desktop can fail after registering a project. Only explicit
            # validation/cancellation responses prove that creation did not occur.
            safe = isinstance(content, str) and any(marker in content for marker in (
                'received invalid arguments', 'Project creation canceled by the user',
                'primarySource must be', 'remote projects accept', 'Unsupported dynamic tool'))
            raise ToolError(content or 'Codex 桌面操作未完成', unknown=name == 'create_project' and not safe)
        try:
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                raise ValueError('Expected an object')
            return parsed
        except (TypeError, ValueError) as exc:
            raise ToolError('桌面工具响应格式不受支持，请检查 Codex 桌面项目列表', unknown=True) from exc

    def close(self):
        self.stream.close()
        self.reader.join(timeout=2)

    @classmethod
    def connect_profile(cls, bridge, *, timeout=None):
        deadline = time.monotonic()+timeout if timeout is not None else None
        from bridge.clients.desktop_app import DesktopApp
        projects = {p['key'].split('|', 1)[1] for p in bridge.hosts.projects() if p['host'] == 'local'}
        contexts = bridge.store.list(limit=1, source='desktop')
        if not projects or not contexts:
            raise ToolError('No verified desktop profile context')
        executable = bridge.accounts.index.get('desktopExecutable') or DesktopApp.scan(bridge.catalog_reader.executable, bridge.codex_home)
        return cls.connect(executable, contexts[0]['id'], projects,
                           **({'timeout': max(0, deadline-time.monotonic())} if deadline is not None else {}))

    @classmethod
    def connect(cls, executable, context_id, project_ids, *, timeout=None):
        from bridge.platforms.windows.tool_pipe import endpoints, verify_server
        deadline = time.monotonic()+timeout if timeout is not None else None
        for endpoint in endpoints():
            if deadline is not None and time.monotonic() >= deadline:
                break
            client, stream = None, None
            try:
                stream = connect_stream(endpoint, timeout=min(.3, max(.001, deadline-time.monotonic())) if deadline is not None else .3)
                verify_server(stream, executable)
                client = cls(stream, context_id)
                if deadline is not None and time.monotonic() >= deadline:
                    raise ToolError('读取桌面状态超时')
                native = client.call('list_projects', {}, **({'timeout': max(.001, deadline-time.monotonic())} if deadline is not None else {}))
                if not project_ids.intersection(p.get('projectId') for p in native.get('projects', [])):
                    raise ToolError('桌面项目数据与当前 Codex 配置不一致')
                return client
            except (OSError, ValueError):
                if client:
                    client.close()
                elif stream:
                    stream.close()
        raise ToolError('未连接到当前配置的 Codex 桌面工具，请打开 Codex 后重试')
