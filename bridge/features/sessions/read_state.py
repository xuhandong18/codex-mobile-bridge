"""A read acknowledgement identifies exactly the terminal turn the user saw."""
import json
import sqlite3
import threading
import uuid
from pathlib import Path


class SharedReadState:
    """Gateway receipts shared by its listeners and devices, scoped by host/chat."""
    def __init__(self, directory):
        self.lock = threading.RLock()
        if directory:
            Path(directory).mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(str(Path(directory) / 'chat-read-state.sqlite3') if directory else ':memory:',
                                  check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS completions ('
                        'sequence INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, '
                        'chat TEXT NOT NULL, token TEXT NOT NULL, UNIQUE(host, chat, token))')
        self.db.execute('CREATE TABLE IF NOT EXISTS completion_activity ('
                        'host TEXT NOT NULL, chat TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(host, chat))')
        self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()

    def read(self, host, chat):
        with self.lock:
            return [row[0] for row in self.db.execute(
                'SELECT token FROM completions WHERE host=? AND chat=? ORDER BY sequence', (host, chat))]

    def remember(self, host, chat, body):
        validate_read_state(body)
        token = body['turnId'] + ':' + body['turnStatus']
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO completions(host, chat, token) VALUES (?, ?, ?)', (host, chat, token))
            self.db.execute('DELETE FROM completions WHERE host=? AND chat=? AND sequence NOT IN '
                            '(SELECT sequence FROM completions WHERE host=? AND chat=? ORDER BY sequence DESC LIMIT 64)',
                            (host, chat, host, chat))
        return self.read(host, chat)

    def activity(self, rows):
        # Copy cached summaries: a late activity reply must not mutate another reader.
        result = []
        with self.lock, self.db:
            for row in rows:
                host, chat = row['host'], row['id']
                item = {**row, 'readCompletions': self.read(host, chat), 'completionToken': self._observe(host, chat, row)}
                if isinstance(row.get('sideChats'), list):
                    item['sideChats'] = [{**child, 'readCompletions': self.read(host, chat + '/side/' + child['id']),
                                         'completionToken': self._observe(host, chat + '/side/' + child['id'], child)}
                                         for child in row['sideChats']]
                result.append(item)
        return result

    def observe(self, host, chat, row):
        """Share new completions even with devices that never saw the run.

        The first confirmed snapshot only establishes a baseline. Observations
        never acknowledge reading, activate an owner, or load any chat history.
        """
        with self.lock, self.db:
            return self._observe(host, chat, row)

    def _observe(self, host, chat, row):
        saved = self.db.execute('SELECT state FROM completion_activity WHERE host=? AND chat=?', (host, chat)).fetchone()
        previous = json.loads(saved[0]) if saved else {}
        completion = previous.get('completion')
        if not (row.get('activityConnected') or row.get('connected')) or row.get('status') in (None, 'unknown'):
            return completion
        observed = row.get('waitingObservedAt')
        if observed is not None and previous.get('observedAt') is not None and observed < previous['observedAt']:
            return completion
        last = (row.get('turns') or [{}])[-1]
        turn_id, turn_status = row.get('turnId') or last.get('id'), row.get('turnStatus') or last.get('status')
        parent_status = row.get('parentStatus', row['status'])
        terminal = parent_status != 'active' and turn_status in ('completed', 'failed', 'interrupted')
        token = turn_id + ':' + turn_status if terminal and turn_id else previous.get('token')
        descendants = row.get('runningSubagents', previous.get('runningSubagents', 0))
        subtree_finished = previous.get('runningSubagents', 0) > 0 and not descendants
        was_active = previous.get('parentStatus') == 'active' or subtree_finished
        if terminal and turn_id and previous and (was_active or previous.get('turnKnown') and token != previous.get('token')):
            completion = token
        current = {'parentStatus': parent_status, 'runningSubagents': descendants, 'token': token,
                   'turnKnown': bool(turn_status) or previous.get('turnKnown', False), 'completion': completion,
                   'observedAt': observed if observed is not None else previous.get('observedAt')}
        if current != previous:
            self.db.execute('INSERT INTO completion_activity(host, chat, state) VALUES (?, ?, ?) '
                            'ON CONFLICT(host, chat) DO UPDATE SET state=excluded.state',
                            (host, chat, json.dumps(current, separators=(',', ':'))))
        return completion


def validate_read_state(body, *, codex=False):
    fields = {'id', 'turnId', 'turnStatus'} | ({'host'} if codex else set())
    if not isinstance(body, dict) or set(body) != fields:
        raise ValueError('聊天已读参数无效')
    if not isinstance(body['id'], str):
        raise ValueError('聊天已读操作标识无效')
    uuid.UUID(body['id'])
    if (not isinstance(body['turnId'], str) or not 0 < len(body['turnId']) <= 512
            or body['turnStatus'] not in ('completed', 'failed', 'interrupted')):
        raise ValueError('只能同步已经查看的已结束轮次')
    if codex and (not isinstance(body['host'], str) or not body['host']):
        raise ValueError('聊天主机无效')
