"""Only explicitly fingerprinted application bundles may be used by the probe."""
import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.clients.chatgpt.installation import UnsupportedInstallation, inspect_installation


class ChatGptInstallationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.exe = self.root / 'ChatGPT.exe'
        self.exe.touch()
        (self.root / 'resources').mkdir()
        self.members = {
            'package.json': json.dumps({'name': 'openai-codex-electron', 'version': 'fixture'}).encode(),
            'webview/assets/primary.js': b'export const scope = {};',
            'webview/assets/initial.js': b'export const state = {};',
        }
        self.profile = {'modules': {'primary': 'assets/primary.js', 'initial': 'assets/initial.js'},
                        'sha256': {name: hashlib.sha256(raw).hexdigest()
                                   for name, raw in self.members.items() if name.startswith('webview/')}}
        self.enterContext(patch('bridge.clients.chatgpt.installation.PROFILES', {'fixture': self.profile}))
        self.write_archive()

    def write_archive(self, *, corrupt_offset=False):
        tree, content = {'files': {}}, b''
        for name, raw in self.members.items():
            node = tree
            parts = name.split('/')
            for part in parts[:-1]:
                node = node['files'].setdefault(part, {'files': {}})
            node['files'][parts[-1]] = {'size': len(raw), 'offset': str(len(content))}
            content += raw
        if corrupt_offset:
            tree['files']['package.json']['offset'] = '-1'
        raw = json.dumps(tree).encode()
        header_size = len(raw) + 8
        self.archive = self.root / 'resources/app.asar'
        self.archive.write_bytes(struct.pack('<4I', 4, header_size, header_size - 4, len(raw)) + raw + content)

    def test_accepts_only_the_expected_application_and_complete_module_hashes(self):
        result = inspect_installation(self.exe)
        self.assertEqual(result.version, 'fixture')
        self.assertEqual(dict(result.modules), self.profile['modules'])
        self.assertEqual(result.executable, self.exe.resolve())

    def test_same_version_with_changed_bundle_is_rejected(self):
        self.members['webview/assets/primary.js'] += b' changed'
        self.write_archive()
        with self.assertRaisesRegex(UnsupportedInstallation, '指纹'):
            inspect_installation(self.exe)

    def test_unknown_version_and_wrong_application_are_rejected(self):
        for metadata in ({'name': 'openai-codex-electron', 'version': 'unknown'},
                         {'name': 'other-app', 'version': 'fixture'}):
            with self.subTest(metadata=metadata):
                self.members['package.json'] = json.dumps(metadata).encode()
                self.write_archive()
                with self.assertRaises(UnsupportedInstallation):
                    inspect_installation(self.exe)

    def test_corrupt_archive_cannot_read_outside_its_member_range(self):
        self.write_archive(corrupt_offset=True)
        with self.assertRaises(UnsupportedInstallation):
            inspect_installation(self.exe)

    def test_read_only_inspection_does_not_modify_the_installation(self):
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (self.exe, self.archive)}
        inspect_installation(self.exe)
        self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in before})


if __name__ == '__main__':
    unittest.main()
