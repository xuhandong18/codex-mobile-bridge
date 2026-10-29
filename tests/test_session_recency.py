"""Only confirmed interaction or conversation content affects ordering."""
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from bridge.clients.codex.remote import AppHosts
from bridge.features.sessions.side_chat import SideChat, SideChats
from bridge.features.sessions.store import SessionStore
from test_side_chat import RuntimeFixture


class NativeRecencyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]/'.tmp')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.store = SessionStore(self.root)
        self.hosts = AppHosts(self.root)
        self.hosts.state = lambda: {}

    def populate(self, fields, rows):
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.execute('DROP TABLE IF EXISTS threads')
            db.execute('CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, archived INTEGER, '
                       'originator TEXT, source TEXT, ' + ','.join(name + ' INTEGER' for name in fields) + ')')
            columns = ['id', 'title', 'cwd', 'archived', 'originator', 'source', *fields]
            for row in rows:
                values = [row['id'], 'Fixture', '/fixture', 0, 'Codex Desktop', 'vscode',
                          *(row.get(field) for field in fields)]
                db.execute('INSERT INTO threads(' + ','.join(columns) + ') VALUES(' +
                           ','.join('?' for _ in values) + ')', values)

    def test_process_update_cannot_override_interaction_in_all_read_paths(self):
        working, newer_input = str(uuid.uuid4()), str(uuid.uuid4())
        self.populate(['recency_at', 'recency_at_ms', 'updated_at', 'updated_at_ms'], [
            {'id': working, 'recency_at': 10, 'recency_at_ms': 10001, 'updated_at': 90, 'updated_at_ms': 90002},
            {'id': newer_input, 'recency_at': 80, 'recency_at_ms': 80003, 'updated_at': 80, 'updated_at_ms': 80003},
        ])
        rows = self.store.list()
        self.assertEqual([row['id'] for row in rows], [newer_input, working])
        self.assertEqual(self.store.recencies([working, newer_input]), {working: 10001, newer_input: 80003})
        decorated = self.hosts.decorate(rows, 'local', 'Fixture')
        self.assertEqual([row['recency'] for row in decorated], [80003, 10001])

    def test_process_updates_do_not_change_pagination(self):
        working = str(uuid.uuid4())
        rows = [{'id': str(uuid.uuid4()), 'recency_at': 200+i, 'updated_at': 200+i} for i in range(120)]
        rows.append({'id': working, 'recency_at': 1, 'updated_at': 1000})
        self.populate(['recency_at', 'updated_at'], rows)
        self.assertNotEqual(self.store.list(limit=1)[0]['id'], working)
        pages = self.store.list(limit=100) + self.store.list(limit=100, offset=100)
        self.assertEqual(len({row['id'] for row in pages}), 121)

    def test_timestamp_units_nulls_and_legacy_schemas_agree(self):
        cases = [
            ({'recency_at': 5, 'updated_at': 20}, 5000),
            ({'recency_at': 30, 'updated_at': 20}, 30000),
            ({'updated_at': 20}, 0),
            ({'created_at': 15, 'updated_at': 20}, 15000),
            ({'created_at_ms': 15001, 'updated_at_ms': 20002}, 15001),
            ({'recency_at_ms': 5001, 'updated_at_ms': 20002}, 5001),
            ({'recency_at_ms': None, 'recency_at': 5, 'updated_at_ms': None, 'updated_at': 20}, 5000),
            ({'recency_at_ms': 0, 'recency_at': 5, 'updated_at_ms': 0, 'updated_at': 20}, 5000),
            ({'recency_at_ms': 5001, 'recency_at': 99, 'updated_at_ms': 7002, 'updated_at': 88}, 5001),
        ]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                identifier = str(uuid.uuid4())
                self.populate(list(fields), [{'id': identifier, **fields}])
                row = self.store.list()[0]
                self.assertEqual(self.store.recencies([identifier]), {identifier: expected})
                self.assertEqual(self.hosts.decorate([row], 'local', 'Fixture')[0]['recency'], expected)

    def test_polling_does_not_substitute_the_current_time(self):
        identifier = str(uuid.uuid4())
        self.populate(['recency_at', 'updated_at'], [{'id': identifier, 'recency_at': 20, 'updated_at': 30}])
        before = self.store.recencies([identifier])
        with patch('time.time', return_value=999999):
            after = self.store.recencies([identifier])
        self.assertEqual(before, after)


class SideProgressRecencyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]/'.tmp')
        self.addCleanup(directory.cleanup)
        self.parent = str(uuid.uuid4())
        self.manager = SideChats('fixture', directory.name, directory.name, 'local',
                                 factory=lambda *args: SideChat(*args, runtime_factory=RuntimeFixture))
        self.addCleanup(self.manager.close)
        with patch('bridge.features.sessions.side_chat.check_runtime'):
            self.manager.operate(self.parent, 'create', {'creationId': str(uuid.uuid4())},
                                 {'cwd': directory.name}, {'model': 'fixture', 'modelProvider': 'custom'})
        self.chat = self.manager.chats[(self.parent, '')]
        with patch('time.time', return_value=10):
            self.chat.send('question', str(uuid.uuid4()))

    def test_assistant_text_counts_but_subsequent_tool_and_completion_events_do_not(self):
        events = [
            ('item/agentMessage/delta', {'turnId': 'turn', 'itemId': 'reply', 'delta': 'progress'}),
            ('item/started', {'turnId': 'turn', 'item': {'id': 'tool', 'type': 'commandExecution'}}),
            ('item/commandExecution/outputDelta', {'turnId': 'turn', 'itemId': 'tool', 'delta': 'output'}),
            ('item/completed', {'turnId': 'turn', 'item': {'id': 'tool', 'type': 'commandExecution', 'status': 'completed'}}),
            ('turn/completed', {'turn': {'id': 'turn', 'status': 'completed'}}),
        ]
        for at, (method, params) in enumerate(events, 20):
            with self.subTest(method=method), patch('time.time', return_value=at):
                self.chat.runtime.emit(method, timestamp=at, **params)
                self.assertEqual(self.chat.view()['recency'], 20000)
                self.assertEqual(self.manager.recencies(), {self.parent: 20000})

    def test_reads_usage_notifications_empty_deltas_and_other_threads_do_not_promote(self):
        with patch('time.time', return_value=20):
            self.chat.view()
            self.manager.activity(self.parent)
            self.manager.operate(self.parent, 'read', {})
            self.chat.runtime.emit('thread/tokenUsage/updated', tokenUsage={'totalTokens': 200})
            self.chat.runtime.emit('item/agentMessage/delta', turnId='turn', itemId='reply', delta='')
            self.chat.runtime.emit('item/started', turnId='turn', item={'id': 'reply', 'type': 'agentMessage', 'text': ''})
            self.chat._event({'method': 'item/agentMessage/delta', 'params': {
                'threadId': 'other', 'turnId': 'turn', 'itemId': 'reply', 'delta': 'private'}})
        self.assertEqual(self.manager.recencies(), {self.parent: 10000})


if __name__ == '__main__':
    unittest.main()
