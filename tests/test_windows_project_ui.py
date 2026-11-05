import json
import queue
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge.platforms.windows.projects import create_project, edit_project, watch_project_trust, ProjectUIError


class WindowsProjectUITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.helper = self.root/'helper.exe'; self.helper.touch()
        self.project = {'projectId':'native-id','label':'Test','path':str(self.root)}
        self.snapshot = {'main':123,'pids':{123},'created':1234567890}
        self.patches = [patch('bridge.platforms.windows.projects.helper_path',return_value=self.helper),
            patch('bridge.platforms.windows.projects._snapshot',return_value=self.snapshot),
            patch.object(subprocess,'CREATE_NO_WINDOW',0,create=True)]
        for item in self.patches:
            item.start();self.addCleanup(item.stop)

    def test_verified_helper_receipt_does_not_claim_that_metadata_readback_completed(self):
        result=SimpleNamespace(returncode=0,stdout='{"phase":"dispatching","pid":123}\n{"phase":"submitted","pid":123}\n')
        with patch('bridge.platforms.windows.projects.subprocess.run',return_value=result) as run:
            self.assertEqual(edit_project(self.root/'Codex.exe','rename',self.project,'Changed'),{'submitted':True})
        payload=__import__('json').loads(run.call_args.kwargs['input'])
        self.assertEqual(payload['name'],'Test');self.assertEqual(payload['newName'],'Changed')
        self.assertNotIn('script',payload)

    def test_identity_change_blocks_helper_before_any_native_input(self):
        changed={**self.snapshot,'created':9876543210}
        with patch('bridge.platforms.windows.projects._snapshot',side_effect=[self.snapshot,changed]), \
             patch('bridge.platforms.windows.projects.subprocess.run') as run:
            with self.assertRaises(ValueError):edit_project(self.root/'Codex.exe','delete',self.project)
        run.assert_not_called()

    def test_create_submits_exact_directory_to_guarded_native_dialog(self):
        result = SimpleNamespace(returncode=0,stdout='{"phase":"submitted","pid":123}\n')
        with patch('bridge.platforms.windows.projects.subprocess.run', return_value=result) as run:
            self.assertEqual(create_project(self.root/'Codex.exe', 'New project', str(self.root)), {'submitted':True})
        payload = __import__('json').loads(run.call_args.kwargs['input'])
        self.assertEqual(payload['action'], 'create')
        self.assertEqual(payload['path'], str(self.root.resolve()))
        self.assertEqual(payload['name'], 'New project')
        self.assertEqual(payload['pid'], 123)
        self.assertEqual(payload['created'], self.snapshot['created'])

    def test_create_invalid_directory_and_name_never_touch_native_ui(self):
        with patch('bridge.platforms.windows.projects.subprocess.run') as run:
            for name, directory in [('Test', self.root/'missing'), ('Test', 'relative'), ('',self.root), ('Bad\nName',self.root)]:
                with self.subTest(name=name, directory=directory), self.assertRaises(ProjectUIError):
                    create_project(self.root/'Codex.exe', name, directory)
        run.assert_not_called()

    def test_create_rejected_before_dispatch_is_safe_but_dispatch_timeout_is_unknown(self):
        result = SimpleNamespace(returncode=1, stdout='{"phase":"failed","pid":123,"error":"dialog already open"}\n')
        with patch('bridge.platforms.windows.projects.subprocess.run', return_value=result):
            with self.assertRaises(ProjectUIError) as caught:
                create_project(self.root/'Codex.exe', 'New', self.root)
        self.assertFalse(caught.exception.unknown)
        with patch('bridge.platforms.windows.projects.subprocess.run', side_effect=subprocess.TimeoutExpired('helper',60)):
            with self.assertRaises(ProjectUIError) as caught:
                create_project(self.root/'Codex.exe', 'New', self.root)
        self.assertTrue(caught.exception.unknown)

    def test_dispatch_followed_by_failure_is_unknown_not_retryable(self):
        result=SimpleNamespace(returncode=1,stdout='{"phase":"dispatching","pid":123}\n{"phase":"unknown","pid":123,"error":"interrupted"}\n')
        with patch('bridge.platforms.windows.projects.subprocess.run',return_value=result):
            with self.assertRaises(ProjectUIError) as caught:edit_project(self.root/'Codex.exe','delete',self.project)
        self.assertTrue(caught.exception.unknown)

    def test_timeout_never_implies_it_is_safe_to_replay_the_metadata_write(self):
        with patch('bridge.platforms.windows.projects.subprocess.run',side_effect=subprocess.TimeoutExpired('helper',10)):
            with self.assertRaises(ProjectUIError) as caught:edit_project(self.root/'Codex.exe','rename',self.project,'Changed')
        self.assertTrue(caught.exception.unknown)

    def test_actions_outside_project_metadata_are_rejected(self):
        with patch('bridge.platforms.windows.projects.subprocess.run') as run:
            with self.assertRaises(ProjectUIError):edit_project(self.root/'Codex.exe','delete-files',self.project)
        run.assert_not_called()


