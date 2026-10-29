import copy
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge.clients.codex.ipc import IPCError
from bridge.features.sessions.activity import SubagentActivity
from bridge.features.sessions.store import StoreUnavailable


class AgentIPC:
    states = {}
    instances = []

    def __init__(self, path, on_event, on_disconnect):
        self.path, self.on_event, self.on_disconnect = path, on_event, on_disconnect
        self.calls = []
        self.closed = False
        self.instances.append(self)

    def connect(self):
        self.calls.append(('connect',))

    def owner(self, identifier, host):
        self.calls.append(('owner', host, identifier))
        if identifier not in self.states:
            raise IPCError('no-client-found')
        return 'original-owner'

    def follow(self, identifier, owner, enabled=True, host='local'):
        self.calls.append(('follow', host, identifier, owner, enabled))
        if enabled:
            self.publish(identifier, host=host)

    def publish(self, identifier, host='local', owner='original-owner', revision=1, **changes):
        self.on_event({'method': 'thread-stream-state-changed', 'version': 11, 'sourceClientId': owner,
                       'params': {'hostId': host, 'conversationId': identifier, 'change': {
                           'type': 'snapshot', 'revision': revision,
                           'conversationState': copy.deepcopy(self.states[identifier]), **changes}}})

    def close(self):
        self.closed = True


def agent_state(identifier, runtime='active', status='inProgress'):
    return {'id': identifier, 'threadRuntimeStatus': {'type': runtime},
            'turns': [{'turnId': identifier+'-turn', 'status': status}], 'requests': []}


