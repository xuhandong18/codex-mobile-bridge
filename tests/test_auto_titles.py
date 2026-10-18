from contextlib import closing
import json
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from bridge.features.sessions.auto_titles import AutoTitles
from bridge.features.sessions.model import normalize_state, session_title
from bridge.clients.codex.title_runtime import clean_title, TitleError
from bridge.features.sessions.side_chat import SideChat
import test_bridge as support
from test_side_chat import RuntimeFixture


def wait_for(predicate):
    end = time.monotonic() + 3
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.01)
    raise AssertionError('Background title did not reach expected state')


class AutoTitleJobTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=support.ROOT / '.tmp')
        self.addCleanup(self.temp.cleanup)
        self.jobs = AutoTitles(self.temp.name)
        self.addCleanup(self.jobs.close)

    def test_once_per_chat_without_persisting_prompt_and_restart_does_not_replay(self):
        received = []
        self.jobs.submit('main:chat', 'PRIVATE FIRST MESSAGE', lambda cancel: {'title': '整理项目需求', 'usage': {'last': {'totalTokens': 20}}},
                         lambda title: received.append(title) or True)
        wait_for(lambda: self.jobs.jobs['main:chat']['status'] == 'complete')
        self.assertFalse(self.jobs.submit('main:chat', 'second', lambda cancel: self.fail('duplicate'), lambda title: True))
        self.assertEqual(received, ['整理项目需求'])
        saved = self.jobs.path.read_text(encoding='utf-8')
        self.assertNotIn('PRIVATE FIRST MESSAGE', saved)
        self.jobs.close()
        again = AutoTitles(self.temp.name)
        self.addCleanup(again.close)
        self.assertFalse(again.submit('main:chat', 'third', None, None))
        self.assertEqual(again.jobs['main:chat']['usage']['last']['totalTokens'], 20)

    def test_manual_name_cancels_inflight_job_and_late_result_cannot_apply(self):
        started, release = threading.Event(), threading.Event()
        applied = []

        def generate(cancel):
            started.set()
            release.wait(2)
            self.assertTrue(cancel.is_set())
            return {'title': '迟到的摘要'}

        self.jobs.submit('main:chat', 'first', generate, lambda title: applied.append(title))
        self.assertTrue(started.wait(1))
        self.jobs.protect('main:chat')
        release.set()
        wait_for(lambda: 'main:chat' not in self.jobs.cancels)
        self.assertEqual(applied, [])
        self.assertEqual(self.jobs.jobs['main:chat']['status'], 'manual')

    def test_unknown_results_and_pre_restart_work_are_never_replayed(self):
        calls = []

        def generate(cancel):
            calls.append('sent')
            raise TimeoutError('private provider response')

        self.jobs.submit('main:chat', 'first', generate, lambda title: self.fail('unknown write'))
        wait_for(lambda: self.jobs.jobs['main:chat']['status'] == 'unknown')
        self.assertFalse(self.jobs.submit('main:chat', 'first', generate, lambda title: True))
        self.assertEqual(calls, ['sent'])
        self.jobs.close()
        self.jobs.path.write_text(json.dumps({'main:pending': {'status': 'running'}}), encoding='utf-8')
        again = AutoTitles(self.temp.name)
        self.addCleanup(again.close)
        self.assertEqual(again.jobs['main:pending']['status'], 'unknown')
        self.assertFalse(again.submit('main:pending', 'first', generate, None))

    def test_only_raw_first_message_titles_are_shortened_and_manual_names_win(self):
        text = '第一条消息' * 30
        self.assertEqual(session_title({'title': text, 'first_user_message': text}), text[:28] + '…')
        self.assertEqual(normalize_state({'title': text, 'first_user_message': text})['titleSource'], 'preview')
        self.assertEqual(session_title({'name': text, 'title': text, 'first_user_message': text}), text)
        self.assertEqual(clean_title('  “修复侧边聊天同步”  '), '修复侧边聊天同步')
        for value in ('', '字' * 29, '隐藏\u200b字符', None):
            with self.assertRaises(TitleError):
                clean_title(value)


