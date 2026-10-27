import threading
import unittest
import uuid
from unittest.mock import patch

import test_bridge as support
from test_auto_titles import wait_for
from bridge.features.sessions.title_rename import conversation_text
from bridge.features.sessions.title_rename import TitleRenames
from bridge.features.sessions.auto_titles import AutoTitles


class TitleRenameTests(unittest.TestCase):
    def setUp(self):
        self.fixture = support.IntegrationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.bridge = self.fixture.bridge
        self.started, self.release = threading.Event(), threading.Event()
        self.addCleanup(self.release.set)
        self.generated, self.renamed = [], []
        self.history = {**support.state(), 'turns': [{'items': [
            {'type': 'userMessage', 'content': [{'type': 'text', 'text': '最初讨论登录'}]},
            {'type': 'agentMessage', 'text': '已经完成登录'},
            {'type': 'userMessage', 'content': [{'type': 'text', 'text': '现在增加聊天重命名'}]},
            {'type': 'commandExecution', 'output': 'PRIVATE TOOL OUTPUT'}]}]}
        self.bridge.store.history = lambda *a, **k: self.history

        def generate(*args, **kwargs):
            self.generated.append((args, kwargs))
            self.started.set()
            self.release.wait(2)
            return {'title': '完善聊天标题管理'}

        self.addCleanup(patch.stopall)
        patch('bridge.app.service.generate_title', side_effect=generate).start()
        patch('bridge.app.service.rename_thread', side_effect=lambda *args: self.renamed.append(args[-1])).start()

    def test_explicit_summary_uses_conversation_and_original_model_without_activation(self):
        self.assertEqual(self.bridge.title_renames.status(support.THREAD)['status'], 'ready')
        self.assertEqual(self.generated, [])
        rid = str(uuid.uuid4())
        before = list(self.fixture.fixture.requests)
        self.bridge.title_renames.start(support.THREAD, rid)
        self.assertTrue(self.started.wait(1))
        self.bridge.title_renames.start(support.THREAD, rid)
        self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
        self.assertEqual(len(self.generated), 1)
        args, options = self.generated[0]
        self.assertIn('最初讨论登录', args[2])
        self.assertIn('现在增加聊天重命名', args[2])
        self.assertIn('已经完成登录', args[2])
        self.assertNotIn('PRIVATE TOOL OUTPUT', args[2])
        self.assertEqual(args[3:5], ('same-model', 'custom-api'))
        self.assertTrue(options['conversation'])
        self.release.set()
        wait_for(lambda: self.bridge.title_renames.status(support.THREAD)['status'] == 'complete')
        self.assertEqual(self.renamed, ['完善聊天标题管理'])
        self.assertEqual(before, self.fixture.fixture.requests)
        self.assertNotIn('现在增加聊天重命名', self.bridge.auto_titles.path.read_text(encoding='utf-8'))

    def test_coalesced_request_remains_deduplicated_after_the_original_completes(self):
        self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
        self.assertTrue(self.started.wait(1))
        merged = str(uuid.uuid4())
        self.bridge.title_renames.start(support.THREAD, merged)
        self.release.set()
        wait_for(lambda: self.bridge.title_renames.status(support.THREAD)['status'] == 'complete')
        self.assertEqual(self.bridge.title_renames.start(support.THREAD, merged)['status'], 'complete')
        self.assertEqual(len(self.generated), 1)
        self.bridge.auto_titles.close()
        self.bridge.auto_titles = AutoTitles(self.bridge.data_dir)
        self.bridge.title_renames = TitleRenames(self.bridge)
        self.assertEqual(self.bridge.title_renames.start(support.THREAD, merged)['status'], 'complete')
        self.assertEqual(len(self.generated), 1)

    def test_manual_rename_wins_even_when_the_name_is_unchanged(self):
        self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
        self.assertTrue(self.started.wait(1))
        self.bridge.rename(support.THREAD, 'Desktop test')
        self.release.set()
        wait_for(lambda: not self.bridge.auto_titles.cancels)
        self.assertEqual(self.renamed, ['Desktop test'])
        self.assertEqual(self.bridge.title_renames.status(support.THREAD)['status'], 'manual')

    def test_later_explicit_request_can_replace_a_previous_ai_or_manual_title(self):
        self.release.set()
        for _ in range(2):
            self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
            wait_for(lambda: self.bridge.title_renames.status(support.THREAD)['status'] == 'complete')
        self.assertEqual(len(self.generated), 2)

    def test_empty_history_and_unsupported_hosts_do_not_generate(self):
        self.history['turns'] = []
        with self.assertRaises(ValueError):
            self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
        self.bridge.host = 'remote'
        with self.assertRaises(ValueError):
            self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
        self.assertEqual(self.generated, [])

    def test_unknown_result_never_replays_the_same_request(self):
        rid = str(uuid.uuid4())
        with patch('bridge.app.service.generate_title', side_effect=TimeoutError('private error')) as generate:
            self.bridge.title_renames.start(support.THREAD, rid)
            wait_for(lambda: self.bridge.title_renames.status(support.THREAD)['status'] == 'unknown')
            self.bridge.title_renames.start(support.THREAD, rid)
            self.assertEqual(generate.call_count, 1)
        self.assertEqual(self.renamed, [])

    def test_external_name_change_is_preserved(self):
        self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
        self.assertTrue(self.started.wait(1))
        original_get = self.bridge.store.get
        self.bridge.store.get = lambda identifier: {**original_get(identifier), 'name': '电脑上刚改的名字'}
        self.release.set()
        wait_for(lambda: self.bridge.title_renames.status(support.THREAD)['status'] == 'skipped')
        self.assertEqual(self.renamed, [])

    def test_reading_a_missing_request_never_reports_an_older_completed_job(self):
        self.release.set()
        self.bridge.title_renames.start(support.THREAD, str(uuid.uuid4()))
        wait_for(lambda: self.bridge.title_renames.status(support.THREAD)['status'] == 'complete')
        missing = str(uuid.uuid4())
        result = self.bridge.title_renames.status(support.THREAD, missing)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['requestId'], missing)

    def test_long_conversations_keep_initial_and_latest_topics_with_a_bounded_prompt(self):
        state = {**support.state(), 'turns': [{'items': [
            {'type': 'agentMessage', 'text': str(n) + '字' * 1990} for n in range(30)]}]}
        text = conversation_text(state)
        self.assertLessEqual(len(text), 12000)
        self.assertIn('0字', text)
        self.assertIn('29字', text)


