"""Use the verified desktop tool to clear one observed completion badge."""
from contextlib import nullcontext
import sys

from bridge.clients.codex.desktop_tools import DesktopTools, ToolError


class ReadStateTools(DesktopTools):
    METHODS = {'list_projects', 'read_thread', 'set_thread_read_state'}


class NativeReadState:
    def __init__(self, bridge):
        self.bridge = bridge

    def call(self, action, sid, body):
        if action != 'read-state':
            raise ValueError('不支持的已读操作')
        if sys.platform != 'win32' or self.bridge is None:
            return {'status': 'unsupported', 'message': '当前系统尚未提供 Codex 桌面已读同步通路'}
        bridge = self.bridge
        with getattr(getattr(bridge, 'accounts', None), 'operation_lock', nullcontext()):
            target = bridge.for_host(body['host'])
            # Metadata lookup enforces the same source and host visibility as history.
            target.store.get(sid)
            native = None
            try:
                native = ReadStateTools.connect_profile(bridge)
                value = native.call('read_thread', {'threadId': sid, 'hostId': target.host,
                    'turnLimit': 1, 'includeOutputs': False, 'maxOutputCharsPerItem': 500})
                thread = value.get('thread') or {}
                last = (value.get('turns') or [{}])[0]
                if thread.get('id') != sid or thread.get('hostId') != target.host:
                    raise ValueError('Codex 桌面聊天身份不一致，未同步已读')
                if (thread.get('status', {}).get('type') not in ('idle', 'notLoaded', 'systemError')
                        or last.get('id') != body['turnId'] or last.get('status') != body['turnStatus']):
                    return {'status': 'stale'}
                native.call('set_thread_read_state', {'threadId': sid, 'hostId': target.host, 'read': True})
                return {'status': 'accepted'}
            except ToolError as exc:
                raise ToolError('Codex 桌面已读状态尚未确认，请重新打开该聊天核对', unknown=exc.unknown) from exc
            finally:
                if native:
                    native.close()
