"""Side activity and ordering use synthetic runtimes, never installed clients."""
import sqlite3
import threading
import time
import unittest
import uuid
from contextlib import ExitStack, closing, contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from bridge.app.service import LiveSession
from bridge.features.sessions.linux_side_chat import LinuxSideChat
from bridge.features.sessions.side_chat import SideChat, SideChatError
import test_bridge as support
from test_side_chat import RuntimeFixture


class SideActivityTests(unittest.TestCase):
    setUp = support.IntegrationTests.setUp
    tearDown = support.IntegrationTests.tearDown

    def create(self, parent=support.THREAD, slot='', chat_type=SideChat):
        manager = self.bridge.side_chats
        manager.on_first_message = None
        manager.factory = lambda *args: chat_type(*args, runtime_factory=RuntimeFixture)
        manager.executable = 'fixture-runtime'
        manager.executable_getter = None
        with patch('bridge.features.sessions.side_chat.check_runtime'):
            manager.operate(parent, 'create', {'creationId': str(uuid.uuid4()), **({'slot': slot} if slot else {})},
                            {'cwd': str(self.root)}, {'model': 'fixture', 'modelProvider': 'custom'})
        return manager.chats[(parent, slot)]

    @contextmanager
    def hold(self, lock):
        entered, release = threading.Event(), threading.Event()
        def worker():
            with lock:
                entered.set()
                release.wait(2)
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        try:
            self.assertTrue(entered.wait(.5))
            yield
        finally:
            release.set()
            thread.join(1)

    def parent(self, connected=True, status='idle'):
        session = LiveSession(support.THREAD)
        session.connected = connected
        session.state = {'id': support.THREAD, 'threadRuntimeStatus': {'type': status},
                         'turns': [{'turnId': 'parent-turn', 'status': 'completed', 'items': []}]}
        self.bridge.listed.add(session.id)
        self.bridge.live[session.id] = session
        return session

    @contextmanager
    def passive(self):
        activity = {support.THREAD: {'runningSubagents': 0, 'subagentsKnown': True}}
        with ExitStack() as stack:
            for target, name, kwargs in (
                (self.bridge, 'activate', {'side_effect': AssertionError('No parent activation')}),
                (self.bridge, '_attach', {}),
                (self.bridge, '_refresh_activity_recencies', {}),
                (self.bridge.store, 'history', {'side_effect': AssertionError('No history')}),
                (self.bridge.desktop_activity, 'read', {'return_value': {}}),
                (self.bridge.subagent_activity, 'read', {'return_value': activity}),
                (self.bridge.subagent_activity, 'wait', {'return_value': activity}),
            ):
                stack.enter_context(patch.object(target, name, **kwargs))
            yield

    def test_summary_is_parent_scoped_lightweight_and_read_only(self):
        manager = self.bridge.side_chats
        self.assertEqual(manager.activity(support.THREAD), [])
        one = self.create()
        two = self.create(slot=str(uuid.uuid4()))
        other = self.create(parent=str(uuid.uuid4()))
        one.send('question', str(uuid.uuid4()))
        two.send('done', str(uuid.uuid4()))
        two.runtime.emit('turn/completed', turn={'id': 'turn', 'status': 'completed'})
        before = [len(chat.runtime.calls) for chat in (one, two, other)]
        with patch.object(one, 'view', side_effect=AssertionError('No full transcript projection')):
            rows = manager.activity(support.THREAD)
        self.assertEqual(rows, [
            {'id': one.id, 'connected': True, 'status': 'active', 'turnId': 'turn', 'turnStatus': 'inProgress'},
            {'id': two.id, 'connected': True, 'status': 'idle', 'turnId': 'turn', 'turnStatus': 'completed'},
        ])
        rows[0]['status'] = 'changed'
        self.assertEqual(manager.activity(support.THREAD)[0]['status'], 'active')
        self.assertEqual([len(chat.runtime.calls) for chat in (one, two, other)], before)

    def test_summary_never_waits_for_manager_or_child_locks(self):
        one = self.create()
        two = self.create(slot=str(uuid.uuid4()))
        two.send('running', str(uuid.uuid4()))
        with self.hold(self.bridge.side_chats.lock), self.hold(one.lock):
            started = time.monotonic()
            rows = self.bridge.side_chats.activity(support.THREAD)
            self.assertLess(time.monotonic() - started, .2)
            self.assertEqual(rows[0]['status'], 'unknown')
            self.assertFalse(rows[0]['connected'])
            self.assertEqual(rows[1]['status'], 'active')

    def test_linux_runtime_uses_the_same_summary_and_disconnect_is_not_running(self):
        child = self.create(chat_type=LinuxSideChat)
        child.send('question', str(uuid.uuid4()))
        self.assertEqual(self.bridge.side_chats.activity(support.THREAD)[0]['status'], 'active')
        child.runtime.emit('bridge/disconnected')
        row = self.bridge.side_chats.activity(support.THREAD)[0]
        self.assertFalse(row['connected'])
        self.assertEqual(row['status'], 'unknown')
        self.assertIn('recency', child.view())

    def test_activity_aggregates_running_side_without_replacing_parent_status_or_turn(self):
        child = self.create()
        child.send('question', str(uuid.uuid4()))
        self.parent(connected=False)
        with self.passive():
            row = self.bridge.activity([support.THREAD], .08)[0]
        self.assertEqual(row['sideChats'][0]['id'], child.id)
        self.assertEqual(row['status'], 'active')
        self.assertEqual(row['parentStatus'], 'unknown')
        self.assertTrue(row['activityConnected'])
        self.assertFalse(row['connected'])

        for worker in tuple(self.bridge.activity_queries.workers):
            worker.join(.3)
        self.parent()
        with self.passive():
            row = self.bridge.activity([support.THREAD], .2)[0]
        self.assertEqual(row['parentStatus'], 'idle')
        self.assertEqual((row['turnId'], row['turnStatus']), ('parent-turn', 'completed'))
        self.assertEqual(row['status'], 'active')

    def test_activity_has_empty_sides_and_preserves_subagent_aggregation(self):
        self.parent()
        with self.passive():
            self.assertEqual(self.bridge.activity([support.THREAD], .2)[0]['sideChats'], [])
            with patch.object(self.bridge.subagent_activity, 'wait', return_value={
                    support.THREAD: {'runningSubagents': 1, 'subagentsKnown': True}}):
                row = self.bridge.activity([support.THREAD], .2)[0]
        self.assertEqual(row['status'], 'active')
        self.assertEqual(row['parentStatus'], 'idle')
        self.assertEqual(row['runningSubagents'], 1)

    def test_timeout_retains_confirmed_sides_despite_locked_parent_manager_and_other_side(self):
        blocked = self.create()
        running = self.create(slot=str(uuid.uuid4()))
        running.send('running', str(uuid.uuid4()))
        parent = self.parent()
        with self.hold(parent.condition), self.hold(blocked.lock), self.hold(self.bridge.side_chats.lock), \
                patch.object(self.bridge.activity_queries, 'query', side_effect=TimeoutError):
            started = time.monotonic()
            row = self.bridge.activity([support.THREAD], .02)[0]
            self.assertLess(time.monotonic() - started, .2)
        self.assertEqual(row['status'], 'active')
        self.assertEqual(row['parentStatus'], 'unknown')
        self.assertTrue(row['activityConnected'])
        self.assertFalse(row['connected'])
        self.assertEqual([side['status'] for side in row['sideChats']], ['unknown', 'active'])
        self.assertNotIn('activityError', row)

    def test_native_timeout_stays_bounded_and_keeps_side_activity(self):
        child = self.create()
        child.send('running', str(uuid.uuid4()))
        self.parent(connected=False)
        entered, release = threading.Event(), threading.Event()
        def native(*args, **kwargs):
            entered.set()
            release.wait(1)
            return {}
        try:
            with self.passive(), patch.object(self.bridge.desktop_activity, 'read', side_effect=native):
                started = time.monotonic()
                row = self.bridge.activity([support.THREAD], .04)[0]
                self.assertLess(time.monotonic() - started, .3)
            self.assertTrue(entered.is_set())
            self.assertEqual(row['status'], 'active')
            self.assertEqual(row['sideChats'][0]['id'], child.id)
        finally:
            release.set()

    def test_accepted_writes_count_but_request_arrival_retries_reads_and_rename_do_not(self):
        child = self.create()
        manager = self.bridge.side_chats
        self.assertEqual(child.view()['recency'], 0)
        with patch('time.time', return_value=10):
            token = str(uuid.uuid4())
            child.send('question', token)
        self.assertEqual(child.view()['recency'], 10000)
        with patch('time.time', return_value=20):
            child.send('question', token)
            child.rename('new title')
            manager.operate(support.THREAD, 'read', {})
        self.assertEqual(child.view()['recency'], 10000)
        with patch('time.time', return_value=20):
            child._event({'id': 'approval', 'method': 'item/commandExecution/requestApproval',
                          'params': {'threadId': child.id, 'turnId': 'turn'}})
        self.assertEqual(child.view()['recency'], 10000)
        with patch('time.time', return_value=30):
            child.respond('approval', {'decision': 'accept'})
        self.assertEqual(child.view()['recency'], 30000)
        self.assertEqual(manager.recencies(), {support.THREAD: 30000})
        with patch('time.time', return_value=40):
            with self.assertRaises(ValueError):
                child.respond('approval', {'decision': 'accept'})
        self.assertEqual(child.view()['recency'], 30000)

    def test_unknown_and_rejected_send_or_response_do_not_advance_recency(self):
        child = self.create()
        token = str(uuid.uuid4())
        with patch('time.time', return_value=10):
            child.runtime.fail_send = True
            self.assertEqual(child.send('uncertain', token)['status'], 'unknown')
            self.assertEqual(child.send('uncertain', token)['status'], 'unknown')
        self.assertEqual(sum(method == 'turn/start' for method, _ in child.runtime.calls), 1)
        self.assertEqual(child.view()['recency'], 0)
        with patch('time.time', return_value=20):
            child._event({'id': 'approval', 'method': 'item/commandExecution/requestApproval',
                          'params': {'threadId': child.id}})
        with patch.object(child.runtime, 'write', side_effect=SideChatError('unknown write')):
            with self.assertRaises(SideChatError):
                child.respond('approval', {'decision': 'accept'})
        self.assertEqual(child.view()['recency'], 0, 'Request arrival and an unknown response are not confirmed interactions')
        other = self.create(slot=str(uuid.uuid4()))
        error = SideChatError('rejected')
        error.rpc_error = {'code': -1}
        with patch.object(other.runtime, 'request', side_effect=error):
            with self.assertRaises(SideChatError):
                other.send('rejected', str(uuid.uuid4()))
        self.assertEqual(other.view()['recency'], 0)
        self.assertEqual(self.bridge.side_chats.recencies(), {})

    def test_queued_send_counts_at_dispatch_and_steer_counts_once(self):
        child = self.create()
        with patch('time.time', return_value=10):
            child.send('running', str(uuid.uuid4()))
        queued, cancelled = str(uuid.uuid4()), str(uuid.uuid4())
        with patch('time.time', return_value=20):
            child.send('later', queued, mode='queue')
            child.send('cancel', cancelled, mode='queue')
            child.cancel_queued(cancelled)
        self.assertEqual(child.view()['recency'], 10000)
        with patch('time.time', return_value=30):
            child.runtime.emit('turn/completed', turn={'id': 'turn', 'status': 'completed'})
            deadline = time.monotonic() + 1
            while child.submissions[queued]['status'] != 'accepted' and time.monotonic() < deadline:
                time.sleep(.005)
            self.assertEqual(child.submissions[queued]['status'], 'accepted')
            self.assertEqual(child.view()['recency'], 30000)
        steer = str(uuid.uuid4())
        with patch('time.time', return_value=40):
            child.send('follow', steer, mode='steer', work_mode=None)
        with patch('time.time', return_value=50):
            child.send('follow', steer, mode='steer', work_mode=None)
        self.assertEqual(child.view()['recency'], 40000)

    def test_parent_recency_is_shared_monotone_and_survives_side_close(self):
        one = self.create()
        two = self.create(slot=str(uuid.uuid4()), chat_type=LinuxSideChat)
        for child, at in ((one, 30), (two, 20)):
            with patch('time.time', return_value=at):
                child.send('question', str(uuid.uuid4()))
        self.assertEqual(two.view()['recency'], 20000)
        manager = self.bridge.side_chats
        snapshot = manager.recencies()
        self.assertEqual(snapshot, {support.THREAD: 30000})
        snapshot[support.THREAD] = 0
        manager.operate(support.THREAD, 'close', {'id': one.id})
        manager.operate(support.THREAD, 'close', {'slot': next(key[1] for key in manager.chats), 'id': two.id})
        self.assertEqual(manager.activity(support.THREAD), [])
        with self.hold(manager.lock):
            self.assertEqual(manager.recencies(), {support.THREAD: 30000})

    def test_list_promotes_an_old_parent_before_paging_and_keeps_original_filters(self):
        child = self.create()
        with closing(sqlite3.connect(self.root / 'state_5.sqlite')) as db, db:
            db.executemany('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)', [
                (str(uuid.uuid4()), 'Recent', '/workspace', 10+i, 0, 'Codex Desktop', 'vscode', 'unused')
                for i in range(120)])
            db.execute('ALTER TABLE threads ADD COLUMN recency_at INT')
            db.execute('UPDATE threads SET recency_at=updated_at')
        self.assertNotIn(support.THREAD, [row['id'] for row in self.bridge.list(local_only=True)])
        with patch('time.time', return_value=500):
            child.send('promote old parent', str(uuid.uuid4()))
        with patch.object(self.bridge, 'activate', side_effect=AssertionError('No activation')), \
                patch.object(self.bridge.store, 'history', side_effect=AssertionError('No history')):
            first = self.bridge.list(limit=100, local_only=True)
            second = self.bridge.list(limit=100, offset=100, local_only=True)
            self.assertEqual(first[0]['id'], support.THREAD)
            self.assertEqual(first[0]['recency'], 500000)
            self.assertEqual(len(first) + len(second), 121)
            self.assertEqual(len({row['id'] for row in first + second}), 121)
            self.assertEqual(self.bridge.list(limit=1, local_only=True)[0]['id'], support.THREAD)
            self.assertNotEqual(self.bridge.list(limit=1, offset=1, local_only=True)[0]['id'], support.THREAD)
            for kwargs in ({'query': 'no match'}, {'archived': True}, {'source': 'cli'},
                           {'ids': [first[1]['id']]}):
                self.assertNotIn(support.THREAD, [row['id'] for row in self.bridge.list(local_only=True, **kwargs)])
        self.bridge.side_chats.operate(support.THREAD, 'close', {'id': child.id})
        refreshed = self.bridge.list(local_only=True)
        self.assertEqual((refreshed[0]['id'], refreshed[0]['recency']), (support.THREAD, 500000))
        self.assertEqual(self.bridge.live, {})

    def test_activity_and_timeout_recency_take_parent_side_max_without_waiting_on_manager(self):
        child = self.create()
        self.parent()
        self.bridge.activity_recency_snapshot[support.THREAD] = 1000
        with patch('time.time', return_value=10):
            child.send('question', str(uuid.uuid4()))
        with self.passive(), self.hold(self.bridge.side_chats.lock):
            self.assertEqual(self.bridge.activity([support.THREAD], .2)[0]['recency'], 10000)
            self.assertEqual(self.bridge.activity_timeout_rows([support.THREAD])[0]['recency'], 10000)
            self.bridge.activity_recency_snapshot[support.THREAD] = 20000
            self.assertEqual(self.bridge.activity([support.THREAD], .2)[0]['recency'], 20000)

    def test_side_recency_is_host_scoped_when_the_same_parent_id_exists_remotely(self):
        child = self.create()
        with patch('time.time', return_value=10):
            child.send('local question', str(uuid.uuid4()))
        remote = SimpleNamespace(host='ssh', lock=threading.RLock(), live={}, origins={}, listed=set(),
                                 recency_index=SimpleNamespace(request=lambda: None, snapshot=lambda: {}),
                                 _access=self.bridge._access, store=SimpleNamespace(list=lambda **kwargs: [
                                     {'id': support.THREAD, 'title': 'Remote', 'cwd': '/workspace', 'recency_at': 2, 'updated_at': 2}]))
        with patch.object(self.bridge.hosts, 'hosts', return_value={'ssh': {'alias': 'fixture'}}), \
                patch.object(self.bridge, 'for_host', return_value=remote):
            rows = self.bridge.list()
            self.assertEqual([(row['host'], row['recency']) for row in rows], [('local', 10000), ('ssh', 2000)])
            self.assertEqual(self.bridge.list(limit=1, offset=1)[0]['host'], 'ssh')


if __name__ == '__main__':
    unittest.main()
