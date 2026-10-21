import unittest
import uuid
from types import SimpleNamespace

import test_bridge


class SidebarHttpTests(unittest.TestCase):
    setUpClass=classmethod(test_bridge.HttpTests.setUpClass.__func__)
    tearDown=test_bridge.HttpTests.tearDown
    request=test_bridge.HttpTests.request
    login=test_bridge.HttpTests.login

    def setUp(self):
        test_bridge.HttpTests.setUp(self)
        self.calls=[]
        self.identifier=str(uuid.uuid4())
        async def submit(value, preferences=None):
            self.assertIs(preferences, self.server.sidebar_preferences)
            self.calls.append(value)
            return {'id':self.identifier,'status':'pending','message':'Waiting for native confirmation'}
        def operation(identifier):
            if identifier!=self.identifier:raise ValueError('找不到侧栏操作记录')
            return {'id':identifier,'status':'pending'}
        self.server.bridge.sidebar_management=SimpleNamespace(submit=submit,operation=operation)

    def test_mutations_require_login_and_csrf_before_native_submission(self):
        body={'id':self.identifier,'kind':'section','action':'create','name':'Work'}
        self.assertEqual(self.request('POST','/api/sidebar-management',body)[0],401)
        headers=self.login()
        self.assertEqual(self.request('POST','/api/sidebar-management',body,{'Cookie':headers['Cookie']})[0],403)
        self.assertEqual(self.calls,[])
        status,_,result=self.request('POST','/api/sidebar-management',body,headers)
        self.assertEqual(status,202);self.assertEqual(result['status'],'pending')
        self.assertEqual(self.calls,[body])

    def test_receipt_polls_are_authenticated_and_do_not_replay_mutations(self):
        route='/api/sidebar-operations?id='+self.identifier
        self.assertEqual(self.request('GET',route)[0],401)
        status,_,result=self.request('GET',route,headers=self.login())
        self.assertEqual(status,200);self.assertEqual(result['status'],'pending')
        self.assertEqual(self.calls,[])
        self.assertEqual(self.request('GET','/api/sidebar-operations?id=missing',headers=self.login())[0],400)

    def test_relay_exposes_only_the_two_exact_management_routes(self):
        from relay.protocol import validate
        validate('POST','/api/sidebar-management',100)
        validate('GET','/api/sidebar-operations?id='+self.identifier)
        for method,route in [('GET','/api/sidebar-management'),('POST','/api/sidebar-operations'),('POST','/api/sidebar-management/anything')]:
            with self.subTest(method=method,route=route),self.assertRaises(PermissionError):
                validate(method,route,100 if method=='POST' else 0)
