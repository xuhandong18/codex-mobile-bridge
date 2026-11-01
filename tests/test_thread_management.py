import copy
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from bridge.app.service import Bridge, LiveSession
from bridge.clients.codex.desktop_tools import ToolError
from bridge.clients.codex.thread_management import archive_owned_thread
from bridge.clients.codex.remote import RemoteStore
from bridge.features.sessions.create import CreationError
from bridge.features.sessions.store import SessionStore

ROOT = Path(__file__).resolve().parents[1]
SID = '00000000-0000-0000-0000-000000000001'
CHILD = '00000000-0000-0000-0000-000000000002'


class ThreadManagementTests(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.host = 'local'
        self.bridge.codex_home = ROOT / '.tmp'
        self.bridge.catalog_reader = SimpleNamespace(executable='fixture-runtime')
        self.bridge.lock = threading.RLock()
        self.bridge.accounts = SimpleNamespace(gate=threading.RLock(), check_ready=Mock())
        self.bridge.store = SimpleNamespace(get=Mock(return_value={'origin': 'desktop'}),
            subagents=Mock(return_value={'agents': [{'id': CHILD}]}),
            management_records=Mock(return_value=[{'id': SID, 'rollout_path': 'fixture-rollout'}]),
            management_verified=Mock(return_value=True))
        self.bridge.assert_desktop_idle = Mock()
        self.bridge.live = {SID: LiveSession(SID)}

    def test_loaded_writer_is_released_by_native_owner_then_deletion_is_read_back(self):
        events = []
        def delete(*args):
            events.append('delete')
            if events == ['delete']:
                raise CreationError(f'thread {SID} already has an active writer')
        with patch('bridge.app.service.manage_thread', side_effect=delete) as runtime, \
             patch('bridge.app.service.archive_owned_thread', side_effect=lambda *args: events.append('archive')) as native:
            result = self.bridge.manage_session(SID, 'delete', True)
        self.assertEqual(events, ['delete', 'archive', 'delete'])
        native.assert_called_once_with(self.bridge, SID)
        self.assertEqual(runtime.call_count, 2)
        self.assertEqual(self.bridge.assert_desktop_idle.call_count, 2)
        self.bridge.store.management_verified.assert_called_once_with([SID, CHILD], 'delete', ['fixture-rollout'])
        self.assertTrue(result['confirmed'])
        self.assertNotIn(SID, self.bridge.live)

    def test_unknown_write_is_never_archived_or_replayed(self):
        with patch('bridge.app.service.manage_thread', side_effect=CreationError('timeout; outcome unknown')) as runtime, \
             patch('bridge.app.service.archive_owned_thread') as native:
            with self.assertRaises(CreationError):
                self.bridge.manage_session(SID, 'delete', True)
        runtime.assert_called_once()
        native.assert_not_called()
        self.assertIn(SID, self.bridge.live)

    def test_child_writer_or_other_rejection_does_not_archive_parent(self):
        for error in (f'thread {CHILD} already has an active writer', 'permission denied'):
            with self.subTest(error=error), patch('bridge.app.service.manage_thread', side_effect=CreationError(error)) as runtime, \
                 patch('bridge.app.service.archive_owned_thread') as native:
                with self.assertRaises(CreationError):
                    self.bridge.manage_session(SID, 'delete', True)
                runtime.assert_called_once()
                native.assert_not_called()

    def test_failed_native_archive_is_not_followed_by_deletion_retry(self):
        with patch('bridge.app.service.manage_thread', side_effect=CreationError(f'thread {SID} already has an active writer')) as runtime, \
             patch('bridge.app.service.archive_owned_thread', side_effect=ToolError('unknown', unknown=True)) as native:
            with self.assertRaises(ToolError):
                self.bridge.manage_session(SID, 'delete', True)
        runtime.assert_called_once()
        native.assert_called_once()

    def test_success_response_without_native_removal_is_not_reported_as_deleted(self):
        self.bridge.store.management_verified.return_value = False
        with patch('bridge.app.service.manage_thread') as runtime:
            with self.assertRaisesRegex(CreationError, '尚未确认变更'):
                self.bridge.manage_session(SID, 'delete', True)
        runtime.assert_called_once()
        self.assertIn(SID, self.bridge.live)


class NativeThreadManagementTests(unittest.TestCase):
    def setUp(self):
        self.bridge = SimpleNamespace(host='local', store=SimpleNamespace(
            get=Mock(return_value={'cwd': str(ROOT), 'archived': True})))
        self.thread = {'id': SID, 'hostId': 'local', 'cwd': str(ROOT), 'status': {'type': 'idle'}}
        self.artifacts = []
        self.calls = []
        self.native = SimpleNamespace(call=self.call, close=Mock(), context_id='unrelated')
        self.connection = patch('bridge.clients.codex.thread_management.ThreadManagementTools.connect_profile', return_value=self.native)
        self.connection.start()
        self.addCleanup(self.connection.stop)
        platform = patch('bridge.clients.codex.thread_management.sys.platform', 'win32')
        platform.start()
        self.addCleanup(platform.stop)

    def call(self, method, arguments):
        self.calls.append((method, copy.deepcopy(arguments)))
        if method == 'read_thread':
            return {'thread': self.thread, 'turns': []}
        if method == 'list_artifacts':
            return {'artifacts': self.artifacts}
        if method == 'set_thread_archived':
            return {'threadId': SID, 'archived': True}
        raise AssertionError(method)

    def test_archive_uses_verified_original_host_and_selected_chat_context(self):
        archive_owned_thread(self.bridge, SID)
        self.assertEqual(self.native.context_id, SID)
        self.assertEqual([row[0] for row in self.calls], ['read_thread', 'list_artifacts', 'set_thread_archived'])
        self.assertEqual(self.calls[-1][1], {'threadId': SID, 'hostId': 'local', 'archived': True})
        self.native.close.assert_called_once()

    def test_busy_or_mismatched_native_thread_is_not_archived(self):
        for field, value in (('id', CHILD), ('hostId', 'remote:other'), ('cwd', str(ROOT.parent)), ('status', {'type': 'active'})):
            with self.subTest(field=field):
                original = self.thread[field]
                self.thread[field] = value
                self.calls.clear()
                with self.assertRaises(ValueError):
                    archive_owned_thread(self.bridge, SID)
                self.assertFalse(any(method == 'set_thread_archived' for method, _ in self.calls))
                self.thread[field] = original

    def test_attached_worktree_cannot_be_cleaned_up_by_archive_fallback(self):
        self.artifacts = [{'type': 'worktree', 'payload': {'workspaceDir': str(ROOT)}}]
        with self.assertRaisesRegex(ValueError, '工作树'):
            archive_owned_thread(self.bridge, SID)
        self.assertEqual([row[0] for row in self.calls], ['read_thread', 'list_artifacts'])


class ManagementReadbackTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT / '.tmp')
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name)
        self.record = self.home / 'sessions' / 'rollout.jsonl'
        self.record.parent.mkdir()
        self.record.write_text('{}')
        self.db = sqlite3.connect(self.home / 'state_5.sqlite')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE threads(id TEXT, archived INT, rollout_path TEXT)')
        self.db.executemany('INSERT INTO threads VALUES (?,0,?)', [(SID, str(self.record)), (CHILD, str(self.record))])
        self.db.commit()
        self.store = SessionStore(self.home)

    def test_deletion_requires_parent_child_and_record_file_to_disappear(self):
        ids, paths = [SID, CHILD], [str(self.record)]
        self.assertFalse(self.store.management_verified(ids, 'delete', paths))
        self.db.execute('DELETE FROM threads WHERE id=?', (SID,)); self.db.commit()
        self.assertFalse(self.store.management_verified(ids, 'delete', paths))
        self.db.execute('DELETE FROM threads'); self.db.commit()
        self.assertFalse(self.store.management_verified(ids, 'delete', paths))
        self.record.unlink()
        self.assertTrue(self.store.management_verified(ids, 'delete', paths))

    def test_archive_readback_checks_selected_parent_not_child_or_old_cache(self):
        ids = [SID, CHILD]
        self.db.execute('UPDATE threads SET archived=1 WHERE id=?', (CHILD,)); self.db.commit()
        self.assertFalse(self.store.management_verified(ids, 'archive', []))
        self.assertTrue(self.store.management_verified(ids, 'unarchive', []))
        self.db.execute('UPDATE threads SET archived=1 WHERE id=?', (SID,)); self.db.commit()
        self.assertTrue(self.store.management_verified(ids, 'archive', []))

    def test_record_paths_outside_native_history_do_not_confirm_deletion(self):
        self.db.execute('DELETE FROM threads'); self.db.commit()
        self.assertFalse(self.store.management_verified([SID], 'delete', [str(self.home / 'outside.jsonl')]))

    def test_remote_readback_runs_on_original_host_without_local_path_access(self):
        remote = RemoteStore('fixture-host')
        with patch.object(remote, 'call', return_value=True) as call:
            self.assertTrue(remote.management_verified([SID], 'delete', ['/remote/.codex/sessions/chat.jsonl']))
        call.assert_called_once_with('management_verified', {
            'identifiers': [SID], 'action': 'delete', 'record_paths': ['/remote/.codex/sessions/chat.jsonl']})


if __name__ == '__main__':
    unittest.main()
