"""A new device must see confirmed waiting even while a chat is unloaded."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from bridge.clients.codex.activity import DesktopActivity
from bridge.features.sessions.read_state import SharedReadState
import test_bridge

ROOT = Path(__file__).resolve().parents[1]


class SharedWaitingTests(unittest.TestCase):
    def test_new_device_receives_waiting_after_live_chat_is_unloaded(self):
        store = SharedReadState(None)
        self.addCleanup(store.close)
        waiting = {'connected': True, 'status': 'idle', 'waitingForUser': True, 'waitingObservedAt': 100}
        store.observe('local', 'chat', waiting)
        native = DesktopActivity._snapshot({'thread': {'id': 'chat', 'hostId': 'local',
            'status': {'type': 'idle'}}, 'turns': []}, 'chat')
        self.assertIsNone(native['waitingForUser'], '空闲不代表异步问题已回答')
        cold = {'id': 'chat', 'host': 'local', 'connected': False, 'status': 'unknown',
                'waitingForUser': None, 'waitingObservedAt': 200}
        value = store.activity([cold])[0]
        self.assertEqual(value.get('sharedWaiting'), {'waitingForUser': True, 'waitingObservedAt': 100})
        self.assertNotIn('sharedWaiting', cold, '不能改写其他读取者共用的原始快照')

    def test_waiting_survives_restart_and_only_new_confirmed_state_clears_it(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            store = SharedReadState(directory)
            store.observe('local', 'chat', {'connected': True, 'status': 'idle',
                'waitingForUser': True, 'waitingObservedAt': 200})
            store.close()
            store = SharedReadState(directory)
            try:
                cold = {'id': 'chat', 'host': 'local', 'connected': False, 'status': 'unknown'}
                for observation in (
                    {'connected': True, 'status': 'idle', 'waitingForUser': False, 'waitingObservedAt': 100},
                    {'connected': False, 'status': 'unknown', 'waitingForUser': False, 'waitingObservedAt': 300},
                    {'connected': True, 'status': 'idle', 'waitingForUser': None, 'waitingObservedAt': 400},
                ):
                    store.observe('local', 'chat', observation)
                    self.assertTrue(store.activity([cold])[0]['sharedWaiting']['waitingForUser'])
                store.observe('local', 'chat', {'connected': True, 'status': 'idle',
                    'waitingForUser': False, 'waitingObservedAt': 500})
                self.assertEqual(store.activity([cold])[0]['sharedWaiting'],
                                 {'waitingForUser': False, 'waitingObservedAt': 500})
                for host, chat in (('remote', 'chat'), ('local', 'other'), ('local', 'chat/side/one')):
                    self.assertFalse(store.activity([{'id': chat, 'host': host}])[0].get('sharedWaiting'))
            finally:
                store.close()

    def test_side_and_subagent_waits_have_independent_observation_times(self):
        store = SharedReadState(None)
        self.addCleanup(store.close)
        parent = {'id': 'chat', 'host': 'local', 'connected': True, 'status': 'idle',
                  'waitingForUser': False, 'waitingObservedAt': 300,
                  'waitingSubagents': 1, 'waitingSubagentsObservedAt': 200}
        child = {'id': 'one', 'connected': True, 'status': 'idle',
                 'waitingForUser': True, 'waitingObservedAt': 100, 'text': 'PRIVATE_QUESTION'}
        store.activity([{**parent, 'sideChats': [child]}])
        cold = {'id': 'chat', 'host': 'local', 'connected': False, 'status': 'unknown',
                'waitingSubagents': 0, 'waitingSubagentsObservedAt': 150, 'subagentsKnown': True,
                'sideChats': [{'id': 'one', 'connected': False, 'status': 'unknown'}]}
        value = store.activity([cold])[0]
        self.assertFalse(value['sharedWaiting']['waitingForUser'])
        self.assertEqual(value['sharedWaiting']['waitingSubagents'], 1)
        self.assertTrue(value['sideChats'][0]['sharedWaiting']['waitingForUser'])
        for known, timestamp in ((False, 400), (True, 500)):
            value = store.activity([{**cold, 'subagentsKnown': known,
                'waitingSubagentsObservedAt': timestamp}])[0]
            self.assertEqual(value['sharedWaiting']['waitingSubagents'], 0 if known else 1)
        self.assertTrue(value['sideChats'][0]['sharedWaiting']['waitingForUser'])
        saved = list(store.db.execute('SELECT state FROM waiting_activity'))
        self.assertNotIn('PRIVATE_QUESTION', str(saved))
        self.assertEqual(store.read('local', 'chat'), [], '等待状态不登记已读')


class SharedWaitingHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(test_bridge.HttpTests.tearDownClass.__func__)
    setUp = test_bridge.HttpTests.setUp
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_phone_view_wait_is_returned_to_new_pc_activity_and_answer_clears_it(self):
        self.server.bridge.host = 'local'
        sid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        phone, pc = self.login(), self.login()
        view = {'connected': True, 'status': 'idle', 'waitingForUser': True,
                'waitingObservedAt': 100, 'turnId': 'one', 'turnStatus': 'completed'}
        self.server.bridge.timeline_read = Mock(return_value={'meta': view, 'rows': []})
        self.assertEqual(self.request('GET', f'/api/sessions/{sid}/timeline', headers=phone)[0], 200)
        self.server.bridge.activity = Mock(return_value=[{'id': sid, 'host': 'local',
            'connected': False, 'status': 'unknown', 'waitingForUser': None}])
        status, _, result = self.request('POST', '/api/activity', {'hosts': {'local': [sid]}}, pc)
        self.assertEqual(status, 200)
        self.assertTrue(result['sessions'][0]['sharedWaiting']['waitingForUser'])
        self.assertFalse(result['sessions'][0]['connected'])
        self.server.bridge.timeline_read.return_value = {'meta': {
            **view, 'waitingForUser': False, 'waitingObservedAt': 200}, 'rows': []}
        self.assertEqual(self.request('GET', f'/api/sessions/{sid}/timeline', headers=phone)[0], 200)
        result = self.request('POST', '/api/activity', {'hosts': {'local': [sid]}}, pc)[2]
        self.assertFalse(result['sessions'][0]['sharedWaiting']['waitingForUser'])


if __name__ == '__main__':
    unittest.main()
