#!/usr/bin/env python3
"""Compile the project helper and test its real trust matcher, without any UI input."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == 'win32', 'Windows .NET helper')
class NativeTrustMatcherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        target = ROOT/'.tmp'
        target.mkdir(exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(prefix='trust-matcher-', dir=target)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.helper = Path(cls.temp.name)/'codex-project-helper.exe'
        framework = Path(os.environ.get('WINDIR', 'C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319'
        subprocess.run([str(framework/'csc.exe'), '/nologo', '/target:exe', '/platform:x64',
            '/out:'+str(cls.helper),
            *['/reference:'+str(framework/'WPF'/name) for name in
              ('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll')],
            '/reference:'+str(framework/'System.Web.Extensions.dll'),
            str(ROOT/'bridge/platforms/windows/codex-project-helper.cs')], check=True)

    def match(self, **changes):
        value = {'path':r'D:\test\selected', 'title':'信任此文件夹吗？',
                 'paths':[r'D:\test\selected'], 'enabled':True, 'invokable':True,
                 'dialogCount':1, 'buttonCount':1, **changes}
        result = subprocess.run([str(self.helper), '--test-trust-match'],
            input=json.dumps(value, ensure_ascii=False), text=True, encoding='utf-8',
            capture_output=True, timeout=5, check=True)
        return json.loads(result.stdout)['reason']

    def test_exact_full_path_case_slashes_and_extended_windows_paths(self):
        for path in (r'D:\test\selected', r'd:\TEST\SELECTED', 'D:/test/selected/', r'\\?\D:\test\selected'):
            with self.subTest(path=path):
                self.assertIsNone(self.match(paths=[path]))

    def test_matching_unc_paths_and_drive_roots(self):
        self.assertIsNone(self.match(path=r'\\server\share\selected', paths=[r'\\?\UNC\server\share\selected']))
        self.assertIsNone(self.match(path='D:\\', paths=['D:\\']))

    def test_other_directory_same_basename_prefix_and_relative_paths_are_refused(self):
        for path in (r'D:\other\selected', r'C:\test\selected', r'D:\test\selected-other',
                     r'D:\test', r'D:\test\selected\child', 'selected', 'D:selected', ''):
            with self.subTest(path=path):
                self.assertIsNotNone(self.match(paths=[path]))

    def test_missing_extra_and_duplicate_directory_items_are_refused(self):
        for paths in ([], [r'D:\test\selected']*2, [r'D:\test\selected', r'D:\other']):
            with self.subTest(paths=paths):
                self.assertIsNotNone(self.match(paths=paths))

    def test_unrecognized_dialog_titles_are_refused(self):
        for title in ('创建项目', '信任文件夹', '信任此文件夹吗？ other', ''):
            with self.subTest(title=title):
                self.assertIsNotNone(self.match(title=title))

    def test_disabled_noninvokable_missing_and_duplicate_buttons_are_refused(self):
        for change in ({'enabled':False}, {'invokable':False}, {'buttonCount':0}, {'buttonCount':2}):
            with self.subTest(change=change):
                self.assertIsNotNone(self.match(**change))

    def test_multiple_dialogs_are_refused(self):
        self.assertIsNotNone(self.match(dialogCount=2))

    def test_matching_button_is_invoked_once_and_unknown_outcome_is_never_replayed(self):
        for outcome in ('success', 'fail'):
            with self.subTest(outcome=outcome):
                result = subprocess.run([str(self.helper), '--test-trust-once'], input=outcome,
                    text=True, encoding='utf-8', capture_output=True, timeout=5, check=True)
                self.assertEqual(json.loads(result.stdout)['calls'], 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
