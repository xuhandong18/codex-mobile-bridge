import json
import tempfile
import unittest
import copy
import subprocess
import sys
import sqlite3
from pathlib import Path
from unittest.mock import patch

from bridge.features.sessions.message_index import MessageNavigation, scan_rollout, read_window
from bridge.features.sessions.model import normalize_item


class MessageIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]/'.tmp')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'rollout.jsonl'
        self.path.touch()
        self.thread = '11111111-1111-4111-8111-111111111111'
        self.scans = []
        def scan(identifier, checkpoint=None):
            self.scans.append(checkpoint)
            return scan_rollout(self.path, identifier, checkpoint, normalize_item)
        self.nav = MessageNavigation(scan, lambda identifier, point, start, limit: read_window(self.path, identifier, point, start, limit))

    def write(self, value):
        with self.path.open('ab') as stream:
            stream.write((json.dumps(value)+'\n').encode())

    def turn(self, number, tools=2):
        self.write({'type':'event_msg','payload':{'type':'task_started','turn_id':'turn-'+str(number)}})
        self.write({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'message '+str(number)}]}})
        for i in range(tools):
            self.write({'type':'response_item','payload':{'type':'function_call','call_id':str(i),'name':'fixture','arguments':'large tool body '+('x'*1000)}})
        self.write({'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':'reply '+str(number)}]}})
        self.write({'type':'event_msg','payload':{'type':'task_complete'}})

    def test_full_directory_is_separate_from_a_bounded_body_window(self):
        for i in range(300): self.turn(i)
        first = self.nav.page(self.thread, limit=200)
        second = self.nav.page(self.thread, cursor=first['nextCursor'], limit=200)
        self.assertEqual(len(first['items'])+len(second['items']),300)
        self.assertEqual(first['items'][0]['summary'],'message 0')
        self.assertIsNone(second['nextCursor'])
        result = self.nav.window(self.thread, around=first['items'][0]['id'], limit=20)
        self.assertLessEqual(sum(len(t['items']) for t in result['state']['turns']),20)
        self.assertIn('message 0',str(result['state']))
        self.assertNotIn('message 299',str(result['state']))
        self.assertIsNotNone(result['after'])
        self.assertNotIn('large tool body',json.dumps(first))

    def test_directory_contains_only_actual_requests_and_preserves_edit_targets(self):
        from bridge.features.sessions.model import normalize_state
        from bridge.features.sessions.timeline import Timeline
        contexts = [
            '# AGENTS.md instructions for /work\n<INSTRUCTIONS>Rules</INSTRUCTIONS>',
            '<skill><name>fixture</name><path>/work/SKILL.md</path>Instructions</skill>',
            '<subagent_notification>{"agent_id":"fixture","status":{"completed":"Done"}}</subagent_notification>',
            '<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>',
        ]
        self.write({'type':'event_msg','payload':{'type':'task_started','turn_id':'turn'}})
        for text in contexts + ['Actual request']:
            self.write({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':text}]}})
        directory = self.nav.page(self.thread)
        self.assertEqual(directory['total'], 1)
        self.assertEqual([item['summary'] for item in directory['items']], ['Actual request'])
        for entry in directory['items']:
            window = self.nav.window(self.thread, around=entry['id'], limit=20)
            timeline = Timeline();timeline.update({**normalize_state(window['state']), 'sequence': 1})
            self.assertEqual([row['editable'] for row in timeline.rows], [False] * len(contexts) + [True])
            target = next(row for row in timeline.rows if row.get('navigationId') == entry['id'])
            self.assertEqual(target.get('isUserContext', False), entry.get('isUserContext', False))
        self.write({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':contexts[-1]}]}})
        delta = self.nav.page(self.thread, since=directory['tailCursor'])
        self.assertEqual(delta['items'], [])
        self.assertEqual(delta['total'], 1)

    def test_append_reuses_checkpoint_and_preserves_navigation_ids(self):
        self.turn(0)
        first = self.nav.page(self.thread)
        self.turn(1)
        updated = self.nav.page(self.thread)
        self.assertIsNotNone(self.scans[-1])
        self.assertEqual(first['items'][0]['id'],updated['items'][0]['id'])
        self.assertEqual(len(updated['items']),2)

    def test_image_transport_labels_do_not_change_directory_summary(self):
        self.write({'type':'event_msg','payload':{'type':'task_started','turn_id':'turn'}})
        self.write({'type':'response_item','payload':{'type':'message','role':'user','content':[
            {'type':'input_text','text':'Explain the screenshot'},
            {'type':'input_text','text':'<image name=[Image #1] path="/fixture/screen.jpg">'},
            {'type':'input_image','image_url':'data:image/png;base64,AAAA'},
            {'type':'input_text','text':'</image>'},
        ]}})
        self.assertEqual(self.nav.page(self.thread)['items'][0]['summary'],'Explain the screenshot')

    def test_window_starting_mid_turn_does_not_make_a_supplementary_message_editable(self):
        from bridge.features.sessions.model import normalize_state
        from bridge.features.sessions.timeline import Timeline
        self.turn(0,tools=40)
        self.write({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'supplement'}]}})
        catalog=self.nav.page(self.thread)
        result=self.nav.window(self.thread,around=catalog['items'][-1]['id'],limit=10)
        timeline=Timeline();timeline.update({**normalize_state(result['state']),'sequence':1})
        row=next(r for r in timeline.rows if r['text']=='supplement')
        self.assertFalse(row['editable'])

    def test_replacement_and_cross_chat_locators_are_rejected(self):
        self.turn(0)
        anchor = self.nav.page(self.thread)['items'][0]['id']
        with self.assertRaises(ValueError): self.nav.window('other-thread',around=anchor)
        self.path.write_text('')
        self.turn(4)
        with self.assertRaises(ValueError): self.nav.window(self.thread,around=anchor)

    def test_forward_and_backward_windows_are_independent_and_thread_bound(self):
        for i in range(20): self.turn(i)
        entry = self.nav.page(self.thread)['items'][10]
        middle = self.nav.window(self.thread,around=entry['id'],limit=10)
        newer = self.nav.window(self.thread,after=middle['after'],limit=10)
        self.assertGreater(newer['start'],middle['start'])
        older = self.nav.window(self.thread,before=middle['before'],limit=10)
        self.assertLess(older['start'],middle['start'])
        with self.assertRaises(ValueError): self.nav.window('other-thread',after=middle['after'])

    def test_partial_trailing_record_is_read_when_completed_and_attachment_has_a_summary(self):
        self.turn(0)
        self.nav.page(self.thread)
        raw=json.dumps({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'image','name':'picture.png'}]}}).encode()
        with self.path.open('ab') as stream: stream.write(raw[:30])
        self.assertEqual(len(self.nav.page(self.thread)['items']),1)
        with self.path.open('ab') as stream: stream.write(raw[30:]+b'\n')
        result=self.nav.page(self.thread)
        self.assertEqual(len(result['items']),2)
        self.assertIn('picture.png',result['items'][1]['summary'])

    def test_incremental_catalog_returns_only_new_messages_and_a_replacement_resets_it(self):
        self.turn(0);first=self.nav.page(self.thread)
        self.turn(1);delta=self.nav.page(self.thread,since=first['tailCursor'])
        self.assertEqual([r['summary'] for r in delta['items']],['message 1'])
        self.path.write_text('');self.turn(3)
        reset=self.nav.page(self.thread,since=delta['tailCursor'])
        self.assertTrue(reset['reset']);self.assertEqual(reset['items'][0]['summary'],'message 3')

    def test_changed_target_in_a_growing_file_cannot_jump_to_different_content(self):
        for i in range(200):self.turn(i)
        old=self.nav.page(self.thread)['items'][100]['id']
        raw=self.path.read_bytes().replace(b'message 100',b'changed 100')
        self.path.write_bytes(raw);self.turn(201)
        with self.assertRaises(ValueError):self.nav.window(self.thread,around=old)
        refreshed=self.nav.page(self.thread)
        self.assertEqual(refreshed['items'][100]['summary'],'changed 100')
        self.assertNotEqual(refreshed['items'][100]['id'],old)

    def test_large_records_are_explicit_errors_and_do_not_publish_a_partial_directory_as_complete(self):
        self.turn(0)
        with patch('bridge.features.sessions.message_index.MAX_RECORD',100):
            with self.assertRaises(ValueError):self.nav.page(self.thread)

    def test_reopen_reads_no_old_records_and_cache_contains_no_body(self):
        for i in range(5000):self.turn(i,tools=0)
        first=self.nav.page(self.thread)
        with patch('bridge.features.sessions.message_index._line',side_effect=AssertionError('Old records reread')):
            reopened=self.nav.page(self.thread)
        self.assertEqual(first['revision'],reopened['revision'])
        cache=json.dumps(self.nav.cache)
        self.assertNotIn('reply 0',cache)
        self.assertEqual(first['total'],5000)

    def test_host_bound_anchor_and_cursor_and_record_owner(self):
        self.turn(0)
        first=self.nav.page(self.thread)
        other=MessageNavigation(self.nav.scan,self.nav.read_window)
        with self.assertRaises(ValueError):other.window(self.thread,around=first['items'][0]['id'])
        with self.assertRaises(ValueError):other.page(self.thread,cursor=first['tailCursor'])
        self.path.write_text(json.dumps({'type':'session_meta','payload':{'id':'other'}})+'\n')
        with self.assertRaisesRegex(ValueError,'不属于'):self.nav.page(self.thread)

    def test_small_backward_page_stops_at_its_cursor(self):
        for i in range(3):self.turn(i,tools=0)
        anchor=self.nav.page(self.thread)['items'][1]['id']
        page=self.nav.window(self.thread,around=anchor,limit=2)
        earlier=self.nav.window(self.thread,before=page['before'],limit=100)
        self.assertEqual(earlier['end'],page['start'])

    def test_invalid_tokens_are_rejected(self):
        self.turn(0)
        for cursor in ['bad','nav.x.x','x'*4000]:
            with self.assertRaises(ValueError):self.nav.page(self.thread,cursor=cursor)


