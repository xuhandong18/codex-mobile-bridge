import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bridge.features.workspace.workspace import Workspace, operate, MAX_PREVIEW
from relay.protocol import validate


class MarkdownEditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / '.tmp')
        self.root = Path(self.temp.name)
        self.path = self.root / '说明.md'
        self.path.write_bytes(b'\xef\xbb\xbf# Title\r\n\r\nBody\r\n')
        self.work = Workspace(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_save_preserves_bom_newlines_and_returns_new_version(self):
        original = self.work.read('说明.md')
        saved = operate(self.root, 'save', {'path': '说明.md', 'text': '# 新标题\n\n正文\n', 'version': original['version']})
        self.assertEqual(saved['outcome'], 'saved')
        self.assertEqual(self.path.read_bytes(), b'\xef\xbb\xbf' + '# 新标题\r\n\r\n正文\r\n'.encode())
        self.assertEqual(saved['version'], hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertEqual(self.work.read('说明.md')['version'], saved['version'])

    def test_conflict_does_not_overwrite_external_change(self):
        original = self.work.read('说明.md')
        self.path.write_text('电脑修改', encoding='utf-8')
        result = self.work.save('说明.md', '手机修改', original['version'])
        self.assertEqual(result['outcome'], 'conflict')
        self.assertEqual(self.path.read_text(encoding='utf-8'), '电脑修改')

    def test_lost_receipt_can_be_checked_without_replaying_save(self):
        original = self.work.read('说明.md')
        self.work.save('说明.md', '', original['version'])
        self.assertEqual(self.work.read('说明.md')['text'], '')
        self.assertNotEqual(self.work.read('说明.md')['version'], original['version'])

    def test_write_boundary_and_validation(self):
        version = self.work.read('说明.md')['version']
        for path, text, token in [('../other.md', 'text', version), ('.git/notes.md', 'text', version),
                                  ('说明.md', '\x00', version), ('说明.md', 'x' * (MAX_PREVIEW + 1), version),
                                  ('说明.md', 'text', ''), ('说明.md', None, version), ('other.txt', 'text', version)]:
            with self.subTest(path=path, token=token):
                with self.assertRaises((ValueError, PermissionError)):
                    self.work.save(path, text, token)
        self.assertEqual(self.path.read_bytes(), b'\xef\xbb\xbf# Title\r\n\r\nBody\r\n')
        self.assertEqual(list(self.root.glob('.bridge-upload-*')), [])

    def test_relay_save_is_post_only_for_all_clients(self):
        for prefix in ['/api/sessions/11111111-1111-4111-8111-111111111111',
                       '/api/desktop-sessions/claude', '/api/desktop-sessions/deepseek']:
            validate('POST', prefix + '/workspace/save?path=readme.md', 100)
            with self.assertRaises(PermissionError):
                validate('GET', prefix + '/workspace/save?path=readme.md')

    def test_atomic_failure_keeps_original_and_cleans_temporary_file(self):
        original = self.path.read_bytes()
        with patch('os.replace', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                self.work.save('说明.md', 'changed', hashlib.sha256(original).hexdigest())
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.root.glob('.bridge-upload-*')), [])

    def test_self_contained_ssh_source_supports_save(self):
        source = Path(__file__).resolve().parents[1] / 'bridge/features/workspace/workspace.py'
        namespace = {'__name__': 'ssh_markdown_fixture'}
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), namespace)
        result = namespace['operate'](self.root, 'preview', {'path': '说明.md'})
        saved = namespace['operate'](self.root, 'save', {'path': '说明.md', 'text': 'remote save', 'version': result['version']})
        self.assertEqual(saved['outcome'], 'saved')

    def test_windows_junction_parent_cannot_redirect_a_save(self):
        if os.name != 'nt':
            self.skipTest('Windows junction boundary')
        import subprocess
        outside = self.root / 'outside'; outside.mkdir()
        (outside / 'readme.md').write_text('private', encoding='utf-8')
        link = self.root / 'linked'
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(outside)], check=True, capture_output=True)
        try:
            with self.assertRaises(PermissionError):
                self.work.save('linked/readme.md', 'overwrite', hashlib.sha256(b'private').hexdigest())
            self.assertEqual((outside / 'readme.md').read_text(), 'private')
        finally:
            link.rmdir()
