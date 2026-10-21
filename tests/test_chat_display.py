"""Shared display preferences never activate a native conversation."""
import tempfile
import unittest
from pathlib import Path

import test_bridge
from bridge.features.sessions.chat_display import ChatDisplaySettings
from relay.protocol import validate


class ChatDisplayTests(unittest.TestCase):
    def test_partial_updates_survive_restart_and_stale_devices_cannot_overwrite(self):
        temporary = Path(__file__).parents[1] / '.tmp'
        temporary.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary) as directory:
            store = ChatDisplaySettings(directory)
            self.assertEqual(store.read(), {'revision': 0, 'settings': {}})
            status, saved = store.save({'revision': 0, 'changes': {'showProcess': False}})
            self.assertEqual(status, 200)
            self.assertEqual(ChatDisplaySettings(directory).read(), saved)
            self.assertEqual(store.save({'revision': 0, 'changes': {'showProcess': True}})[0], 409)
            status, saved = store.save({'revision': 1, 'changes': {'showReasoning': False}})
            self.assertEqual(saved['settings'], {'showProcess': False, 'showReasoning': False})
            self.assertEqual(status, 200)

    def test_only_boolean_display_fields_and_valid_revisions_are_accepted(self):
        store = ChatDisplaySettings(None)
        for body in ({}, {'revision': True, 'changes': {'showProcess': False}},
                     {'revision': 0, 'changes': {}}, {'revision': 0, 'changes': {'showProcess': 0}},
                     {'revision': 0, 'changes': {'theme': 'dark'}},
                     {'revision': -1, 'changes': {'showProcess': False}}):
            with self.subTest(body=body), self.assertRaises(ValueError):
                store.save(body)
        self.assertEqual(store.read()['revision'], 0)


class ChatDisplayHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    setUp = test_bridge.HttpTests.setUp
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_computer_setting_reaches_phone_and_authenticated_bootstrap(self):
        computer, phone = self.login(), self.login()
        status, _, saved = self.request('POST', '/api/chat-display',
                                       {'revision': 0, 'changes': {'showProcess': False}}, computer)
        self.assertEqual(status, 200)
        self.assertEqual(self.request('GET', '/api/chat-display', headers=phone)[2], saved)
        self.assertEqual(self.request('GET', '/api/auth', headers=phone)[2]['chatDisplay'], saved)
        self.assertNotIn('chatDisplay', self.request('GET', '/api/auth')[2])
        self.assertFalse(hasattr(self.server.bridge, 'last_list'))

    def test_login_origin_and_csrf_are_still_required(self):
        body = {'revision': 0, 'changes': {'showProcess': False}}
        self.assertEqual(self.request('GET', '/api/chat-display')[0], 401)
        headers = self.login()
        self.assertEqual(self.request('POST', '/api/chat-display', body,
                                      {'Cookie': headers['Cookie']})[0], 403)
        self.assertEqual(self.request('POST', '/api/chat-display', body,
                                      {**headers, 'Origin': 'https://foreign.example'})[0], 403)
        self.assertEqual(self.server.chat_display.read()['settings'], {})

    def test_shared_listener_and_relay_use_exact_display_endpoint(self):
        from bridge.api.httpd import GatewayServer
        listener = GatewayServer(('127.0.0.1', 0), None, {}, Path(__file__).parents[1] / 'web', shared=self.server)
        self.assertIs(listener.chat_display, self.server.chat_display)
        listener.server_close()
        validate('GET', '/api/chat-display')
        validate('POST', '/api/chat-display', 100)
        with self.assertRaises(PermissionError):
            validate('POST', '/api/chat-display/extra', 100)


if __name__ == '__main__':
    unittest.main()
