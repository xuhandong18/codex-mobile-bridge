import json
import queue
import struct
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge.clients.codex.desktop_tools import DesktopTools, ToolError
from bridge.clients.codex.projects import NativeProjects, within
from bridge.features.sessions.projects import Projects


class ProjectOperationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root/'workspace'; self.folder.mkdir()
        self.value = {'id':str(uuid.uuid4()),'name':'Native','cwd':str(self.folder),'sectionId':None}

    def wait(self, projects, statuses):
        deadline = time.monotonic()+3
        while time.monotonic() < deadline:
            result = projects.operation(self.value['id'])
            if result['status'] in statuses:
                return result
            time.sleep(.01)
        self.fail('Operation did not finish')

    def test_pending_duplicate_and_completed_retry_do_not_replay_native_write(self):
        gate = threading.Event()
        calls = []
        def create(value, progress):
            calls.append(value)
            gate.wait(2)
            return {'key':'local|native','name':'Native','cwd':str(self.folder)}
        projects = Projects(self.root/'data', create)
        projects.submit(self.value, [], [])
        projects.submit(self.value, [], [])
        with self.assertRaises(ValueError):
            projects.submit({**self.value,'name':'Changed'}, [], [])
        gate.set()
        self.assertEqual(self.wait(projects, {'completed'})['project']['key'], 'local|native')
        projects.submit(self.value, [{'host':'local','cwd':str(self.folder)}], [])
        self.assertEqual(len(calls),1)
        self.assertFalse(projects.path.exists())

    def test_restart_marks_unfinished_result_unknown_without_native_replay(self):
        data = self.root/'data'; data.mkdir()
        (data/'project-operations.json').write_text(json.dumps({self.value['id']:{'id':self.value['id'],
            'fingerprint':'test','status':'creating','message':'pending'}}))
        create = Mock()
        restored = Projects(data, create)
        self.assertEqual(restored.operation(self.value['id'])['status'],'unknown')
        create.assert_not_called()

    def test_timeout_is_unknown_and_same_folder_cannot_be_submitted_with_new_uuid(self):
        def create(value, progress):
            raise ToolError('unconfirmed', unknown=True)
        projects = Projects(self.root/'data', create)
        projects.submit(self.value, [], [])
        self.assertEqual(self.wait(projects, {'unknown'})['status'],'unknown')
        with self.assertRaisesRegex(ValueError,'不要重复创建'):
            projects.submit({**self.value,'id':str(uuid.uuid4())}, [], [])

    def test_section_failure_keeps_created_project_and_reports_partial(self):
        def create(value, progress):
            error = ToolError('section failed')
            error.project = {'key':'local|already-created'}
            raise error
        projects = Projects(self.root/'data', create)
        projects.submit(self.value, [], [])
        result = self.wait(projects, {'partial'})
        self.assertEqual(result['project']['key'],'local|already-created')
        self.assertFalse(projects.path.exists())


class NativeProjectDelegationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root/'child'; self.folder.mkdir()
        self.identifier = str(uuid.uuid4())
        self.row = {'projectId':self.identifier,'label':'Native','path':str(self.folder)}
        self.project = {'key':'local|'+self.identifier,'name':'Native','cwd':str(self.folder),'host':'local'}
        self.bridge = SimpleNamespace(store=SimpleNamespace(list=lambda **k:[{'id':str(uuid.uuid4()), 'cwd':str(self.root), 'origin':'desktop', 'host':'local'}]),
            accounts=SimpleNamespace(index={'desktopExecutable':'Codex.exe'}),catalog_reader=SimpleNamespace(executable='runtime'),
            hosts=SimpleNamespace(projects=lambda:[{'key':'local|existing','host':'local'}],sidebar=lambda:{'sections':[], 'projects':[self.project]}))
        self.bridge.host = 'local'
        self.bridge.accounts.gate = threading.Lock()
        self.request = {'id':str(uuid.uuid4()),'name':'Native','cwd':str(self.folder),'sectionId':None}

    def test_directory_scope_only_reads_native_roots_and_holds_account_gate(self):
        native = Mock()
        native.call.return_value = {'hosts':[{'hostId':'local', 'workspaceRoots':[str(self.root), str(self.folder)]}]}
        context_id = str(uuid.uuid4())
        self.bridge.store.get = Mock(return_value={'id':context_id, 'origin':'desktop', 'host':'local'})
        value = {'parent':str(self.folder), 'contextId':context_id}
        with patch.object(NativeProjects, 'available', True), patch.object(DesktopTools, 'connect', return_value=native) as connect:
            with NativeProjects(self.bridge).directory_scope(value) as root:
                self.assertEqual(root, self.folder.resolve())
                self.assertFalse(self.bridge.accounts.gate.acquire(blocking=False))
                native.close.assert_not_called()
            self.assertTrue(self.bridge.accounts.gate.acquire(blocking=False))
            self.bridge.accounts.gate.release()
        connect.assert_called_once_with('Codex.exe', context_id, {'existing'})
        native.call.assert_called_once_with('list_hosts', {})
        native.close.assert_called_once()

    def test_directory_scope_gate_is_held_during_context_connect_and_live_authorization(self):
        native = Mock()
        def authorize(*args):
            self.assertFalse(self.bridge.accounts.gate.acquire(blocking=False))
            return {'hosts':[{'hostId':'local', 'workspaceRoots':[str(self.root)]}]}
        native.call.side_effect = authorize
        context_id = str(uuid.uuid4())
        def context(**kwargs):
            self.assertFalse(self.bridge.accounts.gate.acquire(blocking=False))
            return [{'id':context_id, 'origin':'desktop', 'host':'local', 'cwd':str(self.root)}]
        self.bridge.store.list = context
        def connect(*args):
            self.assertFalse(self.bridge.accounts.gate.acquire(blocking=False))
            return native
        with patch.object(NativeProjects, 'available', True), patch.object(DesktopTools, 'connect', side_effect=connect):
            with self.assertRaisesRegex(RuntimeError, 'fixture cancellation'):
                with NativeProjects(self.bridge).directory_scope({'parent':str(self.folder)}):
                    raise RuntimeError('fixture cancellation')
        native.close.assert_called_once()
        self.assertTrue(self.bridge.accounts.gate.acquire(blocking=False))
        self.bridge.accounts.gate.release()

    def test_directory_scope_rejects_unavailable_missing_gate_and_remote_context(self):
        creator = NativeProjects(self.bridge)
        with patch.object(DesktopTools, 'connect') as connect:
            with patch.object(NativeProjects, 'available', False), self.assertRaises(ToolError):
                with creator.directory_scope({'parent':str(self.folder)}):
                    self.fail('Unsupported platform authorized')
            with patch.object(NativeProjects, 'available', True):
                self.bridge.accounts.gate = None
                with self.assertRaisesRegex(ToolError, '账号操作锁'):
                    with creator.directory_scope({'parent':str(self.folder)}):
                        self.fail('Missing gate authorized')
                self.bridge.accounts.gate = threading.Lock()
                for row in ({'id':'fixture', 'origin':'desktop', 'host':'ssh-fixture'}, {'id':'fixture', 'origin':'cli'}):
                    self.bridge.store.get = Mock(return_value=row)
                    with self.subTest(row=row), self.assertRaisesRegex(ToolError, '本机'):
                        with creator.directory_scope({'parent':str(self.folder), 'contextId':str(uuid.uuid4())}):
                            self.fail('Non-local desktop context authorized')
            connect.assert_not_called()

    def test_directory_scope_live_root_denial_and_malformed_results_never_write(self):
        results = [
            {'hosts':[{'hostId':'local', 'workspaceRoots':[str(self.folder/'unapproved')]}]},
            {'hosts':[{'hostId':'ssh-fixture', 'workspaceRoots':[str(self.root)]}]},
            {'hosts':[{'hostId':'local', 'workspaceRoots':str(self.root)}]},
            {'hosts':[{'hostId':'local', 'workspaceRoots':['relative']}]},
            {'hosts':[{'hostId':'local', 'workspaceRoots':[None]}]},
            {'hosts':[{'hostId':'local', 'workspaceRoots':[str(self.root)]}]*2},
            {'hosts':None}, {'hosts':[None]}, {'hosts':[]},
        ]
        for result in results:
            native = Mock()
            native.call.return_value = result
            with self.subTest(result=result), patch.object(NativeProjects, 'available', True), \
                    patch.object(DesktopTools, 'connect', return_value=native), self.assertRaises(ToolError):
                with NativeProjects(self.bridge).directory_scope({'parent':str(self.folder)}):
                    self.fail('Invalid root authorized')
            native.call.assert_called_once_with('list_hosts', {})
            native.close.assert_called_once()

    def test_directory_worker_keeps_gate_until_mkdir_and_never_sends_project_write(self):
        from bridge.features.workspace.workspace import Workspace
        native = Mock()
        native.call.return_value = {'hosts':[{'hostId':'local', 'workspaceRoots':[str(self.root)]}]}
        mkdir = Workspace.mkdir
        def guarded(workspace, path, name):
            self.assertFalse(self.bridge.accounts.gate.acquire(blocking=False))
            native.close.assert_not_called()
            return mkdir(workspace, path, name)
        creator = NativeProjects(self.bridge)
        value = {'id':str(uuid.uuid4()), 'parent':str(self.folder), 'name':'fixture-directory'}
        with patch.object(NativeProjects, 'available', True), patch.object(DesktopTools, 'connect', return_value=native), \
                patch.object(Workspace, 'mkdir', new=guarded):
            projects = Projects(self.root/'directory-data', creator)
            projects.submit_directory(value)
            deadline = time.monotonic()+3
            while time.monotonic() < deadline:
                receipt = projects.directory_operation(value['id'])
                if receipt['status'] in ('completed', 'failed', 'unknown'):
                    break
                time.sleep(.01)
            self.assertEqual(receipt['status'], 'completed', receipt)
        native.call.assert_called_once_with('list_hosts', {})
        native.close.assert_called_once()
        self.assertTrue((self.folder/'fixture-directory').is_dir())

    @unittest.skipUnless(__import__('os').name=='nt','Windows path semantics')
    def test_extended_windows_cwd_matches_normal_native_workspace_root(self):
        self.assertTrue(within(str(self.folder),'\\\\?\\'+str(self.root)))
        self.assertFalse(within(str(self.root),'\\\\?\\'+str(self.folder)))

    def test_native_dialog_rejection_does_not_retry_as_a_scoped_tool_write(self):
        from bridge.platforms.windows.projects import ProjectUIError
        native = Mock()
        native.call.side_effect = [{'hosts':[{'hostId':'local','workspaceRoots':[]}]}, {'projects':[]}]
        creator = NativeProjects(self.bridge, project_creator=Mock(side_effect=ProjectUIError('用户取消创建')))
        with patch.object(DesktopTools,'connect',return_value=native), self.assertRaisesRegex(ToolError,'用户取消') as caught:
            creator(self.request,Mock())
        self.assertFalse(caught.exception.unknown)
        self.assertEqual([c.args[0] for c in native.call.call_args_list],['list_hosts','list_projects'])
        native.close.assert_called_once()

    def test_malformed_native_roots_or_projects_never_open_a_create_dialog(self):
        for results in ([{'hosts':None}], [{'hosts':[{'hostId':'local','workspaceRoots':'invalid'}]}],
                        [{'hosts':[{'hostId':'local','workspaceRoots':[]}]}, {'projects':None}],
                        [{'hosts':[{'hostId':'local','workspaceRoots':[]}]}, {'projects':[{'projectId':'missing-path'}]}]):
            native, ui = Mock(), Mock()
            native.call.side_effect = results
            with self.subTest(results=results), patch.object(DesktopTools, 'connect', return_value=native), self.assertRaises(ToolError):
                NativeProjects(self.bridge, project_creator=ui)(self.request, Mock())
            ui.assert_not_called()
            native.close.assert_called_once()

    def test_unconfirmed_native_create_receipt_is_unknown_and_never_assigned(self):
        native = Mock()
        native.call.side_effect = [{'hosts':[{'hostId':'local','workspaceRoots':[]}]}, {'projects':[]}]
        ui = Mock(return_value=None)
        with patch.object(DesktopTools, 'connect', return_value=native), self.assertRaises(ToolError) as caught:
            NativeProjects(self.bridge, project_creator=ui)(self.request, Mock())
        self.assertTrue(caught.exception.unknown)
        self.assertEqual([call.args[0] for call in native.call.call_args_list], ['list_hosts','list_projects'])
        ui.assert_called_once()

    def test_project_list_creation_uses_native_project_dialog_without_a_matching_chat(self):
        self.bridge.store.list = lambda **kwargs:[{'id':str(uuid.uuid4()), 'origin':'desktop', 'host':'local', 'cwd':str(self.folder/'other-project')}]
        native = Mock()
        native.call.side_effect = [
            {'hosts':[{'hostId':'local','workspaceRoots':[]}]},
            {'projects':[]}, {'projects':[self.row]}, {'projects':[self.row]}, {},
            {'sections':[{'sectionId':'threads','itemKeys':['codex:project:'+self.identifier]}]}]
        creator = NativeProjects(self.bridge)
        creator.project_creator = Mock(return_value={'submitted':True})
        with patch.object(DesktopTools, 'connect', return_value=native):
            result = creator(self.request, Mock())
        self.assertEqual(result, self.project)
        creator.project_creator.assert_called_once_with('Codex.exe', self.request['name'], self.request['cwd'])
        self.assertNotIn('create_project', [call.args[0] for call in native.call.call_args_list])
        self.assertEqual([call.args[0] for call in native.call.call_args_list], ['list_hosts','list_projects','list_projects','list_projects','move_project_to_sidebar_section','list_threads'])

    def test_new_directory_project_finishes_only_after_custom_section_is_saved(self):
        section_id = str(uuid.uuid4())
        self.request['sectionId'] = section_id
        section = {'id':section_id, 'name':'学习', 'itemKeys':['codex:project:'+self.identifier]}
        self.bridge.hosts.sidebar = lambda:{'sections':[section], 'projects':[self.project]}
        native = Mock()
        native.call.side_effect = [
            {'hosts':[{'hostId':'local','workspaceRoots':[]}]}, {'projects':[]},
            {'projects':[self.row]}, {'projects':[self.row]}, {},
            {'sections':[{'sectionId':section_id,'itemKeys':section['itemKeys']}]}]
        ui = Mock(return_value={'submitted':True})
        with patch.object(DesktopTools, 'connect', return_value=native):
            self.assertEqual(NativeProjects(self.bridge, project_creator=ui)(self.request, Mock()), self.project)
        native.call.assert_any_call('move_project_to_sidebar_section', {'projectId':self.identifier, 'sectionId':section_id})
        ui.assert_called_once()

    def test_success_requires_native_project_and_section_then_persisted_readback(self):
        native = Mock()
        native.call.side_effect = [
            {'hosts':[{'hostId':'local','workspaceRoots':[str(self.root)]}]},
            {'projectId':self.identifier,'rootPaths':[str(self.folder)]}, {'projects':[self.row]}, {},
            {'sections':[{'sectionId':'threads','itemKeys':['codex:project:'+self.identifier]}]}]
        with patch.object(DesktopTools,'connect',return_value=native):
            result = NativeProjects(self.bridge)(self.request,Mock())
        self.assertEqual(result,self.project)
        writes=[c for c in native.call.call_args_list if c.args[0]=='create_project']
        self.assertEqual(len(writes),1)
        self.assertEqual(writes[0].args[1],{'name':'Native','sources':[str(self.folder)],'host':{'type':'local'}})

    def test_native_dialog_allows_time_for_manual_trust_without_resubmitting_creation(self):
        clock = [0.0]
        def call(method, arguments):
            if method == 'list_hosts':
                return {'hosts':[{'hostId':'local', 'workspaceRoots':[]}]}
            if method == 'list_projects':
                return {'projects':[self.row] if clock[0] >= 20 else []}
            if method == 'list_threads':
                return {'sections':[{'sectionId':'threads','itemKeys':['codex:project:'+self.identifier]}]}
            return {}
        native, ui = Mock(), Mock(return_value={'submitted':True})
        native.call.side_effect = call
        with patch.object(DesktopTools,'connect',return_value=native), \
                patch('bridge.clients.codex.projects.time.monotonic', side_effect=lambda:clock[0]), \
                patch('bridge.clients.codex.projects.time.sleep', side_effect=lambda seconds:clock.__setitem__(0,clock[0]+seconds)):
            result = NativeProjects(self.bridge, project_creator=ui)(self.request, Mock())
        self.assertEqual(result, self.project)
        ui.assert_called_once()
        self.assertGreaterEqual(clock[0], 20)


class ToolProtocolTests(unittest.TestCase):
    def test_framing_and_allowlist_with_fragmented_response(self):
        class Stream:
            def __init__(self):
                self.incoming=queue.Queue();self.sent=[]
            def sendall(self,data):
                message=json.loads(data[4:]);self.sent.append(message)
                response=json.dumps({'jsonrpc':'2.0','id':message['id'],'result':{
                    'success':True,'contentItems':[{'type':'inputText','text':'{"projects":[]}'}]}}).encode()
                frame=struct.pack('<I',len(response))+response
                for byte in frame:self.incoming.put(bytes([byte]))
            def recv(self,size):return self.incoming.get(timeout=2)
            def close(self):self.incoming.put(b'')
        stream=Stream();client=DesktopTools(stream,str(uuid.uuid4()))
        try:
            self.assertEqual(client.call('list_projects',{}),{'projects':[]})
            with self.assertRaises(ToolError):client.call('turn/start',{})
            self.assertEqual(len(stream.sent),1)
            self.assertEqual(stream.sent[0]['params']['namespace'],'codex_app')
        finally:client.close()