class TrustListenerProcess:
    """A line-protocol child; no real window or subprocess is used."""
    def __init__(self, initial='ready', events=(), mismatch=False, hung=False):
        self.lines = queue.Queue()
        self.sent = []
        self.payload = None
        self.closed = False
        self.killed = False
        self.hung = hung
        self.initial, self.events, self.mismatch = initial, events, mismatch
        self.stdin = SimpleNamespace(write=self.write, flush=lambda:None, close=self.end)
        self.stdout = self

    def __iter__(self):
        return self

    def __next__(self):
        line = self.lines.get(timeout=3)
        if line is None:
            raise StopIteration
        return line

    def receipt(self, phase):
        value = {key:self.payload[key] for key in ('pid', 'created', 'path')}
        value.update(phase=phase, message='请在电脑处理已有信任提示' if phase=='failed' else '需要人工确认')
        if self.mismatch:
            value['path'] += '-other'
        self.lines.put(json.dumps(value)+'\n')

    def write(self, line):
        self.sent.append(line.strip())
        if line.startswith('{'):
            self.payload = json.loads(line)
            self.receipt(self.initial)
        elif line == 'arm\n':
            self.receipt('armed')
            for phase in self.events:
                self.receipt(phase)
        elif line == 'stop\n' and not self.hung:
            self.receipt('stopped')
            self.end()

    def end(self):
        if not self.hung and not self.closed:
            self.closed = True
            self.lines.put(None)

    def close(self):
        self.end()

    def wait(self, timeout):
        if self.hung and not self.killed:
            raise subprocess.TimeoutExpired('fixture-listener', timeout)
        return 0

    def kill(self):
        self.killed = True
        self.hung = False
        self.end()


class WindowsProjectTrustTests(unittest.TestCase):
    setUp = WindowsProjectUITests.setUp
    def listen(self, child, callback=None):
        watcher = watch_project_trust(self.root/'ChatGPT.exe', self.root, callback or (lambda *args:None))
        patcher = patch('bridge.platforms.windows.projects.subprocess.Popen', return_value=child)
        patcher.start(); self.addCleanup(patcher.stop)
        return watcher

    def test_listener_is_ready_and_armed_before_creation_and_stopped_after_scope(self):
        child = TrustListenerProcess()
        with self.listen(child) as watcher:
            self.assertEqual(child.sent[1:], ['arm'])
            self.assertFalse(child.closed)
            self.assertEqual(child.payload['action'], 'watch-trust')
            self.assertEqual(child.payload['path'], str(self.root.resolve()))
        self.assertEqual(child.sent[1:], ['arm', 'stop'])
        self.assertTrue(child.closed)
        self.assertFalse(watcher.reader.is_alive())
        watcher.close()  # Cleanup is idempotent.

    def test_preexisting_prompt_refusal_and_mismatched_receipts_never_arm(self):
        for child in (TrustListenerProcess(initial='failed'), TrustListenerProcess(mismatch=True)):
            with self.subTest(child=child), self.assertRaises(ProjectUIError):
                with self.listen(child):
                    self.fail('Listener must not arm')
            self.assertNotIn('arm', child.sent)
            self.assertTrue(child.closed)

    def test_listener_reports_manual_and_unknown_without_sending_another_arm(self):
        for phase in ('manual', 'unknown', 'trusted'):
            child = TrustListenerProcess(events=[phase])
            messages = []
            with self.subTest(phase=phase):
                with self.listen(child, lambda *args:messages.append(args)) as watcher:
                    self.assertEqual(watcher.receipts.get(timeout=1)['phase'], phase)
                self.assertTrue(messages)
                self.assertEqual(child.sent[1:], ['arm', 'stop'])

    def test_creation_exception_stops_listener_and_does_not_replace_the_exception(self):
        child = TrustListenerProcess()
        with self.assertRaisesRegex(RuntimeError, 'creation failed'):
            with self.listen(child):
                raise RuntimeError('creation failed')
        self.assertTrue(child.closed)

    def test_unresponsive_listener_cleanup_kills_only_its_own_child(self):
        child = TrustListenerProcess(hung=True)
        with self.listen(child):
            pass
        self.assertTrue(child.killed)
        self.assertTrue(child.closed)

    def test_process_identity_change_prevents_starting_listener(self):
        child = TrustListenerProcess()
        watcher = self.listen(child)
        with patch('bridge.platforms.windows.projects._snapshot', side_effect=[self.snapshot, {**self.snapshot,'created':1}]), \
                patch('bridge.platforms.windows.projects.subprocess.Popen') as start, self.assertRaises(ValueError):
            watcher.__enter__()
        start.assert_not_called()

    def test_readiness_timeout_closes_listener_without_arming_or_creating(self):
        child = TrustListenerProcess()
        watcher = self.listen(child)
        with patch.object(watcher.receipts, 'get', side_effect=queue.Empty), self.assertRaisesRegex(ProjectUIError, '未就绪'):
            watcher.__enter__()
        self.assertNotIn('arm', child.sent)
        self.assertTrue(child.closed)
