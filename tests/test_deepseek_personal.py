import json
import tempfile
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

import test_bridge
from bridge.clients.manager import DesktopSessions
from bridge.clients.deepseek.adapter import transcript_turns, side_request
from bridge.features.sessions.projects import SelectedDirectories
from relay.protocol import validate

ROOT = Path(__file__).resolve().parents[1]


class PersonalStateTests(unittest.TestCase):
    def test_invalid_side_send_is_refused_before_native_dispatch(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            manager = DesktopSessions(directory)
            adapter = Mock(); manager.adapters['deepseek'] = adapter
            try:
                for payload in ({'text': ''}, {'text': 'x'*20001}, {'text': 'hello', 'mode': 'unsupported'}, {'text': None}):
                    with self.assertRaises(ValueError):
                        manager.call('deepseek', 'side-write', 'parent', {'id': str(uuid.uuid4()), 'operation': 'send', **payload})
                adapter.call.assert_not_called()
            finally:
                manager.close()

    def test_side_mutations_keep_at_most_once_receipts_across_gateway_restart(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            manager = DesktopSessions(directory)
            adapter = Mock(); adapter.call.side_effect = TimeoutError('accepted but disconnected')
            manager.adapters['deepseek'] = adapter
            request = {'id': str(uuid.uuid4()), 'operation': 'create', 'slot': str(uuid.uuid4())}
            try:
                result = manager.call('deepseek', 'side-write', 'native-parent', request)
                self.assertEqual(result['status'], 'unknown')
                self.assertEqual(manager.call('deepseek', 'side-write', 'native-parent', request), result)
                self.assertEqual(adapter.call.call_count, 1)
                with self.assertRaises(ValueError):
                    manager.call('deepseek', 'side-write', 'other-parent', request)
            finally:
                manager.close()
            reopened = DesktopSessions(directory)
            try:
                other = Mock(); reopened.adapters['deepseek'] = other
                self.assertEqual(reopened.call('deepseek', 'side-write', 'native-parent', request), result)
                other.call.assert_not_called()
            finally:
                reopened.close()

    def test_folder_creation_requires_a_live_selection_owned_by_the_login(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            root = Path(directory); folders = SelectedDirectories(root)
            selection = folders.browse(str(root), 'phone')['selectionId']
            request = {'id': str(uuid.uuid4()), 'parent': str(root), 'name': '新建项目', 'selectionId': selection}
            with self.assertRaises(PermissionError): folders.submit_directory(request, 'other-phone')
            with self.assertRaises(PermissionError): folders.submit_directory({key: value for key, value in request.items() if key != 'selectionId'}, 'phone')
            receipt = folders.submit_directory(request, 'phone')
            for _ in range(100):
                receipt = folders.directory_operation(request['id'], 'phone')
                if receipt['status'] not in ('pending', 'creating'): break
                time.sleep(.01)
            self.assertEqual(receipt['status'], 'completed', receipt)
            self.assertTrue((root/'新建项目').is_dir())
            self.assertEqual(folders.submit_directory(request, 'phone'), receipt)
            with self.assertRaises(PermissionError): folders.directory_operation(request['id'], 'other-phone')
            with self.assertRaises(ValueError): folders.submit_directory({**request, 'id': str(uuid.uuid4()), 'name': '../escape'}, 'phone')

    def test_native_history_keeps_turn_end_evidence_and_only_public_records(self):
        records = [{'event': {'seq': seq, 'type': kind, 'data': data}} for seq, kind, data in [
            (1, 'turn/start', {'turn': 1}), (2, 'request/header', {'apiKey': 'never display'}),
            (3, 'assistant/message', {'content': [{'type': 'text', 'text': 'answer'}]}),
            (4, 'turn/end', {'turn': 1, 'reason': {'kind': 'completed'}}),
            (5, 'turn/start', {'turn': 2})]]
        result = transcript_turns(records)
        self.assertEqual([turn['status'] for turn in result], ['completed', 'inProgress'])
        self.assertEqual(result[0]['messages'][0]['text'], 'answer')
        self.assertNotIn('never display', json.dumps(result))
        request = side_request({'id': 'native-question', 'needsInput': True, 'input': {'questions': [{'id': 'q', 'question': 'Choose'}]}})
        self.assertEqual(request['method'], 'tool/requestUserInput')
        self.assertEqual(request['params']['questions'][0]['id'], 'q')

    def test_relay_exposes_only_explicit_harness_feature_routes(self):
        for method, action in [('GET', 'side-chat'), ('POST', 'side-chat'), ('GET', 'subagents'),
                               ('POST', 'manage'), ('GET', 'project-directories'), ('POST', 'project-directories'),
                               ('GET', 'project-directory-operations')]:
            validate(method, '/api/desktop-sessions/deepseek/'+action)
        for method, action in [('GET', 'manage'), ('POST', 'subagents'), ('POST', 'project-directory-operations'),
                               ('GET', 'side-read'), ('POST', 'side-write'), ('POST', 'eval')]:
            with self.assertRaises(PermissionError): validate(method, '/api/desktop-sessions/deepseek/'+action)
        with self.assertRaises(PermissionError): validate('POST', '/api/desktop-sessions/claude/manage')


class PersonalHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    setUp = test_bridge.HttpTests.setUp
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_side_routes_require_auth_csrf_and_preserve_parent_child_slot_and_receipt(self):
        manager = self.server.desktop_sessions = Mock()
        manager.call.return_value = {'id': 'native-child', 'status': 'idle', 'connected': True}
        route = '/api/desktop-sessions/deepseek/side-chat?sessionId=native-parent&slot='+str(uuid.uuid4())
        self.assertEqual(self.request('GET', route)[0], 401)
        headers = self.login()
        self.assertEqual(self.request('GET', route, headers=headers)[0], 200)
        manager.call.assert_called_with('deepseek', 'side-read', 'native-parent', {'operation': 'read', 'childId': None, 'slot': route.split('slot=')[1]})
        rid = str(uuid.uuid4()); body = {'action': 'rename', 'id': 'native-child', 'title': '同步名称', 'operationId': rid}
        self.assertEqual(self.request('POST', route, body, {'Cookie': headers['Cookie']})[0], 403)
        self.assertEqual(self.request('POST', route, body, headers)[0], 200)
        args = manager.call.call_args.args
        self.assertEqual(args[:3], ('deepseek', 'side-write', 'native-parent'))
        self.assertEqual(args[3]['id'], rid); self.assertEqual(args[3]['childId'], 'native-child')
        self.assertEqual(self.request('POST', route, {**body, 'resolvedImages': [{'url': 'data:secret'}]}, headers)[0], 400)

    def test_project_and_subagent_routes_keep_write_and_read_boundaries(self):
        manager = self.server.desktop_sessions = Mock(); manager.call.return_value = {'status': 'accepted'}
        headers = self.login(); rid = str(uuid.uuid4())
        route = '/api/desktop-sessions/deepseek/manage'
        self.assertEqual(self.request('GET', route, headers=headers)[0], 404)
        self.assertEqual(self.request('POST', route, {'id': rid, 'operation': 'section-create', 'title': '工作'}, headers)[0], 200)
        manager.call.assert_called_with('deepseek', 'manage', None, {'id': rid, 'operation': 'section-create', 'title': '工作'})
        self.assertEqual(self.request('GET', '/api/desktop-sessions/deepseek/subagents?sessionId=parent&childId=child', headers=headers)[0], 200)
        manager.call.assert_called_with('deepseek', 'subagents', 'parent', {'childId': 'child'})
