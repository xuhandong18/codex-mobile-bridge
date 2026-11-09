"""Present attached Desktop chats through their existing owner and write ledger."""
import copy
import uuid

from bridge.clients.codex.ipc import IPCError
from bridge.features.workspace.files import path_identity


class NativeSideChats:
    def __init__(self, bridge):
        self.bridge = bridge

    def metadata(self, parent, child):
        uuid.UUID(child)
        b = self.bridge
        root, row = b.store.get(parent), b.store.get(child)
        if (b.host != 'local' or parent == child or row.get('attached_thread_parent_id') != parent
                or root.get('origin') != 'desktop' or row.get('origin') != 'desktop'
                or not root.get('cwd') or not row.get('cwd') or not root.get('model_provider')
                or row.get('model_provider') != root['model_provider']
                or path_identity(row['cwd']) != path_identity(root['cwd'])):
            raise ValueError('原生侧边聊天归属已变化，未连接或发送')
        return row

    def valid_state(self, session, state):
        return (state.get('id') == session.id and state.get('hostId', self.bridge.host) == self.bridge.host
                and state.get('forkedFromId') == session.native_parent_id
                and state.get('sideConversation') is True and state.get('ephemeral') is False
                and bool(session.saved_cwd) and bool(session.saved_provider)
                and path_identity(state.get('cwd') or '') == path_identity(session.saved_cwd)
                and state.get('modelProvider') == session.saved_provider)

    def attach(self, session, timeout):
        b = self.bridge
        try:
            row = self.metadata(session.native_parent_id, session.id)
            if (row['model_provider'] != session.saved_provider
                    or path_identity(row['cwd']) != path_identity(session.saved_cwd or '')):
                raise ValueError('原生侧边聊天配置已变化，请重新打开标签')
            owner = b.ipc.owner(session.id, b.host)
            if not isinstance(owner, str) or not owner:
                raise IPCError('原桌面侧边聊天尚未连接')
            with session.condition:
                session.owner, session.revision = owner, None
                session.discovering = False
            b.ipc.follow(session.id, owner, host=b.host)
            with session.condition:
                session.condition.wait_for(lambda: session.connected or b.closed.is_set(), timeout=timeout)
        except (IPCError, OSError, ValueError, KeyError) as exc:
            b._invalidate(session, str(exc), runtime='desktop')

    def require_target(self, session):
        b = self.bridge
        try:
            row = self.metadata(session.native_parent_id, session.id)
            if (row['model_provider'] != session.saved_provider
                    or path_identity(row['cwd']) != path_identity(session.saved_cwd or '')):
                raise ValueError('原生侧边聊天的模型接入或目录已变化，未发送本次操作')
        except (ValueError, KeyError):
            b._invalidate(session, '原生侧边聊天归属或配置已变化，未发送本次操作')
            raise
        with session.condition:
            if not session.connected or not session.owner or not self.valid_state(session, session.state or {}):
                raise IPCError('原生侧边聊天尚未取得有效桌面连接，请在 Codex 中打开它后重试')
            owner = session.owner
        # Check the live routing authority immediately before each write. A new
        # owner needs its own snapshot; never send using the old cached state.
        if b.ipc.owner(session.id, b.host) != owner:
            b._invalidate(session, '原生侧边聊天的桌面连接已变化，正在重新连接')
            raise IPCError('原生侧边聊天的桌面连接已变化，未发送本次操作')

    def slots(self, parent):
        b, result = self.bridge, []
        for row in b.store.attached_threads(parent):
            try:
                self.metadata(parent, row['id'])
            except (KeyError, ValueError):
                continue
            if not row.get('archived'):
                result.append({'slot': row['id'], 'id': row['id'], 'title': row.get('name') or row.get('title') or '原生侧边聊天',
                               'titleSource': 'native', 'source': 'desktop', 'nativeAttached': True})
        return result

    def matches(self, parent, child):
        if self.bridge.host != 'local' or not child:
            return False
        try:
            self.metadata(parent, child)
            return True
        except (KeyError, ValueError, TypeError):
            return False

    def read(self, parent, child):
        b = self.bridge
        row = self.metadata(parent, child)
        session = b.session(child, attach=False)
        if (row['model_provider'] != session.saved_provider
                or path_identity(row['cwd']) != path_identity(session.saved_cwd or '')):
            b._invalidate(session, '原生侧边聊天配置已变化，请重新打开标签')
        if not session.connected:
            b._attach(session)
        with session.condition:
            state, connected = copy.deepcopy(session.state or {}), session.connected
            if connected and not self.valid_state(session, state):
                connected = False
            view = session.view()
        if connected:
            b.side_chats.native_snapshot(parent, child, state, session.revision)
        saved = b.side_chats.archive.read(parent, child) or {}
        view = {**saved, **view, 'turns': saved.get('turns', view.get('turns', [])),
                'id': child, 'parentId': parent, 'slot': child, 'archiveId': child, 'source': 'desktop',
                'nativeAttached': True, 'connected': connected, 'readOnly': not connected, 'expired': False,
                'syncState': 'live' if connected else 'offline'}
        if not connected:
            view['requests'] = []
        b._submission_meta(session, view)
        last = view.get('turns', [])[-1] if view.get('turns') else {}
        view.update(turnId=last.get('id'), turnStatus=last.get('status'), error=session.error)
        return view

    def operate(self, parent, child, action, body):
        b = self.bridge
        self.metadata(parent, child)
        session = b.session(child, attach=False)
        if action == 'close':
            # Closing a gateway view must never end the Desktop-owned runner.
            return {'closed': True, 'view': {**self.read(parent, child), 'readOnly': True}}
        self.require_target(session)
        if action == 'send':
            if body.get('workMode') == 'goal':
                raise ValueError('原生侧边聊天暂不支持从此入口操作目标')
            mode = body.get('mode', 'send')
            return b.send(child, body.get('text'), body.get('submissionId'), mode,
                          body.get('skills', []), attachments=body.get('attachments', []),
                          work_mode=None if mode == 'steer' else body.get('workMode', 'default'))
        if action == 'cancel-queued':
            return b.cancel_queued(child, body.get('submissionId'))
        if action == 'stop':
            b.interrupt(child)
        elif action == 'respond':
            b.respond(child, body.get('requestId'), body.get('response'))
        elif action == 'settings':
            b.settings(child, body.get('model'), body.get('effort'))
        elif action == 'permissions':
            b.permissions(child, body.get('preset'), body.get('confirmed', False))
        elif action == 'catalog':
            return {**b.catalog(child, kind='models'), 'currentModel': session.view()['model'],
                    'currentEffort': session.view()['effort']}
        elif action == 'skills':
            return b.catalog(child, kind='skills', query=body.get('query', ''), offset=body.get('offset', 0),
                             refresh=body.get('refresh', False), ids=body.get('selected', []))
        else:
            raise ValueError('此原生侧边聊天暂不支持该操作')
        return self.read(parent, child)
