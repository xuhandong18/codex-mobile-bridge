"""Ordering follows conversation content, never process or read activity."""
import json
import io
import os
import sqlite3
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from contextlib import closing, redirect_stdout
from unittest.mock import patch

import bridge.features.sessions.message_index as reader
from bridge.features.sessions.model import normalize_item
from bridge.features.sessions.store import SessionStore


class MessageRecencyReaderTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]/'.tmp')
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name)/'rollout.jsonl'
        self.identifier = str(uuid.uuid4())
        self.path.write_text(json.dumps({'type':'session_meta','payload':{'id':self.identifier}})+'\n', encoding='utf-8')

    def append(self, kind, payload, at='2026-10-29T01:00:00Z'):
        with self.path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'type':kind,'timestamp':at,'payload':payload})+'\n')

    def scan(self, previous=None, **kwargs):
        return reader.scan_message_recency(self.path, self.identifier, previous, normalize_item, **kwargs)

    def test_generic_update_time_cannot_override_confirmed_user_interaction(self):
        self.assertEqual(SessionStore.recency({'recency_at_ms':10000,'updated_at_ms':90000}), 10000)
        self.assertEqual(SessionStore.recency({'updated_at_ms':90000}), 0)
        self.assertEqual(SessionStore.recency({'created_at_ms':5000,'updated_at_ms':90000}), 5000)

    def test_text_progress_counts_but_tools_reasoning_and_turn_end_do_not(self):
        self.append('response_item', {'type':'message','id':'a','role':'assistant','phase':'commentary',
                                     'content':[{'type':'output_text','text':'visible progress'}]})
        first = self.scan()
        self.assertEqual(first['at'], 1793235600000)
        for payload in ({'type':'function_call','call_id':'tool','name':'exec','arguments':'private'},
                        {'type':'function_call_output','call_id':'tool','output':'private output'},
                        {'type':'reasoning','summary':['private reasoning']}):
            self.append('response_item', payload, '2026-10-29T02:00:00Z')
        self.append('event_msg', {'type':'task_complete','turn_id':'t'}, '2026-10-29T03:00:00Z')
        latest = self.scan(first['checkpoint'])
        self.assertEqual(latest['at'], first['at'])
        self.assertNotIn('private', json.dumps(latest))
        self.append('response_item', {'type':'message','id':'b','role':'assistant','phase':'final_answer',
                                     'content':[{'type':'output_text','text':'final reply'}]}, '2026-10-29T04:00:00Z')
        self.assertEqual(self.scan(latest['checkpoint'])['at'], 1793246400000)

    def test_context_empty_content_missing_time_and_duplicate_message_do_not_promote(self):
        message={'type':'message','id':'a','role':'assistant','phase':'commentary',
                 'content':[{'type':'output_text','text':'progress'}]}
        self.append('response_item', message)
        first=self.scan()
        self.append('response_item', message, '2026-10-29T05:00:00Z')
        self.append('response_item', {'type':'message','role':'user','content':[
            {'type':'input_text','text':'<environment_context>injected context</environment_context>'}]}, '2026-10-29T06:00:00Z')
        self.append('response_item', {'type':'message','role':'assistant','content':[]}, '2026-10-29T07:00:00Z')
        self.append('response_item', {'type':'message','role':'assistant','content':[
            {'type':'output_text','text':'no timestamp'}]}, None)
        self.assertEqual(self.scan(first['checkpoint'])['at'], first['at'])

    def test_native_agent_message_event_uses_its_message_body(self):
        self.append('event_msg', {'type':'agent_message','id':'event','phase':'commentary','message':'文字进度'})
        value = self.scan()
        self.assertEqual(value['at'],1793235600000)
        self.append('event_msg', {'type':'agent_message','id':'event','phase':'commentary','message':'文字进度'},
                    '2026-10-29T02:00:00Z')
        self.assertEqual(self.scan(value['checkpoint'])['at'],value['at'])

    def test_partial_tail_replacement_and_identity_are_verified(self):
        self.append('response_item', {'type':'message','role':'user','content':[{'type':'input_text','text':'question'}]})
        first=self.scan()
        record=json.dumps({'type':'response_item','timestamp':'2026-10-29T02:00:00Z','payload':{
            'type':'message','role':'assistant','content':[{'type':'output_text','text':'answer'}]}})
        with self.path.open('a',encoding='utf-8') as stream:stream.write(record[:35])
        pending=self.scan(first['checkpoint'])
        self.assertEqual(pending['at'], first['at'])
        with self.path.open('a',encoding='utf-8') as stream:stream.write(record[35:]+'\n')
        self.assertGreater(self.scan(pending['checkpoint'])['at'], first['at'])
        self.path.write_text(json.dumps({'type':'session_meta','payload':{'id':'other'}})+'\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'identity|belong|聊天'):
            self.scan(pending['checkpoint'])

    def test_bounded_backfill_eventually_finds_text_before_a_long_tool_tail(self):
        self.append('response_item', {'type':'message','id':'a','role':'assistant','content':[
            {'type':'output_text','text':'older final'}]})
        for _ in range(80):self.append('response_item', {'type':'function_call_output','call_id':'tool','output':'x'*1500}, '2026-10-29T03:00:00Z')
        value=self.scan(budget=8192)
        self.assertFalse(value['complete'])
        for _ in range(30):
            if value['complete']:break
            value=self.scan(value['checkpoint'],budget=8192)
        self.assertTrue(value['complete'])
        self.assertEqual(value['at'], 1793235600000)

    def test_backfill_can_read_a_message_larger_than_its_scan_window(self):
        self.append('response_item', {'type':'message','id':'large','role':'assistant','content':[
            {'type':'output_text','text':'long reply '*1000}]})
        for _ in range(30):
            self.append('response_item', {'type':'function_call_output','call_id':'tool','output':'x'*700})
        value = self.scan(budget=1024)
        for _ in range(50):
            if value['complete']:break
            value = self.scan(value['checkpoint'],budget=1024)
        self.assertTrue(value['complete'])
        self.assertEqual(value['at'],1793235600000)


class RecencyIndexTests(unittest.TestCase):
    def test_global_inventory_updates_old_candidates_without_blocking_list_reader(self):
        from bridge.features.sessions.recency import RecencyIndex
        entered,release=threading.Event(),threading.Event()
        class Store:
            def recency_inventory(self):return [{'id':'old','recency_at':1,'updated_at':100},{'id':'new','recency_at':10,'updated_at':10}]
            def message_recencies(self,identifiers,checkpoints=None):
                entered.set();release.wait(1)
                return {sid:{'at':90000 if sid=='old' else 0,'complete':True,'checkpoint':{'at':90000 if sid=='old' else 0}} for sid in identifiers}
        index=RecencyIndex(Store())
        self.addCleanup(index.close)
        index.request()
        self.assertTrue(entered.wait(.5))
        self.assertEqual(index.snapshot(), {})
        release.set();index.wait(1)
        self.assertEqual(index.snapshot()['old'],90000)

    def test_checkpoint_cache_is_private_persistent_and_scoped_by_reader(self):
        from bridge.features.sessions.recency import RecencyIndex
        directory=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]/'.tmp')
        self.addCleanup(directory.cleanup)
        path=Path(directory.name)/'recency.json'
        class Store:
            def recency_inventory(self):return [{'id':'a','updated_at':1}]
            def message_recencies(self,identifiers,checkpoints=None):
                return {'a':{'at':123,'complete':True,'checkpoint':{'at':123,'messageId':'message'}}}
        index=RecencyIndex(Store(),path)
        index.request();index.wait(1);index.close()
        restored=RecencyIndex(Store(),path)
        self.addCleanup(restored.close)
        self.assertEqual(restored.snapshot(),{'a':123})
        self.assertNotIn('text',path.read_text(encoding='utf-8'))


