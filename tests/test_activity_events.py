"""Passive cursor notifications: synthetic state and HTTP, no desktop actions."""
import threading
import copy
from types import SimpleNamespace
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch, Mock

from bridge.features.sessions.activity import ActivityEvents, activity_stamp
from bridge.app.service import LiveSession, Bridge
from relay.protocol import validate
import test_bridge


class ActivityEventsTests(unittest.TestCase):
    def setUp(self):
        self.events = ActivityEvents()
        self.addCleanup(self.events.close)
        self.scope = {'local': ['chat'], 'ssh': ['chat']}

    def checkpoint(self):
        return self.events.read(self.scope)

    def test_only_matching_changed_keys_are_returned_and_coalesced(self):
        checkpoint = self.checkpoint()
        self.assertTrue(checkpoint['reset'])
        self.events.publish('local', 'chat', ('active',))
        self.events.publish('local', 'chat', ('idle',))
        self.events.publish('ssh', 'chat', ('active',))
        self.events.publish('local', 'unselected', ('active',))
        result = self.events.read(self.scope, checkpoint['cursor'], checkpoint['streamId'])
        self.assertEqual(result['hosts'], self.scope)
        self.assertFalse(result['reset'])
        self.assertNotIn('sessions', result)

    def test_live_state_changes_wake_waiters_but_text_chunks_do_not_emit(self):
        events = self.events
        session = LiveSession('chat', lambda row: events.publish('local', row.id, activity_stamp(row.state, row.connected)))
        session.connected = True
        session.state = {'threadRuntimeStatus': {'type': 'active'}, 'turns': [{'turnId': 'one', 'status': 'inProgress', 'items': []}]}
        with session.condition:
            session.changed()
        checkpoint = self.checkpoint()
        with session.condition:
            session.state['turns'][0]['items'].append({'type': 'agentMessage', 'text': 'streaming text'})
            session.changed()
        self.assertEqual(events.cursor, checkpoint['cursor'])
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(events.read, self.scope, checkpoint['cursor'], checkpoint['streamId'])
            with session.condition:
                session.state['threadRuntimeStatus']['type'] = 'idle'
                session.state['turns'][0]['status'] = 'completed'
                session.changed()
            self.assertEqual(waiting.result(1)['hosts'], {'local': ['chat']})

    def test_source_stamps_do_not_make_each_other_emit_again(self):
        self.events.publish('local', 'chat', ('active',))
        self.events.publish('local', 'chat', (1, True, 0), 'subagents')
        cursor = self.events.cursor
        self.events.publish('local', 'chat', ('active',))
        self.assertEqual(self.events.cursor, cursor)

    def test_restart_future_cursor_and_overflow_require_resync(self):
        checkpoint = self.checkpoint()
        for i in range(self.events.LIMIT + 1):
            self.events.publish('local', 'chat', (i,))
        self.assertTrue(self.events.read(self.scope, 0, checkpoint['streamId'])['reset'])
        self.assertTrue(self.events.read(self.scope, self.events.cursor + 1, checkpoint['streamId'])['reset'])
        self.assertTrue(self.events.read(self.scope, self.events.cursor, '0' * 32)['reset'])
        self.assertEqual(len(self.events.events), self.events.LIMIT)

    def test_unrelated_changes_do_not_return_and_close_unblocks_without_reads(self):
        checkpoint = self.checkpoint()
        self.events.publish('other-host', 'chat', ('active',))
        result = self.events.read(self.scope, checkpoint['cursor'], checkpoint['streamId'], timeout=0)
        self.assertEqual(result['hosts'], {})
        self.assertEqual(result['cursor'], self.events.cursor)
        self.events.close()
        self.assertTrue(self.events.read(self.scope, result['cursor'], result['streamId'])['closed'])

    def test_concurrent_long_polls_are_bounded(self):
        self.events.waiters = self.events.MAX_WAITERS
        with self.assertRaises(TimeoutError):
            self.checkpoint()
        self.events.waiters = 0

    def test_remote_bridges_share_the_root_cursor_without_starting_ssh(self):
        root = SimpleNamespace(host='local', hosts=SimpleNamespace(hosts=lambda: {'ssh': {'alias': 'fixture'}}),
                               lock=threading.RLock(), remote_bridges={}, data_dir=test_bridge.ROOT,
                               codex_home=test_bridge.ROOT, ipc=SimpleNamespace(path='fixture-pipe'),
                               activity_events=self.events, accounts=None, recovery=None)
        remote = SimpleNamespace()
        with patch('bridge.app.service.Bridge', return_value=remote) as factory:
            self.assertIs(Bridge.for_host(root, 'ssh'), remote)
            self.assertIs(Bridge.for_host(root, 'ssh'), remote)
        factory.assert_called_once()
        self.assertIs(factory.call_args.kwargs['activity_events'], self.events)


class ActivityEventsHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(test_bridge.HttpTests.tearDownClass.__func__)
    setUp = test_bridge.HttpTests.setUp
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_authenticated_startup_advertises_available_activity_notifications(self):
        headers = self.login()
        events = ActivityEvents()
        self.addCleanup(events.close)
        for available in (False, True):
            with patch.object(self.server.bridge, 'activity_events', events if available else None, create=True):
                status, _, value = self.request('GET', '/api/auth', headers=headers)
                self.assertEqual(status, 200)
                self.assertIs(value.get('activityChanges'), available)

    def test_cursor_route_waits_for_keys_without_activity_reads_or_body(self):
        headers = self.login()
        events = ActivityEvents()
        self.addCleanup(events.close)
        with patch.object(self.server.bridge, 'activity_events', events, create=True), \
                patch.object(self.server.bridge, 'for_host', Mock(side_effect=AssertionError('notification must not discover or attach'))):
            body = {'hosts': {'local': ['chat']}}
            status, _, first = self.request('POST', '/api/activity/changes', body, headers)
            self.assertEqual(status, 200)
            with ThreadPoolExecutor(max_workers=1) as pool:
                waiting = pool.submit(self.request, 'POST', '/api/activity/changes', {**body, 'after': first['cursor'], 'streamId': first['streamId']}, headers)
                events.publish('local', 'chat', ('active',))
                status, _, result = waiting.result(1)
            self.assertEqual(status, 200)
            self.assertEqual(result['hosts'], {'local': ['chat']})
            self.assertNotIn('sessions', result)

    def test_login_csrf_cursor_and_subscription_limits_remain_required(self):
        headers = self.login()
        body = {'hosts': {'local': ['chat']}}
        self.assertEqual(self.request('POST', '/api/activity/changes', body)[0], 401)
        self.assertEqual(self.request('POST', '/api/activity/changes', body, {'Cookie': headers['Cookie']})[0], 403)
        for changes in ({'after': True}, {'after': -1}, {'after': '1'}, {'streamId': 'bad'}, {'hosts': {}}, {'hosts': {'local': ['chat'] * 501}}):
            self.assertEqual(self.request('POST', '/api/activity/changes', {**body, **changes}, headers)[0], 400)

    def test_relay_allows_only_the_exact_post_endpoint(self):
        validate('POST', '/api/activity/changes')
        for method, path in [('GET', '/api/activity/changes'), ('POST', '/api/activity/changes/other')]:
            with self.assertRaises(PermissionError):
                validate(method, path)


class ActivityEventsIntegrationTests(unittest.TestCase):
    setUp = test_bridge.IntegrationTests.setUp
    tearDown = test_bridge.IntegrationTests.tearDown

    def test_verified_owner_stream_publishes_without_additional_desktop_calls(self):
        session = self.bridge.session(test_bridge.THREAD)
        events = self.bridge.activity_events
        scope = {'local': [test_bridge.THREAD]}
        checkpoint = events.read(scope)
        requests = len(self.fixture.requests)
        state = copy.deepcopy(session.state)
        state['threadRuntimeStatus'] = {'type': 'active'}
        message = {'method': 'thread-stream-state-changed', 'version': 11, 'sourceClientId': session.owner,
                   'params': {'hostId': 'local', 'conversationId': session.id,
                              'change': {'type': 'snapshot', 'revision': session.revision + 1, 'conversationState': state}}}
        self.bridge._event(message)
        result = events.read(scope, checkpoint['cursor'], checkpoint['streamId'], timeout=0)
        self.assertEqual(result['hosts'], scope)
        self.assertEqual(len(self.fixture.requests), requests)
        cursor = events.cursor
        self.bridge._event({**message, 'sourceClientId': 'unrelated-owner'})
        self.bridge._event({**message, 'params': {**message['params'], 'hostId': 'ssh'}})
        self.assertEqual(events.cursor, cursor)


if __name__ == '__main__':
    unittest.main()
