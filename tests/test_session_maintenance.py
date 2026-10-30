"""Maintenance failures must not stop unrelated readers or replay writes."""
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from bridge.app.service import Bridge, LiveSession


class SessionMaintenanceTests(unittest.TestCase):
    def bridge(self):
        bridge = Bridge.__new__(Bridge)
        bridge.host = 'local'
        bridge.closed = SimpleNamespace(wait=Mock(side_effect=[False, False, True]))
        bridge.accounts = None
        bridge.subagent_activity = SimpleNamespace(prune=Mock())
        bridge.lock = threading.RLock()
        bridge.submit_lock = threading.Lock()
        bridge.submissions = {}
        bridge.ipc = SimpleNamespace(client_id='fixture')
        bridge.live = {sid: LiveSession(sid) for sid in ('broken', 'healthy')}
        for session in bridge.live.values():
            session.viewers = 1
        return bridge

    def test_one_failed_session_does_not_kill_maintenance_or_skip_other_sessions(self):
        bridge = self.bridge()
        calls = []
        def refresh(session):
            calls.append(session.id)
            if session.id == 'broken':
                raise RuntimeError('synthetic read failure')
        bridge._refresh_async = refresh
        with self.assertLogs('bridge.app.service', level='ERROR') as logs:
            bridge._maintain()
        self.assertEqual(calls, ['broken', 'healthy', 'broken', 'healthy'])
        self.assertEqual(len(logs.records), 2)
        self.assertFalse(bridge.submit_lock.locked())

    def test_failed_prune_is_logged_and_next_pass_still_runs(self):
        bridge = self.bridge()
        bridge.subagent_activity.prune.side_effect = [RuntimeError('synthetic prune failure'), None]
        bridge._refresh_async = Mock()
        with self.assertLogs('bridge.app.service', level='ERROR'):
            bridge._maintain()
        self.assertEqual(bridge._refresh_async.call_count, 2)

    def test_native_backup_failure_does_not_skip_chat_maintenance(self):
        bridge = self.bridge()
        bridge.side_chats = SimpleNamespace(native_sync=SimpleNamespace(start=Mock(side_effect=RuntimeError('synthetic backup startup failure'))))
        bridge._refresh_async = Mock()
        with self.assertLogs('bridge.app.service', level='ERROR'):
            bridge._maintain()
        self.assertEqual(bridge._refresh_async.call_count, 4)

    def test_failed_queue_send_keeps_unknown_result_and_is_not_replayed(self):
        bridge = self.bridge()
        session = bridge.live['healthy']
        session.connected = True
        session.view = lambda: {'status': 'idle'}
        bridge.live = {session.id: session}
        entry = {'status': 'queued', 'text': 'synthetic message'}
        bridge.submissions = {'healthy:operation-id': entry}
        def send(target, key, value):
            entry['status'] = 'unknown'
            raise RuntimeError('synthetic unknown delivery')
        bridge._send_queued = Mock(side_effect=send)
        bridge._maintain()
        bridge._send_queued.assert_called_once()
        self.assertEqual(entry['status'], 'unknown')
        self.assertFalse(bridge.submit_lock.locked())
