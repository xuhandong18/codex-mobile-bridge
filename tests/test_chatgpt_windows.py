"""A debugger listener is useful only when it belongs to the selected desktop."""
import copy
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.platforms.windows.chatgpt import DebuggerUnavailable, validate_snapshot, verify_debugger
from bridge.platforms.windows.discovery_ext import launch_windows_desktop


class ChatGptEndpointTests(unittest.TestCase):
    def setUp(self):
        self.exe = Path('C:/Apps/ChatGPT.exe').resolve()
        self.snapshot = {'currentSession': 2, 'currentUser': 'S-fixture', 'processes': [
            {'pid': 42, 'executable': str(self.exe), 'session': 2, 'user': 'S-fixture',
             'startedAt': '2026-10-29T00:00:00Z', 'commandKnown': True, 'port': 43871}],
            'listeners': [{'pid': 42, 'address': '127.0.0.1', 'port': 43871}]}

    def test_returns_a_binding_to_the_exact_process_instance(self):
        binding = validate_snapshot(self.snapshot, self.exe, port=43871)
        self.assertEqual(binding.pid, 42)
        self.assertEqual(binding.started_at, '2026-10-29T00:00:00Z')

    def test_subsequent_verification_reads_the_bound_process_again(self):
        binding = validate_snapshot(self.snapshot, self.exe, port=43871)
        with patch('bridge.platforms.windows.chatgpt.read_snapshot', return_value=self.snapshot) as read:
            self.assertEqual(verify_debugger(self.exe, 43871, expected=binding), binding)
        read.assert_called_once_with(self.exe, port=43871, pid=binding.pid)

    def test_wrong_process_account_session_or_missing_command_is_rejected(self):
        for changes in ({'executable': str(self.exe.parent / 'other.exe')}, {'session': 3},
                        {'user': 'S-other'}, {'commandKnown': False}, {'startedAt': ''}):
            with self.subTest(changes=changes):
                value = copy.deepcopy(self.snapshot)
                value['processes'][0].update(changes)
                with self.assertRaises(DebuggerUnavailable):
                    validate_snapshot(value, self.exe, port=43871)

    def test_public_or_wrong_owner_or_ambiguous_listener_is_rejected(self):
        for listener in ({'address': '0.0.0.0'}, {'address': '::'}, {'pid': 999}):
            with self.subTest(listener=listener):
                value = copy.deepcopy(self.snapshot)
                value['listeners'][0].update(listener)
                with self.assertRaises(DebuggerUnavailable):
                    validate_snapshot(value, self.exe, port=43871)

    def test_a_public_listener_cannot_be_hidden_by_a_valid_loopback_listener(self):
        self.snapshot['listeners'].append({'pid': 42, 'address': '0.0.0.0', 'port': 43871})
        with self.assertRaises(DebuggerUnavailable):
            validate_snapshot(self.snapshot, self.exe, port=43871)

    def test_multiple_main_processes_or_stale_process_identity_is_rejected(self):
        binding = validate_snapshot(self.snapshot, self.exe, port=43871)
        self.snapshot['processes'][0]['startedAt'] = 'changed'
        with self.assertRaises(DebuggerUnavailable):
            validate_snapshot(self.snapshot, self.exe, port=43871, expected=binding)
        self.snapshot['processes'].append(dict(self.snapshot['processes'][0], pid=43))
        with self.assertRaises(DebuggerUnavailable):
            validate_snapshot(self.snapshot, self.exe, port=43871)

    def test_missing_debug_switch_or_listener_does_not_claim_ready(self):
        for changes in ({'listeners': []}, {'processes': []}):
            with self.subTest(changes=changes):
                with self.assertRaises(DebuggerUnavailable):
                    validate_snapshot({**self.snapshot, **changes}, self.exe, port=43871)
        self.snapshot['processes'][0]['port'] = None
        with self.assertRaises(DebuggerUnavailable):
            validate_snapshot(self.snapshot, self.exe, port=43871)


class ArgumentPreservingLaunchTests(unittest.TestCase):
    def test_direct_launch_keeps_arguments_as_arguments(self):
        arguments = ('--remote-debugging-port=43871', '--remote-debugging-address=127.0.0.1')
        with patch('bridge.platforms.windows.discovery_ext.subprocess.Popen') as spawn:
            launch_windows_desktop(Path('C:/Apps/ChatGPT.exe'), arguments=arguments, cwd='C:/profile')
        self.assertEqual(spawn.call_args.args[0], [str(Path('C:/Apps/ChatGPT.exe')), *arguments])
        self.assertNotIn('arguments', spawn.call_args.kwargs)

    def test_store_argument_launch_uses_native_activation_and_never_explorer(self):
        denied = OSError('denied'); denied.winerror = 5
        with patch('bridge.platforms.windows.discovery_ext.subprocess.Popen', side_effect=denied) as spawn, \
             patch('bridge.platforms.windows.discovery_ext.application_user_model_id', return_value='Fixture!App'), \
             patch('bridge.platforms.windows.app_activation.activate_application', return_value=123) as activate:
            result = launch_windows_desktop(Path('C:/Apps/ChatGPT.exe'), arguments=('--fixture',))
        self.assertEqual(result.pid, 123)
        activate.assert_called_once_with('Fixture!App', ('--fixture',))
        self.assertEqual(spawn.call_count, 1)

    def test_store_activation_failure_is_not_retried_without_arguments(self):
        denied = OSError('denied'); denied.winerror = 5
        with patch('bridge.platforms.windows.discovery_ext.subprocess.Popen', side_effect=denied) as spawn, \
             patch('bridge.platforms.windows.discovery_ext.application_user_model_id', return_value='Fixture!App'), \
             patch('bridge.platforms.windows.app_activation.activate_application', side_effect=OSError('unconfirmed')):
            with self.assertRaisesRegex(OSError, 'unconfirmed'):
                launch_windows_desktop(Path('C:/Apps/ChatGPT.exe'), arguments=('--fixture',))
        self.assertEqual(spawn.call_count, 1)


if __name__ == '__main__':
    unittest.main()
