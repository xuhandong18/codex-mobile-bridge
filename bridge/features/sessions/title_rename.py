"""Explicit conversation summaries; the original chat is never resumed or prompted."""
import uuid

from bridge.clients.codex.title_runtime import access_stamp
from bridge.features.sessions.model import normalize_state, session_title


def conversation_text(state):
    messages = []
    for turn in normalize_state(state)['turns']:
        for message in turn['messages']:
            text = message.get('text')
            if message['role'] in ('user', 'assistant') and isinstance(text, str) and text.strip():
                messages.append(message['role'] + ': ' + text[:2000])
    text = '\n\n'.join(messages)
    # Preserve the initial subject and the latest discussion for long chats.
    return text if len(text) <= 12000 else text[:4000] + '\n[…]\n' + text[-7990:]


class TitleRenames:
    def __init__(self, bridge):
        self.bridge = bridge
        self.jobs = bridge.auto_titles

    def _rows(self, thread_id):
        prefix = 'rename:' + thread_id + ':'
        return [(key, row) for key, row in self.jobs.jobs.items() if key.startswith(prefix)]

    def status(self, thread_id, request_id=None):
        uuid.UUID(thread_id)
        if request_id is not None:
            request_id = str(uuid.UUID(request_id))
        metadata = self.bridge.store.get(thread_id)
        with self.jobs.lock:
            rows = self._rows(thread_id)
            if request_id is not None:
                rows = [(key, row) for key, row in rows if key.endswith(':' + request_id)]
            key, row = rows[-1] if rows else ('', {})
            if row.get('status') == 'linked':
                row = self.jobs.jobs.get(row['target'], {'status': 'unknown'})
            return {'status': row.get('status', 'unknown' if request_id else 'ready'),
                    'requestId': key.rsplit(':', 1)[-1] if key else request_id, 'title': session_title(metadata)}

    def cancel(self, thread_id):
        with self.jobs.lock:
            for key, row in self._rows(thread_id):
                if row['status'] in ('queued', 'running'):
                    self.jobs.protect(key)

    def start(self, thread_id, request_id):
        uuid.UUID(thread_id)
        if not isinstance(request_id, str):
            raise ValueError('AI重命名请求标识无效')
        request_id = str(uuid.UUID(request_id))
        bridge = self.bridge
        if bridge.host != 'local':
            raise ValueError('AI重命名暂仅支持本机 Codex 聊天')
        bridge._require_desktop_feature(thread_id)
        session = bridge.session(thread_id, attach=False, background=True)
        # Serialize explicit requests with manual/automatic title writes.
        with session.action_lock:
            key = 'rename:' + thread_id + ':' + request_id
            with self.jobs.lock:
                if key in self.jobs.jobs:
                    return self.status(thread_id, request_id)
                pending = next((key for key, row in self._rows(thread_id) if row['status'] in ('queued', 'running')), None)
                if pending:
                    self.jobs.jobs[key] = {'status': 'linked', 'target': pending}
                    self.jobs._save()
                    return self.status(thread_id, request_id)
            metadata = bridge.store.get(thread_id)
            if metadata.get('archived'):
                raise ValueError('请先取消归档，再使用AI重命名')
            history = bridge.store.history(thread_id, turn_limit=100)
            with session.condition:
                current = session.state or {}
                settings = {'model': current.get('latestModel') or history.get('latestModel') or metadata.get('model'),
                            'modelProvider': current.get('modelProvider') or history.get('modelProvider') or metadata.get('model_provider')}
                current_title = current.get('name') or current.get('title')
                # Prefer the latest live conversation when available.
                live_text = conversation_text(current) if current.get('turns') else ''
            text = conversation_text(history)
            if live_text and live_text not in text:
                text = (text[:6000] + '\n\n' + live_text[-5990:]) if text else live_text
            if not text.strip():
                raise ValueError('此聊天还没有可用于生成标题的文字')
            if not all(settings.values()):
                raise ValueError('尚未取得此聊天的模型接入，请先连接聊天后再生成名称')
            stamp = access_stamp(bridge.codex_home)
            expected = (metadata.get('name'), metadata.get('title'))

            def apply(title):
                with session.action_lock:
                    if self.jobs.protected(key) or stamp != access_stamp(bridge.codex_home):
                        return False
                    latest = bridge.store.get(thread_id)
                    if latest.get('archived') or (latest.get('name'), latest.get('title')) != expected:
                        return False
                    with session.condition:
                        now = session.state or {}
                        if (now.get('name') or now.get('title')) != current_title:
                            return False
                    bridge._rename(thread_id, title, manual=False)
                    return True

            # An explicit choice supersedes pending first-message naming.
            self.jobs.protect('main:' + thread_id)
            if not self.jobs.submit(key, text, bridge._title_generator(text, settings, stamp, conversation=True),
                                    lambda title: bridge.apply_title_rename(apply, title)):
                raise ValueError('标题任务队列已满，请稍后再试')
            return self.status(thread_id)
