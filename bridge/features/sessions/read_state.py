"""A read acknowledgement identifies exactly the terminal turn the user saw."""
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
        with self.lock:
            for row in rows:
                host, chat = row['host'], row['id']
                item = {**row, 'readCompletions': self.read(host, chat)}
                if isinstance(row.get('sideChats'), list):
                    item['sideChats'] = [{**child, 'readCompletions': self.read(host, chat + '/side/' + child['id'])}
                                         for child in row['sideChats']]
                result.append(item)
        return result


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
