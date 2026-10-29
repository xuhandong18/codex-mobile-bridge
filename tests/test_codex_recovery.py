"""Automatic recovery uses synthetic owner state and a controllable clock."""
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from bridge.features.sessions.recovery import Recovery, capacity_error, save_settings
import test_bridge as support


ROOT = Path(__file__).resolve().parents[1]
ERROR = {'message': 'Selected model is at capacity. Please try a different model.',
         'codexErrorInfo': 'serverOverloaded'}


def snapshot(turn='first', status='inProgress', request=None, **changes):
    return {'host': 'local', 'id': 'chat', 'connected': True, 'owner': 'owner',
            'cwd': '/fixture', 'provider': 'original', 'runtime': 'desktop',
            'turnId': turn, 'turnStatus': status, 'active': status == 'inProgress',
            'waiting': False, 'requestId': request, 'inputId': request or turn,
            'overloaded': status == 'failed', **changes}


class Source:
    def __init__(self):
        self.sent = []
        self.current = snapshot()
        self.unknown = False

    def for_host(self, host):
        return self

    def recovery_send(self, expected, identifier, claim):
        if self.current != expected:
            return {'status': 'cancelled'}
        if not claim():
            return {'status': 'cancelled'}
        self.sent.append(identifier)
        if self.unknown:
            raise OSError('synthetic lost acknowledgement')
        return {'status': 'accepted'}

    def release_recovery_session(self, identifier):
        return True


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        (ROOT / '.tmp').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.tmp')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.now = 1000
        self.source = Source()
        self.recovery = Recovery(self.source, self.directory, clock=lambda: self.now)
        self.recovery.scan()

    def state(self, row):
        self.source.current = copy.deepcopy(row)
        self.recovery.observe(row)
        self.recovery.scan()

    def failed(self, turn='first', request=None, **changes):
        self.state(snapshot(turn, 'failed', request, **changes))

    def begin(self):
        self.state(snapshot())
        self.failed()

    def automatic_failure(self, turn):
        request = self.source.sent[-1]
        self.state(snapshot(turn, request=request))
        self.failed(turn, request)

    def test_initial_failed_snapshot_and_repeated_old_error_never_send(self):
        self.state(snapshot(connected=False, owner=None, turn=None, status=None))
        self.failed()
        for _ in range(5):
            self.failed()
        self.assertEqual(self.source.sent, [])
        self.state(snapshot('new'))
        self.failed('new')
        self.assertEqual(len(self.source.sent), 1)

    def test_failed_turn_arriving_before_idle_runtime_is_still_recovered(self):
        self.state(snapshot())
        self.failed(active=True)
        self.assertEqual(self.source.sent, [])
        self.failed()
        self.assertEqual(len(self.source.sent), 1)

    def test_automatic_turn_can_be_identified_after_its_initial_empty_patch(self):
        self.begin()
        self.state(snapshot('auto', inputId=None))
        self.automatic_failure('auto')
        self.now += 600
        self.recovery.scan()
        self.assertEqual(len(self.source.sent), 2)

    def test_cancelled_automatic_turn_does_not_get_a_new_budget_after_toggle(self):
        self.begin()
        request = self.source.sent[-1]
        self.state(snapshot('auto', request=request))
        save_settings(self.directory, {'enabled': False})
        self.recovery.scan()
        save_settings(self.directory, {'enabled': True})
        self.recovery.scan()
        self.state(snapshot('auto', request=request))
        self.failed('auto', request)
        self.assertEqual(len(self.source.sent), 1)

    def test_first_retry_is_immediate_then_ten_minutes_with_three_total_attempts(self):
        self.begin()
        self.assertEqual(len(self.source.sent), 1)
        for turn in ('second', 'third'):
            self.automatic_failure(turn)
            count = len(self.source.sent)
            self.now += 599
            self.recovery.scan()
            self.assertEqual(len(self.source.sent), count)
            self.now += 1
            self.recovery.scan()
            self.assertEqual(len(self.source.sent), count + 1)
        self.automatic_failure('fourth')
        self.now += 6000
        self.recovery.scan()
        self.assertEqual(len(self.source.sent), 3)
        self.assertEqual(len(set(self.source.sent)), 3)

    def test_other_errors_stop_requests_and_aggregate_activity_do_not_trigger(self):
        for changes in ({'overloaded': False}, {'turnStatus': 'interrupted'},
                        {'waiting': True}, {'active': True}):
            with self.subTest(changes=changes):
                self.state(snapshot('baseline'))
                self.failed('failure', **changes)
        self.assertEqual(self.source.sent, [])

    def test_delayed_retry_is_cancelled_by_manual_message_stop_or_owner_change(self):
        for change in ('message', 'stop', 'owner', 'request', 'running'):
            with self.subTest(change=change):
                self.recovery = Recovery(self.source, self.directory, clock=lambda: self.now)
                self.recovery.scan()
                self.source.sent = []
                self.begin()
                self.automatic_failure('retry')
                if change == 'message':
                    row = snapshot('manual', request='human')
                elif change == 'stop':
                    row = snapshot('retry', 'interrupted', self.source.sent[-1])
                elif change == 'owner':
                    row = snapshot('retry', 'failed', self.source.sent[-1], owner='replacement')
                elif change == 'request':
                    row = snapshot('retry', 'failed', self.source.sent[-1], waiting=True)
                else:
                    row = snapshot('retry', request=self.source.sent[-1])
                self.state(row)
                self.now += 600
                self.recovery.scan()
                self.assertEqual(len(self.source.sent), 1)

    def test_unknown_write_and_restart_never_replay(self):
        self.source.unknown = True
        self.begin()
        self.now += 6000
        self.failed()
        restarted = Recovery(self.source, self.directory, clock=lambda: self.now)
        restarted.scan()
        restarted.observe(self.source.current)
        restarted.scan()
        self.assertEqual(len(self.source.sent), 1)

    def test_switch_off_cancels_delay_and_reenable_does_not_revive_old_failure(self):
        self.begin()
        self.automatic_failure('retry')
        save_settings(self.directory, {'enabled': False})
        self.recovery.scan()
        self.now += 600
        save_settings(self.directory, {'enabled': True})
        self.recovery.scan()
        self.failed('retry', self.source.sent[-1])
        self.assertEqual(len(self.source.sent), 1)

    def test_latest_state_is_checked_again_before_sending(self):
        self.state(snapshot())
        self.recovery.observe(snapshot(status='failed'))
        self.source.current = snapshot('manual', request='human')
        self.recovery.scan()
        self.assertEqual(self.source.sent, [])

    def test_read_failure_before_submission_waits_without_spending_an_attempt(self):
        original = self.source.recovery_send
        self.source.recovery_send = Mock(side_effect=OSError('synthetic unavailable owner'))
        self.begin()
        self.assertEqual(self.source.sent, [])
        self.source.recovery_send = original
        self.now += 3
        self.recovery.scan()
        self.assertEqual(len(self.source.sent), 1)

    def test_manual_intervention_between_preflight_and_claim_cancels_the_write(self):
        original = self.source.recovery_send
        def intervene(expected, identifier, claim):
            self.recovery.intervene(expected['host'], expected['id'])
            return original(expected, identifier, claim)
        self.source.recovery_send = intervene
        self.begin()
        self.assertEqual(self.source.sent, [])

    def test_success_and_a_new_manual_task_allow_a_new_recovery(self):
        self.begin()
        self.state(snapshot('auto', 'completed', self.source.sent[-1]))
        self.state(snapshot('manual', request='human'))
        self.failed('manual', 'human')
        self.assertEqual(len(self.source.sent), 2)

    def test_unknown_automatic_turn_identity_cannot_reset_retry_budget(self):
        self.begin()
        self.failed('uncorrelated')
        self.now += 6000
        self.recovery.scan()
        self.assertEqual(len(self.source.sent), 1)

    def test_multiple_chats_are_independent(self):
        self.begin()
        self.state(snapshot('other', id='another-chat'))
        self.state(snapshot('other', 'failed', id='another-chat'))
        self.assertEqual(len(self.source.sent), 2)

    def test_identical_chat_ids_on_different_hosts_are_independent(self):
        self.begin()
        self.state(snapshot(host='ssh:fixture'))
        self.failed(host='ssh:fixture')
        self.assertEqual(len(self.source.sent), 2)


