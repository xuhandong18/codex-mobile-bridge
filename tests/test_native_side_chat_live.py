import copy
import unittest
import uuid
from unittest.mock import Mock, patch

from bridge.app.service import Bridge
from bridge.clients.codex.ipc import IPCError
import test_native_attached_history as attached


class NativeSideChatLiveTests(unittest.TestCase):
    def setUp(self):
        self.fixture = attached.NativeAttachedHistoryTests('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.parent, self.child = self.fixture.parent, self.fixture.child
        self.bridge = Bridge(self.fixture.home, self.fixture.root / 'live-data',
                             codex_bin=self.fixture.root / 'not-installed')
        self.addCleanup(self.bridge.close)
        self.native = {'id': self.child, 'forkedFromId': self.parent, 'sideConversation': True,
                       'ephemeral': False, 'cwd': str(self.fixture.root), 'modelProvider': 'custom',
                       'latestModel': 'same-model', 'threadRuntimeStatus': {'type': 'idle'},
                       'turns': [], 'requests': []}
        self.revision = 1
        self.bridge.ipc.connect = Mock()
        self.bridge.ipc.owner = Mock(return_value='native-owner')
        self.bridge.ipc.follow = Mock(side_effect=self.follow)
        self.bridge.ipc.request = Mock(return_value={'result': {'turnId': 'native-turn'}})
        self.bridge._open_desktop = Mock(side_effect=AssertionError('must not navigate desktop'))
        self.bridge.activate = Mock(side_effect=AssertionError('must not activate'))
        self.bridge._schedule_title = Mock()

    def follow(self, child, owner, enabled=True, host='local'):
        if enabled and child == self.child:
            self.bridge._event({'method': 'thread-stream-state-changed', 'version': 11,
                'sourceClientId': 'native-owner', 'params': {'hostId': host, 'conversationId': child,
                'change': {'type': 'snapshot', 'revision': self.revision, 'conversationState': copy.deepcopy(self.native)}}})

    def read(self):
        return self.bridge.side_chat(self.parent, 'browser', 'read', {'archiveId': self.child})

    def test_native_side_stays_writable_in_same_parent_after_gateway_restart(self):
        view = self.read()
        self.assertEqual((view['id'], view['parentId']), (self.child, self.parent))
        self.assertTrue(view['connected'])
        self.assertFalse(view.get('readOnly', False))
        submission = str(uuid.uuid4())
        result = self.bridge.side_chat(self.parent, 'browser', 'send', {
            'id': self.child, 'text': 'same native child', 'submissionId': submission})
        self.assertEqual(result['status'], 'accepted')
        method, params = self.bridge.ipc.request.call_args.args[:2]
        self.assertEqual(method, 'thread-follower-start-turn')
        self.assertEqual(params['conversationId'], self.child)
        self.assertEqual(self.bridge.ipc.request.call_args.kwargs['target'], 'native-owner')
        self.bridge.activate.assert_not_called()
        self.bridge._open_desktop.assert_not_called()

    def test_parent_discovers_native_slot_without_owner_or_new_executor(self):
        view = self.bridge.side_chat(self.parent, 'browser', 'read', {})
        self.assertEqual([(row['slot'], row['id']) for row in view['slots']], [(self.child, self.child)])
        self.bridge.ipc.owner.assert_not_called()
        self.assertEqual(self.bridge.side_chats.chats, {})
        history = self.bridge.side_chat(self.parent, 'browser', 'history', {})
        self.assertTrue(history['items'][0]['nativeAttached'])
        with self.assertRaises(ValueError):
            self.bridge.side_chat(self.parent, 'browser', 'create', {
                'slot': self.child, 'creationId': str(uuid.uuid4())})
        with self.assertRaises(ValueError):
            self.bridge.side_chat(self.parent, 'browser', 'send', {
                'slot': str(uuid.uuid4()), 'id': self.child, 'text': 'wrong tab', 'submissionId': str(uuid.uuid4())})

    def test_disconnect_returns_saved_history_and_same_child_reconnects(self):
        self.read()
        self.bridge._disconnected()
        self.bridge.ipc.owner.side_effect = IPCError('no-client-found')
        offline = self.read()
        self.assertTrue(offline['readOnly'])
        self.assertFalse(offline['expired'])
        self.assertEqual(offline['id'], self.child)
        self.bridge.ipc.owner.side_effect = None
        self.assertTrue(self.read()['connected'])
        self.bridge.activate.assert_not_called()

    def test_invalid_owner_host_or_native_identity_cannot_enable_writes(self):
        self.read()
        for field, value in [('forkedFromId', str(uuid.uuid4())), ('modelProvider', 'other'),
                             ('cwd', '/other'), ('sideConversation', False), ('ephemeral', True)]:
            with self.subTest(field=field):
                self.native[field], original = value, self.native[field]
                self.follow(self.child, 'native-owner')
                self.assertFalse(self.bridge.live[self.child].connected)
                with self.assertRaises(IPCError):
                    self.bridge.side_chat(self.parent, 'browser', 'send', {
                        'id': self.child, 'text': 'blocked', 'submissionId': str(uuid.uuid4())})
                self.native[field] = original
                self.follow(self.child, 'native-owner')
        self.bridge.ipc.request.assert_not_called()

    def test_fresh_owner_and_native_relation_are_checked_before_dispatch(self):
        self.read()
        self.bridge.ipc.owner.return_value = 'replacement-owner'
        with self.assertRaises(IPCError):
            self.bridge.side_chat(self.parent, 'browser', 'send', {
                'id': self.child, 'text': 'blocked', 'submissionId': str(uuid.uuid4())})
        self.bridge.ipc.request.assert_not_called()
        self.bridge.ipc.owner.return_value = 'native-owner'
        self.read()
        self.fixture.update('attached_thread_parent_id', str(uuid.uuid4()))
        with self.assertRaises(ValueError):
            self.bridge.side_chat(self.parent, 'browser', 'send', {
                'id': self.child, 'text': 'wrong parent', 'submissionId': str(uuid.uuid4())})
        self.bridge.ipc.request.assert_not_called()

    def test_unknown_send_is_persisted_and_never_replayed(self):
        self.read()
        body = {'id': self.child, 'text': 'uncertain', 'submissionId': str(uuid.uuid4())}
        self.bridge.ipc.request.side_effect = IPCError('write response lost')
        with self.assertRaises(IPCError):
            self.bridge.side_chat(self.parent, 'browser', 'send', body)
        self.assertEqual(self.bridge.ipc.request.call_count, 1)
        result = self.bridge.side_chat(self.parent, 'browser', 'send', body)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(self.bridge.ipc.request.call_count, 1)
        self.assertEqual(self.read()['submissions'][0]['id'], body['submissionId'])

    def test_gateway_restart_keeps_unknown_submission_without_resending(self):
        self.read()
        body = {'id': self.child, 'text': 'uncertain across restart', 'submissionId': str(uuid.uuid4())}
        self.bridge.ipc.request.side_effect = IPCError('write response lost')
        with self.assertRaises(IPCError):
            self.bridge.side_chat(self.parent, 'browser', 'send', body)
        self.bridge.close()
        restored = Bridge(self.fixture.home, self.fixture.root / 'live-data', codex_bin=self.fixture.root / 'not-installed')
        self.bridge = restored
        self.addCleanup(restored.close)
        restored.ipc.connect = Mock()
        restored.ipc.owner = Mock(return_value='native-owner')
        restored.ipc.follow = Mock(side_effect=self.follow)
        restored.ipc.request = Mock()
        restored.activate = Mock(side_effect=AssertionError('must not activate'))
        self.assertTrue(self.read()['connected'])
        result = restored.side_chat(self.parent, 'browser', 'send', body)
        self.assertEqual(result['status'], 'unknown')
        restored.ipc.request.assert_not_called()

    def test_host_and_owner_spoofed_events_are_ignored(self):
        self.read()
        session = self.bridge.live[self.child]
        original = copy.deepcopy(session.state)
        for source, host in [('other-owner', 'local'), ('native-owner', 'ssh:other')]:
            self.bridge._event({'method': 'thread-stream-state-changed', 'version': 11,
                'sourceClientId': source, 'params': {'hostId': host, 'conversationId': self.child,
                'change': {'type': 'snapshot', 'revision': 10, 'conversationState': {**self.native, 'title': 'spoofed'}}}})
            self.assertEqual(session.state, original)

    def test_stop_approval_and_close_use_only_original_child(self):
        self.native.update(threadRuntimeStatus={'type': 'active'}, turns=[{'turnId': 'native-turn', 'status': 'inProgress', 'items': []}])
        self.read()
        self.bridge.side_chat(self.parent, 'browser', 'stop', {'id': self.child})
        method, params = self.bridge.ipc.request.call_args.args[:2]
        self.assertEqual(method, 'thread-follower-interrupt-turn')
        self.assertEqual(params['conversationId'], self.child)
        self.native['requests'] = [{'id': 'approval', 'method': 'item/commandExecution/requestApproval',
                                    'params': {'threadId': self.child, 'turnId': 'native-turn', 'itemId': 'command'}}]
        self.follow(self.child, 'native-owner')
        self.bridge.side_chat(self.parent, 'browser', 'respond', {
            'id': self.child, 'requestId': 'approval', 'response': {'decision': 'accept'}})
        self.assertEqual(self.bridge.ipc.request.call_args.args[0], 'thread-follower-command-approval-decision')
        before = self.bridge.ipc.request.call_count
        self.bridge.side_chat(self.parent, 'browser', 'close', {'id': self.child})
        self.assertEqual(self.bridge.ipc.request.call_count, before)
        self.assertTrue(self.bridge.live[self.child].connected)

    def test_attachments_and_queue_use_the_existing_child_ledger(self):
        self.read()
        attachment = str(uuid.uuid4())
        self.bridge.side_attachment(self.parent, self.child, 'put', attachment, 'note.txt', b'attachment')
        body = {'id': self.child, 'text': '', 'attachments': [attachment], 'submissionId': str(uuid.uuid4())}
        self.bridge.side_chat(self.parent, 'browser', 'send', body)
        self.assertEqual(self.bridge.ipc.request.call_args.args[1]['conversationId'], self.child)
        self.native['threadRuntimeStatus'] = {'type': 'active'}
        self.follow(self.child, 'native-owner')
        body = {'id': self.child, 'text': 'queued', 'mode': 'queue', 'submissionId': str(uuid.uuid4())}
        result = self.bridge.side_chat(self.parent, 'browser', 'send', body)
        self.assertEqual(result['status'], 'queued')
        before = self.bridge.ipc.request.call_count
        self.native['threadRuntimeStatus'] = {'type': 'idle'}
        self.follow(self.child, 'native-owner')
        self.bridge._maintain_session(self.bridge.live[self.child])
        self.assertEqual(self.bridge.ipc.request.call_count, before + 1)


if __name__ == '__main__':
    unittest.main()