class NavigationBridgeTests(unittest.TestCase):
    def setUp(self):
        import test_bridge as support
        self.support=support
        support.IntegrationTests.setUp(self)
        self.addCleanup(lambda:support.IntegrationTests.tearDown(self))
        self.path=self.root/'sessions'/'fixture.jsonl';self.path.parent.mkdir();self.path.touch()
        db=sqlite3.connect(self.root/'state_5.sqlite')
        db.execute('UPDATE threads SET rollout_path=? WHERE id=?',(str(self.path),support.THREAD));db.commit();db.close()
        with self.path.open('w',encoding='utf-8') as stream:
            for i in range(100):
                for value in [
                    {'type':'event_msg','payload':{'type':'task_started','turn_id':'old-'+str(i)}},
                    {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':'question '+str(i)}]}},
                    {'type':'response_item','payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':'answer '+str(i)+' '+('x'*9000)}]}},
                    {'type':'event_msg','payload':{'type':'task_complete'}}]:stream.write(json.dumps(value)+'\n')

    def test_early_window_and_detail_do_not_replace_live_state_or_read_all_history(self):
        from bridge.features.sessions.timeline import PAGE_BYTES,encoded
        session=self.bridge.session(self.support.THREAD)
        state=copy.deepcopy(session.state)
        with patch('bridge.app.service.open_in_desktop',side_effect=AssertionError('No navigation')),patch.object(self.bridge.store,'history',side_effect=AssertionError('No full-history read')):
            catalog=self.bridge.message_index(self.support.THREAD)
            page=self.bridge.timeline_read(self.support.THREAD,around=catalog['items'][0]['id'],limit=100)
            self.assertTrue(page['navigationWindow']);self.assertIsNotNone(page['targetKey'])
            self.assertLessEqual(len(encoded(page['rows'])),PAGE_BYTES)
            self.assertEqual(session.state,state)
            self.assertTrue(any(r['text']=='question 0' for r in page['rows']))
            self.assertTrue(next(r for r in page['rows'] if r['text']=='question 0')['editable'])
            self.assertTrue(any(r.get('forkable') for r in page['rows']))
            old=next(r for r in page['rows'] if r['role']=='assistant')
            detail=self.bridge.timeline_read(self.support.THREAD,'detail',cursor=page['epoch']+'.'+old['key'],offset=0,version=old['version'])
            self.assertTrue(detail['text'].startswith('answer 0'))
            next_page=self.bridge.timeline_read(self.support.THREAD,after=page['after'],limit=30)
            self.assertTrue(next_page['navigationWindow'])
        self.assertTrue(all(call['method'] in ('initialize','thread-owner-discovery') for call in self.fixture.requests))

    def test_navigation_embedded_image_has_a_scoped_preview(self):
        import base64
        data=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII=')
        records=[json.loads(line) for line in self.path.read_text().splitlines()]
        records[1]['payload']['content'].append({'type':'input_image','image_url':'data:image/png;base64,'+base64.b64encode(data).decode()})
        self.path.write_text(''.join(json.dumps(record)+'\n' for record in records))
        page=self.bridge.timeline_read(self.support.THREAD,around=self.bridge.message_index(self.support.THREAD)['items'][0]['id'])
        row=next(r for r in page['rows'] if r['text']=='question 0')
        attachment=row['attachments'][0]
        self.assertIn('desktopId',attachment)
        self.assertNotIn('image_url',json.dumps(page))
        preview,_=self.bridge.desktop_image_preview(self.support.THREAD,attachment['desktopId'])
        self.assertEqual(preview['previewData'],data)
        with self.assertRaises(KeyError):self.bridge.desktop_image_preview(self.support.THREAD,'0'*64)
        from bridge.app.service import LiveSession
        other=LiveSession('other');other.state={}
        with patch.object(self.bridge,'session',return_value=other):
            with self.assertRaises(KeyError):self.bridge.desktop_image_preview('other',attachment['desktopId'])

    def test_navigation_malformed_embedded_image_cannot_be_served(self):
        records=[json.loads(line) for line in self.path.read_text().splitlines()]
        records[1]['payload']['content'].append({'type':'input_image','image_url':'data:image/png;base64,not-an-image'})
        self.path.write_text(''.join(json.dumps(record)+'\n' for record in records))
        page=self.bridge.timeline_read(self.support.THREAD,around=self.bridge.message_index(self.support.THREAD)['items'][0]['id'])
        image=next(r for r in page['rows'] if r['text']=='question 0')['attachments'][0]
        with self.assertRaises(KeyError):self.bridge.desktop_image_preview(self.support.THREAD,image['desktopId'])

    def test_navigation_edit_revalidates_its_anchor_before_creating_a_branch(self):
        import uuid
        session=self.bridge.session(self.support.THREAD)
        with session.condition:session.state['cwd']=str(self.root)
        page=self.bridge.timeline_read(self.support.THREAD,around=self.bridge.message_index(self.support.THREAD)['items'][0]['id'])
        row=next(r for r in page['rows'] if r['text']=='question 0')
        body={'id':str(uuid.uuid4()),'action':'edit-fork','key':page['epoch']+'.'+row['key'],'version':row['version'],'text':'replacement'}
        child=str(uuid.uuid4())
        with patch.object(self.bridge,'_target',side_effect=[session,RuntimeError('activation unavailable')]),patch('bridge.app.service.fork_copy',return_value=child) as fork:
            with self.assertRaisesRegex(RuntimeError,'activation unavailable'):
                self.bridge.message_action(self.support.THREAD,body)
            self.assertEqual(fork.call_args.kwargs['turn_id'],'old-0')
        body['id']=str(uuid.uuid4())
        self.path.write_bytes(self.path.read_bytes().replace(b'question 0',b'replaced 0'))
        with patch.object(self.bridge,'_target',return_value=session),patch('bridge.app.service.fork_copy') as fork:
            with self.assertRaises(ValueError):self.bridge.message_action(self.support.THREAD,body)
            fork.assert_not_called()

    def test_navigation_in_place_edit_loads_original_owner_and_rechecks_source(self):
        import uuid
        session=self.bridge.session(self.support.THREAD)
        page=self.bridge.timeline_read(self.support.THREAD,around=self.bridge.message_index(self.support.THREAD)['items'][0]['id'])
        row=next(r for r in page['rows'] if r['text']=='question 0')
        body={'id':str(uuid.uuid4()),'action':'edit','key':page['epoch']+'.'+row['key'],'version':row['version'],'text':'replacement'}
        def load(session,method,params,**kwargs):
            if method=='thread-follower-load-complete-history':
                with session.condition:
                    session.state['turns'].insert(0,{'turnId':'old-0','status':'completed',
                        'params':{'input':[{'type':'text','text':'question 0'}]},'items':[]})
                    session.changed()
            return {'ok':True}
        with patch.object(self.bridge,'_target',return_value=session),patch.object(self.bridge,'_call',side_effect=load) as call,patch('bridge.app.service.fork_copy') as fork:
            self.assertEqual(self.bridge.message_action(self.support.THREAD,body)['id'],self.support.THREAD)
            self.assertEqual([entry.args[1] for entry in call.call_args_list],
                ['thread-follower-load-complete-history','thread-follower-edit-last-user-turn'])
            self.assertTrue(call.call_args.args[2]['allowEarlierMessages'])
            self.assertEqual(call.call_args.args[2]['turnId'],'old-0')
            fork.assert_not_called()
        body['id']=str(uuid.uuid4())
        self.path.write_bytes(self.path.read_bytes().replace(b'question 0',b'replaced 0'))
        with patch.object(self.bridge,'_target',return_value=session),patch.object(self.bridge,'_call') as call:
            with self.assertRaises(ValueError):self.bridge.message_action(self.support.THREAD,body)
            call.assert_not_called()

    def test_ssh_navigation_source_runs_without_an_installed_project_package(self):
        from bridge.clients.codex.remote import RemoteStore
        remote=RemoteStore('fixture')
        def execute(alias,source,**kwargs):
            source=source.replace('os.environ.get("CODEX_HOME", str(Path.home()/".codex"))',repr(str(self.root)))
            result=subprocess.run([sys.executable,'-X','utf8','-I','-S','-B','-'],input=source,cwd=self.root,text=True,encoding='utf-8',capture_output=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            return json.loads(result.stdout)
        with patch('bridge.clients.codex.remote.ssh_read',side_effect=execute):
            nav=MessageNavigation(remote.navigation_scan,remote.navigation_window)
            catalog=nav.page(self.support.THREAD)
            result=nav.window(self.support.THREAD,around=catalog['items'][0]['id'],limit=10)
            raw=self.path.read_bytes().replace(b'question 50',b'changed_ 50')
            self.path.write_bytes(raw+b'{"type":"event_msg","payload":{"type":"task_complete"}}\n')
            with self.assertRaises(ValueError):nav.window(self.support.THREAD,around=catalog['items'][50]['id'])
            self.assertEqual(nav.page(self.support.THREAD)['items'][50]['summary'],'changed_ 50')
        self.assertEqual(len(catalog['items']),100)
        self.assertIn('question 0',str(result['state']))

    def test_path_boundary_is_enforced_for_local_and_injected_reader(self):
        db=sqlite3.connect(self.root/'state_5.sqlite')
        db.execute('UPDATE threads SET rollout_path=? WHERE id=?',(str(self.root/'outside.jsonl'),self.support.THREAD));db.commit();db.close()
        (self.root/'outside.jsonl').write_text('{}\n')
        with self.assertRaisesRegex(ValueError,'数据目录'):self.bridge.message_index(self.support.THREAD)
        from bridge.features.sessions.store import SessionStore
        from types import SimpleNamespace
        injected=SessionStore(self.root,navigation_source=SimpleNamespace(scan=scan_rollout,window=read_window,summarize=normalize_item))
        with self.assertRaisesRegex(ValueError,'数据目录'):injected.navigation_scan(self.support.THREAD)

    def test_backward_byte_budget_keeps_the_content_nearest_the_current_window(self):
        self.bridge.session(self.support.THREAD)
        catalog=self.bridge.message_index(self.support.THREAD)
        middle=self.bridge.timeline_read(self.support.THREAD,around=catalog['items'][80]['id'],limit=100)
        earlier=self.bridge.timeline_read(self.support.THREAD,before=middle['before'],limit=100)
        self.assertEqual(earlier['rows'][-1]['navigationPosition'],middle['rows'][0]['navigationPosition']-1)
        self.assertTrue(earlier['hasMore'])

    def test_large_attachment_summaries_cannot_push_the_target_out_of_its_window(self):
        self.bridge.session(self.support.THREAD)
        records=[{'type':'event_msg','payload':{'type':'task_started','turn_id':'wide'}}]
        for i in range(4):
            records.append({'type':'response_item','payload':{'type':'message','role':'user','content':[
                {'type':'input_text','text':str(i)+'🚀'*8000}]+[{'type':'file','name':'附件'*150} for _ in range(20)]}})
        self.path.write_text(''.join(json.dumps(record)+'\n' for record in records))
        catalog=self.bridge.message_index(self.support.THREAD)
        page=self.bridge.timeline_read(self.support.THREAD,around=catalog['items'][-1]['id'],limit=100)
        self.assertTrue(any(row['key']==page['targetKey'] for row in page['rows']))
        from bridge.features.sessions.timeline import encoded,PAGE_BYTES
        self.assertLessEqual(len(encoded(page['rows'])),PAGE_BYTES)

    def test_historical_attachments_and_artifacts_use_only_the_bounded_window_evidence(self):
        import base64
        png=self.root/'old-picture.png'
        png.write_bytes(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9foAAAAASUVORK5CYII='))
        artifact=self.root/'old-note.txt';artifact.write_text('old artifact')
        records=[json.loads(line) for line in self.path.read_text().splitlines()]
        records[1]['payload']['content']=[{'type':'localImage','path':str(png)}]
        records[2]['payload']['content']=[{'type':'output_text','text':'[note](<'+str(artifact)+'>)'}]
        self.path.write_text(''.join(json.dumps(record)+'\n' for record in records))
        session=self.bridge.session(self.support.THREAD)
        with session.condition:session.state['cwd']=str(self.root)
        catalog=self.bridge.message_index(self.support.THREAD)
        self.assertEqual(catalog['items'][0]['summary'],'old-picture.png')
        page=self.bridge.timeline_read(self.support.THREAD,around=catalog['items'][0]['id'])
        attachment=page['rows'][0]['attachments'][0]
        self.assertNotIn('path',attachment)
        preview,source=self.bridge.desktop_image_preview(self.support.THREAD,attachment['desktopId'])
        self.assertEqual(Path(preview['previewPath']),png)
        self.assertEqual(source,'desktop')
        item=next(item for item in page['files'] if item['name']=='old-note.txt')
        self.assertEqual(self.bridge.artifact(self.support.THREAD,item['id'])['path'],artifact)
        with self.assertRaises(KeyError):self.bridge.artifact(self.support.THREAD,'0'*64)


class MessageIndexHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import test_bridge as support
        support.HttpTests.setUpClass.__func__(cls)

    def setUp(self):
        import test_bridge as support
        self.support=support
        support.HttpTests.setUp(self)
        self.addCleanup(lambda:support.HttpTests.tearDown(self))

    def request(self,*args,**kwargs):return self.support.HttpTests.request(self,*args,**kwargs)
    def login(self):return self.support.HttpTests.login(self)

    def test_index_is_authenticated_read_only_and_keeps_host_routing(self):
        from unittest.mock import Mock
        read=Mock(return_value={'items':[],'status':'ready'})
        self.server.bridge.message_index=read
        path='/api/sessions/'+self.support.THREAD+'/message-index'
        self.assertEqual(self.request('GET',path)[0],401)
        read.assert_not_called()
        headers=self.login()
        self.assertEqual(self.request('GET',path+'?cursor=next&limit=50',headers=headers)[0],200)
        read.assert_called_once_with(self.support.THREAD,cursor='next',limit=50,since=None)
        self.assertEqual(self.request('GET',path+'?host=foreign',headers=headers)[0],404)
        self.assertEqual(self.request('POST',path,{},headers=headers)[0],404)
        self.assertEqual(read.call_count,1)
        self.assertEqual(self.request('GET',path+'?limit=bad',headers=headers)[0],400)

    def test_embedded_image_preview_requires_login_and_returns_image_bytes(self):
        import hashlib,http.client
        from unittest.mock import Mock
        data=b'\x89PNG\r\n\x1a\nfixture-image'
        preview=Mock(return_value=({'previewData':data,'previewMime':'image/png','previewSha256':hashlib.sha256(data).hexdigest(),'name':'image.png'},'embedded'))
        self.server.bridge.desktop_image_preview=preview
        path='/api/sessions/'+self.support.THREAD+'/desktop-images/'+'a'*64
        self.assertEqual(self.request('GET',path)[0],401);preview.assert_not_called()
        headers=self.login()
        connection=http.client.HTTPConnection('127.0.0.1',self.port,timeout=3)
        try:
            connection.request('GET',path,headers=headers);response=connection.getresponse()
            self.assertEqual(response.status,200);self.assertEqual(response.getheader('Content-Type'),'image/png')
            self.assertEqual(response.read(),data)
        finally:connection.close()

    def test_around_and_forward_cursor_reach_the_existing_timeline_route(self):
        from unittest.mock import Mock
        self.server.bridge.timeline_read=Mock(return_value={'rows':[]})
        path='/api/sessions/'+self.support.THREAD+'/timeline'
        self.assertEqual(self.request('GET',path+'?around=anchor&limit=30',headers=self.login())[0],200)
        self.server.bridge.timeline_read.assert_called_once_with(self.support.THREAD,limit=30,before=None,around='anchor')


if __name__=='__main__':unittest.main()
