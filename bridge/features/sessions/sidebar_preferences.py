"""Gateway-owned sidebar display settings shared by every authenticated device.

Each pin, placement and project list has its own version. Clearing a setting
retains its version so an old browser cannot import it again after deletion.
No operation here connects to, activates or changes a native client session.
"""
import json
import sqlite3
import threading
from pathlib import Path


class SidebarPreferences:
    MAX_FIELDS = 10000
    MAX_VALUE = 128 * 1024

    def __init__(self, data_dir):
        path = Path(data_dir) / 'sidebar-preferences.sqlite3' if data_dir else ':memory:'
        if data_dir:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.execute('CREATE TABLE IF NOT EXISTS fields '
                        '(key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)')
        self.db.execute('INSERT OR IGNORE INTO state VALUES (1, 0)')
        self.db.commit()

    @staticmethod
    def _text(value):
        return isinstance(value, str) and 0 < len(value) <= 1024 and all(c.isprintable() for c in value)

    @classmethod
    def _field(cls, key, value):
        try:
            parts = json.loads(key) if isinstance(key, str) and len(key) <= 8192 else None
        except ValueError:
            parts = None
        if not isinstance(parts, list) or not parts or not all(cls._text(part) for part in parts):
            raise ValueError('侧栏设置标识无效')
        kind = parts[0]
        valid = False
        if kind == 'pin' and len(parts) == 3:
            valid = type(value) is bool
        elif kind == 'order' and len(parts) == 2:
            valid = (isinstance(value, list) and len(value) <= 2000
                     and all(cls._text(item) for item in value) and len(value) == len(set(value)))
        elif kind == 'placement' and len(parts) == 4 and parts[1] in ('thread', 'project'):
            def destination(target):
                return cls._text(target) and (target in ('home', 'pinned')
                       or target.startswith('section:') and len(target) > 8)
            valid = (value is None or isinstance(value, dict) and {'target'} <= value.keys()
                     and not value.keys() - {'target', 'previous'} and destination(value['target'])
                     and ('previous' not in value or destination(value['previous'])))
        if not valid:
            raise ValueError('侧栏设置内容无效')
        encoded = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        if len(encoded.encode('utf-8')) > cls.MAX_VALUE:
            raise ValueError('侧栏设置内容过长')
        return json.dumps(parts, ensure_ascii=False, separators=(',', ':')), encoded

    def _read(self):
        return {'revision': self.db.execute('SELECT revision FROM state WHERE id=1').fetchone()[0],
                'fields': {key: {'value': json.loads(value), 'version': version}
                           for key, value, version in self.db.execute('SELECT key, value, version FROM fields')}}

    def read(self):
        with self.lock, self.db:
            self.db.execute('BEGIN')
            return self._read()

    def save(self, body):
        if (not isinstance(body, dict) or set(body) != {'changes'}
                or not isinstance(body['changes'], list) or not 1 <= len(body['changes']) <= 1000):
            raise ValueError('侧栏设置请求格式无效')
        changes = []
        for row in body['changes']:
            if not isinstance(row, dict) or set(row) != {'key', 'value', 'version'}:
                raise ValueError('侧栏设置字段无效')
            if type(row['version']) is not int or not 0 <= row['version'] < 2 ** 53:
                raise ValueError('侧栏设置版本无效')
            key, encoded = self._field(row['key'], row['value'])
            changes.append((key, encoded, row['version']))
        if len({key for key, _, _ in changes}) != len(changes):
            raise ValueError('侧栏设置字段重复')
        with self.lock, self.db:
            self.db.execute('BEGIN IMMEDIATE')
            current = {key: version for key, version in self.db.execute('SELECT key, version FROM fields')}
            if any(current.get(key, 0) != version for key, _, version in changes):
                return 409, {'error': '其他设备已修改此侧栏设置，请核对最新结果后重试。', **self._read()}
            if len(set(current) | {key for key, _, _ in changes}) > self.MAX_FIELDS:
                raise ValueError('侧栏设置空间已满')
            self.db.executemany('INSERT OR REPLACE INTO fields VALUES (?, ?, ?)',
                                [(key, encoded, version + 1) for key, encoded, version in changes])
            self.db.execute('UPDATE state SET revision=revision+1 WHERE id=1')
            result = self._read()
        return 200, result

    def close(self):
        with self.lock:
            self.db.close()
