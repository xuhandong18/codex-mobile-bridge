import threading
import time
from concurrent.futures import ThreadPoolExecutor
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

    def test_waiting_read_returns_the_result_of_this_query_without_a_second_request(self):
        entered, release = threading.Event(), threading.Event()
        def read(*args, **kwargs):
            entered.set()
            release.wait(1)
            return metadata()
        self.native.call.side_effect = read
        result = []
        caller = threading.Thread(target=lambda: result.append(self.reader.read(['cold'], timeout=.8)))
        caller.start()
        try:
            self.assertTrue(entered.wait(.3))
            self.assertTrue(caller.is_alive(), 'The request must wait for the desktop result')
            release.set();caller.join(1)
            self.assertEqual(result[0]['cold']['status'], 'notLoaded')
            self.native.call.assert_called_once()
        finally:
            release.set();caller.join(1)

    def test_waiting_read_fetches_fresh_metadata_even_inside_the_old_cache_lifetime(self):
        self.refresh()
        self.native.call.return_value = metadata(status='active', result='inProgress')
        result = self.reader.read(['cold'], timeout=.5)
        self.assertEqual(result['cold']['status'], 'active')
        self.assertEqual(self.native.call.call_count, 2)

    def test_waiting_read_has_one_deadline_and_does_not_return_stale_status_after_timeout(self):
        self.refresh()
        entered, release = threading.Event(), threading.Event()
        def read(*args, **kwargs):
            entered.set();release.wait(1);return metadata(status='active')
        self.native.call.side_effect = read
        started = time.monotonic()
        try:
            self.assertEqual(self.reader.read(['cold'], timeout=.04), {})
            self.assertTrue(entered.is_set())
            self.assertLess(time.monotonic()-started, .3)
        finally:
            release.set();self.reader.worker.join(1)
        self.assertNotIn('cold', self.reader.snapshots, 'A reply after the query deadline cannot become a fresh snapshot')

    def test_account_operation_gate_is_part_of_the_query_deadline(self):
        gate = threading.RLock()
        self.reader.bridge.accounts = SimpleNamespace(gate=gate)
        with gate:
            self.assertEqual(self.reader.read(['cold'], timeout=.03), {})
        self.reader.worker.join(1)
        self.connect.assert_not_called()

    def test_verified_result_is_returned_before_the_tool_connection_finishes_cleanup(self):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        def close():
            entered.set();release.wait(1)
        self.native.close.side_effect = close
        def read():
            try:
                return self.reader.read(['cold'], timeout=.8)
            finally:
                finished.set()
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(read)
            try:
                self.assertTrue(entered.wait(.3))
                self.assertTrue(finished.wait(.2), 'A verified status must not wait for connection cleanup')
                self.assertEqual(waiting.result()['cold']['status'], 'notLoaded')
            finally:
                release.set()