class SubagentActivityTests(unittest.TestCase):
    def setUp(self):
        AgentIPC.states = {'child': agent_state('child'), 'nested': agent_state('nested', 'idle', 'completed')}
        AgentIPC.instances = []
        self.store = SimpleNamespace(activity_tree=Mock(return_value={
            'parent': {'agents': ['child', 'nested'], 'limited': False}}))
        self.monitor = SubagentActivity(self.store, lambda: 'fixture-ipc', 'local')
        self.patch = patch('bridge.features.sessions.activity.DesktopIPC', AgentIPC)
        self.patch.start();self.addCleanup(self.patch.stop);self.addCleanup(self.monitor.close)

    def refresh(self, identifiers=None):
        identifiers = identifiers or ['parent']
        self.monitor.read(identifiers)
        self.monitor.worker.join(2)
        self.assertFalse(self.monitor.worker.is_alive())
        # Read without starting another worker, to make stream assertions exact.
        with self.monitor.lock:
            worker = self.monitor.worker
            self.monitor.worker = SimpleNamespace(is_alive=lambda: True)
            try:
                return self.monitor.read(identifiers)
            finally:
                self.monitor.worker = worker

    def test_follows_descendants_with_original_host_and_owner_without_writable_sessions(self):
        value = self.refresh()['parent']
        self.assertEqual(value, {'runningSubagents': 1, 'subagentsKnown': True, 'waitingSubagents': 0})
        ipc = AgentIPC.instances[0]
        self.assertIn(('follow', 'local', 'child', 'original-owner', True), ipc.calls)
        self.assertTrue(all(call[0] in ('connect', 'owner', 'follow') for call in ipc.calls))
        AgentIPC.states['child'] = agent_state('child', 'idle', 'completed');ipc.publish('child', revision=2)
        self.assertEqual(self.refresh()['parent']['runningSubagents'], 0)

    def test_idle_runtime_does_not_hide_a_still_running_turn_or_pending_approval(self):
        AgentIPC.states['child']['threadRuntimeStatus']['type'] = 'idle'
        self.assertEqual(self.refresh()['parent']['runningSubagents'], 1)
        AgentIPC.states['child'] = agent_state('child', 'idle', 'completed')
        AgentIPC.states['child']['requests'] = [{'id': 'approval', 'method': 'item/commandExecution/requestApproval', 'params': {}}]
        AgentIPC.instances[0].publish('child', revision=2)
        self.assertEqual(self.refresh()['parent']['runningSubagents'], 1)
        self.assertEqual(self.refresh()['parent']['waitingSubagents'], 1)

    def test_fresh_absent_owner_is_idle_and_read_failure_is_unknown(self):
        del AgentIPC.states['child']
        self.assertEqual(self.refresh()['parent'], {'runningSubagents': 0, 'subagentsKnown': True, 'waitingSubagents': 0})
        self.store.activity_tree.side_effect = StoreUnavailable('fixture')
        self.assertEqual(self.refresh()['parent'], {'runningSubagents': 0, 'subagentsKnown': False, 'waitingSubagents': None})

    def test_disconnect_or_invalid_revision_never_means_complete(self):
        self.refresh();ipc = AgentIPC.instances[0]
        ipc.publish('child', revision=2, type='patches', baseRevision=99, patches=[])
        with self.monitor.lock:
            self.assertFalse(self.monitor.records['child']['connected'])
        self.refresh()
        ipc.on_disconnect()
        ipc.publish('child',revision=99)
        self.assertFalse(self.monitor.records['child']['connected'])
        # Prevent a reconnect while checking the disconnected summary.
        self.monitor.worker = SimpleNamespace(is_alive=lambda: True)
        value = self.monitor.read(['parent'])['parent']
        self.assertFalse(value['subagentsKnown']);self.assertEqual(value['runningSubagents'], 0)
        self.monitor.worker = None

    def test_wrong_host_owner_or_identifier_cannot_overwrite_a_valid_snapshot(self):
        self.refresh();ipc = AgentIPC.instances[0]
        AgentIPC.states['child'] = agent_state('child', 'idle', 'completed')
        ipc.publish('child', host='remote:other', revision=2)
        ipc.publish('child', owner='another-owner', revision=2)
        self.assertEqual(self.refresh()['parent']['runningSubagents'], 1)
        ipc.publish('child', revision=2, conversationState=agent_state('unrelated', 'idle', 'completed'))
        self.assertFalse(self.monitor.records['child']['connected'])

    def test_remote_uses_the_selected_host_and_a_single_metadata_call(self):
        self.monitor.host = 'remote:fixture'
        AgentIPC.states['child']['requests']=[{'id':'q','method':'tool/requestUserInput','params':{'questions':[]}}]
        value=self.refresh()['parent']
        self.assertEqual(value['runningSubagents'], 1)
        self.assertEqual(value['waitingSubagents'],1)
        self.store.activity_tree.assert_called_once_with(['parent'])
        self.assertIn(('owner', 'remote:fixture', 'child'), AgentIPC.instances[0].calls)

    def test_list_read_does_not_wait_for_metadata_and_close_discards_a_late_read(self):
        entered, release = threading.Event(), threading.Event()
        def read(identifiers):
            entered.set();release.wait(2)
            return {'parent': {'agents': ['child'], 'limited': False}}
        self.store.activity_tree.side_effect = read
        result = self.monitor.read(['parent'])
        self.assertFalse(result['parent']['subagentsKnown']);self.assertTrue(entered.wait(1))
        with self.monitor.lock:
            self.monitor.closed = True
        release.set();self.monitor.worker.join(2)
        self.assertEqual(AgentIPC.instances, [])

    def test_limited_tree_or_follower_budget_reports_unknown_without_losing_verified_activity(self):
        self.monitor.MAX_FOLLOWERS = 1
        value = self.refresh()['parent']
        self.assertEqual(value, {'runningSubagents': 1, 'subagentsKnown': False, 'waitingSubagents': None})
        self.assertEqual(len(self.monitor.records), 1)

    def test_inactive_subscriptions_expire_even_without_another_list_request(self):
        self.refresh();ipc = AgentIPC.instances[0]
        for record in self.monitor.records.values():record['touched'] -= 301
        for tree in self.monitor.trees.values():tree['touched'] -= 301
        self.monitor.prune()
        self.assertEqual(self.monitor.records,{})
        self.assertEqual(self.monitor.trees,{})
        self.assertIn(('follow','local','child','original-owner',False),ipc.calls)

    def test_valid_patches_finish_a_child_but_malformed_runtime_fields_remain_unknown(self):
        self.refresh();ipc = AgentIPC.instances[0]
        ipc.publish('child',revision=2,type='patches',baseRevision=1,patches=[
            {'op':'replace','path':'/threadRuntimeStatus/type','value':'idle'},
            {'op':'replace','path':'/turns/0/status','value':'completed'}])
        self.assertEqual(self.refresh()['parent'],{'runningSubagents':0,'subagentsKnown':True,'waitingSubagents':0})
        ipc.publish('child',revision=3,conversationState={'id':'child','threadRuntimeStatus':None})
        self.assertEqual(self.refresh()['parent'],{'runningSubagents':0,'subagentsKnown':False,'waitingSubagents':None})

    def test_wait_returns_the_initial_descendant_snapshot_without_a_second_metadata_request(self):
        def follow(ipc, identifier, owner, enabled=True, host='local'):
            ipc.calls.append(('follow', host, identifier, owner, enabled))
        with patch.object(AgentIPC, 'follow', follow):
            self.monitor.read(['parent'], force=True)
            self.monitor.worker.join(1)
            values = []
            waiter = threading.Thread(target=lambda: values.append(self.monitor.wait(['parent'], time.monotonic()+.8)))
            waiter.start()
            try:
                self.assertTrue(waiter.is_alive())
                for child in ('child', 'nested'):
                    AgentIPC.instances[0].publish(child)
                waiter.join(1)
                self.assertEqual(values[0]['parent'], {'runningSubagents': 1, 'subagentsKnown': True, 'waitingSubagents': 0})
                self.store.activity_tree.assert_called_once_with(['parent'])
            finally:
                self.monitor.close();waiter.join(1)

    def test_slow_metadata_has_a_bounded_wait_and_does_not_return_cached_completion(self):
        self.refresh()
        entered, release = threading.Event(), threading.Event()
        def read(ids):
            entered.set();release.wait(1);return {'parent': {'agents': [], 'limited': False}}
        self.store.activity_tree.side_effect = read
        self.monitor.read(['parent'], force=True)
        self.assertTrue(entered.wait(.3));started=time.monotonic()
        try:
            self.assertEqual(self.monitor.wait(['parent'], started+.03)['parent'], {'runningSubagents': 0, 'subagentsKnown': False, 'waitingSubagents': None})
            self.assertLess(time.monotonic()-started, .3)
        finally:
            release.set();self.monitor.worker.join(1)

    def test_explicit_query_rechecks_an_absent_child_without_waiting_for_retry_cooldown(self):
        del AgentIPC.states['child'];self.refresh()
        AgentIPC.states['child'] = agent_state('child')
        self.monitor.read(['parent'], force=True)
        self.assertEqual(self.monitor.wait(['parent'], time.monotonic()+.8)['parent']['runningSubagents'], 1)
