"""Synthetic filesystem writes; native directory authorization is always mocked."""
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import Mock, patch

from bridge.features.notifications.channels import write_json
from bridge.features.sessions.projects import Projects
from bridge.features.workspace.workspace import Workspace


class DirectoryCreator:
    available = True

    def __init__(self, root):
        self.root = root
        self.calls = []
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()

    @contextmanager
    def directory_scope(self, value):
        self.calls.append(dict(value))
        self.entered.set()
        if not self.release.wait(3):
            raise RuntimeError('Fixture gate timed out')
        yield self.root

    def __call__(self, value, progress):
        return {'key':'local|fixture-project', 'cwd':value['cwd']}


def wait_directory(projects, identifier):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        receipt = projects.directory_operation(identifier)
        if receipt['status'] in ('completed', 'failed', 'unknown'):
            return receipt
        time.sleep(.01)
    raise AssertionError('Directory operation did not finish')


class ProjectDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.parent = self.root / 'workspace'; self.parent.mkdir()
        self.creator = DirectoryCreator(self.parent)
        self.projects = Projects(self.root / 'data', self.creator)
        self.value = {'id':str(uuid.uuid4()), 'parent':str(self.parent), 'name':'新目录 🙂'}

    def wait(self, projects=None, identifier=None):
        return wait_directory(projects or self.projects, identifier or self.value['id'])

    def test_exact_fields_ids_and_single_component_names(self):
        invalid = [[], {}, {**self.value, 'cwd':str(self.parent)}, {**self.value, 'host':'remote'},
                   {**self.value, 'id':None}, {**self.value, 'id':'bad'},
                   {**self.value, 'contextId':None}, {**self.value, 'contextId':'bad'}]
        invalid.extend({key:v for key,v in self.value.items() if key != field} for field in self.value)
        names = [None, 123, '', ' ', '.', '..', '../child', 'a/b', 'a\\b', '/child', 'C:child', 'child:stream',
                 'child.', 'child ', 'a\x00b', 'a\nb', 'a\x7fb', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b',
                 'CON', 'con.txt', 'PRN', 'aux', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$',
                 'COM1', 'com9.ext', 'LPT1', 'lpt9.ext', 'COM¹', 'LPT²', 'LPT³', 'CON .txt',
                 'a'*256, '中'*86, '\ud800']
        invalid.extend({**self.value, 'name':name} for name in names)
        for value in invalid:
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                self.projects.submit_directory(value)
        self.assertFalse(self.projects.directory_operations_path.exists())
        self.assertEqual(self.creator.calls, [])

    def test_parent_requires_an_absolute_path_without_traversal(self):
        for parent in (None, '', ' ', 'relative', str(self.parent)+'/../workspace', str(self.parent)+'/./child',
                       str(self.parent)+'\x00', str(self.parent)+'\n', 'a'*4097):
            with self.subTest(parent=parent), self.assertRaises(ValueError):
                self.projects.submit_directory({**self.value, 'parent':parent})

    def test_pending_saved_before_authorization_and_duplicate_never_replays(self):
        self.creator.release.clear()
        try:
            receipt = self.projects.submit_directory(self.value)
            self.assertEqual(receipt, {'id':self.value['id'], 'status':'pending', 'message':'正在核验 Codex 桌面目录权限'})
            self.assertTrue(self.creator.entered.wait(1))
            persisted = json.loads(self.projects.directory_operations_path.read_text(encoding='utf-8'))
            self.assertEqual(persisted[self.value['id']]['status'], 'pending')
            self.assertFalse((self.parent/self.value['name']).exists())
            for _ in range(3):
                self.assertEqual(self.projects.submit_directory(self.value), receipt)
            for key, value in (('name', 'changed'), ('parent', str(self.root)), ('contextId', str(uuid.uuid4()))):
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, '不能修改'):
                    self.projects.submit_directory({**self.value, key:value})
            with self.assertRaisesRegex(ValueError, '不要重复创建'):
                self.projects.submit_directory({**self.value, 'id':str(uuid.uuid4())})
        finally:
            self.creator.release.set()
            self.wait()
        self.assertEqual(len(self.creator.calls), 1)

    def test_completed_receipt_is_json_and_project_target_is_independent(self):
        self.projects.submit_directory(self.value)
        receipt = self.wait()
        expected = {'path':str(self.parent/self.value['name']), 'parent':str(self.parent), 'name':self.value['name']}
        self.assertEqual(receipt, {'id':self.value['id'], 'status':'completed', 'message':'文件夹已创建', 'directory':expected})
        self.assertTrue(Path(expected['path']).is_dir())
        self.assertFalse(self.projects.operations_path.exists())
        self.assertFalse(self.projects.path.exists())
        # Even a matching UUID is independent from native project creation.
        self.projects.submit({'id':self.value['id'], 'cwd':expected['path'], 'name':'Project', 'sectionId':None}, [], [])
        deadline = time.monotonic()+3
        while self.projects.operation(self.value['id'])['status'] == 'pending' and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(self.projects.operation(self.value['id'])['status'], 'completed')
        self.assertEqual(self.projects.submit_directory(self.value), receipt)
        receipt['directory']['path'] = 'tampered'
        self.assertEqual(self.projects.directory_operation(self.value['id'])['directory'], expected)
        restored = Projects(self.root/'data', None)
        self.assertEqual(restored.submit_directory(self.value)['directory'], expected)
        self.assertEqual(len(self.creator.calls), 1)

    def test_concurrent_duplicate_submissions_start_only_one_worker(self):
        self.creator.release.clear()
        try:
            with ThreadPoolExecutor(max_workers=6) as executor:
                receipts = list(executor.map(lambda _: self.projects.submit_directory(self.value), range(12)))
            self.assertTrue(self.creator.entered.wait(1))
            self.assertTrue(all(receipt == receipts[0] for receipt in receipts))
            self.assertEqual(len(self.creator.calls), 1)
        finally:
            self.creator.release.set()
            self.wait()

    def test_completed_parent_and_name_preserve_request_spelling_for_frontend_verification(self):
        value = {**self.value, 'parent':self.parent.as_posix()+'/'}
        self.projects.submit_directory(value)
        receipt = self.wait()
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(receipt['directory']['parent'], value['parent'])
        self.assertEqual(receipt['directory']['name'], value['name'])
        self.assertEqual(Path(receipt['directory']['path']), self.parent/value['name'])

    @unittest.skipUnless(os.name == 'nt', 'Windows path aliases')
    def test_unknown_windows_target_cannot_be_replayed_by_case_slash_or_short_parent_alias(self):
        import ctypes
        from ctypes import wintypes
        with patch.object(Workspace, 'mkdir', side_effect=OSError('unconfirmed fixture')):
            self.projects.submit_directory(self.value)
            self.assertEqual(self.wait()['status'], 'unknown')
        aliases = [str(self.parent).upper(), str(self.parent).replace('\\', '/'), str(self.parent)+'\\']
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.GetShortPathNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        kernel.GetShortPathNameW.restype = wintypes.DWORD
        buffer = ctypes.create_unicode_buffer(32768)
        length = kernel.GetShortPathNameW(str(self.parent), buffer, len(buffer))
        self.assertTrue(0 < length < len(buffer))
        aliases.append(buffer.value)
        for parent in aliases:
            with self.subTest(parent=parent), self.assertRaisesRegex(ValueError, '不要重复创建'):
                self.projects.submit_directory({**self.value, 'id':str(uuid.uuid4()), 'parent':parent})
        with self.assertRaisesRegex(ValueError, '不要重复创建'):
            self.projects.submit_directory({**self.value, 'id':str(uuid.uuid4()), 'name':self.value['name'].upper()})

    def test_restart_converts_pending_and_creating_to_persisted_unknown(self):
        for status in ('pending', 'creating'):
            data = self.root/status
            original = Projects(data, self.creator)
            with patch('bridge.features.sessions.projects.threading.Thread') as thread:
                original.submit_directory(self.value)
                thread.return_value.start.assert_called_once()
            original._directory_progress(self.value['id'], status, 'interrupted fixture')
            restored = Projects(data, self.creator)
            receipt = restored.directory_operation(self.value['id'])
            self.assertEqual(receipt['status'], 'unknown')
            self.assertEqual(restored.submit_directory(self.value), receipt)
            with self.assertRaisesRegex(ValueError, '不要重复创建'):
                restored.submit_directory({**self.value, 'id':str(uuid.uuid4())})
            self.assertEqual(json.loads(restored.directory_operations_path.read_text(encoding='utf-8'))[self.value['id']]['status'], 'unknown')
        self.assertEqual(self.creator.calls, [])
        self.assertFalse((self.parent/self.value['name']).exists())

    def test_unknown_after_mkdir_failure_never_replays_even_with_new_id(self):
        with patch.object(Workspace, 'mkdir', side_effect=OSError('unconfirmed fixture')) as mkdir:
            self.projects.submit_directory(self.value)
            receipt = self.wait()
            self.assertEqual(receipt['status'], 'unknown')
            self.assertEqual(self.projects.submit_directory(self.value), receipt)
            with self.assertRaisesRegex(ValueError, '不要重复创建'):
                self.projects.submit_directory({**self.value, 'id':str(uuid.uuid4())})
            mkdir.assert_called_once()

    def test_missing_parent_file_parent_and_collisions_are_failed_without_overwrite(self):
        (self.parent/'file').write_text('fixture content')
        (self.parent/'directory').mkdir()
        for parent, name in ((self.parent/'missing', 'child'), (self.parent/'file', 'child'),
                             (self.parent, 'file'), (self.parent, 'directory')):
            value = {**self.value, 'id':str(uuid.uuid4()), 'parent':str(parent), 'name':name}
            self.projects.submit_directory(value)
            receipt = self.wait(identifier=value['id'])
            self.assertEqual(receipt['status'], 'failed')
            if parent == self.parent:
                self.assertIn('不会覆盖', receipt['message'])
            self.assertEqual(self.projects.submit_directory(value), receipt)
        self.assertEqual((self.parent/'file').read_text(), 'fixture content')
        self.assertEqual(sorted(p.name for p in self.parent.iterdir()), ['directory', 'file'])

    def test_authorization_is_rechecked_for_new_requests_and_denial_never_writes(self):
        @contextmanager
        def denied(value):
            raise PermissionError('fixture authorization revoked')
            yield
        self.creator.directory_scope = denied
        with patch.object(Workspace, 'mkdir') as mkdir:
            self.projects.submit_directory(self.value)
            self.assertEqual(self.wait()['status'], 'failed')
            mkdir.assert_not_called()
        self.creator.directory_scope = DirectoryCreator(self.parent).directory_scope
        value = {**self.value, 'id':str(uuid.uuid4())}
        self.projects.submit_directory(value)
        self.assertEqual(self.wait(identifier=value['id'])['status'], 'completed')

    def test_pending_persistence_failure_does_not_start_worker(self):
        with patch('bridge.features.sessions.projects.write_json', side_effect=OSError('fixture disk full')), \
                patch('bridge.features.sessions.projects.threading.Thread') as thread:
            with self.assertRaises(OSError):
                self.projects.submit_directory(self.value)
            thread.assert_not_called()
        self.assertEqual(self.creator.calls, [])

    def test_creating_persistence_failure_prevents_mkdir(self):
        def persist(path, values):
            if values[self.value['id']]['status'] == 'creating':
                raise OSError('fixture disk full')
            write_json(path, values)
        with patch('bridge.features.sessions.projects.write_json', side_effect=persist), patch.object(Workspace, 'mkdir') as mkdir:
            self.projects.submit_directory(self.value)
            self.assertEqual(self.wait()['status'], 'failed')
            mkdir.assert_not_called()

    def test_completed_persistence_failure_is_unknown_and_preserves_created_directory(self):
        def persist(path, values):
            if values[self.value['id']]['status'] == 'completed':
                raise OSError('fixture disk full')
            write_json(path, values)
        with patch('bridge.features.sessions.projects.write_json', side_effect=persist):
            self.projects.submit_directory(self.value)
            self.assertEqual(self.wait()['status'], 'unknown')
        self.assertTrue((self.parent/self.value['name']).is_dir())
        with self.assertRaisesRegex(ValueError, '不要重复创建'):
            self.projects.submit_directory({**self.value, 'id':str(uuid.uuid4())})
        self.assertEqual(Projects(self.root/'data', self.creator).directory_operation(self.value['id'])['status'], 'unknown')

    def test_directory_verification_failure_after_successful_mkdir_is_unknown(self):
        with patch('bridge.features.workspace.workspace.os.stat', side_effect=PermissionError('fixture verification denial')):
            # Exercise the Workspace boundary directly to avoid replacing stat
            # used by constructor or native authorization.
            workspace = object.__new__(Workspace)
            workspace.root = self.parent
            @contextmanager
            def pinned(parts):
                yield self.parent, None
            workspace._mkdir_directory = pinned
            with self.assertRaises(PermissionError) as caught:
                workspace.mkdir('', 'verified')
            self.assertTrue(caught.exception.unknown)
        self.assertTrue((self.parent/'verified').is_dir())

    def test_scope_close_error_after_creation_cannot_be_failed_or_replayed(self):
        @contextmanager
        def close_error(value):
            yield self.parent
            raise ValueError('fixture native close failed')
        self.creator.directory_scope = close_error
        self.projects.submit_directory(self.value)
        self.assertEqual(self.wait()['status'], 'unknown')
        with self.assertRaisesRegex(ValueError, '不要重复创建'):
            self.projects.submit_directory({**self.value, 'id':str(uuid.uuid4())})

    def test_cannot_create_without_native_directory_authorization(self):
        for creator in (None, Mock(available=False), lambda *args:None):
            self.projects.native_creator = creator
            with self.assertRaisesRegex(ValueError, '原生目录授权接口'):
                self.projects.submit_directory(self.value)
        self.assertFalse(self.projects.directory_operations_path.exists())

    @unittest.skipUnless(os.name != 'nt', 'POSIX directory fd replacement boundary')
    def test_posix_parent_and_root_ancestor_symlinks_are_never_followed(self):
        outside = self.root/'outside'; outside.mkdir()
        (self.parent/'linked').symlink_to(outside, target_is_directory=True)
        workspace = Workspace(self.parent)
        with self.assertRaises(OSError):
            workspace.mkdir('linked', 'escaped')
        # Keep the original workspace root, then replace an ancestor.
        container = self.root/'container'; container.mkdir()
        project = container/'project'; project.mkdir()
        workspace = Workspace(project)
        container.rename(self.root/'container-moved')
        container.symlink_to(outside, target_is_directory=True)
        with self.assertRaises(OSError):
            workspace.mkdir('', 'escaped')
        self.assertFalse((outside/'escaped').exists())


if __name__ == '__main__':
    unittest.main()
