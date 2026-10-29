"""Waiting summaries use live requests, never assistant prose or saved history."""
import json
import unittest

import test_side_chat_activity as side_support
from bridge.clients.codex.activity import DesktopActivity


class WaitingActivityTests(unittest.TestCase):
    setUp = side_support.SideActivityTests.setUp
    tearDown = side_support.SideActivityTests.tearDown
    create = side_support.SideActivityTests.create
    parent = side_support.SideActivityTests.parent
    passive = side_support.SideActivityTests.passive

    def test_live_parent_requests_reach_activity_without_body_or_activation(self):
        parent = self.parent(status='active')
        parent.state['requests'] = [{'id':'approval','method':'item/commandExecution/requestApproval',
                                     'params':{'command':'PRIVATE_COMMAND'}}]
        with self.passive():
            value = self.bridge.activity([parent.id], .2)[0]
        self.assertTrue(value.get('waitingForUser'))
        self.assertNotIn('PRIVATE_COMMAND',json.dumps(value))
        parent.state['requests'] = []
        with self.passive():
            self.assertFalse(self.bridge.activity([parent.id], .2)[0]['waitingForUser'])

    def test_side_waiting_is_independent_of_parent_and_does_not_change_recency(self):
        child = self.create();parent = self.parent(status='active')
        before = child.view()['recency']
        child._event({'id':'question','method':'item/tool/requestUserInput','params':{
            'threadId':child.id,'turnId':'turn','questions':[{'id':'q','question':'PRIVATE_QUESTION'}]}})
        with self.passive():
            value = self.bridge.activity([parent.id], .2)[0]
        self.assertFalse(value.get('waitingForUser'))
        self.assertTrue(value['sideChats'][0].get('waitingForUser'))
        self.assertNotIn('PRIVATE_QUESTION',json.dumps(value))
        self.assertEqual(child.view()['recency'],before)
        child.respond('question',{'answers':{'q':['chosen']}})
        self.assertFalse(child.activity()['waitingForUser'])

    def test_async_question_is_waiting_even_after_turn_completed_but_plain_question_is_not(self):
        parent = self.parent()
        parent.state['turns'][0]['items']=[{'id':'async','type':'agentMessage','text':'ordinary question?',
            'questions':[{'title':'Choose','options':['yes','no']}]}]
        with self.passive():
            self.assertTrue(self.bridge.activity([parent.id], .2)[0].get('waitingForUser'))
        del parent.state['turns'][0]['items'][0]['questions']
        with self.passive():
            self.assertFalse(self.bridge.activity([parent.id], .2)[0]['waitingForUser'])

    def test_native_flags_are_retained_without_request_details(self):
        for flag in ('waitingOnApproval','waitingOnUserInput'):
            value=DesktopActivity._snapshot({'thread':{'id':'chat','hostId':'local',
                'status':{'type':'active','activeFlags':[flag]}},'turns':[]},'chat')
            self.assertTrue(value.get('waitingForUser'))
        value=DesktopActivity._snapshot({'thread':{'id':'chat','hostId':'local',
            'status':{'type':'active'}},'turns':[]},'chat')
        self.assertIsNone(value.get('waitingForUser'))


if __name__=='__main__':unittest.main()
