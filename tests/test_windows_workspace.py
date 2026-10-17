"""Exercise real Windows junctions and case-insensitive upload boundaries."""
import base64
import contextlib
import ctypes
import os
from pathlib import Path, PureWindowsPath
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from bridge.features.workspace.workspace import Workspace, _windows_listing_directory


@unittest.skipUnless(os.name == 'nt', 'Windows filesystem semantics')
class WindowsWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cmb-workspace-windows-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / 'project'
        self.outside = self.root / 'outside'
        self.project.mkdir()
        self.outside.mkdir()
        (self.outside / 'fixture.txt').write_text('outside fixture', encoding='utf-8')
        self.workspace = Workspace(self.project)
        self.payload = base64.b64encode(b'upload fixture').decode()

    def junction(self):
        import _winapi
        link = self.project / 'linked'
        _winapi.CreateJunction(str(self.outside), str(link))
        # Remove only the junction, before TemporaryDirectory cleans its targets.
        self.addCleanup(os.rmdir, link)
        return link

    @contextlib.contextmanager
    def renamed(self, path):
        # Only fresh fixture directories may be moved, always to a sibling.
        self.assertTrue(path == self.root or self.root in path.parents)
        moved = path.with_name(path.name + '-moved')
        self.assertFalse(moved.exists())
        path.rename(moved)
        try:
            yield moved
        finally:
            moved.rename(path)

    @contextlib.contextmanager
    def replaced_with_junction(self, path):
        import _winapi
        with self.renamed(path):
            _winapi.CreateJunction(str(self.outside), str(path))
            try:
                yield
            finally:
                os.rmdir(path)  # Remove the junction itself, never its target.

    @staticmethod
    def kernel():
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                      ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        return kernel

    def test_listing_pins_target_workspace_and_root_ancestor_before_scandir(self):
        target = self.project / 'child'; target.mkdir(); (target / 'inside.txt').touch()
        scandir = os.scandir
        for recursive in (False, True):
            attempts = []
            def guarded(path):
                if Path(path) == target:
                    for candidate in (self.root, self.project, target):
                        with self.assertRaises(OSError) as denied:
                            with self.renamed(candidate):
                                self.fail('A directory was renamed while enumeration held its handle')
                        self.assertIn(denied.exception.winerror, (5, 32))
                        attempts.append(candidate)
                return scandir(path)
            with self.subTest(recursive=recursive), patch('bridge.features.workspace.workspace.os.scandir', side_effect=guarded):
                page = self.workspace.listing('child', recursive=recursive)
            self.assertEqual(attempts, [self.root, self.project, target])
            self.assertEqual([row['path'] for row in page['entries']], ['child/inside.txt'])
            self.assertFalse(page['truncated'])
            # Release must cover the target, workspace and ancestors on success.
            for candidate in (target, self.project, self.root):
                with self.renamed(candidate):
                    pass

    def test_listing_blocks_real_junction_replacement_between_check_and_scan(self):
        target = self.project / 'child'; target.mkdir(); (target / 'inside.txt').touch()
        scandir = os.scandir
        for recursive in (False, True):
            attempts = []
            def guarded(path):
                if Path(path) == target:
                    with self.assertRaises(OSError) as denied:
                        with self.replaced_with_junction(target):
                            self.fail('A junction replacement escaped the directory guard')
                    self.assertIn(denied.exception.winerror, (5, 32))
                    attempts.append(True)
                return scandir(path)
            with self.subTest(recursive=recursive), patch('bridge.features.workspace.workspace.os.scandir', side_effect=guarded):
                page = self.workspace.listing('child', recursive=recursive)
            self.assertEqual(attempts, [True])
            self.assertEqual([row['name'] for row in page['entries']], ['inside.txt'])
        # The very same replacement works after release, and is then rejected
        # as a reparse point before enumeration rather than followed.
        with self.replaced_with_junction(target):
            with self.assertRaises(PermissionError):
                self.workspace.listing('child')

    def test_listing_rejects_a_root_ancestor_replaced_before_locking(self):
        container = self.root / 'container'; container.mkdir()
        project = container / 'nested'; project.mkdir()
        (self.outside / 'nested').mkdir(); (self.outside / 'nested' / 'secret.txt').touch()
        workspace = Workspace(project)
        with self.replaced_with_junction(container):
            for recursive in (False, True):
                with self.subTest(recursive=recursive), self.assertRaises(PermissionError):
                    workspace.listing(recursive=recursive)
        with self.renamed(container):
            pass

    def test_listing_share_conflict_fails_closed_without_scandir_fallback(self):
        kernel = self.kernel()
        # An existing DELETE-capable handle is incompatible with FILE_SHARE_READ.
        handle = kernel.CreateFileW(str(self.project), 0x10000, 7, None, 3, 0x02200000, None)
        self.assertNotIn(handle, (None, ctypes.c_void_p(-1).value))
        try:
            with patch('bridge.features.workspace.workspace.os.scandir', side_effect=AssertionError('Unsafe fallback')):
                for recursive in (False, True):
                    with self.subTest(recursive=recursive):
                        with self.assertRaises(OSError) as denied:
                            self.workspace.listing(recursive=recursive)
                        self.assertEqual(denied.exception.winerror, 32)
        finally:
            kernel.CloseHandle(handle)
        with self.renamed(self.project):
            pass

    def test_listing_open_denial_and_attribute_failure_close_every_acquired_handle(self):
        kernel = self.kernel()
        for failure in ('open', 'attributes'):
            opened, closed = [], []
            def create(path, *args):
                if failure == 'open' and Path(path) == self.project:
                    ctypes.set_last_error(5)
                    return ctypes.c_void_p(-1).value
                handle = kernel.CreateFileW(path, *args)
                if handle not in (None, ctypes.c_void_p(-1).value):
                    opened.append(handle)
                return handle
            def attributes(handle, *args):
                if failure == 'attributes' and handle == opened[-1] and len(opened) == len(self.project.parts):
                    ctypes.set_last_error(5)
                    return 0
                return kernel.GetFileInformationByHandleEx(handle, *args)
            def close(handle):
                closed.append(handle)
                return kernel.CloseHandle(handle)
            api = SimpleNamespace(CreateFileW=Mock(side_effect=create),
                                  GetFileInformationByHandleEx=Mock(side_effect=attributes), CloseHandle=Mock(side_effect=close))
            with self.subTest(failure=failure), patch('ctypes.WinDLL', return_value=api):
                with self.assertRaises(PermissionError):
                    self.workspace.listing()
            self.assertTrue(opened)
            self.assertEqual(closed, list(reversed(opened)))
            with self.renamed(self.root):
                pass

    def test_listing_scandir_exception_releases_directory_chain(self):
        for recursive in (False, True):
            with self.subTest(recursive=recursive), patch('bridge.features.workspace.workspace.os.scandir', side_effect=OSError('fixture scan failure')):
                with self.assertRaises(OSError):
                    self.workspace.listing(recursive=recursive)
            with self.renamed(self.root):
                pass
        with self.assertRaises(RuntimeError):
            with self.workspace._listing_directory([]):
                raise RuntimeError('fixture cancellation')
        with self.renamed(self.root):
            pass

    def test_listing_rejects_file_handles_without_leaking_ancestor_locks(self):
        (self.project / 'file.txt').touch()
        with self.assertRaises(NotADirectoryError):
            self.workspace.listing('file.txt')
        with self.renamed(self.root):
            pass

    def test_guard_locks_drive_unc_and_extended_path_ancestors_in_order(self):
        for raw in ('C:/work/project', '//server/share/work/project', '//?/C:/work/project', '//?/UNC/server/share/work/project'):
            target = PureWindowsPath(raw)
            opened, closed = [], []
            def create(path, access, share, security, disposition, flags, template):
                self.assertEqual((access, share, disposition, flags), (0x81, 1, 3, 0x02200000))
                opened.append(path)
                return len(opened)
            def attributes(handle, kind, info, size):
                self.assertEqual(kind, 9)
                info._obj.attributes = 0x10
                return 1
            api = SimpleNamespace(CreateFileW=Mock(side_effect=create), GetFileInformationByHandleEx=Mock(side_effect=attributes),
                                  CloseHandle=Mock(side_effect=lambda handle: closed.append(handle)))
            with self.subTest(path=raw), patch('ctypes.WinDLL', return_value=api):
                with _windows_listing_directory(target) as result:
                    self.assertEqual(result, target)
                    self.assertEqual(opened, [str(path) for path in [*reversed(target.parents), target]])
                    self.assertEqual(closed, [])
            self.assertEqual(closed, list(range(len(opened), 0, -1)))

    def test_junction_read_info_and_download_cannot_leave_project(self):
        self.junction()
        for action in (lambda: self.workspace.read('linked/fixture.txt'),
                       lambda: self.workspace.info('linked/fixture.txt')):
            with self.subTest(action=action), self.assertRaises(PermissionError):
                action()
        with self.assertRaises(PermissionError):
            with self.workspace.download('linked/fixture.txt'):
                pass

    def test_junction_upload_cannot_write_outside_project(self):
        self.junction()
        with self.assertRaises(PermissionError):
            self.workspace.upload('linked/new.txt', self.payload)
        self.assertEqual(sorted(p.name for p in self.outside.iterdir()), ['fixture.txt'])

    def test_junction_is_blocked_in_listing_and_archive(self):
        self.junction()
        entry = next(row for row in self.workspace.listing()['entries'] if row['name'] == 'linked')
        self.assertEqual(entry['kind'], 'blocked')
        with self.assertRaises(PermissionError):
            with self.workspace.archive('linked'):
                pass

    def test_git_upload_rejects_case_and_win32_name_aliases(self):
        (self.project / '.git' / 'hooks').mkdir(parents=True)
        for name in ('.git', '.GIT', '.Git', '.git.', '.GIT '):
            with self.subTest(name=name), self.assertRaises(PermissionError):
                self.workspace.upload(name + '/hooks/fixture.txt', self.payload)
        self.assertEqual(list((self.project / '.git' / 'hooks').iterdir()), [])

    def test_nested_git_upload_is_also_blocked(self):
        (self.project / 'nested' / '.git').mkdir(parents=True)
        with self.assertRaises(PermissionError):
            self.workspace.upload('nested/.GIT/config', self.payload)
        self.assertFalse((self.project / 'nested' / '.git' / 'config').exists())

    def test_ordinary_unicode_upload_read_and_download_still_work(self):
        folder = self.project / 'folder \u4e2d\u6587'
        folder.mkdir()
        name = folder.name + '/data.txt'
        self.workspace.upload(name, self.payload)
        self.assertEqual(self.workspace.read(name)['text'], 'upload fixture')
        with self.workspace.download(name) as (_, stream):
            self.assertEqual(stream.read(), b'upload fixture')


if __name__ == '__main__':
    unittest.main()
