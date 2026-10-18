import concurrent.futures
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

from bridge.features.sessions.answer_drafts import AnswerDrafts
from bridge.features.sessions.model import normalize_request
from relay.protocol import validate
import test_bridge


ROOT = Path(__file__).resolve().parents[1]
SCOPE = json.dumps(['codex', 'local', 'main', 'chat-a', 'tool/requestUserInput', 7])
VALUE = [{'value': '手机上的回答', 'checked': False}]


class DraftStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.tmp')
        self.store = AnswerDrafts(self.temp.name)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def save(self, field='q1', value=None, version=0, scope=SCOPE):
        return self.store.save({'scope': scope, 'field': field, 'value': VALUE if value is None else value, 'version': version})

    def test_partial_answers_survive_restart_and_another_reader(self):
        self.assertEqual(self.save()[0], 200)
        self.assertEqual(self.save('q2', [{'value': '选项二', 'checked': True}])[0], 200)
        self.store.close()
        self.store = AnswerDrafts(self.temp.name)
        fields = self.store.read(SCOPE)['fields']
        self.assertEqual(fields['q1']['value'], VALUE)
        self.assertEqual(fields['q2']['value'][0]['value'], '选项二')
        self.assertNotIn('q3', fields)

    def test_stale_device_cannot_overwrite_newer_answer(self):
        self.save()
        status, _ = self.save(value=[{'value': '过期设备的回答', 'checked': False}])
        self.assertEqual(status, 409)
        self.assertEqual(self.store.read(SCOPE)['fields']['q1']['value'], VALUE)
        self.assertEqual(self.save(value=[{'value': '', 'checked': False}], version=1)[0], 200)
        self.assertEqual(self.store.read(SCOPE)['fields']['q1']['value'][0]['value'], '')

    def test_independent_questions_merge_and_same_question_has_one_winner(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda i: self.save(str(i)), range(8)))
            same = list(pool.map(lambda i: self.save('same'), range(8)))
        self.assertTrue(all(status == 200 for status, _ in results))
        self.assertEqual(sum(status == 200 for status, _ in same), 1)
        self.assertEqual(len(self.store.read(SCOPE)['fields']), 9)

    def test_scope_and_question_schema_are_isolated(self):
        self.save('question-v1')
        for index, replacement in [(0, 'claude'), (1, 'ssh-host'), (2, 'side'), (3, 'chat-b'), (5, 8)]:
            scope = json.loads(SCOPE)
            scope[index] = replacement
            self.assertEqual(self.store.read(json.dumps(scope))['fields'], {})
        self.assertNotIn('question-v2', self.store.read(SCOPE)['fields'])

    def test_native_turn_and_item_identity_reach_the_draft_scope(self):
        for method in ['item/tool/requestUserInput', 'tool/requestUserInput']:
            request = normalize_request({'id': 1, 'method': method,
                                         'params': {'turnId': 'turn-a', 'itemId': 'item-a', 'questions': []}})
            self.assertEqual(request['params']['turnId'], 'turn-a')
            self.assertEqual(request['params']['itemId'], 'item-a')

    def test_invalid_or_excessive_data_is_rejected(self):
        for value in [None, {}, ['text'], [{'value': 1, 'checked': False}], [{'value': 'x', 'checked': 1}],
                      [{'value': 'x' * 65536, 'checked': False}]]:
            with self.subTest(value_type=type(value).__name__), self.assertRaises(ValueError):
                self.store.save({'scope': SCOPE, 'field': 'q', 'value': value, 'version': 0})
        for version in [-1, True, '0', 2 ** 53]:
            with self.assertRaises(ValueError):
                self.save(version=version)
        self.store.MAX_FIELDS = 1
        self.save()
        with self.assertRaises(ValueError):
            self.save('another')


class DraftHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    setUp = test_bridge.HttpTests.setUp
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_shared_listener_uses_the_same_store_and_does_not_close_it(self):
        from bridge.api.httpd import GatewayServer
        listener = GatewayServer(('127.0.0.1', 0), None, {}, ROOT / 'web', shared=self.server)
        self.assertIs(listener.answer_drafts, self.server.answer_drafts)
        listener.server_close()
        self.assertEqual(self.server.answer_drafts.read(SCOPE), {'fields': {}})

    def test_two_authenticated_devices_share_drafts_without_touching_native_clients(self):
        phone, tablet = self.login(), self.login()
        body = {'scope': SCOPE, 'field': 'q1', 'value': VALUE, 'version': 0}
        self.assertEqual(self.request('POST', '/api/answer-drafts', body, phone)[0], 200)
        status, _, result = self.request('GET', '/api/answer-drafts?scope=' + quote(SCOPE), headers=tablet)
        self.assertEqual(status, 200)
        self.assertEqual(result['fields']['q1']['value'], VALUE)
        self.assertEqual(self.request('POST', '/api/answer-drafts', body, tablet)[0], 409)
        # EmptyBridge has no session/respond methods: drafts must not call them.

    def test_auth_csrf_origin_and_validation_are_required(self):
        path = '/api/answer-drafts?scope=' + quote(SCOPE)
        self.assertEqual(self.request('GET', path)[0], 401)
        headers = self.login()
        body = {'scope': SCOPE, 'field': 'q1', 'value': VALUE, 'version': 0}
        self.assertEqual(self.request('POST', '/api/answer-drafts', body, {'Cookie': headers['Cookie']})[0], 403)
        self.assertEqual(self.request('POST', '/api/answer-drafts', body, {**headers, 'Origin': 'https://invalid.example'})[0], 403)
        self.assertEqual(self.request('POST', '/api/answer-drafts', {**body, 'action': 'respond'}, headers)[0], 400)
        validate('GET', path)
        validate('POST', '/api/answer-drafts', 200)
        for method, url in [('DELETE', '/api/answer-drafts'), ('POST', '/api/answer-drafts/anything')]:
            with self.assertRaises((ValueError, PermissionError)):
                validate(method, url)
