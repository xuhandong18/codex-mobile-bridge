"""Gateway-owned answer drafts. Saving never loads or responds to a client session."""
import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path


class AnswerDrafts:
    MAX_VALUE = 64 * 1024
    MAX_FIELDS = 4096
    MAX_AGE = 90 * 24 * 3600

    def __init__(self, data_dir):
        self.path = Path(data_dir) / 'answer-drafts.sqlite3' if data_dir else ':memory:'
        if data_dir:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS fields '
                        '(scope TEXT, field TEXT, value TEXT, version INTEGER, updated REAL, PRIMARY KEY(scope, field))')
        self.db.commit()

    @staticmethod
    def _key(value, limit):
        if not isinstance(value, str) or not value or len(value.encode('utf-8')) > limit:
            raise ValueError('答案草稿标识无效')
        return hashlib.sha256(value.encode('utf-8')).hexdigest()

    def read(self, scope):
        scope = self._key(scope, 4096)
        with self.lock:
            rows = self.db.execute('SELECT field, value, version FROM fields WHERE scope=? AND updated>?',
                                   (scope, time.time() - self.MAX_AGE)).fetchall()
        return {'fields': {field: {'value': json.loads(value), 'version': version} for field, value, version in rows}}

    def save(self, body):
        if not isinstance(body, dict) or set(body) != {'scope', 'field', 'value', 'version'}:
            raise ValueError('答案草稿格式无效')
        scope, field = self._key(body['scope'], 4096), body['field']
        self._key(field, 32768)
        version, value = body['version'], body['value']
        if type(version) is not int or not 0 <= version < 2 ** 53:
            raise ValueError('答案草稿版本无效')
        if (not isinstance(value, list) or len(value) > 200
                or any(not isinstance(row, dict) or set(row) != {'value', 'checked'}
                       or not isinstance(row['value'], str) or type(row['checked']) is not bool for row in value)):
            raise ValueError('答案草稿内容无效')
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        if len(encoded.encode('utf-8')) > self.MAX_VALUE:
            raise ValueError('答案草稿内容过长')
        with self.lock, self.db:
            self.db.execute('DELETE FROM fields WHERE updated<=?', (time.time() - self.MAX_AGE,))
            old = self.db.execute('SELECT value, version FROM fields WHERE scope=? AND field=?', (scope, field)).fetchone()
            if (old[1] if old else 0) != version:
                return 409, {'error': '其他设备已修改此答案，当前输入已保留。请核对后重新编辑。'}
            if not old and self.db.execute('SELECT COUNT(*) FROM fields').fetchone()[0] >= self.MAX_FIELDS:
                raise ValueError('答案草稿空间已满')
            self.db.execute('INSERT OR REPLACE INTO fields VALUES (?, ?, ?, ?, ?)',
                            (scope, field, encoded, version + 1, time.time()))
        return 200, {'value': value, 'version': version + 1}

    def close(self):
        with self.lock:
            self.db.close()