class SideAutoTitleTests(unittest.TestCase):
    def setUp(self):
        self.chat = SideChat('fixture', '/home', str(uuid.uuid4()), '/project',
                             {'model': 'fixture', 'modelProvider': 'custom'}, RuntimeFixture)
        self.addCleanup(self.chat.close)

    def test_first_accepted_message_only_and_manual_rename_wins(self):
        calls = []
        self.chat.on_first_message = lambda chat, text: calls.append((text, chat.title_revision))
        identifier = str(uuid.uuid4())
        text = '请支持多个侧边聊天并同步手机和平板中的名称，方便我在不同设备继续讨论。'
        self.chat.send(text, identifier)
        self.chat.send(text, identifier)
        self.assertEqual(len(calls), 1)
        revision = calls[0][1]
        self.assertEqual(self.chat.view()['titleSource'], 'preview')
        self.assertLessEqual(len(self.chat.view()['title']), 29)
        self.assertTrue(self.chat.apply_auto_title('支持多个侧边聊天与同步', revision))
        self.assertEqual(self.chat.view()['titleSource'], 'summary')
        self.chat.rename(self.chat.title)  # Same text is still an explicit choice.
        self.assertFalse(self.chat.apply_auto_title('迟到的摘要', revision))
        self.assertEqual(self.chat.view()['titleSource'], 'manual')

    def test_preset_name_or_unknown_first_send_never_summarizes_a_later_message(self):
        calls = []
        self.chat.on_first_message = lambda chat, text: calls.append(text)
        self.chat.runtime.fail_send = True
        self.assertEqual(self.chat.send('first', str(uuid.uuid4()))['status'], 'unknown')
        self.chat.runtime.fail_send = False
        self.chat.state['threadRuntimeStatus']['type'] = 'idle'
        self.chat.send('second', str(uuid.uuid4()))
        self.assertEqual(calls, [])

    def test_named_chat_skips_generation_and_close_discards_result(self):
        self.chat.on_first_message = lambda chat, text: self.fail('manual title must win')
        self.chat.rename('我的侧边聊天')
        self.chat.send('first', str(uuid.uuid4()))
        self.chat.close()
        self.assertFalse(self.chat.apply_auto_title('关闭后的摘要', self.chat.title_revision))


