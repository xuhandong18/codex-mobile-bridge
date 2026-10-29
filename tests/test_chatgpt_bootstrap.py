"""The verification launcher never interrupts an existing desktop task."""
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bridge.clients.chatgpt.bootstrap import ProbeBlocked, launch_if_stopped, probe


class ChatGptBootstrapTests(unittest.TestCase):
    def setUp(self):
        self.exe, self.home = Path('C:/Apps/ChatGPT.exe'), Path.cwd()
        self.installation = SimpleNamespace(executable=self.exe, version='fixture')
        self.enterContext(patch('bridge.clients.chatgpt.bootstrap.inspect_installation', return_value=self.installation))
        self.launch = self.enterContext(patch('bridge.clients.chatgpt.bootstrap.DesktopApp.launch'))
        self.enterContext(patch('bridge.clients.chatgpt.bootstrap.choose_port', return_value=43871))
        self.context = self.enterContext(patch('bridge.clients.chatgpt.bootstrap.profile_context',
                                               return_value=('fixture-context', {'fixture-project'})))

    def test_running_or_unknown_process_inventory_blocks_launch(self):
        for value in ({'allPids': [42]}, {'allPids': None}, {}):
            with self.subTest(value=value), patch('bridge.clients.chatgpt.bootstrap.read_snapshot', return_value=value):
                with self.assertRaises(ProbeBlocked):
                    launch_if_stopped(self.exe, self.home)
        self.launch.assert_not_called()

    def test_stopped_application_gets_exact_debug_arguments_and_original_profile(self):
        with patch('bridge.clients.chatgpt.bootstrap.read_snapshot', return_value={'allPids': []}), \
             patch('bridge.clients.chatgpt.bootstrap.verify_debugger', return_value='verified'), \
             patch.dict(os.environ, {'ELECTRON_RUN_AS_NODE': '1'}):
            result = launch_if_stopped(self.exe, self.home)
        self.assertEqual(result, 'verified')
        kwargs = self.launch.call_args.kwargs
        self.assertEqual(kwargs['arguments'], ('--remote-debugging-port=43871', '--remote-debugging-address=127.0.0.1'))
        self.assertEqual(kwargs['env']['CODEX_HOME'], str(self.home.resolve()))
        self.assertNotIn('ELECTRON_RUN_AS_NODE', kwargs['env'])

    def test_startup_timeout_does_not_launch_again_or_stop_the_desktop(self):
        with patch('bridge.clients.chatgpt.bootstrap.read_snapshot', return_value={'allPids': []}), \
             patch('bridge.clients.chatgpt.bootstrap.verify_debugger', side_effect=ValueError('not listening')), \
             patch('bridge.clients.chatgpt.bootstrap.time.monotonic', side_effect=[0, 0, 30]), \
             patch('bridge.clients.chatgpt.bootstrap.time.sleep'):
            with self.assertRaises(ProbeBlocked):
                launch_if_stopped(self.exe, self.home, timeout=20)
        self.assertEqual(self.launch.call_count, 1)

    def test_a_directory_without_original_profile_context_does_not_start_a_new_environment(self):
        self.context.side_effect = ProbeBlocked('profile unknown')
        with patch('bridge.clients.chatgpt.bootstrap.read_snapshot', return_value={'allPids': []}):
            with self.assertRaises(ProbeBlocked):
                launch_if_stopped(self.exe, self.home)
        self.launch.assert_not_called()


class ChatGptRuntimeGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_profile_failure_blocks_cdp_before_evaluation(self):
        with patch('bridge.clients.chatgpt.bootstrap.inspect_installation'), \
             patch('bridge.clients.chatgpt.bootstrap.verify_profile', side_effect=ValueError('profile mismatch')), \
             patch('bridge.clients.chatgpt.bootstrap.ProbeConnection.connect', new_callable=AsyncMock) as connect:
            with self.assertRaises(ProbeBlocked):
                await probe(Path('ChatGPT.exe'), Path('profile'))
        connect.assert_not_called()

    async def test_a_cached_read_does_not_pass_the_fresh_background_read_gate(self):
        client = SimpleNamespace(snapshot=AsyncMock(return_value={
            'route': '/threads/another', 'thread': {'accountVerified': False}, 'scopeReady': True}),
            close=AsyncMock())
        binding = SimpleNamespace(port=43871)
        with patch('bridge.clients.chatgpt.bootstrap.inspect_installation', return_value=SimpleNamespace(version='fixture')), \
             patch('bridge.clients.chatgpt.bootstrap.verify_profile'), \
             patch('bridge.clients.chatgpt.bootstrap.existing_binding', return_value=binding), \
             patch('bridge.clients.chatgpt.bootstrap.verify_debugger', return_value=binding), \
             patch('bridge.clients.chatgpt.bootstrap.ProbeConnection.connect', new_callable=AsyncMock, return_value=client):
            value = await probe(Path('ChatGPT.exe'), Path('profile'), thread_id='fixture')
        self.assertFalse(value['runtimeGatePassed'])
        client.close.assert_awaited_once()

    async def test_only_a_fresh_read_of_another_chat_can_pass_the_runtime_gate(self):
        target = '00000000-0000-4000-8000-000000000001'
        client = SimpleNamespace(snapshot=AsyncMock(return_value={
            'route': '/threads/another', 'thread': {'accountVerified': True}}), close=AsyncMock())
        binding = SimpleNamespace(port=43871)
        with patch('bridge.clients.chatgpt.bootstrap.inspect_installation', return_value=SimpleNamespace(version='fixture')), \
             patch('bridge.clients.chatgpt.bootstrap.verify_profile'), \
             patch('bridge.clients.chatgpt.bootstrap.existing_binding', return_value=binding), \
             patch('bridge.clients.chatgpt.bootstrap.verify_debugger', return_value=binding), \
             patch('bridge.clients.chatgpt.bootstrap.ProbeConnection.connect', new_callable=AsyncMock, return_value=client):
            result = await probe(Path('ChatGPT.exe'), Path('profile'), thread_id=target, refresh=True)
            self.assertTrue(result['runtimeGatePassed'])
            client.snapshot.return_value['route'] = '/chatgpt/' + target
            result = await probe(Path('ChatGPT.exe'), Path('profile'), thread_id=target, refresh=True)
            self.assertFalse(result['runtimeGatePassed'])
        self.assertEqual(client.close.await_count, 2)

    async def test_snapshot_failure_closes_only_the_connector(self):
        client = SimpleNamespace(snapshot=AsyncMock(side_effect=ValueError('query failed')), close=AsyncMock())
        with patch('bridge.clients.chatgpt.bootstrap.inspect_installation'), \
             patch('bridge.clients.chatgpt.bootstrap.verify_profile'), \
             patch('bridge.clients.chatgpt.bootstrap.existing_binding'), \
             patch('bridge.clients.chatgpt.bootstrap.ProbeConnection.connect', new_callable=AsyncMock, return_value=client):
            with self.assertRaises(ValueError):
                await probe(Path('ChatGPT.exe'), Path('profile'))
        client.close.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
