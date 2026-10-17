import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
import test_bridge
from bridge.features.sessions.projects import Projects


class ProjectsHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def setUp(self):
        test_bridge.HttpTests.setUp(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)/'project'; self.folder.mkdir()
        self.server.bridge.project_registry = Projects(Path(self.temp.name)/'data')
        self.server.bridge.hosts = SimpleNamespace(projects=lambda:[], sidebar=lambda:{'sections':[{'id':'work'}]})

    def test_create_requires_login_csrf_and_refuses_gateway_only_storage(self):
        value = {'id':str(uuid.uuid4()), 'name':'Project', 'cwd':str(self.folder), 'sectionId':'work'}
        self.assertEqual(self.request('POST','/api/projects',value)[0],401)
        headers = self.login()
        self.assertEqual(self.request('POST','/api/projects',value,{'Cookie':headers['Cookie']})[0],403)
        status, _, body = self.request('POST','/api/projects',value,headers)
        self.assertEqual(status,400);self.assertIn('原生项目创建接口',body['error'])
        self.assertFalse(self.server.bridge.project_registry.path.exists())

    def test_directory_listing_is_authenticated_and_does_not_read_files(self):
        from urllib.parse import urlencode
        (self.folder/'child').mkdir(); (self.folder/'secret.txt').write_text('sensitive')
        route = '/api/project-directories?'+urlencode({'path':str(self.folder)})
        self.assertEqual(self.request('GET',route)[0],401)
        status, _, body = self.request('GET',route,headers=self.login())
        self.assertEqual(status,200)
        self.assertEqual([row['name'] for row in body['directories']],['child'])

    def test_relay_allows_only_project_creation_and_directory_reads(self):
        from relay.protocol import validate
        validate('POST','/api/projects',100)
        validate('GET','/api/project-directories?path=D%3A%5Cwork')
        with self.assertRaises(PermissionError):
            validate('POST','/api/project-directories',100)

    def test_project_dialog_can_read_fresh_sections_before_chat_list_loads(self):
        self.assertEqual(self.request('GET','/api/projects?metadata=1')[0],401)
        status, _, body = self.request('GET','/api/projects?metadata=1',headers=self.login())
        self.assertEqual(status,200);self.assertEqual(body['sections'],[{'id':'work'}])
        self.assertFalse(body['canCreateProject'])

    def test_operation_receipts_require_authentication_and_unknown_ids_are_rejected(self):
        self.assertEqual(self.request('GET','/api/project-operations?id=unknown')[0],401)
        self.assertEqual(self.request('GET','/api/project-operations?id=unknown',headers=self.login())[0],400)

    def test_native_project_submission_returns_an_async_receipt(self):
        import threading
        gate = threading.Event()
        def create(value, progress):
            gate.wait(1)
            return {'key':'local|native-project'}
        self.server.bridge.project_registry.native_creator=create
        headers=self.login()
        value={'id':str(uuid.uuid4()),'name':'Native','cwd':str(self.folder),'sectionId':None}
        try:
            status,_,body=self.request('POST','/api/projects',value,headers)
            self.assertEqual(status,202)
            self.assertEqual(body['id'],value['id'])
            self.assertEqual(self.request('GET','/api/project-operations?id='+value['id'],headers=headers)[0],200)
        finally:
            gate.set()
            # Wait for the worker to finish before the temporary directory is removed.
            import time
            for _ in range(100):
                if self.server.bridge.project_registry.operation(value['id'])['status']=='completed':break
                time.sleep(.01)
