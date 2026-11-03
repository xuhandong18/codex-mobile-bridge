"""Conditional display snapshots always verify authoritative data and auth."""
import unittest
from unittest.mock import Mock, patch
import test_bridge


class VersionedSnapshotsTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def setUp(self):
        test_bridge.HttpTests.setUp(self)
        self.server.bridge.list = Mock(return_value=([{'id': test_bridge.THREAD, 'host': 'local', 'title': 'First'}], ['desktop']))
        self.route = '/api/sessions?scope=host&host=local&versioned=1'

    def test_unchanged_list_is_small_but_still_checks_authoritative_rows(self):
        headers = self.login();status, _, full = self.request('GET', self.route, headers=headers)
        self.assertEqual(status, 200);self.assertEqual(len(full['version']), 64)
        _, _, same = self.request('GET', self.route+'&knownVersion='+full['version'], headers=headers)
        self.assertTrue(same['unchanged']);self.assertNotIn('sessions', same)
        self.assertEqual(self.server.bridge.list.call_count, 2)
        self.server.bridge.list.return_value = ([{'id': test_bridge.THREAD, 'host': 'local', 'title': 'Renamed'}], ['desktop'])
        _, _, changed = self.request('GET', self.route+'&knownVersion='+full['version'], headers=headers)
        self.assertEqual(changed['sessions'][0]['title'], 'Renamed')
        self.assertNotEqual(changed['version'], full['version'])

    def test_sidebar_changes_and_partial_failures_cannot_reuse_old_version(self):
        headers = self.login();full = self.request('GET', self.route, headers=headers)[2]
        with patch.object(self.server.bridge.hosts, 'sidebar', return_value={'sections': [{'id': 'new', 'name': 'New'}], 'projects': []}):
            changed = self.request('GET', self.route+'&knownVersion='+full['version'], headers=headers)[2]
        self.assertIn('sessions', changed)
        self.assertNotEqual(changed['version'], full['version'])
        self.server.bridge.host_errors = [{'host': 'local', 'error': 'unavailable'}]
        failed = self.request('GET', self.route+'&knownVersion='+full['version'], headers=headers)[2]
        self.assertFalse(failed['complete']);self.assertNotIn('unchanged', failed);self.assertNotIn('version', failed)

    def test_notification_cursor_changes_without_retransmitting_list(self):
        headers = self.login();notifications = self.server.notifications = Mock()
        notifications.mobile.checkpoint.return_value = {'streamId': 'feed', 'cursor': 1}
        full = self.request('GET', self.route, headers=headers)[2]
        notifications.mobile.checkpoint.return_value = {'streamId': 'feed', 'cursor': 9}
        same = self.request('GET', self.route+'&knownVersion='+full['version'], headers=headers)[2]
        self.assertTrue(same['unchanged']);self.assertEqual(same['notificationRead']['cursor'], 9)

    def test_settings_change_and_unknown_write_reconciliation_keep_full_reads(self):
        headers = self.login();route = '/api/chat-display?versioned=1'
        full = self.request('GET', route, headers=headers)[2]
        same = self.request('GET', route+'&knownVersion='+full['version'], headers=headers)[2]
        self.assertTrue(same['unchanged']);self.assertNotIn('settings', same)
        self.request('POST', '/api/chat-display', {'revision': 0, 'changes': {'showProcess': False}}, headers)
        changed = self.request('GET', route+'&knownVersion='+full['version'], headers=headers)[2]
        self.assertFalse(changed['settings']['showProcess'])
        self.assertNotEqual(changed['version'], full['version'])

    def test_legacy_responses_and_auth_boundary_stay_compatible(self):
        headers = self.login()
        self.assertNotIn('version', self.request('GET', '/api/chat-display', headers=headers)[2])
        self.assertNotIn('version', self.request('GET', '/api/sessions?scope=host', headers=headers)[2])
        self.assertEqual(self.request('GET', self.route)[0], 401)
        for suffix in ('&knownVersion=bad', '&knownVersion=', '&versioned=0', '&knownVersion='+'a'*64+'&knownVersion='+'b'*64):
            self.assertEqual(self.request('GET', self.route+suffix, headers=headers)[0], 400)
