"""Release a desktop-owned idle thread through its original native manager."""
import sys
import time

from bridge.clients.codex.desktop_tools import DesktopTools, ToolError
from bridge.clients.codex.projects import canonical


class ThreadManagementTools(DesktopTools):
    METHODS = {'list_projects', 'read_thread', 'list_artifacts', 'set_thread_archived'}


def archive_owned_thread(bridge, thread_id):
    if sys.platform != 'win32' or bridge.host != 'local':
        raise ValueError('此聊天仍由 Codex 桌面占用，请在原桌面永久删除')
    metadata = bridge.store.get(thread_id)
    native = ThreadManagementTools.connect_profile(bridge)
    try:
        # The profile has already been verified. Bind artifact checks and the
        # archive operation to the selected, authorized chat rather than the
        # unrelated context used to discover the desktop pipe.
        native.context_id = thread_id
        value = native.call('read_thread', {'threadId': thread_id, 'hostId': bridge.host,
                            'turnLimit': 1, 'includeOutputs': False, 'maxOutputCharsPerItem': 100})
        thread = value.get('thread') or {}
        if (thread.get('id') != thread_id or thread.get('hostId') != bridge.host
                or canonical(thread.get('cwd')) != canonical(metadata.get('cwd'))):
            raise ValueError('Codex 桌面聊天身份已变化，尚未继续删除')
        if (thread.get('status', {}).get('type') not in ('idle', 'notLoaded')
                or any(turn.get('status') == 'inProgress' for turn in value.get('turns', []))):
            raise ValueError('此聊天仍有任务运行，尚未继续删除')
        artifacts = native.call('list_artifacts', {}).get('artifacts')
        if not isinstance(artifacts, list) or any(not isinstance(row, dict) for row in artifacts):
            raise ValueError('无法核验聊天工作树，尚未继续删除')
        if any('worktree' in str(row.get('type', row.get('artifactType', ''))).lower() for row in artifacts):
            # Native archiving can clean up a managed worktree. Chat deletion
            # does not authorize that additional filesystem operation.
            raise ValueError('此聊天附带工作树，请在 Codex 桌面永久删除，以保留工作树处理选项')
        result = native.call('set_thread_archived', {'threadId': thread_id, 'hostId': bridge.host, 'archived': True})
        if result.get('threadId') != thread_id or result.get('archived') is not True:
            raise ToolError('原生归档结果无法核验，请检查桌面聊天列表', unknown=True)
        deadline = time.monotonic() + 8
        while True:
            if bridge.store.get(thread_id).get('archived'):
                return
            if time.monotonic() >= deadline:
                raise ToolError('原生归档尚未确认保存，请检查桌面聊天列表', unknown=True)
            time.sleep(.1)
    finally:
        native.close()
