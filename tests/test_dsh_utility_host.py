import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge.clients.lifecycle import _process_state


class DshUtilityHostTests(unittest.TestCase):
    def state(self, commands, provider='deepseek'):
        app = SimpleNamespace(home=Path('fixture-home'))
        with patch('bridge.clients.lifecycle.sys.platform', 'win32'):
            return _process_state({'id': provider}, app, list(commands), commands)

    def test_windows_isolated_node_host_is_runtime_candidate(self):
        result = self.state({
            11: '"F:\\DSH\\DSH Desktop\\DSH Desktop.exe"',
            12: '"F:\\DSH\\DSH Desktop\\DSH Desktop.exe" --type=utility '
                '--utility-sub-type=node.mojom.NodeService --service-sandbox-type=none',
            13: '"F:\\DSH\\DSH Desktop\\DSH Desktop.exe" --type=utility '
                '--utility-sub-type=network.mojom.NetworkService',
            14: '"F:\\DSH\\DSH Desktop\\DSH Desktop.exe" --type=renderer',
        })
        self.assertEqual(result['mainPids'], [11])
        self.assertEqual(result['runtimePids'], [12])
        self.assertFalse(result['unknown'])

    def test_utility_host_requires_shell_quit(self):
        result = self.state({11: 'DSH.exe', 12: 'DSH.exe --type=utility '
                             '--utility-sub-type=node.mojom.NodeService'})
        self.assertTrue(result.get('shellQuitRequired'))

    def test_multiple_node_hosts_remain_ambiguous(self):
        command = 'DSH.exe --type=utility --utility-sub-type=node.mojom.NodeService'
        result = self.state({11: 'DSH.exe', 12: command, 13: command})
        self.assertEqual(result['runtimePids'], [12, 13])
        self.assertTrue(result['unknown'])

    def test_other_clients_node_utilities_are_owner_managed_children(self):
        result = self.state({11: 'Claude.exe', 12: 'Claude.exe --type=utility '
                             '--utility-sub-type=node.mojom.NodeService'}, provider='claude')
        self.assertEqual(result['runtimePids'], [])
        self.assertFalse(result['unknown'])

    def test_utility_type_and_subtype_must_match_whole_arguments(self):
        for command in (
            'DSH.exe --type=renderer --utility-sub-type=node.mojom.NodeService',
            'DSH.exe --type=utility --utility-sub-type=node.mojom.NodeServiceOther',
            'DSH.exe --type=utilityOther --utility-sub-type=node.mojom.NodeService',
        ):
            with self.subTest(command=command):
                self.assertEqual(self.state({11: 'DSH.exe', 12: command})['runtimePids'], [])


class DshNativeQuitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.endpoint = {'pid': 12, 'port': 54321, 'generation': 'fixture-generation'}
        (self.directory/'endpoint.json').write_text(json.dumps(self.endpoint))
        self.state = {'running': True, 'pids': [11, 12], 'mainPids': [11],
                      'runtimePids': [12], 'unknown': False}
        self.status = {'connected': True, 'nativeQuit': True}
        self.adapter = Mock(directory=self.directory)
        self.adapter.call.side_effect = lambda action, **kwargs: (self.status if action == 'status' else
            {'status': 'accepted', 'pid': 12, 'generation': 'fixture-generation'})
        self.app = Mock()
        self.app.processes.side_effect = [[12], []]
        for name, value in [('inspect_client', self.state), ('_app', self.app)]:
            patcher = patch('bridge.clients.lifecycle.'+name, return_value=value)
            mocked = patcher.start(); self.addCleanup(patcher.stop)
            if name == 'inspect_client': self.inspect = mocked
        for name, value in [('sys.platform', 'win32'), ('time.sleep', Mock())]:
            patcher = patch('bridge.clients.lifecycle.'+name, value)
            patcher.start(); self.addCleanup(patcher.stop)

    def stop(self):
        from bridge.clients.lifecycle import stop_deepseek
        return stop_deepseek({'id': 'deepseek'}, self.adapter, state=self.state)

    def test_requests_native_shutdown_and_waits_for_observed_exit(self):
        self.stop()
        self.adapter.call.assert_any_call('quit', body={'expectedPid': 12,
                                                      'expectedGeneration': 'fixture-generation'})
        self.assertEqual(self.app.processes.call_count, 2)
        self.app.stop.assert_not_called()

    def test_utility_host_app_exit_must_not_leave_desktop_shell_running(self):
        self.assert_shell_quit(utility=True)

    def test_packaged_fork_host_also_requires_shell_quit(self):
        self.assert_shell_quit(utility=False)

    def assert_shell_quit(self, *, utility):
        # In current Harness, appExit tears down only the utility Host's profile.
        # The shell stays open, so accepting that request leads to the reported timeout.
        if utility:
            self.state['shellQuitRequired'] = True
        self.app.processes.side_effect = None
        self.app.processes.return_value = [11, 12]
        self.adapter.call.side_effect = lambda action, **kwargs: (
            self.status if action == 'status' else
            {'bridgeRevision': 5, 'complete': True, 'sessions': []} if action == 'lifecycle' else
            {'status': 'accepted', 'pid': 12, 'generation': 'fixture-generation'})
        def exit_shell(*args, **kwargs):
            self.app.processes.return_value = []
        with patch('bridge.platforms.windows.dsh_quit.request_desktop_quit',
                   side_effect=exit_shell) as quit_shell, \
                patch('bridge.platforms.windows.dsh_quit.desktop_quit_required', return_value=not utility), \
                patch('bridge.clients.lifecycle.time.monotonic', side_effect=[0, 30]):
            self.stop()
        quit_shell.assert_called_once()
        self.assertNotIn('quit', [call.args[0] for call in self.adapter.call.call_args_list])
        self.app.stop.assert_not_called()

    def test_shell_quit_requires_fresh_complete_idle_tasks(self):
        self.state['shellQuitRequired'] = True
        for runtime in (
            {'bridgeRevision': 5, 'complete': False, 'sessions': []},
            {'bridgeRevision': 999, 'complete': True, 'sessions': []},
            {'bridgeRevision': 5, 'complete': True, 'sessions': [
                {'status': 'active', 'runtimeKnown': True, 'requests': []}]},
            {'bridgeRevision': 5, 'complete': True, 'sessions': [
                {'status': 'idle', 'runtimeKnown': True, 'requests': [{'id': 'confirmation'}]}]},
        ):
            self.adapter.call.side_effect = [self.status, runtime]
            with self.subTest(runtime=runtime), \
                    patch('bridge.platforms.windows.dsh_quit.request_desktop_quit') as quit_shell:
                with self.assertRaisesRegex(ValueError, '任务运行'):
                    self.stop()
                quit_shell.assert_not_called()

    def test_shell_quit_refuses_replaced_endpoint(self):
        self.state['shellQuitRequired'] = True
        def response(action, **kwargs):
            if action == 'status':
                return self.status
            (self.directory/'endpoint.json').write_text(json.dumps({**self.endpoint, 'generation': 'replacement'}))
            return {'bridgeRevision': 5, 'complete': True, 'sessions': []}
        self.adapter.call.side_effect = response
        with patch('bridge.platforms.windows.dsh_quit.request_desktop_quit') as quit_shell:
            with self.assertRaisesRegex(ValueError, '进程已变化'):
                self.stop()
            quit_shell.assert_not_called()

    def test_disconnected_fork_host_explicit_quit_defers_to_shell_confirmation(self):
        from bridge.clients.lifecycle import stop_deepseek
        (self.directory/'endpoint.json').unlink()
        self.adapter.call.side_effect = AssertionError('native confirmation must not need the disposed connector')
        with patch('bridge.platforms.windows.dsh_quit.desktop_quit_required', return_value=True), \
                patch('bridge.platforms.windows.dsh_quit.request_desktop_quit') as quit_shell:
            stop_deepseek({'id': 'deepseek'}, self.adapter, state=self.state, native_confirmation=True)
        quit_shell.assert_called_once()
        self.adapter.call.assert_not_called()
        self.app.stop.assert_not_called()

    def test_disconnected_utility_candidate_cannot_bypass_profile_verification(self):
        from bridge.clients.lifecycle import stop_deepseek
        self.state['shellQuitRequired'] = True
        with patch('bridge.platforms.windows.dsh_quit.desktop_quit_required', return_value=True), \
                patch('bridge.platforms.windows.dsh_quit.request_desktop_quit') as quit_shell:
            with self.assertRaisesRegex(ValueError, '进程已变化'):
                stop_deepseek({'id': 'deepseek'}, self.adapter, state=self.state, native_confirmation=True)
        quit_shell.assert_not_called()

    def test_old_plugin_does_not_fall_back_to_process_termination(self):
        self.status.pop('nativeQuit')
        with patch('bridge.platforms.windows.dsh_quit.installer_quit_command', side_effect=ValueError('无后台退出通道')), \
                patch('bridge.clients.lifecycle._commands', return_value={}):
            with self.assertRaisesRegex(ValueError, '后台退出通道'):
                self.stop()
        self.assertEqual(self.adapter.call.call_count, 1)
        self.app.stop.assert_not_called()

    def test_legacy_plugin_uses_supported_installer_handoff_after_idle_check(self):
        self.status.pop('nativeQuit')
        self.adapter.call.side_effect = [self.status, {'bridgeRevision': 3, 'complete': True,
                                                     'sessions': [{'status': 'idle', 'runtimeKnown': True, 'requests': []}]}]
        command = ['fixture.exe', '--dsh-installer-quit']
        with patch('bridge.platforms.windows.dsh_quit.installer_quit_command', return_value=command), \
                patch('bridge.platforms.windows.dsh_quit.send_installer_quit') as send, \
                patch('bridge.clients.lifecycle._commands', return_value={}):
            self.stop()
        send.assert_called_once_with(command)
        self.assertEqual([call.args[0] for call in self.adapter.call.call_args_list], ['status', 'lifecycle'])
        self.app.stop.assert_not_called()

    def test_legacy_handoff_rechecks_tasks_and_endpoint_before_sending(self):
        self.status.pop('nativeQuit')
        for busy in (True, False):
            def response(action, **kwargs):
                if action == 'status': return self.status
                if not busy:
                    (self.directory/'endpoint.json').write_text(json.dumps({**self.endpoint, 'generation': 'changed'}))
                return {'bridgeRevision': 3, 'complete': True, 'sessions': [
                    {'status': 'active' if busy else 'idle', 'runtimeKnown': True, 'requests': []}]}
            self.adapter.call.side_effect = response
            with self.subTest(busy=busy), \
                    patch('bridge.platforms.windows.dsh_quit.installer_quit_command', return_value=['fixture.exe']), \
                    patch('bridge.platforms.windows.dsh_quit.send_installer_quit') as send, \
                    patch('bridge.clients.lifecycle._commands', return_value={}):
                with self.assertRaises(ValueError): self.stop()
                send.assert_not_called()

    def test_replaced_endpoint_never_receives_quit(self):
        (self.directory/'endpoint.json').write_text(json.dumps({**self.endpoint, 'pid': 99}))
        with self.assertRaisesRegex(ValueError, '进程已变化'):
            self.stop()
        self.assertEqual(self.adapter.call.call_count, 1)

    def test_new_process_before_request_is_rejected(self):
        self.inspect.side_effect = [self.state, {**self.state, 'pids': [11, 12, 13]}]
        with self.assertRaisesRegex(ValueError, '进程已变化'):
            self.stop()
        self.assertEqual(self.adapter.call.call_count, 1)

    def test_unconfirmed_native_response_does_not_report_success(self):
        self.adapter.call.side_effect = [self.status, {'status': 'accepted', 'pid': 99}]
        with self.assertRaisesRegex(ValueError, '确认退出'):
            self.stop()
        self.app.processes.assert_not_called()

    def test_native_shutdown_timeout_does_not_terminate_processes(self):
        self.app.processes.side_effect = None
        self.app.processes.return_value = [11, 12]
        with patch('bridge.clients.lifecycle.time.monotonic', side_effect=[0, 30]):
            with self.assertRaisesRegex(ValueError, '尚未退出'):
                self.stop()
        self.app.stop.assert_not_called()


if __name__ == '__main__':
    unittest.main()
