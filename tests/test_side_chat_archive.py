import copy
import json
import os
import sqlite3
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

from bridge.clients.codex.native_side_chats import NativeSideChatSync
from bridge.features.sessions.side_chat import SideChat, SideChats, SideChatError
from bridge.features.sessions.side_chat_archive import SideChatArchive
from test_side_chat import RuntimeFixture


class SideChatPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.parent = str(uuid.uuid4())
        self.manager = self.open()

    def open(self, home='home', host='local'):
        manager = SideChats('fixture', self.root/home, self.root/'data', host,
            factory=lambda *args: SideChat(*args, runtime_factory=RuntimeFixture))
        manager.checked = True
        self.addCleanup(manager.close)
        return manager

    def create(self, slot=''):
        view = self.manager.operate(self.parent, 'create', {'creationId': str(uuid.uuid4()), **({'slot': slot} if slot else {})},
            {'cwd': str(self.root)}, {'model': 'fixture', 'modelProvider': 'custom'})
        return self.manager.chats[(self.parent, slot)], view

    def test_events_persist_without_reading_and_restart_never_restores_executor(self):
        chat, view = self.create()
        chat.send('question', str(uuid.uuid4()))
        chat.runtime.emit('item/agentMessage/delta', turnId='turn', itemId='reply', delta='saved stream')
        saved = self.manager.archive.read(self.parent, chat.id)
        self.assertEqual(saved['turns'][0]['messages'][-1]['text'], 'saved stream')
        self.assertEqual(saved['turns'][0]['messages'][0]['text'], 'question')
        self.manager.close()
        restored = self.open()
        restored.factory = Mock(side_effect=AssertionError('History must never create an executor'))
        reread = restored.operate(self.parent, 'read', {'archiveId': view['id']})
        self.assertTrue(reread['readOnly'])
        self.assertFalse(reread['connected'])
        self.assertEqual(reread['turns'], saved['turns'])
        self.assertEqual(restored.chats, {})
        self.assertEqual(len(restored.operate(self.parent, 'history', {})['items']), 1)
        restored.factory.assert_not_called()

    def test_storage_failure_blocks_send_and_recovery_does_not_replay(self):
        chat, _ = self.create()
        submission = str(uuid.uuid4())
        with patch.object(self.manager.archive, 'save', side_effect=sqlite3.OperationalError('disk full')):
            with self.assertRaisesRegex(SideChatError, '保存异常'):
                chat.send('blocked', submission)
            self.assertTrue(chat.view()['saveError'])
            self.assertFalse(any(method == 'turn/start' for method, _ in chat.runtime.calls))
        recovered = self.manager.operate(self.parent, 'read', {})
        self.assertIsNone(recovered['saveError'])
        self.assertEqual(recovered['submissions'][0]['status'], 'failed')
        self.assertFalse(any(method == 'turn/start' for method, _ in chat.runtime.calls))
        chat.send('explicit new message', str(uuid.uuid4()))
        self.assertEqual(sum(method == 'turn/start' for method, _ in chat.runtime.calls), 1)

    def test_closed_attachments_remain_readable_but_cannot_be_changed(self):
        chat, _ = self.create()
        attachment = str(uuid.uuid4())
        self.manager.attachment(self.parent, chat.id, 'put', attachment, 'image.png', b'\x89PNG\r\n\x1a\nfixture')
        chat.send('', str(uuid.uuid4()), [attachment])
        self.manager.operate(self.parent, 'close', {'id': chat.id})
        self.assertEqual(self.manager.activity(self.parent), [])
        saved = self.manager.operate(self.parent, 'read', {'archiveId': chat.id})
        self.assertTrue(saved['readOnly'])
        with self.assertRaises(ValueError):
            self.manager.operate(self.parent, 'send', {'id': chat.id, 'text': 'no', 'submissionId': str(uuid.uuid4())})
        self.manager.close()
        restored = self.open()
        artifact, _ = restored.attachment(self.parent, chat.id, 'preview', attachment)
        self.assertTrue(Path(artifact['previewPath']).is_file())
        with self.assertRaises(ValueError):
            restored.attachment(str(uuid.uuid4()), chat.id, 'preview', attachment)
        with self.assertRaises(ValueError):
            restored.attachment(self.parent, chat.id, 'put', str(uuid.uuid4()), 'new.txt', b'no')

    def test_question_answers_are_saved_as_inert_history(self):
        chat, _ = self.create()
        chat.send('question', str(uuid.uuid4()))
        chat._event({'id': 'question-request', 'method': 'item/tool/requestUserInput', 'params': {
            'threadId': chat.id, 'turnId': 'turn', 'questions': [{'id': 'choice', 'question': 'Which option?'}]}})
        chat.respond('question-request', {'answers': {'choice': ['saved answer']}})
        saved = self.manager.archive.read(self.parent, chat.id)
        self.assertEqual(saved['requests'], [])
        self.assertFalse(saved['historyRequests'][0]['supported'])
        self.assertEqual(saved['historyResponses'][0]['response']['answers']['choice']['answers'], ['saved answer'])
        self.assertEqual(sum(method == 'turn/start' for method, _ in chat.runtime.calls), 1)

    def test_archives_do_not_use_active_slots_and_history_is_paginated(self):
        for _ in range(33):
            chat, _ = self.create()
            self.manager.operate(self.parent, 'close', {'id': chat.id})
        page = self.manager.operate(self.parent, 'history', {})
        self.assertEqual(len(page['items']), 30)
        rest = self.manager.operate(self.parent, 'history', {'offset': page['nextOffset']})
        self.assertEqual(len(rest['items']), 3)
        self.assertIsNone(rest['nextOffset'])
        self.assertEqual(len({row['id'] for row in page['items']+rest['items']}), 33)
        self.assertEqual(self.manager.chats, {})

    def test_disconnected_executors_do_not_consume_running_limit(self):
        for _ in range(9):
            chat, _ = self.create(str(uuid.uuid4()))
            chat._event({'method': 'bridge/disconnected'})
            self.assertTrue(chat.view()['readOnly'])
        self.assertEqual(len(self.manager.archive.list(self.parent)['items']), 9)
        self.assertEqual(self.manager.operate(self.parent, 'read', {})['slots'], [])

    def test_profiles_hosts_and_parents_are_isolated(self):
        chat, _ = self.create()
        for manager in (self.open('other-profile'), self.open(host='ssh:other')):
            self.assertEqual(manager.operate(self.parent, 'history', {})['items'], [])
            self.assertIsNone(manager.archive.read(self.parent, chat.id))
        self.assertIsNone(self.manager.archive.read(str(uuid.uuid4()), chat.id))

    def test_native_attachment_is_copied_only_from_verified_workspace(self):
        workspace = self.root/'project';workspace.mkdir()
        inside, outside = workspace/'inside.png', self.root/'outside.png'
        inside.write_bytes(b'\x89PNG\r\n\x1a\nfixture');outside.write_bytes(b'private')
        child = str(uuid.uuid4())
        state = {'id': child, 'cwd': str(workspace), 'modelProvider': 'custom', 'turns': [
            {'turnId': 'native', 'items': [{'id': 'user', 'type': 'userMessage', 'content': [
                {'type': 'localImage', 'path': str(inside)}, {'type': 'localImage', 'path': str(outside)}]}]}]}
        self.manager.native_snapshot(self.parent, child, state, 1)
        saved = self.manager.archive.read(self.parent, child)
        files = saved['turns'][0]['messages'][0]['attachments']
        self.assertEqual(len(files), 2)
        self.assertNotIn('unavailable', files[0])
        self.assertTrue(files[1]['unavailable'])
        self.assertNotIn('path', files[1])
        self.assertEqual(saved['source'], 'desktop')
        artifact, _ = self.manager.attachment(self.parent, child, 'preview', files[0]['id'])
        self.assertEqual(Path(artifact['previewPath']).read_bytes(), inside.read_bytes())
        inside.unlink()
        self.manager.native_snapshot(self.parent, child, state, 2)
        saved = self.manager.archive.read(self.parent, child)
        self.assertNotIn('unavailable', saved['turns'][0]['messages'][0]['attachments'][0])

    def test_incremental_updates_reject_old_revision_and_keep_requests_inert(self):
        chat, _ = self.create()
        view = {'id': chat.id, 'title': 'stored', 'turns': [{'id': 'one', 'messages': [
            {'id': 'm1', 'role': 'assistant', 'text': 'one'}, {'id': 'm2', 'role': 'assistant', 'text': 'two'}]}],
            'requests': [{'id': 9, 'supported': True, 'params': {'command': 'do not execute'}}], 'auth': 'NOT_A_CREDENTIAL_TO_SAVE'}
        store = self.manager.archive
        store.save(self.parent, '', view, revision=10)
        count = store.db.total_changes
        newer = copy.deepcopy(view)
        newer['turns'][0]['messages'][1]['text'] = 'updated'
        newer['requests'] = []
        store.save(self.parent, '', newer, revision=11)
        self.assertEqual(store.db.total_changes-count, 2, 'Only metadata and the changed message are written')
        store.save(self.parent, '', view, revision=9)
        restored = store.read(self.parent, chat.id)
        self.assertEqual(restored['turns'][0]['messages'][1]['text'], 'updated')
        self.assertEqual(restored['requests'], [])
        self.assertFalse(restored['historyRequests'][0]['supported'])
        self.assertNotIn('NOT_A_CREDENTIAL_TO_SAVE', store.db.execute('SELECT metadata FROM chats').fetchone()[0])

    def test_snapshot_import_is_idempotent_and_title_only_history_has_no_fake_body(self):
        folder = self.root/'data'/'side-chat-recovery'
        folder.mkdir()
        child, title_child = str(uuid.uuid4()), str(uuid.uuid4())
        view = {'id': child, 'cwd': str(self.root), 'provider': 'custom', 'title': 'Recovered',
                'turns': [{'id': 't', 'messages': [{'id': 'm', 'role': 'user', 'text': 'saved'}]}]}
        (folder/'snapshot.json').write_text(json.dumps([{'parent': self.parent, 'slot': '', 'view': view}]), encoding='utf-8')
        lookup = lambda parent: {'cwd': str(self.root), 'model_provider': 'custom', 'origin': 'desktop'}
        self.manager.archive.import_snapshots(lookup)
        self.manager.archive.import_snapshots(lookup)
        self.assertEqual(len(self.manager.archive.list(self.parent)['items']), 1)
        older = {**view, 'parentId': self.parent, 'turns': [{'id': 't', 'messages': [
            {'id': 'earlier', 'role': 'user', 'text': 'earlier page'}, {'id': 'm', 'role': 'user', 'text': 'outdated'}]}]}
        old_path = folder/'older-direct-view.json'
        old_path.write_text(json.dumps(older), encoding='utf-8')
        os.utime(old_path, (1, 1))
        self.manager.archive.import_snapshots(lookup)
        merged = self.manager.archive.read(self.parent, child)['turns'][0]['messages']
        self.assertEqual([m['text'] for m in merged], ['earlier page', 'saved'])
        receipts = sqlite3.connect(str(self.root/'data'/'chat-read-state.sqlite3'))
        receipts.execute('CREATE TABLE completions(host TEXT,chat TEXT)')
        receipts.execute('INSERT INTO completions VALUES (?,?)', ('local', self.parent+'/side/'+title_child))
        receipts.commit();receipts.close()
        (self.root/'data'/'auto-titles.json').write_text(json.dumps({'side:'+title_child: {'title': 'Title only'}}), encoding='utf-8')
        self.manager.archive.import_titles(lookup)
        saved = self.manager.archive.read(self.parent, title_child)
        self.assertFalse(saved['hasBody'])
        self.assertEqual(saved['turns'], [])


class NativeSideChatSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.parent, self.child = str(uuid.uuid4()), str(uuid.uuid4())
        self.store = SideChatArchive(self.root, self.root/'home', 'local')
        self.addCleanup(self.store.close)
        self.ipc = Mock()
        self.ipc.owner.return_value = 'native-owner'
        self.lookup = Mock(return_value={'origin': 'desktop', 'cwd': str(self.root), 'model_provider': 'custom'})
        self.save = Mock(side_effect=lambda parent, child, state, revision: self.store.save(parent, child,
            {'id': child, 'title': 'Native', 'turns': [{'id': 'turn', 'messages': [{'id': 'reply', 'role': 'assistant', 'text': state.get('text', '')}]}]}, source='desktop'))
        self.sync = NativeSideChatSync('fixture', 'local', self.lookup, self.save,
            self.store.disconnect, log_files=lambda: [], ipc_factory=lambda *args: self.ipc)
        self.addCleanup(self.sync.close)
        self.sync.follow(self.child)
        self.state = {'id': self.child, 'forkedFromId': self.parent, 'ephemeral': True,
            'sideConversation': True, 'cwd': str(self.root), 'modelProvider': 'custom', 'text': 'first'}

    def event(self, change, **overrides):
        self.sync.event({'method': 'thread-stream-state-changed', 'version': 11,
            'sourceClientId': overrides.get('owner', 'native-owner'), 'params': {
                'hostId': overrides.get('host', 'local'), 'conversationId': self.child, 'change': change}})

    def test_snapshot_patches_gap_and_stale_data_never_resume_or_execute(self):
        self.event({'type': 'snapshot', 'revision': 5, 'conversationState': self.state})
        self.event({'type': 'patches', 'baseRevision': 5, 'revision': 6, 'patches': [{'op': 'replace', 'path': ['text'], 'value': 'second'}]})
        self.event({'type': 'snapshot', 'revision': 4, 'conversationState': self.state})
        self.assertEqual(self.save.call_count, 2)
        self.assertEqual(self.store.read(self.parent, self.child)['turns'][0]['messages'][0]['text'], 'second')
        self.event({'type': 'patches', 'baseRevision': 3, 'revision': 7, 'patches': []})
        self.assertEqual(self.store.read(self.parent, self.child)['syncState'], 'offline')
        self.assertEqual(self.ipc.follow.call_count, 2, 'A gap requests a fresh owner snapshot')
        self.event({'type': 'snapshot', 'revision': 4, 'conversationState': self.state})
        self.assertEqual(self.store.read(self.parent, self.child)['turns'][0]['messages'][0]['text'], 'second')
        self.event({'type': 'snapshot', 'revision': 6, 'conversationState': {**self.state, 'text': 'second'}})
        self.assertEqual(self.sync.status()['state'], 'connected')
        self.assertFalse(self.ipc.request.called)
        self.sync.disconnect()
        self.assertEqual(self.sync.status()['state'], 'unavailable')

    def test_wrong_owner_host_parent_provider_or_non_side_is_rejected(self):
        self.event({'type': 'snapshot', 'revision': 1, 'conversationState': self.state}, owner='other')
        self.event({'type': 'snapshot', 'revision': 1, 'conversationState': self.state}, host='ssh:other')
        for key, value in [('sideConversation', False), ('ephemeral', False), ('modelProvider', 'other'), ('cwd', str(self.root/'other')), ('forkedFromId', self.child)]:
            self.sync.follow(self.child)
            self.event({'type': 'snapshot', 'revision': 1, 'conversationState': {**self.state, key: value}})
        self.save.assert_not_called()
        self.assertEqual(self.store.list(self.parent)['items'], [])

    def test_routing_logs_are_only_bounded_hints_and_partial_lines_are_not_consumed(self):
        path = self.root/'routing.log'
        line = 'thread/inject_items threadId='+self.child
        path.write_text(line, encoding='utf-8')
        self.sync.log_files = lambda: [path]
        self.assertEqual(self.sync.candidates(), [])
        with path.open('a', encoding='utf-8') as stream:
            stream.write('\n')
        self.assertEqual(self.sync.candidates(), [self.child])
        self.assertEqual(self.sync.candidates(), [])
        self.save.assert_not_called()


if __name__ == '__main__':
    unittest.main()
