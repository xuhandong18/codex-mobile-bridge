import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge.clients.codex.read_state import NativeReadState, ReadStateTools
from bridge.clients.codex.activity import ActivityTools
from bridge.clients.codex.desktop_tools import ToolError
from bridge.clients.manager import DesktopSessions, READS
from bridge.features.sessions.timeline import Timeline
from bridge.features.sessions.read_state import SharedReadState
from relay.protocol import validate
import test_bridge

ROOT = Path(__file__).resolve().parents[1]
SID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'


def body(**values):
    return {'id': str(uuid.uuid4()), 'turnId': 'last', 'turnStatus': 'completed', **values}


class NativeReadTests(unittest.TestCase):
    def setUp(self):
        self.bridge = Mock()
        self.bridge.accounts.operation_lock = threading.RLock()
        self.bridge.for_host.return_value = SimpleNamespace(host='ssh:fixture', store=Mock())
        self.native = Mock()
        self.native.call.return_value = {'thread': {'id': SID, 'hostId': 'ssh:fixture', 'status': {'type': 'idle'}},
                                         'turns': [{'id': 'last', 'status': 'completed'}]}
        self.enterContext(patch('bridge.clients.codex.read_state.sys.platform', 'win32'))
        self.connect = self.enterContext(patch.object(ReadStateTools, 'connect_profile', return_value=self.native))

    def test_same_host_and_observed_turn_use_native_read_tool_without_activating(self):
        result = NativeReadState(self.bridge).call('read-state', SID, body(host='ssh:fixture'))
        self.assertEqual(result, {'status': 'accepted'})
        self.native.call.assert_any_call('set_thread_read_state', {'threadId': SID, 'hostId': 'ssh:fixture', 'read': True})
        self.native.close.assert_called_once()
        self.bridge.for_host.assert_called_once_with('ssh:fixture')
        self.bridge.for_host.return_value.store.get.assert_called_once_with(SID)
        self.bridge.activate.assert_not_called()
        self.assertNotIn('set_thread_read_state', ActivityTools.METHODS)
        self.assertEqual(ReadStateTools.METHODS, {'list_projects', 'read_thread', 'set_thread_read_state'})

    def test_timeline_exposes_latest_terminal_turn_even_when_it_has_no_visible_messages(self):
        timeline = Timeline()
        timeline.update({'sequence': 1, 'turns': [{'id': 'last', 'status': 'completed', 'messages': []}]})
        self.assertEqual(timeline.page()['meta']['turnId'], 'last')
        self.assertEqual(timeline.page()['meta']['turnStatus'], 'completed')

    def test_new_turn_running_or_different_native_identity_cannot_clear_unread(self):
        for change in ('turn', 'running', 'host', 'identity'):
            self.native.reset_mock()
            value = {'thread': {'id': SID, 'hostId': 'ssh:fixture', 'status': {'type': 'idle'}},
                     'turns': [{'id': 'last', 'status': 'completed'}]}
            if change == 'turn': value['turns'][0]['id'] = 'new'
            if change == 'running': value['thread']['status']['type'] = 'active'
            if change == 'host': value['thread']['hostId'] = 'other'
            if change == 'identity': value['thread']['id'] = 'other'
            self.native.call.return_value = value
            with self.subTest(change=change):
                if change in ('host', 'identity'):
                    with self.assertRaises(ValueError): NativeReadState(self.bridge).call('read-state', SID, body(host='ssh:fixture'))
                else:
                    self.assertEqual(NativeReadState(self.bridge).call('read-state', SID, body(host='ssh:fixture'))['status'], 'stale')
                self.assertEqual(self.native.call.call_count, 1)
                self.native.close.assert_called_once()


class ReadReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT/'.tmp')
        self.addCleanup(self.temp.cleanup)
        self.manager = DesktopSessions(self.temp.name)
        self.manager.config['enabled'] = {'codex': True, 'deepseek': True}
        self.addCleanup(self.manager.close)

    def test_codex_unknown_is_persisted_and_never_replayed(self):
        request = body(host='local')
        with patch('bridge.clients.manager.NativeReadState') as adapter:
            adapter.return_value.call.side_effect = ToolError('lost acknowledgement', unknown=True)
            result = self.manager.call('codex', 'read-state', SID, request)
            self.assertEqual(result['status'], 'unknown')
            self.assertEqual(self.manager.call('codex', 'read-state', SID, request), result)
            adapter.return_value.call.assert_called_once()
            other = DesktopSessions(self.temp.name)
            try:
                self.assertEqual(other.call('codex', 'read-state', SID, request), result)
                adapter.return_value.call.assert_called_once()
            finally: other.close()
            with self.assertRaises(ValueError): self.manager.call('codex', 'read-state', SID, {**request, 'host': 'other'})

    def test_deepseek_read_is_a_validated_write_with_durable_receipts(self):
        adapter = Mock(); adapter.call.return_value = {'status': 'accepted'}
        self.manager.adapters['deepseek'] = adapter
        request = body()
        self.assertNotIn('read-state', READS)
        self.manager.call('deepseek', 'read-state', 'native-id', request)
        self.manager.call('deepseek', 'read-state', 'native-id', request)
        adapter.call.assert_called_once_with('read-state', 'native-id', request)
        for values in ({'turnStatus': 'inProgress'}, {'turnId': ''}, {'extra': True}, {'host': 'local'}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.manager.call('deepseek', 'read-state', 'native-id', body(**values))
        with self.assertRaises(ValueError): self.manager.call('claude', 'read-state', 'native-id', body())
        self.manager.config['enabled']['codex'] = False
        with self.assertRaises(ValueError): self.manager.call('codex', 'read-state', SID, body(host='local'))


class ReadStateHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    def setUp(self):
        test_bridge.HttpTests.setUp(self)
        self.server.bridge.host = 'local'
        self.server.bridge.store = Mock()
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_codex_and_deepseek_require_authenticated_csrf_posts(self):
        self.server.bridge.host = 'local'
        manager = self.server.desktop_sessions = Mock()
        manager.call.return_value = {'status': 'accepted'}
        headers = self.login()
        for path, provider, sid in ((f'/api/sessions/{SID}/read-state', 'codex', SID),
                                    ('/api/desktop-sessions/deepseek/read-state', 'deepseek', 'native-id')):
            request = body(**({'sessionId': sid} if provider == 'deepseek' else {}))
            with self.subTest(provider=provider):
                self.assertEqual(self.request('POST', path, request)[0], 401)
                self.assertEqual(self.request('POST', path, request, {'Cookie': headers['Cookie']})[0], 403)
                self.assertEqual(self.request('GET', path, headers=headers)[0], 404)
                self.assertEqual(self.request('POST', path, request, headers)[0], 200)
                sent = {k: v for k, v in request.items() if k != 'sessionId'}
                if provider == 'codex': sent['host'] = 'local'
                manager.call.assert_called_with(provider, 'read-state', sid, sent)
                validate('POST', path)
                with self.assertRaises(PermissionError): validate('GET', path)
        self.assertEqual(self.request('POST', f'/api/sessions/{SID}/read-state?host=unknown', body(), headers)[0], 404)
        self.assertEqual(self.request('POST', f'/api/sessions/{SID}/read-state', body(read=True), headers)[0], 400)

    def test_tablet_read_is_returned_to_phone_even_when_native_sync_is_unsupported(self):
        tablet, phone = self.login(), self.login()
        manager = self.server.desktop_sessions = Mock()
        manager.call.return_value = {'status': 'unsupported'}
        self.server.bridge.activity = Mock(return_value=[{'id': SID, 'host': 'local', 'connected': True,
            'status': 'idle', 'turnId': 'last', 'turnStatus': 'completed'}])
        path = f'/api/sessions/{SID}/read-state'
        self.assertEqual(self.request('POST', path, body(), tablet)[0], 200)
        result = self.request('POST', '/api/activity', {'hosts': {'local': [SID]}}, phone)
        self.assertEqual(result[0], 200)
        self.assertEqual(result[2]['sessions'][0]['readCompletions'], ['last:completed'])
        self.server.bridge.store.get.assert_called_once_with(SID)
        self.assertNotIn('readCompletions', self.server.bridge.activity.return_value[0])

    def test_side_read_has_its_own_receipt_and_never_calls_native_main_read(self):
        headers = self.login()
        manager = self.server.desktop_sessions = Mock()
        child = {'id': 'side-one', 'turnId': 'last', 'turnStatus': 'completed'}
        self.server.bridge.side_chats = SimpleNamespace(activity=Mock(return_value=[child]))
        path = f'/api/sessions/{SID}/read-state?side=side-one'
        self.assertEqual(self.request('POST', path, body(), headers)[2]['status'], 'accepted')
        manager.call.assert_not_called()
        self.assertEqual(self.server.chat_read_state.read('local', SID), [])
        self.assertEqual(self.server.chat_read_state.read('local', SID+'/side/side-one'), ['last:completed'])
        rows = self.server.chat_read_state.activity([{'id': SID, 'host': 'local', 'sideChats': [child]}])
        self.assertEqual(rows[0]['sideChats'][0]['readCompletions'], ['last:completed'])
        self.assertEqual(self.request('POST', path, body(turnId='other'), headers)[2]['status'], 'stale')
        self.assertEqual(self.request('POST', path.replace('side-one', 'missing'), body(), headers)[0], 400)

    def test_invalid_or_invisible_chat_cannot_create_shared_receipts(self):
        headers = self.login()
        path = f'/api/sessions/{SID}/read-state'
        for request in (body(turnStatus='inProgress'), body(turnId=''), body(extra=True)):
            self.assertEqual(self.request('POST', path, request, headers)[0], 400)
        self.server.bridge.store.get.side_effect = KeyError(SID)
        self.assertEqual(self.request('POST', path, body(), headers)[0], 404)
        self.assertEqual(self.server.chat_read_state.read('local', SID), [])

    def test_rejected_operation_id_does_not_create_a_shared_receipt(self):
        headers = self.login()
        manager = self.server.desktop_sessions = Mock()
        manager.call.side_effect = ValueError('相同请求 ID 不能用于不同操作')
        self.assertEqual(self.request('POST', f'/api/sessions/{SID}/read-state', body(), headers)[0], 400)
        self.assertEqual(self.server.chat_read_state.read('local', SID), [])


class SharedReadTests(unittest.TestCase):
    def test_receipts_survive_restart_and_are_isolated_by_host_chat_and_side(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            store = SharedReadState(directory)
            store.remember('local', SID, body())
            store.close()
            store = SharedReadState(directory)
            try:
                self.assertEqual(store.read('local', SID), ['last:completed'])
                for host, chat in [('remote', SID), ('local', 'other'), ('local', SID+'/side/one')]:
                    self.assertEqual(store.read(host, chat), [])
            finally:
                store.close()

    def test_simultaneous_devices_merge_and_keep_only_64_distinct_turns(self):
        store = SharedReadState(None)
        self.addCleanup(store.close)
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda i: store.remember('local', SID, body(turnId=str(i))), range(70)))
        receipts = store.read('local', SID)
        self.assertEqual(len(receipts), 64)
        token = receipts[-1].removesuffix(':completed')
        store.remember('local', SID, body(turnId=token))
        self.assertEqual(store.read('local', SID), receipts)
