import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge.platforms.windows.projects import create_project, edit_project, ProjectUIError


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