class TitleRenameHttpTests(unittest.TestCase):
    setUpClass = classmethod(support.HttpTests.setUpClass.__func__)
    request = support.HttpTests.request
    login = support.HttpTests.login
    tearDown = support.HttpTests.tearDown

    def setUp(self):
        support.HttpTests.setUp(self)
        self.calls = []
        self.reads = []
        reads = self.reads
        self.server.bridge.title_renames = type('Titles', (), {'status': lambda _, identifier, request_id=None: reads.append((identifier, request_id)) or {'status': 'ready'}})()
        self.server.bridge.ai_rename = lambda identifier, rid: self.calls.append((identifier, rid)) or {'status': 'queued'}
        self.route = '/api/sessions/' + support.THREAD + '/ai-rename'

    def test_login_csrf_and_exact_body_are_required(self):
        rid = str(uuid.uuid4())
        self.assertEqual(self.request('GET', self.route)[0], 401)
        headers = self.login()
        self.assertEqual(self.request('GET', self.route, headers=headers)[2]['status'], 'ready')
        self.assertEqual(self.request('GET', self.route+'?requestId='+rid, headers=headers)[0], 200)
        self.assertEqual(self.reads[-1], (support.THREAD, rid))
        self.assertEqual(self.request('POST', self.route, {'id': rid}, {'Cookie': headers['Cookie']})[0], 403)
        self.assertEqual(self.request('POST', self.route, {'id': rid, 'text': 'caller prompt'}, headers)[0], 400)
        self.assertEqual(self.request('POST', self.route, {'id': rid}, headers)[2]['status'], 'queued')
        self.assertEqual(self.calls, [(support.THREAD, rid)])

    def test_relay_routes_are_exact(self):
        from relay.protocol import validate
        for method in ('GET', 'POST'):
            validate(method, self.route)
            with self.assertRaises((ValueError, PermissionError)):
                validate(method, self.route + '/extra')