class MainAutoTitleTests(unittest.TestCase):
    def setUp(self):
        # Reuse the real desktop IPC fixture without inheriting its unrelated tests.
        self.support = support.IntegrationTests()
        self.support.setUp()
        self.addCleanup(self.support.tearDown)
        self.bridge, self.fixture = self.support.bridge, self.support.fixture
        with closing(sqlite3.connect(self.support.root / 'state_5.sqlite')) as db:
            db.execute('ALTER TABLE threads ADD COLUMN first_user_message TEXT')
            db.execute('ALTER TABLE threads ADD COLUMN name TEXT')
            db.execute('UPDATE threads SET title=""')
            db.commit()
        self.fixture.state['title'] = ''
        self.fixture.state['cwd'] = str(self.support.root)
        self.bridge.view(support.THREAD)
        self.started, self.release = threading.Event(), threading.Event()
        self.calls = []

        def generate(*args, **kwargs):
            self.calls.append(args)
            self.started.set()
            self.release.wait(2)
            return {'title': '修复侧边聊天同步', 'usage': {'last': {'totalTokens': 30}}}

        def rename(executable, home, identifier, title):
            with closing(sqlite3.connect(self.support.root / 'state_5.sqlite')) as db:
                db.execute('UPDATE threads SET name=? WHERE id=?', (title, identifier))
                db.commit()

        self.patch_generate = patch('bridge.app.service.generate_title', side_effect=generate)
        self.patch_generate.start()
        self.addCleanup(self.patch_generate.stop)
        self.patch_rename = patch('bridge.app.service.rename_thread', side_effect=rename)
        self.patch_rename.start()
        self.addCleanup(self.patch_rename.stop)
        self.addCleanup(self.release.set)

    def test_accepted_send_schedules_without_blocking_and_writes_native_shared_name_once(self):
        message = str(uuid.uuid4())
        result = self.bridge.send(support.THREAD, '请修复侧边聊天的同步问题', message)
        self.assertEqual(result['status'], 'accepted')
        self.assertTrue(self.started.wait(1))
        self.bridge.send(support.THREAD, '请修复侧边聊天的同步问题', message)
        for _ in range(3):
            self.bridge.view(support.THREAD)
        self.assertEqual(len(self.calls), 1)
        self.release.set()
        wait_for(lambda: self.bridge.auto_titles.jobs['main:' + support.THREAD]['status'] == 'complete')
        self.assertEqual(self.bridge.view(support.THREAD)['title'], '修复侧边聊天同步')
        self.assertEqual(self.bridge.list(local_only=True)[0]['title'], '修复侧边聊天同步')
        self.assertEqual(self.calls[0][3:5], ('same-model', 'custom-api'))
        requests = [r for r in self.fixture.requests if r['method'] == 'thread-follower-start-turn']
        self.assertEqual(len(requests), 1)

    def test_manual_name_while_generating_cannot_be_overwritten(self):
        self.bridge.send(support.THREAD, '请修复同步', str(uuid.uuid4()))
        self.assertTrue(self.started.wait(1))
        self.bridge.rename(support.THREAD, '我的手动名称')
        self.release.set()
        wait_for(lambda: not self.bridge.auto_titles.cancels)
        self.assertEqual(self.bridge.view(support.THREAD)['title'], '我的手动名称')

    def test_desktop_name_arriving_while_generating_is_reused(self):
        self.bridge.send(support.THREAD, '请修复同步', str(uuid.uuid4()))
        self.assertTrue(self.started.wait(1))
        with closing(sqlite3.connect(self.support.root / 'state_5.sqlite')) as db:
            db.execute('UPDATE threads SET name="桌面原生摘要"')
            db.commit()
        self.release.set()
        wait_for(lambda: self.bridge.auto_titles.jobs['main:' + support.THREAD]['status'] == 'skipped')
        self.assertEqual(self.bridge.list(local_only=True)[0]['title'], '桌面原生摘要')

    def test_native_title_available_before_queued_work_skips_inference(self):
        busy, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def blocker(cancel):
            busy.set()
            release.wait(2)
            return {'title': '队列占位'}

        self.bridge.auto_titles.submit('side:blocker', 'first', blocker, lambda title: True)
        self.assertTrue(busy.wait(1))
        self.bridge.send(support.THREAD, '请修复同步', str(uuid.uuid4()))
        with closing(sqlite3.connect(self.support.root / 'state_5.sqlite')) as db:
            db.execute('UPDATE threads SET name="桌面原生摘要"')
            db.commit()
        release.set()
        wait_for(lambda: self.bridge.auto_titles.jobs['main:' + support.THREAD]['status'] == 'skipped')
        self.assertEqual(self.calls, [])
        self.assertTrue(self.bridge.auto_titles.jobs['main:' + support.THREAD]['reusedNative'])

    def test_old_messages_and_reads_never_start_model_work(self):
        with closing(sqlite3.connect(self.support.root / 'state_5.sqlite')) as db:
            db.execute('UPDATE threads SET first_user_message="已有首条消息"')
            db.commit()
        self.bridge.list(local_only=True)
        self.bridge.view(support.THREAD)
        self.bridge.send(support.THREAD, '后续消息', str(uuid.uuid4()))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.bridge.auto_titles.jobs, {})

    def test_unknown_first_send_does_not_summarize_a_later_message(self):
        with patch.object(self.bridge, '_call', side_effect=support.IPCError('result unknown')):
            with self.assertRaises(support.IPCError):
                self.bridge.send(support.THREAD, 'first', str(uuid.uuid4()))
        self.bridge.send(support.THREAD, 'second', str(uuid.uuid4()))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.bridge.auto_titles.jobs, {})

    def test_side_title_reaches_discovery_on_both_devices_without_parent_rename(self):
        self.bridge.side_chats.checked = True
        self.bridge.side_chats.factory = lambda *args: SideChat(*args, runtime_factory=RuntimeFixture)
        slot = str(uuid.uuid4())
        child = self.bridge.side_chat(support.THREAD, 'phone', 'create',
            {'slot': slot, 'creationId': str(uuid.uuid4())})
        text = '请修复手机和平板之间侧边聊天丢失的问题，并且支持多个侧边聊天。'
        result = self.bridge.side_chat(support.THREAD, 'phone', 'send',
            {'slot': slot, 'id': child['id'], 'text': text, 'submissionId': str(uuid.uuid4())})
        self.assertEqual(result['status'], 'accepted')
        self.assertTrue(self.started.wait(1))
        pending = self.bridge.side_chat(support.THREAD, 'tablet', 'read', {'slot': slot})
        self.assertEqual(pending['titleSource'], 'preview')
        self.release.set()
        wait_for(lambda: self.bridge.auto_titles.jobs['side:' + child['id']]['status'] == 'complete')
        phone = self.bridge.side_chat(support.THREAD, 'phone', 'read', {'slot': slot})
        tablet = self.bridge.side_chat(support.THREAD, 'tablet', 'read', {'slot': slot})
        self.assertEqual(phone['title'], '修复侧边聊天同步')
        self.assertEqual(phone['titleSource'], 'summary')
        self.assertGreater(tablet['titleRevision'], pending['titleRevision'])
        self.assertEqual(tablet['slots'][0]['title'], phone['title'])
        self.assertFalse(self.bridge.store.get(support.THREAD)['name'])

    def test_queue_waiting_or_account_change_cannot_send_a_title_request(self):
        candidate = self.bridge._title_candidate(self.bridge.live[support.THREAD], 'first')
        (self.support.root / 'config.toml').write_text('model_provider="another"', encoding='utf-8')
        self.bridge._schedule_title(self.bridge.live[support.THREAD], 'first', candidate)
        wait_for(lambda: self.bridge.auto_titles.jobs['main:' + support.THREAD]['status'] == 'unknown')
        self.assertEqual(self.calls, [])
