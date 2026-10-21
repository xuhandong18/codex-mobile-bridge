import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from bridge.features.sessions.create import CreationUnavailable, create_empty, rename_thread, manage_thread, open_in_desktop, CreationError
from bridge.clients.codex.remote import AppHosts
from bridge.app.service import Bridge

ROOT = Path(__file__).resolve().parents[1]


class CreationTests(unittest.TestCase):
    def setUp(self):
        runtime = patch('bridge.clients.codex.catalog.Catalog.find_runtime', return_value=None)
        runtime.start();self.addCleanup(runtime.stop)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT/'.tmp')
        self.root = Path(self.temp.name)
        self.bridge = Bridge(self.root, self.root/'data')
        self.bridge.hosts.state = lambda: {'local-projects': {'p': {'id': 'p', 'name': 'Test', 'rootPaths': [str(self.root)]}}}
        self.bridge.ipc.connect = lambda: None
        self.tid = str(uuid.uuid4())

    def test_rename_persists_name_updates_live_view_and_validates_input(self):
        from bridge.app.service import LiveSession
        session = LiveSession(self.tid)
        session.state = {'id': self.tid, 'title': 'Old'}
        self.bridge.live[self.tid] = session
        with patch.object(self.bridge.store, 'get', return_value={'id': self.tid}), patch('bridge.app.service.rename_thread') as rename:
            result = self.bridge.rename(self.tid, '  New title  ')
            self.assertEqual(result['title'], 'New title')
            self.assertEqual(session.view()['title'], 'New title')
            self.assertEqual(rename.call_args.args[2:], (self.tid, 'New title'))
            for value in ('', ' ', 'x'*121, 'x\ny', 'x\x7fy', 'x\x85y', 'x\u2028y', 'x\u2029y', None):
                with self.assertRaises(ValueError):
                    self.bridge.rename(self.tid, value)
            self.assertEqual(rename.call_count, 1)
            rename.side_effect = CreationError('failed')
            with self.assertRaises(CreationError):
                self.bridge.rename(self.tid, 'Rejected')
            self.assertEqual(session.view()['title'], 'New title')

    def test_remote_rename_uses_remote_runtime_and_clears_list_cache(self):
        from bridge.clients.codex.remote import RemoteStore
        self.bridge.store = RemoteStore('test-host')
        self.bridge.store.cache['old'] = 'cached'
        title = 'quoted " title $()'
        with patch.object(self.bridge.store, 'get', return_value={'id': self.tid}), patch('bridge.app.service.ssh_read', return_value={'ok': True}) as remote:
            self.bridge.rename(self.tid, title)
            self.assertEqual(remote.call_args.args[0], 'test-host')
            self.assertIn('rename_thread(runtime, home', remote.call_args.args[1])
            self.assertNotIn(title, remote.call_args.args[1])
            self.assertFalse(self.bridge.store.cache)

    def test_record_path_is_passive_and_checks_the_codex_home_boundary(self):
        record = self.root / 'sessions' / 'record.jsonl'
        record.parent.mkdir();record.write_text('{}\n')
        with patch.object(self.bridge.store, 'get', return_value={'rollout_path': str(record)}), patch.object(self.bridge, 'activate') as activate:
            self.assertEqual(self.bridge.session_record_path(self.tid)['path'], str(record.resolve()))
            activate.assert_not_called()
        outside = self.root / 'outside.jsonl';outside.write_text('{}\n')
        with patch.object(self.bridge.store, 'get', return_value={'rollout_path': str(outside)}):
            with self.assertRaisesRegex(ValueError, '数据目录'):
                self.bridge.session_record_path(self.tid)

    def test_management_checks_fresh_parent_and_descendant_state_and_delete_confirmation(self):
        child = str(uuid.uuid4())
        with patch.object(self.bridge.store, 'get', return_value={'origin': 'desktop'}), \
             patch.object(self.bridge.store, 'subagents', return_value={'agents': [{'id': child}]}), \
             patch.object(self.bridge, 'assert_desktop_idle') as idle, \
             patch('bridge.app.service.manage_thread') as manage:
            with self.assertRaisesRegex(ValueError, '确认永久删除'):
                self.bridge.manage_session(self.tid, 'delete')
            manage.assert_not_called();idle.assert_not_called()
            self.assertTrue(self.bridge.manage_session(self.tid, 'archive')['confirmed'])
            idle.assert_called_once_with(thread_ids={self.tid, child})
            self.assertEqual(manage.call_args.args[2:], (self.tid, 'archive'))
            idle.side_effect = ValueError('任务运行')
            with self.assertRaisesRegex(ValueError, '任务运行'):
                self.bridge.manage_session(self.tid, 'delete', True)
            self.assertEqual(manage.call_count, 1)

    def test_new_chat_models_reads_selected_project_without_creating_or_activating(self):
        with patch.object(self.bridge.accounts, 'current_models', return_value={'models': [{'id': 'fixture'}]}) as models, \
             patch.object(self.bridge, 'activate') as activate:
            self.assertEqual(self.bridge.new_chat_models('local|p')['models'][0]['id'], 'fixture')
            models.assert_called_once_with(False);activate.assert_not_called()
            with self.assertRaises(ValueError):self.bridge.new_chat_models('local|missing')

    def test_legacy_gateway_projects_are_preserved_but_not_injected_as_native_projects(self):
        path = self.bridge.project_registry.path;path.parent.mkdir(parents=True, exist_ok=True)
        legacy = [{'key':'local|gateway-old', 'host':'local', 'name':'Old gateway project', 'cwd':str(self.root)}]
        path.write_text(json.dumps(legacy))
        self.assertFalse(any(p['key']=='local|gateway-old' for p in self.bridge.hosts.projects()))
        self.assertEqual(json.loads(path.read_text()), legacy)

    def test_automatic_title_does_not_persist_the_placeholder_or_replay_a_different_mode(self):
        request=str(uuid.uuid4())
        with patch('bridge.app.service.create_empty',return_value=self.tid) as create, patch('bridge.app.service.open_in_desktop'):
            self.bridge.create_chat('local|p','新聊天',request,auto_title=True)
            self.assertIsNone(create.call_args.args[-1])
            self.bridge.create_chat('local|p','新聊天',request,auto_title=True)
            create.assert_called_once()
            with self.assertRaises(ValueError):self.bridge.create_chat('local|p','新聊天',request)

    def tearDown(self):
        self.bridge.close()
        self.temp.cleanup()

    def test_duplicate_creation_and_restart_reuse_original_thread(self):
        request = str(uuid.uuid4())
        with patch('bridge.app.service.create_empty', return_value=self.tid) as create, patch('bridge.app.service.open_in_desktop') as opened:
            first = self.bridge.create_chat('local|p', 'Phone test', request)
            second = self.bridge.create_chat('local|p', 'Phone test', request)
            self.assertEqual(first['id'], second['id'])
            self.assertEqual(create.call_count, 1)
            self.assertEqual(opened.call_args.args, (self.tid, 'local'))
            self.bridge.close()
            self.bridge = Bridge(self.root, self.root/'data')
            self.bridge.hosts.projects = lambda: [{'key':'local|p','host':'local','cwd':str(self.root)}]
            self.assertEqual(self.bridge.create_chat('local|p', 'Phone test', request)['id'], self.tid)
            self.assertEqual(create.call_count, 1)
            with self.assertRaises(ValueError):self.bridge.create_chat('local|p', 'Other', request)

    def test_independent_chat_needs_no_saved_project_and_is_idempotent(self):
        self.bridge.hosts.state = lambda: {}
        request = str(uuid.uuid4())
        with patch('bridge.app.service.create_empty', return_value=self.tid) as create, patch('bridge.app.service.open_in_desktop'):
            first = self.bridge.create_chat('local|independent', 'No project', request)
            second = self.bridge.create_chat('local|independent', 'No project', request)
            self.assertEqual(first['id'], second['id'])
            self.assertEqual(create.call_count, 1)
            directory = Path(create.call_args.args[2])
            self.assertTrue(directory.is_dir())
            self.assertEqual(directory, (self.root / 'data/independent-chats' / request).resolve())
        with patch('bridge.app.service.create_empty', side_effect=CreationError('unknown')) as create:
            request = str(uuid.uuid4())
            for _ in range(2):
                with self.assertRaises(CreationError): self.bridge.create_chat('local|independent', 'Unknown', request)
            self.assertEqual(create.call_count, 1)

    def test_independent_chat_does_not_inherit_project_containing_gateway_data(self):
        request = str(uuid.uuid4())
        rows = []
        saved_state = self.bridge.hosts.state()

        def create(executable, home, cwd, title):
            rows.append({'id': self.tid, 'cwd': cwd, 'project_id': None, 'origin': 'desktop'})
            return self.tid

        with patch('bridge.app.service.create_empty', side_effect=create) as created, \
             patch('bridge.app.service.open_in_desktop'):
            result = self.bridge.create_chat('local|independent', 'No project', request)
            for restarted in (False, True):
                if restarted:
                    self.bridge.close()
                    self.bridge = Bridge(self.root, self.root/'data')
                    self.bridge.hosts.state = lambda: saved_state
                with self.subTest(restarted=restarted), \
                     patch.object(self.bridge.store, 'list', side_effect=lambda **kwargs: [dict(row) for row in rows]), \
                     patch.object(self.bridge, '_save_creations') as saved:
                    row = next(row for row in self.bridge.list() if row['id'] == result['id'])
                    self.assertEqual(row['projectKey'], 'local|independent')
                    self.assertEqual(row['projectName'], '独立聊天')
                    self.assertEqual(row['cwd'], rows[0]['cwd'])
                    saved.assert_not_called()
            created.assert_called_once()

    def test_selected_project_survives_overlapping_roots_and_gateway_restart(self):
        request = str(uuid.uuid4())
        saved_state = {'local-projects': {
            'skills': {'id': 'skills', 'name': 'Skills',
                       'rootPaths': [str(self.root / 'skills'), str(self.root)]},
            'p': {'id': 'p', 'name': 'Selected', 'rootPaths': [str(self.root)]},
        }}
        self.bridge.hosts.state = lambda: saved_state
        rows = []

        def create(executable, home, cwd, title):
            rows.append({'id': self.tid, 'cwd': cwd, 'project_id': None, 'origin': 'desktop'})
            return self.tid

        with patch('bridge.app.service.create_empty', side_effect=create) as created, \
             patch('bridge.app.service.open_in_desktop'):
            result = self.bridge.create_chat('local|p', 'Selected project', request)
            self.assertEqual(rows[0]['cwd'], str(self.root))
            for restarted in (False, True):
                if restarted:
                    self.bridge.close()
                    self.bridge = Bridge(self.root, self.root/'data')
                    self.bridge.hosts.state = lambda: saved_state
                with self.subTest(restarted=restarted), \
                     patch.object(self.bridge.store, 'list', side_effect=lambda **kwargs: [dict(row) for row in rows]), \
                     patch.object(self.bridge, '_save_creations') as saved:
                    row = next(row for row in self.bridge.list() if row['id'] == result['id'])
                    self.assertEqual(row['projectKey'], 'local|p')
                    self.assertEqual(row['projectName'], 'Selected')
                    self.assertEqual(row['cwd'], str(self.root))
                    saved.assert_not_called()
            created.assert_called_once()

    def test_creation_project_display_is_scoped_to_desktop_and_host(self):
        self.bridge.hosts.state = lambda: {'local-projects': {
            'other': {'id': 'other', 'name': 'Other', 'rootPaths': [str(self.root)]},
            'p': {'id': 'p', 'name': 'Selected', 'rootPaths': [str(self.root)]},
        }}
        for kind, host, confirmed in (('desktop', 'local', True), ('cli', 'local', True),
                                      ('desktop', 'remote', True), ('desktop', 'local', False)):
            entry = {'project': 'local|p', 'kind': kind, 'host': host}
            if confirmed:
                entry['id'] = self.tid
            self.bridge.creations = {'request': entry}
            with self.subTest(kind=kind, host=host, confirmed=confirmed), \
                 patch.object(self.bridge.store, 'list', side_effect=lambda **kwargs: [
                     {'id': self.tid, 'cwd': str(self.root), 'project_id': None, 'origin': 'desktop'}]):
                row = self.bridge.list()[0]
                expected = 'local|p' if kind == 'desktop' and host == 'local' and confirmed else 'local|other'
                self.assertEqual(row['projectKey'], expected)

    def test_independent_directory_failure_is_safe_to_retry(self):
        request = str(uuid.uuid4())
        with patch('bridge.features.sessions.create.Path.mkdir', side_effect=PermissionError('read only')):
            with self.assertRaises(CreationUnavailable): self.bridge.create_chat('local|independent', 'Retry', request)
        self.assertNotIn(request, self.bridge.creations)
        with patch('bridge.app.service.create_empty', return_value=self.tid) as create, patch('bridge.app.service.open_in_desktop'):
            self.bridge.create_chat('local|independent', 'Retry', request)
            self.assertEqual(create.call_count, 1)

    def test_unknown_result_is_not_replayed(self):
        request = str(uuid.uuid4())
        with patch('bridge.app.service.create_empty', side_effect=CreationError('timeout')) as create:
            with self.assertRaises(CreationError):self.bridge.create_chat('local|p', 'Test', request)
            with self.assertRaisesRegex(CreationError, '避免重复'):self.bridge.create_chat('local|p', 'Test', request)
            self.assertEqual(create.call_count, 1)
            self.assertNotIn('id', json.loads(self.bridge.creations_path.read_text())[request])

    def test_failed_desktop_open_keeps_created_id(self):
        with patch('bridge.app.service.create_empty', return_value=self.tid), patch('bridge.app.service.open_in_desktop', side_effect=OSError()):
            result = self.bridge.create_chat('local|p', 'Test', str(uuid.uuid4()))
            self.assertEqual(result['id'], self.tid)
            self.assertFalse(result['opened'])

    def test_blocked_desktop_open_reuses_created_id_after_retry_and_gateway_restart(self):
        request = str(uuid.uuid4())
        with patch('bridge.app.service.create_empty', return_value=self.tid) as create, \
             patch('bridge.app.service.open_in_desktop', side_effect=CreationError('桌面暂不可交互')) as opened:
            for _ in range(2):
                result = self.bridge.create_chat('local|p', 'Test', request)
                self.assertEqual(result['id'], self.tid)
                self.assertFalse(result['opened'])
            self.assertEqual(json.loads(self.bridge.creations_path.read_text())[request]['id'], self.tid)
            self.bridge.close()
            self.bridge = Bridge(self.root, self.root/'data')
            self.bridge.hosts.projects = lambda: [{'key': 'local|p', 'host': 'local', 'cwd': str(self.root)}]
            opened.side_effect = None
            result = self.bridge.create_chat('local|p', 'Test', request)
            self.assertEqual(result['id'], self.tid)
            self.assertTrue(result['opened'])
            create.assert_called_once()

    def test_only_saved_project_and_valid_title_are_accepted(self):
        with patch('bridge.app.service.create_empty') as create:
            for project,title,request in [('unknown','ok',str(uuid.uuid4())),('local|p',' ',str(uuid.uuid4())),('local|p','a'*121,str(uuid.uuid4())),('local|p','ok',None)]:
                with self.assertRaises(ValueError):self.bridge.create_chat(project,title,request)
            create.assert_not_called()

    def test_cli_creation_uses_known_cli_directory_and_never_opens_desktop(self):
        cwd = str(self.root)
        self.bridge.store.list = lambda **kwargs: [{'origin': 'cli', 'cwd': cwd}]
        project = next(p for p in self.bridge.projects() if p['type'] == 'cli')
        with patch.object(self.bridge.cli_sessions, 'create', return_value={'id': self.tid, 'cwd': cwd,
                'modelProvider': 'openai', 'turns': [], 'requests': []}) as created, \
             patch('bridge.app.service.open_in_desktop') as opened:
            request = str(uuid.uuid4())
            first = self.bridge.create_chat(project['key'], 'CLI chat', request, kind='cli')
            second = self.bridge.create_chat(project['key'], 'CLI chat', request, kind='cli')
            self.assertEqual(first['id'], self.tid)
            self.assertEqual(second['id'], self.tid)
            self.assertFalse(first['opened'])
            self.assertEqual(created.call_args.args, (cwd, 'CLI chat'))
            self.assertIn('on_start', created.call_args.kwargs)
            self.assertIn('on_created', created.call_args.kwargs)
            opened.assert_not_called()
        with self.assertRaises(ValueError):
            self.bridge.create_chat(project['key'], 'CLI chat', request, kind='desktop')

    def test_cli_creation_does_not_replay_unknown_started_request(self):
        from bridge.clients.codex.app_server import AppServerUnavailable
        self.bridge.store.list = lambda **kwargs: [{'origin': 'cli', 'cwd': str(self.root)}]
        project = next(p for p in self.bridge.projects() if p['type'] == 'cli')
        request = str(uuid.uuid4())
        def uncertain(cwd, title, on_start, on_created):
            on_start()
            raise AppServerUnavailable('timeout after thread/start')
        with patch.object(self.bridge.cli_sessions, 'create', side_effect=uncertain) as create:
            with self.assertRaises(AppServerUnavailable):
                self.bridge.create_chat(project['key'], 'CLI chat', request, kind='cli')
            with self.assertRaises(CreationError):
                self.bridge.create_chat(project['key'], 'CLI chat', request, kind='cli')
            self.assertEqual(create.call_count, 1)

    def test_remote_creation_keeps_host_and_literal_payload(self):
        host='remote-ssh-discovered:test'
        self.bridge.hosts.state=lambda:{'remote-projects':[{'id':'r','hostId':host,'remotePath':'/remote/project'}],
                                      'codex-managed-remote-connections':[{'hostId':host,'alias':'test'}]}
        with patch('bridge.app.service.ssh_read', return_value={'id':self.tid}) as remote, patch('bridge.app.service.open_in_desktop') as opened:
            result=self.bridge.create_chat(host+'|r', 'quoted " title $()', str(uuid.uuid4()))
            self.assertEqual(result['host'],host)
            self.assertEqual(remote.call_args.args[0],'test')
            self.assertNotIn('quoted " title $()',remote.call_args.args[1])
            self.assertIn('create_empty(runtime, home',remote.call_args.args[1])
            opened.assert_called_once_with(self.tid,host)

    def test_runtime_only_initializes_creates_names_and_materializes(self):
        script=self.root/'runtime.py'
        log=self.root/'calls.json'
        script.write_text('''import json,sys
from pathlib import Path
calls=[]
for line in sys.stdin:
 r=json.loads(line);calls.append(r)
 if 'id' not in r:continue
 result={'thread':{'id':''' + repr(self.tid) + ''', 'path':str(Path('rollout.jsonl').resolve())}} if r['method'] in ('thread/start','thread/read') else {}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
Path('rollout.jsonl').write_text('{}')
Path(''' + repr(str(log)) + ''').write_text(json.dumps(calls))
''',encoding='utf-8')
        real_popen=subprocess.Popen
        def spawn(argv,**kwargs):
            self.assertEqual(argv,['runtime','app-server','--listen','stdio://'])
            if os.name == 'nt':
                self.assertEqual(kwargs.get('creationflags'),subprocess.CREATE_NO_WINDOW)
            return real_popen([sys.executable,str(script)],**kwargs)
        with patch('bridge.features.sessions.create.subprocess.Popen',side_effect=spawn):
            self.assertEqual(create_empty('runtime',self.root,str(self.root),'test'),self.tid)
        calls=json.loads(log.read_text())
        self.assertEqual([c['method'] for c in calls],['initialize','initialized','thread/start','thread/name/set','thread/read'])
        self.assertEqual(calls[-1]['params'],{'threadId':self.tid,'includeTurns':True})
        self.assertEqual(calls[2]['params'],{'cwd':str(self.root),'ephemeral':False})
        with patch('bridge.features.sessions.create.subprocess.Popen',side_effect=spawn):
            create_empty('runtime',self.root,str(self.root),None)
        calls=json.loads(log.read_text())
        self.assertEqual([c['method'] for c in calls],['initialize','initialized','thread/start','thread/read'])
        with patch('bridge.features.sessions.create.subprocess.Popen',side_effect=spawn):
            rename_thread('runtime', self.root, self.tid, 'Renamed')
        calls=json.loads(log.read_text())
        self.assertEqual([c['method'] for c in calls], ['initialize','initialized','thread/name/set'])
        self.assertEqual(calls[-1]['params'], {'threadId': self.tid, 'name': 'Renamed'})
        for action in ('archive', 'unarchive', 'delete'):
            with patch('bridge.features.sessions.create.subprocess.Popen',side_effect=spawn):
                manage_thread('runtime', self.root, self.tid, action)
            calls=json.loads(log.read_text())
            self.assertEqual([c['method'] for c in calls], ['initialize','initialized','thread/'+action])
            self.assertEqual(calls[-1]['params'], {'threadId':self.tid})

    def test_deep_link_encodes_host_and_never_invokes_shell(self):
        with patch('bridge.features.sessions.create.sys.platform','darwin'),patch('bridge.features.sessions.create.subprocess.run') as run:
            open_in_desktop(self.tid,'remote:test & other')
            self.assertEqual(run.call_args.args[0],['open','codex://threads/'+self.tid+'?hostId=remote%3Atest+%26+other'])
            self.assertNotIn('shell',run.call_args.kwargs)

    @unittest.skipUnless(os.name == 'nt', 'Windows desktop URL handler')
    def test_windows_deep_link_uses_registered_handler(self):
        with patch('bridge.features.sessions.create.os.startfile') as opened:
            open_in_desktop(self.tid,'remote:test & other')
            opened.assert_called_once_with('codex://threads/'+self.tid+'?hostId=remote%3Atest+%26+other')
