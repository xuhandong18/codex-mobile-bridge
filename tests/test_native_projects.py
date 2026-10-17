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
        self.bridge = SimpleNamespace(store=SimpleNamespace(list=lambda **k:[{'id':str(uuid.uuid4()),'cwd':str(self.root)}]),
            accounts=SimpleNamespace(index={'desktopExecutable':'Codex.exe'}),catalog_reader=SimpleNamespace(executable='runtime'),
            hosts=SimpleNamespace(projects=lambda:[{'key':'local|existing','host':'local'}],sidebar=lambda:{'sections':[], 'projects':[self.project]}))
        self.request = {'id':str(uuid.uuid4()),'name':'Native','cwd':str(self.folder),'sectionId':None}

    @unittest.skipUnless(__import__('os').name=='nt','Windows path semantics')
    def test_extended_windows_cwd_matches_normal_native_workspace_root(self):
        self.assertTrue(within(str(self.folder),'\\\\?\\'+str(self.root)))
        self.assertFalse(within(str(self.root),'\\\\?\\'+str(self.folder)))

    def test_native_permission_failure_never_sends_create(self):
        native = Mock()
        native.call.return_value = {'hosts':[{'hostId':'local','workspaceRoots':[str(self.folder/'unapproved')]}]}
        with patch.object(DesktopTools,'connect',return_value=native), self.assertRaisesRegex(ToolError,'获准'):
            NativeProjects(self.bridge)(self.request,Mock())
        self.assertEqual([c.args[0] for c in native.call.call_args_list],['list_hosts'])
        native.close.assert_called_once()

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
