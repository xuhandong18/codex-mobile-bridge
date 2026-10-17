import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
import test_bridge
from bridge.features.sessions.projects import Projects
import test_project_directories as directory_support


class ProjectsHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def wait_selected_directory(self, identifier, headers):
        import time
        for _ in range(100):
            status, _, body = self.request('GET', '/api/project-directory-operations?id='+identifier, headers=headers)
            self.assertEqual(status, 200)
            if body['status'] not in ('pending', 'creating'):
                return body
            time.sleep(.01)
        self.fail('Directory creation did not finish')

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

    def test_folder_browser_creates_a_project_sibling_without_a_matching_chat(self):
        from urllib.parse import urlencode
        from unittest.mock import Mock
        creator = SimpleNamespace(available=True, directory_scope=Mock(side_effect=ValueError('请先打开一个关联目录的本机 Codex 桌面聊天，再创建项目')))
        registry = self.server.bridge.project_registry
        registry.native_creator = creator
        headers = self.login()
        status, _, listing = self.request('GET', '/api/project-directories?'+urlencode({'path':str(self.folder.parent)}), headers=headers)
        self.assertEqual(status, 200)
        self.assertIn('selectionId', listing, 'Browsing the selected parent must authorize only single-folder creation there, without a chat lookup')
        value = {'id':str(uuid.uuid4()), 'parent':listing['path'], 'name':'LearningBitcoin', 'selectionId':listing['selectionId']}
        status, _, _ = self.request('POST', '/api/project-directories', value, headers)
        self.assertEqual(status, 202)
        result = self.wait_selected_directory(value['id'], headers)
        self.assertEqual(result['status'], 'completed', result)
        self.assertTrue((self.folder.parent/'LearningBitcoin').is_dir())
        creator.directory_scope.assert_not_called()

    def test_metadata_advertises_directory_creation_only_when_the_handler_is_available(self):
        registry = self.server.bridge.project_registry
        headers = self.login()
        for creator, project, directory in ((None, False, False),
                (SimpleNamespace(available=True), True, False),
                (directory_support.DirectoryCreator(self.folder), True, True),
                (SimpleNamespace(available=False, directory_scope=lambda value:None), False, False)):
            registry.native_creator = creator
            status, _, body = self.request('GET', '/api/projects?metadata=1', headers=headers)
            self.assertEqual(status, 200)
            self.assertIs(body['canCreateProject'], project)
            self.assertIs(body['canCreateDirectory'], directory)

    def test_parent_selection_is_bound_to_login_path_and_csrf(self):
        from urllib.parse import urlencode
        registry = self.server.bridge.project_registry
        registry.native_creator = directory_support.DirectoryCreator(self.folder)
        first, second = self.login(), self.login()
        listing = self.request('GET', '/api/project-directories?'+urlencode({'path':str(self.folder)}), headers=first)[2]
        value = {'id':str(uuid.uuid4()), 'parent':listing['path'], 'name':'Selected', 'selectionId':listing['selectionId']}
        for headers, body, status in (({'Cookie':first['Cookie']}, value, 403),
                (second, value, 403), (first, {**value, 'parent':str(self.folder.parent)}, 403),
                (first, {**value, 'selectionId':'f'*64}, 403)):
            self.assertEqual(self.request('POST', '/api/project-directories', body, headers)[0], status)
        self.assertFalse(registry.directory_operations_path.exists())
        self.assertEqual(self.request('POST', '/api/project-directories', value, first)[0], 202)
        self.assertEqual(self.wait_selected_directory(value['id'], first)['status'], 'completed')
        self.assertEqual(self.request('GET', '/api/project-directory-operations?id='+value['id'], headers=second)[0], 403)
        self.assertEqual(self.request('POST', '/api/project-directories', value, second)[0], 403)
        self.assertEqual(self.request('POST', '/api/project-directories', value, first)[2]['status'], 'completed')

    def test_expired_or_restarted_selection_requires_browsing_again(self):
        from urllib.parse import urlencode
        registry = self.server.bridge.project_registry
        registry.native_creator = directory_support.DirectoryCreator(self.folder)
        headers = self.login()
        listing = self.request('GET', '/api/project-directories?'+urlencode({'path':str(self.folder)}), headers=headers)[2]
        value = {'id':str(uuid.uuid4()), 'parent':listing['path'], 'name':'Selected', 'selectionId':listing['selectionId']}
        registry.directory_selections[listing['selectionId']]['expires'] = 0
        self.assertEqual(self.request('POST', '/api/project-directories', value, headers)[0], 403)
        registry.directory_selections.clear()
        self.assertEqual(self.request('POST', '/api/project-directories', value, headers)[0], 403)
        self.assertFalse((self.folder/'Selected').exists())

    def test_parent_replaced_after_browsing_is_rejected_without_creating_anywhere(self):
        from urllib.parse import urlencode
        registry = self.server.bridge.project_registry
        registry.native_creator = directory_support.DirectoryCreator(self.folder)
        headers = self.login()
        listing = self.request('GET', '/api/project-directories?'+urlencode({'path':str(self.folder)}), headers=headers)[2]
        moved = self.folder.with_name('moved'); self.folder.rename(moved); self.folder.mkdir()
        value = {'id':str(uuid.uuid4()), 'parent':listing['path'], 'name':'Selected', 'selectionId':listing['selectionId']}
        self.assertEqual(self.request('POST', '/api/project-directories', value, headers)[0], 202)
        result = self.wait_selected_directory(value['id'], headers)
        self.assertEqual(result['status'], 'failed'); self.assertIn('父文件夹已发生变化', result['message'])
        self.assertFalse((moved/'Selected').exists()); self.assertFalse((self.folder/'Selected').exists())

    def test_relay_allows_exact_project_and_directory_operation_routes(self):
        from relay.protocol import validate
        validate('POST','/api/projects',100)
        validate('GET','/api/project-directories?path=D%3A%5Cwork')
        validate('POST','/api/project-directories',100)
        validate('GET','/api/project-directory-operations?id='+str(uuid.uuid4()))
        for method, path in (('POST','/api/project-directory-operations'),
                             ('GET','/api/project-directory-operations/'),
                             ('POST','/api/project-directories/'),
                             ('GET','/api/project-directory-operations/child'),
                             ('POST','/api/project-directories/mkdir'),
                             ('POST','/api/sessions/'+str(uuid.uuid4())+'/workspace/mkdir')):
            with self.subTest(method=method, path=path), self.assertRaises(PermissionError):
                validate(method, path)
        for path in ('/api/project%2ddirectories', '/api/project-directories%2fchild', '/api//project-directories'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                validate('POST', path)

    def test_directory_creation_and_receipts_require_login_origin_csrf(self):
        creator = directory_support.DirectoryCreator(self.folder)
        registry = self.server.bridge.project_registry
        registry.native_creator = creator
        value = {'id':str(uuid.uuid4()), 'parent':str(self.folder), 'name':'Created'}
        route = '/api/project-directory-operations?id='+value['id']
        self.assertEqual(self.request('POST', '/api/project-directories', value)[0], 401)
        self.assertEqual(self.request('GET', route)[0], 401)
        headers = self.login()
        self.assertEqual(self.request('POST', '/api/project-directories', value, {'Cookie':headers['Cookie']})[0], 403)
        self.assertEqual(self.request('POST', '/api/project-directories', value, {**headers, 'Origin':''})[0], 403)
        self.assertEqual(self.request('POST', '/api/project-directories', value, {**headers, 'Origin':'https://other.invalid'})[0], 403)
        self.assertFalse(registry.directory_operations_path.exists())
        self.assertEqual(creator.calls, [])
        status, _, receipt = self.request('POST', '/api/project-directories', value, headers)
        self.assertEqual(status, 202)
        self.assertEqual(set(receipt), {'id', 'status', 'message'})
        self.assertEqual(receipt['id'], value['id'])
        result = directory_support.wait_directory(registry, value['id'])
        self.assertEqual(result['status'], 'completed')
        status, _, body = self.request('GET', route, headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(body, result)
        self.assertEqual(set(body), {'id', 'status', 'message', 'directory'})
        self.assertEqual(body['directory'], {'name':'Created', 'parent':str(self.folder), 'path':str(self.folder/'Created')})
        self.assertEqual(self.request('POST', '/api/project-directories', value, headers)[2], result)
        self.assertEqual(len(creator.calls), 1)

    def test_directory_requests_reject_extra_fields_invalid_ids_and_nonexact_receipt_query(self):
        registry = self.server.bridge.project_registry
        registry.native_creator = directory_support.DirectoryCreator(self.folder)
        headers = self.login()
        value = {'id':str(uuid.uuid4()), 'parent':str(self.folder), 'name':'Created'}
        for body in ({**value, 'cwd':str(self.folder)}, {**value, 'contextId':None},
                     {**value, 'host':'local'}, {**value, 'name':'a/b'},
                     {**value, 'parent':''}, {**value, 'id':'bad'}):
            with self.subTest(body=body):
                self.assertEqual(self.request('POST', '/api/project-directories', body, headers)[0], 400)
        for query in ('', '?id=bad', '?id='+value['id'], '?id='+value['id']+'&extra=1',
                      '?id=', '?id='+value['id']+'&extra=', '?id='+value['id']+'&id=',
                      '?id='+value['id']+'&id='+value['id']):
            with self.subTest(query=query):
                self.assertEqual(self.request('GET', '/api/project-directory-operations'+query, headers=headers)[0], 400)
        self.assertEqual(self.request('POST', '/api/project-directories?extra=', value, headers)[0], 400)
        self.assertFalse(registry.directory_operations_path.exists())

    def test_directory_collision_has_failed_json_receipt_and_never_overwrites(self):
        registry = self.server.bridge.project_registry
        registry.native_creator = directory_support.DirectoryCreator(self.folder)
        (self.folder/'existing').write_text('fixture content')
        headers = self.login()
        value = {'id':str(uuid.uuid4()), 'parent':str(self.folder), 'name':'existing'}
        self.assertEqual(self.request('POST', '/api/project-directories', value, headers)[0], 202)
        receipt = directory_support.wait_directory(registry, value['id'])
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(set(receipt), {'id', 'status', 'message'})
        self.assertIn('不会覆盖', receipt['message'])
        self.assertEqual((self.folder/'existing').read_text(), 'fixture content')
        self.assertEqual(self.request('GET', '/api/project-directory-operations?id='+value['id'], headers=headers)[2], receipt)

    def test_directory_unknown_receipt_survives_reconnect_and_prevents_new_id_replay(self):
        from unittest.mock import patch
        from bridge.features.workspace.workspace import Workspace
        registry = self.server.bridge.project_registry
        creator = directory_support.DirectoryCreator(self.folder)
        registry.native_creator = creator
        headers = self.login()
        value = {'id':str(uuid.uuid4()), 'parent':str(self.folder), 'name':'unknown'}
        with patch.object(Workspace, 'mkdir', side_effect=OSError('fixture disconnect')) as mkdir:
            self.assertEqual(self.request('POST', '/api/project-directories', value, headers)[0], 202)
            receipt = directory_support.wait_directory(registry, value['id'])
            self.assertEqual(receipt['status'], 'unknown')
            self.assertEqual(self.request('POST', '/api/project-directories', value, headers)[2], receipt)
            self.assertEqual(self.request('POST', '/api/project-directories', {**value, 'id':str(uuid.uuid4())}, headers)[0], 400)
            mkdir.assert_called_once()
        self.server.bridge.project_registry = Projects(Path(self.temp.name)/'data', creator)
        self.assertEqual(self.request('GET', '/api/project-directory-operations?id='+value['id'], headers=headers)[2], receipt)

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
