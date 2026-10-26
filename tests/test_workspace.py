import base64
import contextlib
import http.client
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from bridge.features.workspace.workspace import Workspace, operate, MAX_TRANSFER, MAX_PREVIEW, MAX_HTML_PREVIEW
from bridge.app.service import Bridge
from bridge.clients.codex.remote import RemoteStore
from relay.protocol import validate as validate_relay_request
import test_bridge as support


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=support.ROOT / '.tmp')
        self.root = Path(self.temp.name) / 'project'; self.root.mkdir()
        self.work = Workspace(self.root)
        (self.root / 'folder').mkdir(); (self.root / 'hello.txt').write_bytes('你好\nworkspace🙂'.encode('utf-8'))
        (self.root / '.hidden').write_text('hidden')

    def tearDown(self): self.temp.cleanup()

    def symlink(self, link, target, directory=False):
        try:
            link.symlink_to(target, target_is_directory=directory)
        except OSError as error:
            if os.name == 'nt' and error.winerror == 1314:
                self.skipTest('Windows token cannot create symlinks; real junctions are tested separately')
            raise

    def test_listing_hidden_search_and_paging(self):
        listing = self.work.listing()
        self.assertEqual([x['name'] for x in listing['entries']], ['folder', 'hello.txt'])
        self.assertEqual(listing['root'], str(self.root.resolve()))
        self.assertEqual(listing['project'], 'project')
        self.assertFalse(listing['truncated'])
        self.assertEqual(listing['truncationReasons'], [])
        self.assertEqual(self.work.listing('folder')['root'], listing['root'])
        self.assertEqual(self.work.listing(hidden=True)['total'], 3)
        self.assertEqual(self.work.listing(search='HELLO')['entries'][0]['path'], 'hello.txt')
        for i in range(205): (self.root / ('page-%03d' % i)).touch()
        page = self.work.listing(search='page-'); self.assertEqual(len(page['entries']), 200)
        self.assertEqual(len(self.work.listing(search='page-', offset=page['nextOffset'])['entries']), 5)

    def test_recursive_search_matches_names_and_workspace_relative_paths_within_requested_subtree(self):
        nested = self.root / 'folder' / '中文目录'; nested.mkdir()
        (nested / 'Needle.txt').write_text('fixture')
        (self.root / 'Needle-outside.txt').touch()
        self.assertEqual(self.work.listing('folder', search='needle')['entries'], [])
        page = self.work.listing('folder', recursive=True, search='NEEDLE')
        self.assertEqual([row['path'] for row in page['entries']], ['folder/中文目录/Needle.txt'])
        self.assertEqual(page['root'], str(self.root.resolve()))
        self.assertFalse(page['truncated'])
        page = self.work.listing(recursive=True, search='folder/中文目录/needle')
        self.assertEqual([row['name'] for row in page['entries']], ['Needle.txt'])
        page = self.work.listing(recursive=True, search='中文目录')
        self.assertEqual({row['kind'] for row in page['entries']}, {'directory', 'file'})

    def test_recursive_search_preserves_hidden_upload_and_git_boundaries(self):
        for name in ('.secret', '.git', '.bridge-upload-pending', 'visible'):
            folder = self.root / name; folder.mkdir(); (folder / 'needle.txt').touch()
        page = self.work.listing(recursive=True, search='needle')
        self.assertEqual([row['path'] for row in page['entries']], ['visible/needle.txt'])
        page = self.work.listing(hidden=True, recursive=True, search='needle')
        self.assertEqual({row['path'] for row in page['entries']}, {'.secret/needle.txt', 'visible/needle.txt'})
        self.assertFalse(page['truncated'])
        self.assertEqual(self.work.listing('.git', recursive=True)['entries'], [])
        # Ordinary browsing still permits explicitly opening the existing .git directory.
        self.assertEqual(self.work.listing('.git')['entries'][0]['name'], 'needle.txt')

    def test_recursive_search_scans_all_matches_before_paging_and_can_find_a_late_match(self):
        for i in range(205): (self.root / 'folder' / ('needle-%03d.txt' % i)).touch()
        first = self.work.listing(recursive=True, search='needle')
        second = self.work.listing(recursive=True, search='needle', offset=first['nextOffset'])
        self.assertEqual((first['total'], len(first['entries']), first['nextOffset']), (205, 200, 200))
        self.assertEqual((second['total'], len(second['entries']), second['nextOffset']), (205, 5, None))
        self.assertEqual(len({row['path'] for row in first['entries'] + second['entries']}), 205)
        self.assertFalse(first['truncated'] or second['truncated'])
        self.assertEqual(self.work.listing(recursive=True, search='needle-204')['entries'][0]['name'], 'needle-204.txt')

    def test_recursive_search_reports_depth_scan_and_time_limits(self):
        deep = self.root / 'folder' / 'deep'; deep.mkdir(); (deep / 'needle.txt').touch()
        with patch('bridge.features.workspace.workspace.SEARCH_MAX_DEPTH', 1):
            page = self.work.listing(recursive=True, search='needle')
        self.assertEqual(page['entries'], [])
        self.assertTrue(page['truncated'])
        self.assertEqual(page['truncationReasons'], ['depthLimit'])
        with patch('bridge.features.workspace.workspace.SEARCH_MAX_SCANNED', 1):
            page = self.work.listing(recursive=True)
        self.assertTrue(page['truncated'])
        self.assertEqual(page['truncationReasons'], ['scanLimit'])
        self.assertLessEqual(page['total'], 1)
        with patch('bridge.features.workspace.workspace.time.monotonic', side_effect=[0, 0, 100]):
            page = self.work.listing(recursive=True)
        self.assertEqual(page['entries'], [])
        self.assertTrue(page['truncated'])
        self.assertEqual(page['truncationReasons'], ['timeLimit'])

    def test_truncated_search_results_remain_pageable(self):
        for i in range(205): (self.root / ('needle-%03d.txt' % i)).touch()
        # Existing folder, hello.txt and .hidden are also counted, even when filtered out.
        with patch('bridge.features.workspace.workspace.SEARCH_MAX_SCANNED', 207):
            first = self.work.listing(recursive=True, search='needle')
            second = self.work.listing(recursive=True, search='needle', offset=first['nextOffset'])
        self.assertTrue(first['truncated'] and second['truncated'])
        self.assertEqual(first['nextOffset'], 200)
        self.assertGreater(second['total'], 200)
        self.assertIsNone(second['nextOffset'])
        self.assertEqual(len({row['path'] for row in first['entries'] + second['entries']}), first['total'])

    def test_recursive_search_reports_unreadable_subtrees_and_rejects_invalid_start_paths(self):
        directory = self.work._listing_directory
        @contextlib.contextmanager
        def guarded(parts):
            if parts == ['folder']:
                raise PermissionError('fixture denial')
            with directory(parts) as value:
                yield value
        with patch.object(self.work, '_listing_directory', side_effect=guarded):
            page = self.work.listing(recursive=True)
        self.assertTrue(page['truncated'])
        self.assertEqual(page['truncationReasons'], ['unreadable'])
        for path in ('../private', '/etc', 'C:\\private', 'folder//file'):
            with self.subTest(path=path), self.assertRaises((ValueError, PermissionError)):
                self.work.listing(path, recursive=True)
        for params in ({'recursive': 'false'}, {'hidden': 'true'}, {'offset': True}, {'offset': -1}, {'search': 'x' * 201}):
            with self.subTest(params=params), self.assertRaises(ValueError):
                self.work.listing(**params)

    def test_recursive_search_never_follows_symlinks(self):
        outside = Path(self.temp.name) / 'outside'; outside.mkdir(); (outside / 'needle.txt').touch()
        self.symlink(self.root / 'linked', outside, directory=True)
        self.symlink(self.root / 'needle-link', outside / 'needle.txt')
        page = self.work.listing(recursive=True, search='needle')
        self.assertEqual(page['entries'], [])
        self.assertFalse(page['truncated'])
        with self.assertRaises((OSError, ValueError, PermissionError)):
            self.work.listing('linked', recursive=True)

    @unittest.skipUnless(os.name == 'nt', 'Windows reparse points and Git name aliases')
    def test_recursive_search_blocks_windows_junctions_and_git_aliases(self):
        import _winapi
        outside = Path(self.temp.name) / 'outside'; outside.mkdir(); (outside / 'needle.txt').touch()
        link = self.root / 'linked'; _winapi.CreateJunction(str(outside), str(link))
        try:
            protected = self.root / '.GIT'; protected.mkdir(); (protected / 'needle.txt').touch()
            page = self.work.listing(hidden=True, recursive=True, search='needle')
            self.assertEqual(page['entries'], [])
            self.assertFalse(page['truncated'])
        finally:
            os.rmdir(link)

    def test_read_text_image_binary_and_large_preview(self):
        self.assertEqual(self.work.read('hello.txt')['text'], '你好\nworkspace🙂')
        (self.root / 'image.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture')
        self.assertEqual(self.work.read('image.png')['kind'], 'image')
        (self.root / 'binary').write_bytes(b'\0\xff')
        self.assertEqual(self.work.read('binary')['kind'], 'binary')
        (self.root / 'big.txt').write_bytes(b'x' * (MAX_PREVIEW + 1))
        self.assertNotIn('text', self.work.read('big.txt'))
        self.assertEqual(base64.b64decode(self.work.read('big.txt', download=True)['data']), b'x' * (MAX_PREVIEW + 1))

    def test_large_html_preview_preserves_embedded_images_and_limits_other_text(self):
        html = '<!doctype html><h1>通知截图</h1><img src="data:image/png;base64,' + 'A' * (MAX_PREVIEW + 1) + '">'
        for name in ('gallery.html', 'gallery.htm', 'gallery.HTML', 'gallery.HTM'):
            with self.subTest(name=name):
                (self.root / name).write_bytes(html.encode('utf-8'))
                result = operate(str(self.root), 'preview', {'path': name})
                self.assertEqual(result['kind'], 'text')
                self.assertEqual(result['size'], len(html.encode('utf-8')))
                self.assertEqual(result['text'], html)
        (self.root / 'gallery.txt').write_bytes(html.encode('utf-8'))
        self.assertNotIn('text', self.work.read('gallery.txt'))
        for data in (b'\xff', b'<html>\x00</html>'):
            (self.root / 'invalid.html').write_bytes(data)
            self.assertEqual(self.work.read('invalid.html')['kind'], 'binary')

    def test_html_preview_accepts_exact_byte_limit_and_rejects_one_byte_more(self):
        data = '中'.encode('utf-8') * (MAX_HTML_PREVIEW // 3) + b'x' * (MAX_HTML_PREVIEW % 3)
        path = self.root / 'boundary.html'; path.write_bytes(data)
        result = self.work.read(path.name)
        self.assertEqual(result['kind'], 'text')
        self.assertEqual(result['text'].encode('utf-8'), data)
        with path.open('ab') as stream: stream.write(b'x')
        result = self.work.read(path.name)
        self.assertEqual(result['kind'], 'binary')
        self.assertNotIn('text', result)
        self.assertNotIn('data', result)

    def test_traversal_and_symlinks_never_escape(self):
        outside = Path(self.temp.name) / 'private'; outside.mkdir(); (outside / 'secret').write_text('private')
        for path in ('../private/secret', '/etc/passwd', 'folder/../../private', 'C:\\private', 'file:stream', 'folder//file'):
            with self.assertRaises((ValueError, PermissionError)): operate(str(self.root), 'preview', {'path': path})
        self.symlink(self.root / 'link', outside, directory=True)
        self.symlink(self.root / 'secret-link', outside / 'secret')
        for path in ('link/secret', 'secret-link'):
            with self.assertRaises((ValueError, PermissionError)): operate(str(self.root), 'download', {'path': path})
        with self.assertRaises((ValueError, PermissionError)): operate(str(self.root), 'upload', {'path': 'link/new', 'encoded': 'YQ=='})
        self.assertFalse((outside / 'new').exists())
        self.assertEqual(next(x['kind'] for x in self.work.listing()['entries'] if x['name'] == 'link'), 'blocked')

    def test_atomic_upload_retry_collision_and_git_boundary(self):
        data = base64.b64encode('文件🙂'.encode()).decode()
        self.assertFalse(self.work.upload('folder/new.txt', data)['existing'])
        self.assertTrue(self.work.upload('folder/new.txt', data)['existing'])
        with self.assertRaises(ValueError): self.work.upload('folder/new.txt', 'YQ==')
        self.assertEqual((self.root / 'folder/new.txt').read_text(encoding='utf-8'), '文件🙂')
        with self.assertRaises(PermissionError): self.work.upload('.git/config', data)
        with patch('bridge.features.workspace.workspace.os.link', side_effect=OSError('disk error')):
            with self.assertRaises(ValueError): operate(str(self.root), 'upload', {'path': 'failed', 'encoded': data})
        self.assertFalse((self.root / 'failed').exists()); self.assertEqual(list(self.root.rglob('.bridge-upload-*')), [])

    def test_empty_files_and_limits(self):
        self.work.upload('empty', ''); self.assertEqual(self.work.read('empty')['text'], '')
        with self.assertRaises(ValueError): self.work.upload('big', base64.b64encode(b'x' * (MAX_TRANSFER + 1)).decode())
        with (self.root / 'oversize').open('wb') as f: f.truncate(MAX_TRANSFER + 1)
        with self.assertRaises(ValueError): self.work.read('oversize', download=True)

    def test_file_browsing_uses_metadata_without_activating_desktop(self):
        bridge = SimpleNamespace(host='local', store=SimpleNamespace(get=lambda _: {'cwd': str(self.root)}))
        result = Bridge.workspace(bridge, support.THREAD, 'list', {})
        self.assertEqual(result['project'], 'project')
        self.assertEqual(Bridge.workspace(bridge, support.THREAD, 'list', {'recursive': True})['root'], str(self.root.resolve()))

    def test_remote_operations_execute_on_remote_root_and_preserve_errors(self):
        remote = Path(self.temp.name) / 'remote'; remote.mkdir(); (remote / 'remote.txt').write_text('remote')
        store = RemoteStore('fixture-host'); store.get = lambda _: {'cwd': str(remote)}
        bridge = SimpleNamespace(host='remote:fixture', store=store)
        def execute(alias, source, timeout):
            self.assertEqual(alias, 'fixture-host'); output = io.StringIO()
            with contextlib.redirect_stdout(output): exec(compile(source, '<remote-workspace>', 'exec'), {})
            return json.loads(output.getvalue())
        with patch('bridge.app.service.ssh_read', side_effect=execute):
            self.assertEqual(Bridge.workspace(bridge, support.THREAD, 'preview', {'path': 'remote.txt'})['text'], 'remote')
            html = '<h1>Remote gallery</h1><!--' + 'x' * (MAX_PREVIEW + 1) + '-->'
            (remote / 'gallery.html').write_text(html, encoding='utf-8')
            self.assertEqual(Bridge.workspace(bridge, support.THREAD, 'preview', {'path': 'gallery.html'})['text'], html)
            nested = remote / 'nested'; nested.mkdir(); (nested / 'needle.txt').touch()
            page = Bridge.workspace(bridge, support.THREAD, 'list', {'recursive': True, 'search': 'nested/needle'})
            self.assertEqual(page['root'], str(remote.resolve()))
            self.assertEqual(page['project'], 'remote')
            self.assertEqual([row['path'] for row in page['entries']], ['nested/needle.txt'])
            self.assertFalse(page['truncated'])
            with self.assertRaises(ValueError): Bridge.workspace(bridge, support.THREAD, 'preview', {'path': '../project/hello.txt'})


class WorkspaceHttpTests(unittest.TestCase):
    setUpClass = classmethod(support.HttpTests.setUpClass.__func__)
    request = support.HttpTests.request
    login = support.HttpTests.login

    def setUp(self):
        support.HttpTests.setUp(self)
        self.temp = tempfile.TemporaryDirectory(dir=support.ROOT / '.tmp'); self.root = Path(self.temp.name)
        self.server.bridge.workspace = lambda thread, action, params: operate(str(self.root), action, params)
        self.path = '/api/sessions/' + support.THREAD + '/workspace'

    def tearDown(self): support.HttpTests.tearDown(self); self.temp.cleanup()

    def raw(self, path, data, headers):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        connection.request('POST', path, body=data, headers={'Origin': self.origin, **headers})
        response = connection.getresponse(); result = response.status, json.loads(response.read()); connection.close(); return result

    def test_auth_csrf_and_origin_required_for_upload(self):
        self.assertEqual(self.request('GET', self.path)[0], 401)
        auth = self.login(); target = self.path + '/upload?path=test.txt'
        self.assertEqual(self.raw(target, b'text', {'Cookie': auth['Cookie']})[0], 403)
        self.assertEqual(self.raw(target, b'text', {**auth, 'Origin': 'https://evil.example'})[0], 403)
        self.assertFalse((self.root / 'test.txt').exists())
        self.assertEqual(self.raw(target, b'text', auth)[0], 200)
        self.assertEqual(self.request('GET', self.path + '/preview?path=test.txt', headers=auth)[2]['text'], 'text')

    def test_markdown_save_keeps_auth_csrf_schema_and_version_boundaries(self):
        target = self.path + '/save?path=readme.md'
        (self.root / 'readme.md').write_text('# Original', encoding='utf-8')
        version = Workspace(self.root).read('readme.md')['version']
        body = {'text': '# Updated', 'version': version}
        self.assertEqual(self.request('POST', target, body)[0], 401)
        auth = self.login()
        self.assertEqual(self.request('POST', target, body, {'Cookie': auth['Cookie']})[0], 403)
        self.assertEqual(self.raw(target, json.dumps(body).encode(), {**auth, 'Origin': 'https://evil.example', 'Content-Type': 'application/json'})[0], 403)
        self.assertEqual(self.request('GET', target, headers=auth)[0], 405)
        self.assertEqual(self.request('POST', target, {**body, 'force': True}, auth)[0], 400)
        self.assertEqual(self.request('POST', target, body, auth)[2]['outcome'], 'saved')
        self.assertEqual(self.request('POST', target, body, auth)[2]['outcome'], 'conflict')
        self.assertEqual(self.request('POST', self.path + '/save?path=../readme.md', body, auth)[0], 403)
        self.assertEqual((self.root / 'readme.md').read_text(encoding='utf-8'), '# Updated')

    def test_markdown_save_accepts_json_escaping_over_default_body_limit(self):
        (self.root / 'readme.md').write_text('', encoding='utf-8')
        version = Workspace(self.root).read('readme.md')['version']
        text = '中' * 170000  # 510 KB of UTF-8, over 1 MB when JSON-escaped.
        body = json.dumps({'text': text, 'version': version}).encode('utf-8')
        status, result = self.raw(self.path + '/save?path=readme.md', body, {**self.login(), 'Content-Type': 'application/json'})
        self.assertEqual(status, 200)
        self.assertEqual(result['outcome'], 'saved')
        self.assertEqual((self.root / 'readme.md').read_bytes(), text.encode('utf-8'))

    def test_large_html_preview_requires_login_and_keeps_workspace_boundary(self):
        html = '<h1>通知截图</h1><!--' + 'x' * (MAX_PREVIEW + 1) + '-->'
        (self.root / 'gallery.html').write_bytes(html.encode('utf-8'))
        target = self.path + '/preview?path=gallery.html'
        self.assertEqual(self.request('GET', target)[0], 401)
        auth = self.login()
        status, _, result = self.request('GET', target, headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual(result['text'], html)
        self.assertEqual(self.request('GET', self.path + '/preview?path=../outside.html', headers=auth)[0], 403)

    def test_authenticated_binary_download_and_no_overwrite(self):
        auth = self.login(); data = b'\0binary\xff'; target = self.path + '/upload?path=test.apk'
        self.assertEqual(self.raw(target, data, auth)[0], 200)
        self.assertEqual(self.raw(target, b'changed', auth)[0], 400)
        connection = http.client.HTTPConnection('127.0.0.1', self.port)
        connection.request('GET', self.path + '/download?path=test.apk', headers=auth)
        response = connection.getresponse(); self.assertEqual(response.status, 200)
        self.assertIn('attachment', response.getheader('Content-Disposition')); self.assertEqual(response.read(), data); connection.close()
        self.assertEqual(self.request('GET', self.path + '/download?path=../outside', headers=auth)[0], 403)

    def test_static_assets_and_invalid_host(self):
        auth = self.login()
        self.assertEqual(self.request('GET', self.path + '?host=wrong', headers=auth)[0], 404)
        self.assertEqual(self.request('POST', self.path, {}, auth)[0], 405)

    def test_listing_passes_exact_booleans_and_returns_absolute_root(self):
        folder = self.root / 'folder'; folder.mkdir(); (folder / 'needle.txt').touch()
        (self.root / '.hidden').touch()
        calls = []
        def listing(thread, action, params):
            calls.append((thread, action, params))
            return operate(str(self.root), action, params)
        self.server.bridge.workspace = listing
        auth = self.login()
        for suffix, recursive, hidden in (('', False, False), ('?recursive=false&hidden=false', False, False),
                                           ('?recursive=true&hidden=true&search=folder%2Fneedle', True, True)):
            status, _, result = self.request('GET', self.path + suffix, headers=auth)
            self.assertEqual(status, 200)
            self.assertIs(calls[-1][2]['recursive'], recursive)
            self.assertIs(calls[-1][2]['hidden'], hidden)
            self.assertEqual(result['root'], str(self.root.resolve()))
            self.assertEqual(result['project'], self.root.name)
            self.assertFalse(result['truncated'])
        self.assertEqual([row['path'] for row in result['entries']], ['folder/needle.txt'])
        self.assertEqual(calls[-1][:2], (support.THREAD, 'list'))
        self.assertEqual(self.request('GET', self.path + '?recursive=true')[0], 401)

    def test_listing_rejects_ambiguous_or_invalid_boolean_parameters(self):
        auth = self.login()
        for name in ('hidden', 'recursive'):
            for value in ('1', '0', 'True', 'FALSE', '', 'true&' + name + '=false', 'true&' + name + '=true'):
                with self.subTest(name=name, value=value):
                    status, _, _ = self.request('GET', self.path + '?' + name + '=' + value, headers=auth)
                    self.assertEqual(status, 400)

    def test_recursive_http_pagination_and_truncation_contract(self):
        folder = self.root / 'folder'; folder.mkdir()
        for i in range(205): (folder / ('needle-%03d.txt' % i)).touch()
        auth = self.login(); path = self.path + '?recursive=true&search=needle'
        status, _, first = self.request('GET', path, headers=auth)
        self.assertEqual(status, 200)
        status, _, second = self.request('GET', path + '&offset=200', headers=auth)
        self.assertEqual(status, 200)
        self.assertEqual((first['total'], len(first['entries']), first['nextOffset']), (205, 200, 200))
        self.assertEqual((second['total'], len(second['entries']), second['nextOffset']), (205, 5, None))
        self.assertFalse(first['truncated'] or second['truncated'])
        with patch('bridge.features.workspace.workspace.SEARCH_MAX_SCANNED', 1):
            status, _, result = self.request('GET', path, headers=auth)
        self.assertEqual(status, 200)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['truncationReasons'], ['scanLimit'])

    def test_workspace_recursive_query_needs_no_relay_whitelist_change(self):
        query = '?host=remote%3Atest&path=folder&search=needle&hidden=false&recursive=true&offset=200'
        for path in (self.path, '/api/desktop-sessions/claude/workspace'):
            validate_relay_request('GET', path + query)
            with self.assertRaises(PermissionError):
                validate_relay_request('POST', path + query)
