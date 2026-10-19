import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge.clients.codex.activity import ActivityTools, DesktopActivity
from bridge.clients.codex.desktop_tools import ToolError


def metadata(identifier='cold', status='notLoaded', result='completed', host='local'):
    return {'thread': {'id': identifier, 'hostId': host, 'status': {'type': status}},
            'turns': [{'id': 'last-turn', 'status': result, 'items': [{'type': 'agentMessage', 'text': 'private fixture text'}]}]}


class DesktopMetadataActivityTests(unittest.TestCase):
    def setUp(self):
        self.reader = DesktopActivity(SimpleNamespace(host='local'))
        self.native = Mock()
        self.native.call.return_value = metadata()
        self.enterContext(patch.object(DesktopActivity, 'available', True))
        self.connect = self.enterContext(patch.object(self.reader, '_connect', return_value=self.native))
        self.addCleanup(self.reader.close)

    def refresh(self, identifiers=None):
        identifiers = identifiers or ['cold']
        self.reader.read(identifiers)
        self.reader.worker.join(2)
        self.assertFalse(self.reader.worker.is_alive())
        return self.reader.read(identifiers)

    def test_unloaded_snapshot_is_known_without_promoting_it_to_a_writable_connection(self):
        value = self.refresh()['cold']
        self.assertEqual(value, {'status': 'notLoaded', 'turnId': 'last-turn', 'turnStatus': 'completed'})
        self.assertNotIn('private', str(value))
        self.native.call.assert_called_once_with('read_thread', {'threadId': 'cold', 'hostId': 'local', 'turnLimit': 1,
                                                               'includeOutputs': False, 'maxOutputCharsPerItem': 500}, timeout=2)
        self.native.close.assert_called_once()

    def test_original_identity_and_all_runtime_statuses_are_checked(self):
        for status in ('notLoaded', 'idle', 'active', 'systemError'):
            self.assertEqual(DesktopActivity._snapshot(metadata(status=status), 'cold')['status'], status)
        for value in (metadata('other'), metadata(host='remote'), metadata(status='invented')):
            with self.subTest(value=value), self.assertRaises(ValueError):
                DesktopActivity._snapshot(value, 'cold')

    def test_failed_or_mismatched_refresh_clears_old_display_data(self):
        self.refresh()
        for reply in (metadata('other'), None):
            with self.subTest(reply=reply):
                self.reader.retry_at.clear()
                if reply is None:
                    self.native.call.side_effect = ToolError('read unavailable')
                else:
                    self.native.call.return_value = reply
                self.assertEqual(self.refresh(), {})

    def test_cached_status_expires_and_unknown_turn_status_is_not_completion(self):
        with patch('bridge.clients.codex.activity.time.monotonic', return_value=100):
            self.refresh()
        with patch('bridge.clients.codex.activity.time.monotonic', return_value=116):
            self.reader.worker = SimpleNamespace(is_alive=lambda: True)
            self.assertEqual(self.reader.read(['cold']), {})
        self.reader.worker = None
        self.assertIsNone(DesktopActivity._snapshot(metadata(result='unknown'), 'cold')['turnStatus'])

    def test_calls_are_deduplicated_bounded_and_only_requested_chats_are_refreshed(self):
        self.native.call.side_effect = lambda name, args, **kwargs: metadata(args['threadId'])
        self.reader.MAX_BATCH = 2
        values = self.refresh(['cold', 'cold', 'second', 'hidden'])
        self.assertEqual(set(values), {'cold', 'second'})
        self.assertEqual([call.args[1]['threadId'] for call in self.native.call.call_args_list], ['cold', 'second'])

    def test_slow_read_does_not_block_list_or_repopulate_after_close(self):
        entered, release = threading.Event(), threading.Event()
        def read(*args, **kwargs):
            entered.set()
            release.wait(2)
            return metadata()
        self.native.call.side_effect = read
        self.assertEqual(self.reader.read(['cold']), {})
        self.assertTrue(entered.wait(1))
        with self.reader.lock:
            self.reader.closed = True
        release.set()
        self.reader.worker.join(2)
        self.assertEqual(self.reader.read(['cold']), {})

    def test_unsupported_platform_does_not_open_another_runtime(self):
        with patch.object(DesktopActivity, 'available', False):
            self.assertEqual(self.reader.read(['cold']), {})
        self.connect.assert_not_called()

    def test_activity_tool_client_has_no_mutating_methods(self):
        self.assertEqual(ActivityTools.METHODS, {'list_projects', 'read_thread'})
        client = ActivityTools.__new__(ActivityTools)
        for method in ('thread/resume', 'turn/start', 'create_project', 'send_message_to_thread'):
            with self.subTest(method=method), self.assertRaises(ToolError):
                client.call(method, {})
