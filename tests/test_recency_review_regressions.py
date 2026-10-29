"""独立审查的排序回归；只用合成运行时、临时 SQLite/JSONL 和 SSH 执行桩。"""
import copy
import io
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import uuid
from contextlib import closing, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge.app.service import Bridge
from bridge.clients.codex.remote import AppHosts, RemoteStore
from bridge.features.sessions.message_index import scan_message_recency
from bridge.features.sessions.model import normalize_item
from bridge.features.sessions.recency import RecencyIndex
from bridge.features.sessions.side_chat import SideChat
from bridge.features.sessions.store import SessionStore
from test_side_chat import RuntimeFixture


BASE = 1800000000000
CONFIRMED = BASE + 1000
BODY_AT = BASE + 5000
ARRIVAL = BASE + 900000


class SideChatReviewRegressions(unittest.TestCase):
    def setUp(self):
        self.chat = SideChat('fixture-runtime', '/fixture-home', str(uuid.uuid4()),
                             '/fixture-project', {'model': 'fixture', 'modelProvider': 'custom'},
                             RuntimeFixture)
        self.addCleanup(self.chat.close)
        self.submission = str(uuid.uuid4())
        with patch('bridge.features.sessions.side_chat.time.time', return_value=CONFIRMED / 1000):
            result = self.chat.send('已确认的用户问题', self.submission)
        self.assertEqual(result['status'], 'accepted')
        self.assertEqual(self.chat.view()['recency'], CONFIRMED)

    def emit(self, method, **params):
        with patch('bridge.features.sessions.side_chat.time.time', return_value=ARRIVAL / 1000):
            self.chat.runtime.emit(method, **params)

    def test_old_item_timestamp_does_not_become_arrival_now(self):
        for number, method in enumerate(('item/started', 'item/completed')):
            with self.subTest(method=method):
                at = BODY_AT + number * 1000
                item = {'id': method, 'type': 'agentMessage', 'phase': 'commentary',
                        'text': '延迟到达的独立文字进度', 'timestamp': at}
                self.emit(method, turnId='turn', item=item)
                self.assertEqual(self.chat.view()['recency'], at,
                                 '正文应采用原生时间，不能采用较晚的事件到达时间')

    def test_untimed_body_is_displayed_without_inventing_recency(self):
        for method in ('item/started', 'item/completed'):
            with self.subTest(method=method):
                self.emit(method, turnId='turn', item={
                    'id': method, 'type': 'agentMessage', 'text': '没有时间的真实正文'})
                messages = self.chat.view()['turns'][0]['messages']
                self.assertTrue(any(row['id'] == method and row['text'] == '没有时间的真实正文'
                                    for row in messages), '不能通过丢弃正文来满足排序断言')
                self.assertEqual(self.chat.view()['recency'], CONFIRMED)

    def test_untimed_delta_is_displayed_without_inventing_recency(self):
        self.emit('item/agentMessage/delta', turnId='turn', itemId='reply', delta='无时间的增量')
        reply = next(row for row in self.chat.view()['turns'][0]['messages'] if row['id'] == 'reply')
        self.assertEqual(reply['text'], '无时间的增量')
        self.assertEqual(self.chat.view()['recency'], CONFIRMED,
                         'delta 没有消息或事件时间时也不能回退到 now')

    def test_delta_uses_explicit_event_timestamp(self):
        self.emit('item/agentMessage/delta', turnId='turn', itemId='reply',
                  delta='带事件时间的增量', timestamp=BODY_AT)
        self.assertEqual(self.chat.view()['turns'][0]['messages'][-1]['text'], '带事件时间的增量')
        self.assertEqual(self.chat.view()['recency'], BODY_AT)

    def test_delta_can_use_native_item_timestamp_without_event_timestamp(self):
        self.emit('item/started', turnId='turn', item={
            'id': 'reply', 'type': 'agentMessage', 'text': '', 'timestamp': BODY_AT})
        self.assertEqual(self.chat.view()['recency'], CONFIRMED, '空占位不能推动排序')
        self.emit('item/agentMessage/delta', turnId='turn', itemId='reply', delta='实际新增正文')
        self.assertEqual(self.chat.view()['recency'], BODY_AT)

    def test_completed_snapshot_uses_only_new_body_timestamps(self):
        # 已有正文时间故意更大；状态快照不能把未变化条目的时间算作新交互。
        turn = self.chat.state['turns'][0]
        turn['items'].append({'id': 'unchanged', 'type': 'agentMessage',
                              'text': '已有正文', 'timestamp': ARRIVAL - 1000})
        items = copy.deepcopy(turn['items'])
        reply = next(item for item in items if item['id'] == 'reply')
        reply.update(text='只在完成快照出现的新正文', timestamp=BODY_AT)
        self.emit('turn/completed', turn={'id': 'turn', 'status': 'completed', 'items': items})
        self.assertEqual(self.chat.activity()['status'], 'idle')
        self.assertEqual(self.chat.view()['recency'], BODY_AT)

    def test_untimed_completed_snapshot_does_not_invent_recency(self):
        self.emit('turn/completed', turn={'id': 'turn', 'status': 'completed', 'items': [
            {'id': 'final', 'type': 'agentMessage', 'phase': 'final_answer', 'text': '无时间的最终正文'}]})
        self.assertEqual(self.chat.view()['turns'][0]['messages'][-1]['text'], '无时间的最终正文')
        self.assertEqual(self.chat.view()['recency'], CONFIRMED)

    def test_successful_user_send_still_counts_confirmation_now_once(self):
        self.emit('turn/completed', turn={'id': 'turn', 'status': 'completed'})
        submission = str(uuid.uuid4())
        with patch('bridge.features.sessions.side_chat.time.time', return_value=ARRIVAL / 1000):
            self.assertEqual(self.chat.send('另一条成功发送', submission)['status'], 'accepted')
        self.assertEqual(self.chat.view()['recency'], ARRIVAL)
        with patch('bridge.features.sessions.side_chat.time.time', return_value=(ARRIVAL + 60000) / 1000):
            self.assertEqual(self.chat.send('另一条成功发送', submission)['status'], 'accepted')
        self.assertEqual(self.chat.view()['recency'], ARRIVAL, '幂等重试不重复计时')

    def test_successful_user_response_still_counts_confirmation_now_once(self):
        self.chat._event({'id': 70, 'method': 'item/commandExecution/requestApproval', 'params': {
            'threadId': self.chat.id, 'turnId': 'turn', 'availableDecisions': ['accept', 'decline']}})
        self.assertEqual(self.chat.view()['recency'], CONFIRMED)
        with patch('bridge.features.sessions.side_chat.time.time', return_value=ARRIVAL / 1000):
            self.chat.respond(70, {'decision': 'accept'})
        self.assertEqual(self.chat.runtime.responses[-1], {'id': 70, 'result': {'decision': 'accept'}})
        self.assertEqual(self.chat.view()['recency'], ARRIVAL)
        with patch('bridge.features.sessions.side_chat.time.time', return_value=(ARRIVAL + 60000) / 1000):
            with self.assertRaises(ValueError):
                self.chat.respond(70, {'decision': 'accept'})
        self.assertEqual(self.chat.view()['recency'], ARRIVAL)


class TemporaryReviewTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(
            dir=Path(__file__).resolve().parents[1] / '.tmp', prefix='recency-review-')
        self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        self.database = self.home / 'state_5.sqlite'
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, cwd TEXT, '
                       'created_at_ms INTEGER, recency_at_ms INTEGER, updated_at INTEGER, '
                       'archived INTEGER, originator TEXT, source TEXT, thread_source TEXT, rollout_path TEXT)')
        self.store = SessionStore(self.home)

    def insert(self, rows):
        defaults = {'title': '合成聊天', 'cwd': '/fixture-project', 'created_at_ms': BASE,
                    'recency_at_ms': BASE, 'updated_at': BASE // 1000 + 5, 'archived': 0,
                    'originator': 'Codex Desktop', 'source': 'vscode', 'thread_source': '',
                    'rollout_path': 'unused'}
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executemany('INSERT INTO threads VALUES(:id,:title,:cwd,:created_at_ms,:recency_at_ms,'
                           ':updated_at,:archived,:originator,:source,:thread_source,:rollout_path)',
                           [{**defaults, **row} for row in rows])


class PendingRolloutReviewRegressions(TemporaryReviewTests):
    def setUp(self):
        super().setUp()
        self.identifier = str(uuid.uuid4())
        sessions = self.home / 'sessions'
        sessions.mkdir()
        self.rollout = sessions / 'rollout.jsonl'

        def encode(value):
            return (json.dumps(value, ensure_ascii=False) + '\n').encode('utf-8')

        def message(at, identifier, text):
            return encode({'type': 'response_item', 'timestamp': at, 'payload': {
                'id': identifier, 'type': 'message', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': text}]}})

        self.next_line = message(BODY_AT, 'new', '稍后写完的新正文')
        self.split = 40
        self.rollout.write_bytes(encode({'type': 'session_meta', 'payload': {'id': self.identifier}})
                                 + message(CONFIRMED, 'old', '已经确认的旧正文')
                                 + self.next_line[:self.split])
        self.insert([{'id': self.identifier, 'rollout_path': str(self.rollout)}])

    def finish_tail(self):
        with self.rollout.open('ab') as stream:
            stream.write(self.next_line[self.split:])

    def test_scanner_marks_partial_tail_pending_until_newline_arrives(self):
        first = scan_message_recency(self.rollout, self.identifier, None, normalize_item)
        self.assertEqual(first['at'], CONFIRMED)
        self.assertTrue(first.get('pending'), '未写完的尾行必须保留待补读标记')
        self.finish_tail()
        final = scan_message_recency(self.rollout, self.identifier, first['checkpoint'], normalize_item)
        self.assertEqual(final['at'], BODY_AT)
        self.assertFalse(final.get('pending'))
        self.assertTrue(final['complete'])

    def test_global_request_resumes_partial_tail_with_unchanged_database_dirty_without_spin(self):
        index = RecencyIndex(self.store)
        self.addCleanup(index.close)
        original = self.store.message_recencies
        reads = []

        def read(identifiers, checkpoints=None):
            reads.append(tuple(identifiers))
            if len(reads) > 6:
                # 仅为错误实现提供硬上限，随后仍按次数断言失败，不能靠此保护算通过。
                raise OSError('测试保护：后台读取发生重复自旋')
            return original(identifiers, checkpoints)

        def refresh():
            index.request()  # 故意不指定可见聊天，验证全局补齐调度。
            index.wait(2)
            self.assertFalse(index.worker.is_alive(), '半行应等待下一轮 request，不能占住后台线程')

        database_before = self.database.read_bytes()
        with patch.object(self.store, 'message_recencies', side_effect=read):
            refresh()
            self.assertEqual(index.snapshot(), {self.identifier: CONFIRMED})
            self.assertEqual(len(reads), 1, '第一次发现半行也不能立即 requeue')
            refresh()
            self.assertEqual(len(reads), 2, '下一轮全局 request 应重读 pending，且每轮只读一次')
            self.assertEqual(index.snapshot(), {self.identifier: CONFIRMED})
            self.finish_tail()
            self.assertEqual(self.database.read_bytes(), database_before, '复现必须保持 DB dirty 完全不变')
            refresh()
            self.assertEqual(index.snapshot(), {self.identifier: BODY_AT})
            self.assertEqual(len(reads), 3)


class RemoteListReviewRegressions(TemporaryReviewTests):
    def setUp(self):
        super().setUp()
        self.ids = {number: str(uuid.UUID(int=number)) for number in range(1, 1001)}
        rows = [{'id': self.ids[number], 'title': 'needle' if number <= 7 else '普通聊天',
                 'recency_at_ms': BASE + number * 1000} for number in range(1, 1001)]
        rows[1]['archived'] = 1
        rows[2].update(originator='codex_cli_rs', source='cli')
        rows[3].update(source='{"subagent":{}}', thread_source='subagent')
        rows[4]['originator'] = 'unrecognized-origin'
        self.insert(rows)
        self.recencies = {identifier: BASE + number for number, identifier in self.ids.items()}
        for number in range(1, 6):
            self.recencies[self.ids[number]] = BASE + number * 2000000

        self.remote = RemoteStore('fixture')
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.host = 'remote-fixture'
        self.bridge.recency_index = SimpleNamespace(request=lambda: None,
                                                     snapshot=lambda: dict(self.recencies))
        self.bridge.store = self.remote
        self.bridge.hosts = AppHosts(self.home)
        self.bridge.creations = {}
        self.bridge.lock = threading.RLock()
        self.bridge.listed, self.bridge.live, self.bridge.origins = set(), {}, {}
        self.bridge._access = lambda *args: {'readOnly': True}

        def ssh_fixture(alias, source, **kwargs):
            self.assertEqual(alias, 'fixture')
            output = io.StringIO()
            # 实际执行发往 SSH 的源码和 SQLite 查询；不启动 SSH，不读取用户 CODEX_HOME。
            with patch.dict(os.environ, {'CODEX_HOME': str(self.home)}), redirect_stdout(output):
                exec(compile(source, 'recency-review-remote.py', 'exec'), {})
            return json.loads(output.getvalue())

        ssh = patch('bridge.clients.codex.remote.ssh_read', side_effect=ssh_fixture)
        self.ssh_read = ssh.start()
        self.addCleanup(ssh.stop)
        calls = patch.object(self.remote, 'call', wraps=self.remote.call)
        self.remote_calls = calls.start()
        self.addCleanup(calls.stop)

    def test_thousand_index_entries_and_unmatched_search_use_one_remote_list_with_original_filters(self):
        for archived, source in ((False, 'all'), (False, 'desktop'), (True, 'cli')):
            with self.subTest(archived=archived, source=source):
                self.remote_calls.reset_mock()
                self.ssh_read.reset_mock()
                rows = self.bridge.list(query='不存在的关键词', archived=archived, source=source)
                self.assertEqual(rows, [])
                self.assertEqual(self.ssh_read.call_count, 1,
                                 '1000 条索引不能被拆成每 50 条一次的同步 SSH 补查')
                self.remote_calls.assert_called_once()
                method, arguments = self.remote_calls.call_args.args
                self.assertEqual(method, 'list')
                self.assertEqual(arguments['query'], '不存在的关键词')
                self.assertEqual(arguments['archived'], archived)
                self.assertEqual(arguments['source'], source)
                self.assertEqual(arguments.get('recencies'), self.recencies)

    def test_overlay_ranks_old_chat_before_paging_without_writing_native_database(self):
        before = self.database.read_bytes()
        first = self.bridge.list(query='needle', source='desktop', limit=2)
        second = self.bridge.list(query='needle', source='desktop', limit=2, offset=2)
        self.assertEqual([row['id'] for row in first + second],
                         [self.ids[1], self.ids[7], self.ids[6]])
        self.assertEqual(first[0]['recency'], self.recencies[self.ids[1]])
        self.assertEqual(self.ssh_read.call_count, 2, '每一页只应有一次远端 list')
        self.assertEqual(self.database.read_bytes(), before,
                         '内部排序映射只能作用于查询，不能写回原生数据库')

    def test_recency_overlay_preserves_archive_source_and_subagent_visibility_filters(self):
        cases = ((False, 'desktop', [1, 7, 6]), (False, 'cli', [3]),
                 (True, 'desktop', [2]), (False, 'all', [3, 1, 7, 6]))
        for archived, source, expected in cases:
            with self.subTest(archived=archived, source=source):
                rows = self.bridge.list(query='needle', archived=archived, source=source)
                self.assertEqual([row['id'] for row in rows], [self.ids[number] for number in expected])

    def test_selected_ids_still_obey_filters_with_internal_recencies_mapping(self):
        rows = self.bridge.list(ids=[self.ids[number] for number in range(1, 8)],
                                query='needle', source='desktop')
        self.assertEqual([row['id'] for row in rows], [self.ids[1], self.ids[7], self.ids[6]])
        self.assertEqual(self.ssh_read.call_count, 1)


if __name__ == '__main__':
    unittest.main()
