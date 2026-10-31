import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock
from bridge.clients.manager import DesktopSessions
from bridge.features.sessions.read_state import SharedReadState

ROOT = Path(__file__).resolve().parents[1]

class HarnessSharedStateTests(unittest.TestCase):
    def test_historical_body_window_does_not_replace_the_actual_current_turn(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            manager=DesktopSessions(directory);adapter=Mock();manager.adapters['deepseek']=adapter
            adapter.call.return_value={'connected':True,'session':{'id':'main','turnId':'20','turnStatus':'completed'},
                'capabilities':{'historyNavigation':True},'turns':[{'turnId':'2','status':'completed'}],'messages':[]}
            try:
                value=manager.call('deepseek','timeline','main',{'around':'old-message'})
                self.assertEqual(value['session']['turnId'],'20')
                self.assertEqual(value['turns'][0]['turnId'],'2')
            finally:manager.close()

    def test_main_and_side_completion_reads_are_shared_and_profile_scoped(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            root=Path(directory);store=SharedReadState(root)
            manager=DesktopSessions(root/'gateway',read_state=store)
            adapter=Mock();adapter.home=root/'harness-home';adapter.receipts_path=None;manager.adapters['deepseek']=adapter
            main={'id':'parent','status':'idle','turnId':'1','turnStatus':'completed','waitingObservedAt':1}
            child={'id':'child','slot':str(uuid.uuid4()),'connected':True,'status':'idle','turnId':'1','turnStatus':'completed','waitingObservedAt':1}
            def call(action,sid,body):
                if action=='list':return {'connected':True,'sessions':[{**main,'sideChats':[dict(child)],'sideChatsObservedAt':main['waitingObservedAt']}]}
                if action=='side-read':return {'connected':True,'id':'child','session':{**child,'host':'local'},'turns':[{'turnId':child['turnId'],'status':child['turnStatus']}]}
                if action in ('read-state','side-write'):return {'status':'accepted','nativeRead':'unsupported'}
                raise AssertionError(action)
            adapter.call.side_effect=call
            try:
                first=manager.call('deepseek','list')['sessions'][0]
                self.assertIsNone(first['completionToken']);self.assertIsNone(first['sideChats'][0]['completionToken'])
                self.assertNotIn('host',first)
                main.update(status='active',turnId='2',turnStatus='inProgress',waitingObservedAt=2)
                child.update(status='active',turnId='2',turnStatus='inProgress',waitingObservedAt=2)
                manager.call('deepseek','list')
                main.update(status='idle',turnStatus='completed',waitingObservedAt=3);child.update(status='idle',turnStatus='completed',waitingObservedAt=3)
                result=manager.call('deepseek','list')['sessions'][0]
                self.assertEqual(result['completionToken'],'2:completed');self.assertEqual(result['sideChats'][0]['completionToken'],'2:completed')
                ack={'id':str(uuid.uuid4()),'turnId':'2','turnStatus':'completed'}
                manager.call('deepseek','read-state','parent',ack)
                after=manager.call('deepseek','list')['sessions'][0]
                self.assertEqual(after['readCompletions'],['2:completed']);self.assertEqual(after['sideChats'][0]['readCompletions'],[])
                manager.call('deepseek','side-write','parent',{**ack,'id':str(uuid.uuid4()),'operation':'read-state','childId':'child','slot':child['slot']})
                view=manager.call('deepseek','side-read','parent',{'slot':child['slot']})
                self.assertEqual(view['readCompletions'],['2:completed']);self.assertEqual(view['session']['host'],'local');self.assertEqual(view['session']['id'],'child')
                adapter.home=root/'other-home'
                isolated=manager.call('deepseek','list')['sessions'][0]
                self.assertEqual(isolated['readCompletions'],[]);self.assertEqual(isolated['sideChats'][0]['readCompletions'],[])
            finally:
                manager.close();store.close()

    def test_new_history_and_queue_writes_keep_unknown_receipts_without_replay(self):
        with tempfile.TemporaryDirectory(dir=ROOT/'.tmp') as directory:
            manager=DesktopSessions(directory);adapter=Mock();adapter.receipts_path=None;adapter.call.side_effect=TimeoutError();manager.adapters['deepseek']=adapter
            try:
                for action,payload in [('message-action',{'action':'edit','key':'native-key','version':'v','text':'edited'}),('queue',{'operation':'remove','itemId':'native-item','submissionId':'request'})]:
                    body={'id':str(uuid.uuid4()),**payload};result=manager.call('deepseek',action,'native',body);self.assertEqual(result['status'],'unknown');count=adapter.call.call_count
                    self.assertEqual(manager.call('deepseek',action,'native',body),result);self.assertEqual(adapter.call.call_count,count)
            finally:manager.close()