class ErrorTests(unittest.TestCase):
    def test_only_structured_error_or_exact_message_matches(self):
        self.assertTrue(capacity_error(ERROR))
        self.assertTrue(capacity_error({'message': ERROR['message']}))
        self.assertFalse(capacity_error({'message': ERROR['message'], 'codexErrorInfo': 'other'}))
        for value in (None, 'serverOverloaded', {'message': 'quoted ' + ERROR['message']},
                      {'message': 'network error'}, {'codexErrorInfo': 'rateLimitExceeded'}):
            self.assertFalse(capacity_error(value))


class OwnerRecoveryTests(unittest.TestCase):
    setUp = support.IntegrationTests.setUp
    tearDown = support.IntegrationTests.tearDown

    def failed_owner(self):
        self.fixture.state['turns'] = [{'turnId': 'failure', 'status': 'failed', 'error': ERROR,
                                       'items': [{'id': 'human', 'type': 'userMessage', 'content': []}]}]
        self.bridge.recovery_session(support.THREAD)
        session = self.bridge.live[support.THREAD]
        with session.condition:
            session.condition.wait_for(lambda: session.connected, timeout=2)
        self.assertTrue(session.connected)
        return session

    def test_original_owner_is_refreshed_and_settings_are_inherited_without_activation(self):
        session = self.failed_owner()
        self.bridge.activate = Mock(side_effect=AssertionError('Recovery must never activate'))
        expected = self.bridge.recovery_snapshot(session)
        identifier = '11111111-1111-4111-8111-111111111111'
        result = self.bridge.recovery_send(expected, identifier, lambda: True)
        self.assertEqual(result['status'], 'accepted')
        sends = [r for r in self.fixture.requests if r['method'] == 'thread-follower-start-turn']
        self.assertEqual(len(sends), 1)
        request = sends[0]['params']['turnStart']
        self.assertEqual(request['request']['input'][0]['text'], '继续执行')
        self.assertEqual(request['context']['inheritThreadSettings'], True)
        self.assertEqual(sends[0]['targetClientId'], 'owner')
        self.assertNotIn('collaborationMode', request['request'])
        self.assertTrue(self.bridge.recovery_send(expected, identifier, lambda: True)['duplicate'])
        self.assertEqual(sum(r['method'] == 'thread-follower-start-turn' for r in self.fixture.requests), 1)

    def test_fresh_snapshot_with_new_task_or_pending_input_prevents_write(self):
        session = self.failed_owner()
        expected = self.bridge.recovery_snapshot(session)
        self.fixture.state['turns'].append({'turnId': 'manual', 'status': 'inProgress', 'items': []})
        claim = Mock(return_value=True)
        result = self.bridge.recovery_send(expected, '11111111-1111-4111-8111-111111111111', claim)
        self.assertEqual(result['status'], 'cancelled')
        claim.assert_not_called()
        self.assertFalse(any(r['method'] == 'thread-follower-start-turn' for r in self.fixture.requests))

    def test_notification_release_cannot_disconnect_supervision(self):
        session = self.failed_owner()
        session.watched = True
        self.bridge.release_notification_session(session)
        self.assertTrue(session.connected)
        self.assertTrue(session.supervised)
        session.watched = True
        self.bridge.release_recovery_session(session.id)
        self.assertTrue(session.connected)
        self.assertTrue(session.watched)
        self.bridge.release_notification_session(session)
        self.assertFalse(session.connected)

    def test_archived_thread_and_subagent_are_not_supervised(self):
        from contextlib import closing
        import sqlite3
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.execute('UPDATE threads SET archived=1 WHERE id=?', (support.THREAD,))
        with self.assertRaises(KeyError):
            self.bridge.recovery_session(support.THREAD)
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.execute('UPDATE threads SET archived=0,source=? WHERE id=?',
                       ('{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}', support.THREAD))
        with self.assertRaises(KeyError):
            self.bridge.recovery_session(support.THREAD)

    def test_background_discovery_uses_its_own_cursor_and_keeps_phone_closed(self):
        recovery = Recovery(self.bridge, self.root / 'recovery')
        self.bridge.recovery = recovery
        self.addCleanup(recovery.close)
        recovery.scan()
        recovery.discover()
        session = self.bridge.live[support.THREAD]
        with session.condition:
            session.condition.wait_for(lambda: session.connected, timeout=2)
        recovery.scan()
        self.assertEqual(session.viewers, 0)
        self.assertEqual(self.bridge.notification_cursor, 0)
        self.fixture.state['turns'] = [{'turnId': 'background', 'status': 'inProgress', 'items': []}]
        self.fixture.state['threadRuntimeStatus'] = {'type': 'active'}
        self.fixture.snapshot()
        with session.condition:
            session.condition.wait_for(lambda: session.state.get('turns'), timeout=2)
        recovery.scan()
        self.fixture.state['turns'][-1].update(status='failed', error=ERROR)
        self.fixture.state['threadRuntimeStatus'] = {'type': 'idle'}
        self.fixture.snapshot()
        with session.condition:
            session.condition.wait_for(lambda: session.state['turns'][-1]['status'] == 'failed', timeout=2)
        recovery.scan()
        sends = [r for r in self.fixture.requests if r['method'] == 'thread-follower-start-turn']
        self.assertEqual(len(sends), 1)
        self.assertEqual(self.bridge.notification_cursor, 0)
        self.assertFalse(session.watched)