class MessageRecencyIntegrationTests(unittest.TestCase):
    def setUp(self):
        import test_bridge as support
        self.support = support
        support.IntegrationTests.setUp(self)

    def tearDown(self):
        self.support.IntegrationTests.tearDown(self)

    def test_background_text_time_promotes_old_chat_before_paging_with_original_filters(self):
        identifier = self.support.THREAD
        sessions = self.root/'sessions';sessions.mkdir()
        rollout = sessions/'rollout.jsonl'
        rollout.write_text(json.dumps({'type':'session_meta','payload':{'id':identifier}})+'\n'+json.dumps({
            'type':'response_item','timestamp':'2026-10-29T01:00:00Z','payload':{
                'type':'message','role':'assistant','phase':'commentary','content':[
                    {'type':'output_text','text':'visible text progress'}]}})+'\n',encoding='utf-8')
        with closing(sqlite3.connect(self.root/'state_5.sqlite')) as db, db:
            db.execute('ALTER TABLE threads ADD COLUMN recency_at INT')
            db.execute('UPDATE threads SET rollout_path=?,recency_at=1',(str(rollout),))
            db.executemany('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)',[
                (str(uuid.uuid4()),'Newer baseline','/workspace',200+i,0,'Codex Desktop','vscode','unused',200+i)
                for i in range(120)])
        entered,release = threading.Event(),threading.Event()
        original = self.bridge.store.message_recencies
        def slow(*args):
            entered.set();release.wait(2)
            return original(*args)
        try:
            with patch.object(self.bridge.store,'message_recencies',side_effect=slow):
                first = self.bridge.list(local_only=True)
                self.assertTrue(entered.wait(1))
                self.assertNotIn(identifier,{row['id'] for row in first})
                release.set();self.bridge.recency_index.wait(2)
            first = self.bridge.list(local_only=True)
            second = self.bridge.list(local_only=True,offset=100)
            self.assertEqual(first[0]['id'],identifier)
            self.assertEqual(first[0]['recency'],1793235600000)
            self.assertEqual(len(first+second),121)
            self.assertEqual(len({row['id'] for row in first+second}),121)
            self.assertEqual(self.bridge.list(local_only=True,query='no match'),[])
            self.assertEqual(self.bridge.list(local_only=True,archived=True),[])
            self.assertEqual(self.bridge.list(local_only=True,source='cli'),[])
            # Even a second append within the same database timestamp must be
            # found for a chat outside the visible activity polling set.
            self.bridge.recency_index.wait(2)
            with rollout.open('a',encoding='utf-8') as stream:
                stream.write(json.dumps({'type':'response_item','timestamp':'2026-10-29T02:00:00Z','payload':{
                    'type':'message','role':'assistant','content':[{'type':'output_text','text':'later reply'}]}})+'\n')
            self.bridge.recency_index.request();self.bridge.recency_index.wait(2)
            self.assertEqual(self.bridge.recency_index.snapshot()[identifier],1793239200000)
            self.assertEqual(self.bridge.live,{})
            self.assertEqual(self.fixture.requests,[])
        finally:
            release.set()

    def test_ssh_injected_reader_runs_without_local_package_and_keeps_remote_home_boundary(self):
        from bridge.clients.codex.remote import RemoteStore
        identifier = self.support.THREAD
        sessions = self.root/'sessions';sessions.mkdir()
        rollout = sessions/'rollout.jsonl'
        rollout.write_text(json.dumps({'type':'session_meta','payload':{'id':identifier}})+'\n'+json.dumps({
            'type':'response_item','timestamp':'2026-10-29T01:00:00Z','payload':{
                'type':'message','role':'assistant','content':[{'type':'output_text','text':'remote reply'}]}})+'\n',encoding='utf-8')
        with closing(sqlite3.connect(self.root/'state_5.sqlite')) as db,db:
            db.execute('UPDATE threads SET rollout_path=?',(str(rollout),))
        import builtins
        original_import = builtins.__import__
        def independent(name,*args,**kwargs):
            if name=='bridge' or name.startswith('bridge.'):
                raise AssertionError('SSH injected code imported the local package')
            return original_import(name,*args,**kwargs)
        def remote_read(alias,source,**kwargs):
            output = io.StringIO()
            with patch.dict(os.environ,{'CODEX_HOME':str(self.root)}),patch('builtins.__import__',side_effect=independent),redirect_stdout(output):
                exec(compile(source,'ssh-recency.py','exec'),{})
            return json.loads(output.getvalue())
        remote = RemoteStore('fixture')
        with patch('bridge.clients.codex.remote.ssh_read',side_effect=remote_read):
            result = remote.message_recencies([identifier])
            self.assertEqual(result[identifier]['at'],1793235600000)
            self.assertNotIn('remote reply',json.dumps(result))
            with closing(sqlite3.connect(self.root/'state_5.sqlite')) as db,db:
                db.execute('UPDATE threads SET rollout_path=?',(str(self.root.parent/'outside.jsonl'),))
            self.assertEqual(remote.message_recencies([identifier]),{})


if __name__=='__main__':unittest.main()
