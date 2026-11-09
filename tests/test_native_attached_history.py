import json
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock

from bridge.clients.codex.native_side_chats import NativeAttachedHistory
from bridge.features.sessions.side_chat import SideChats
from bridge.features.sessions.store import SessionStore


class NativeAttachedHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / '.tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home'
        self.sessions = self.home / 'sessions'
        self.sessions.mkdir(parents=True)
        self.parent, self.child = str(uuid.uuid4()), str(uuid.uuid4())
        self.path = self.sessions / 'child.jsonl'
        self.write_history('saved native reply')
        self.database = self.home / 'state_5.sqlite'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE threads(id TEXT, title TEXT, cwd TEXT, updated_at INT, '
                       'archived INT, originator TEXT, source TEXT, model_provider TEXT, '
                       'attached_thread_parent_id TEXT, rollout_path TEXT)')
            db.executemany('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)', [
                (self.parent, 'Parent', str(self.root), 1, 0, 'Codex Desktop', 'vscode', 'custom', None, ''),
                (self.child, 'Native side', str(self.root), 2, 0, 'Codex Desktop', 'vscode', 'custom', self.parent, str(self.path)),
            ])
        self.store = SessionStore(self.home)
        self.manager = SideChats('unused', self.home, self.root / 'data', 'local', factory=Mock())
        self.addCleanup(self.manager.close)
        self.manager.native_history = NativeAttachedHistory(self.store, self.manager.native_snapshot)

    def write_history(self, text):
        self.path.write_text(json.dumps({'type': 'response_item', 'payload': {
            'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}}) + '\n', encoding='utf-8')

    def update(self, field, value):
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('UPDATE threads SET ' + field + '=? WHERE id=?', (value, self.child))

    def test_parent_history_discovers_reads_and_refreshes_without_executor(self):
        page = self.manager.operate(self.parent, 'history', {})
        self.assertEqual([item['id'] for item in page['items']], [self.child])
        self.assertEqual(page['items'][0]['source'], 'desktop')
        view = self.manager.operate(self.parent, 'read', {'archiveId': self.child})
        self.assertEqual(view['parentId'], self.parent)
        self.assertEqual(view['title'], 'Native side')
        self.assertEqual(view['turns'][0]['messages'][0]['text'], 'saved native reply')
        self.assertTrue(view['readOnly'])
        self.assertFalse(view['connected'])
        self.assertEqual(view['syncState'], 'offline')
        with self.assertRaisesRegex(ValueError, '已关闭|已失效'):
            self.manager.operate(self.parent, 'send', {'id': self.child, 'text': 'must not send'})
        self.write_history('newer native reply')
        view = self.manager.operate(self.parent, 'read', {'archiveId': self.child})
        self.assertEqual(view['turns'][0]['messages'][0]['text'], 'newer native reply')
        self.manager.factory.assert_not_called()

    def test_native_title_changes_and_restart_keep_same_parent_and_child(self):
        self.manager.operate(self.parent, 'history', {})
        self.update('title', 'Renamed in desktop')
        view = self.manager.operate(self.parent, 'read', {'archiveId': self.child})
        self.assertEqual(view['title'], 'Renamed in desktop')
        restored = SideChats('unused', self.home, self.root / 'data', 'local', factory=Mock())
        self.addCleanup(restored.close)
        restored.native_history = NativeAttachedHistory(self.store, restored.native_snapshot)
        view = restored.operate(self.parent, 'read', {'archiveId': self.child})
        self.assertEqual((view['id'], view['parentId']), (self.child, self.parent))
        self.assertTrue(view['readOnly'])
        restored.factory.assert_not_called()

    def test_service_keeps_history_when_owner_unavailable_without_activation(self):
        from bridge.app.service import Bridge
        from bridge.clients.codex.ipc import IPCError
        from unittest.mock import patch
        bridge = Bridge(self.home, self.root / 'gateway-data', codex_bin=self.root / 'not-installed')
        self.addCleanup(bridge.close)
        with patch.object(bridge, 'activate', side_effect=AssertionError('must not activate')), \
                patch.object(bridge.ipc, 'owner', side_effect=IPCError('no-client-found')):
            page = bridge.side_chat(self.parent, 'browser', 'history', {})
            self.assertEqual([item['id'] for item in page['items']], [self.child])
            view = bridge.side_chat(self.parent, 'browser', 'read', {'archiveId': self.child})
            self.assertEqual(view['parentId'], self.parent)
            self.assertTrue(view['readOnly'])
        self.assertFalse(bridge.live[self.child].connected)
        self.assertEqual(bridge.side_chats.chats, {})

    def test_parent_provider_cwd_source_and_file_boundary_are_verified(self):
        self.assertEqual(self.manager.operate(str(uuid.uuid4()), 'history', {})['items'], [])
        for field, invalid, original in [
            ('model_provider', 'other', 'custom'),
            ('cwd', str(self.root / 'other'), str(self.root)),
            ('originator', 'codex-tui', 'Codex Desktop'),
            ('source', '{"subagent":{}}', 'vscode'),
            ('attached_thread_parent_id', str(uuid.uuid4()), self.parent),
            ('rollout_path', str(self.root / 'outside.jsonl'), str(self.path)),
        ]:
            with self.subTest(field=field):
                self.update(field, invalid)
                self.assertEqual(self.manager.operate(self.parent, 'history', {})['items'], [])
                self.update(field, original)
        self.manager.factory.assert_not_called()

    def test_unchanged_reads_do_not_resave_and_broken_record_does_not_hide_others(self):
        self.manager.operate(self.parent, 'history', {})
        with unittest.mock.patch.object(self.manager.native_history, 'save') as save:
            self.manager.operate(self.parent, 'history', {})
            save.assert_not_called()
        self.update('rollout_path', str(self.sessions / 'missing.jsonl'))
        other = str(uuid.uuid4())
        other_path = self.sessions / 'other.jsonl'
        other_path.write_bytes(self.path.read_bytes())
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('INSERT INTO threads SELECT ?,title,cwd,3,archived,originator,source,model_provider,'
                       'attached_thread_parent_id,? FROM threads WHERE id=?', (other, str(other_path), self.child))
        self.assertEqual({item['id'] for item in self.manager.operate(self.parent, 'history', {})['items']}, {self.child, other})


if __name__ == '__main__':
    unittest.main()
