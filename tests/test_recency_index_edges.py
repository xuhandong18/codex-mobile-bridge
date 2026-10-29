"""排序索引边界复现；只使用临时文件、内存 store 和实际事件处理器。"""
import copy
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from bridge.app.service import Bridge, LiveSession
import bridge.features.sessions.message_index as reader
from bridge.features.sessions.model import normalize_item
from bridge.features.sessions.recency import RecencyIndex


BASE = 1800000000000


class FakeStore:
    """只替代外部读取；checkpoint 和排序处理仍执行产品实现。"""
    def __init__(self, read=None, inventory=None):
        self.rows = inventory if inventory is not None else [{'id': 'chat', 'updated_at_ms': 1}]
        self.read = read or (lambda identifiers, checkpoints: {
            sid: {'at': 4000, 'complete': True, 'checkpoint': {'offset': 0, 'at': 4000}}
            for sid in identifiers})
        self.inventory_read = lambda: copy.deepcopy(self.rows)
        self.calls = []

    def recency_inventory(self):
        return self.inventory_read()

    def message_recencies(self, identifiers, checkpoints=None):
        self.calls.append((list(identifiers), copy.deepcopy(checkpoints or {})))
        return self.read(identifiers, checkpoints or {})


class TemporaryTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / '.tmp'
        root.mkdir(exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=root, prefix='recency-edges-')
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def index(self, store, path=None):
        index = RecencyIndex(store, path)
        self.addCleanup(index.close)
        return index

    def refresh(self, index, identifiers=()):
        index.request(identifiers)
        index.wait(1)
        self.assertFalse(index.worker.is_alive(), '合成读取必须结束，不能在后台无限重试')


class RecencyIndexEdgeTests(TemporaryTests):
    def test_snapshot_returns_confirmed_value_while_inventory_or_message_read_is_blocked(self):
        for stage in ('inventory', 'messages'):
            with self.subTest(stage=stage):
                store = FakeStore()
                index = self.index(store)
                self.refresh(index)
                entered, release, done = threading.Event(), threading.Event(), threading.Event()
                result = []

                def blocked():
                    entered.set()
                    if not release.wait(2):
                        raise OSError('测试读取未释放')

                if stage == 'inventory':
                    def inventory():
                        blocked()
                        return copy.deepcopy(store.rows)
                    store.inventory_read = inventory
                else:
                    def read(identifiers, checkpoints):
                        blocked()
                        return {sid: {'at': 9000, 'complete': True} for sid in identifiers}
                    store.read = read

                def snapshot():
                    try:
                        result.append(index.snapshot())
                    finally:
                        done.set()

                thread = threading.Thread(target=snapshot, daemon=True)
                try:
                    index.request(['chat'])
                    self.assertTrue(entered.wait(1))
                    thread.start()
                    self.assertTrue(done.wait(.5), 'snapshot 不应等待后台文件或库存读取')
                    self.assertEqual(result, [{'chat': 4000}])
                finally:
                    release.set()
                    index.wait(1)
                    if thread.ident is not None:
                        thread.join(1)

    def test_close_discards_late_read_and_does_not_persist_it(self):
        store = FakeStore()
        path = self.directory / 'late.json'
        index = self.index(store, path)
        self.refresh(index)
        entered, release = threading.Event(), threading.Event()

        def read(identifiers, checkpoints):
            entered.set()
            if not release.wait(2):
                raise OSError('测试读取未释放')
            return {'chat': {'at': 999999, 'complete': True}}

        store.read = read
        closer = threading.Thread(target=index.close, daemon=True)
        try:
            index.request(['chat'])
            self.assertTrue(entered.wait(1))
            closer.start()
            deadline = time.monotonic() + 1
            while not index.closed and time.monotonic() < deadline:
                release.wait(.005)
            self.assertTrue(index.closed, '必须先关闭发布入口，再等待读取线程退出')
        finally:
            release.set()
            if closer.ident is not None:
                closer.join(1)
            index.wait(1)
        self.assertFalse(closer.is_alive())
        self.assertEqual(index.snapshot(), {'chat': 4000})
        self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['records']['chat']['at'], 4000)
        count = len(store.calls)
        index.record('chat', 888888)
        index.request(['chat'])
        self.assertEqual(index.snapshot(), {'chat': 4000})
        self.assertEqual(len(store.calls), count)

    def test_failed_inventory_or_message_read_keeps_last_confirmed_time(self):
        for stage in ('inventory', 'messages', 'missing'):
            with self.subTest(stage=stage):
                store = FakeStore()
                index = self.index(store)
                self.refresh(index)

                def failure(*args):
                    raise OSError('合成读取失败')

                if stage == 'inventory':
                    store.inventory_read = failure
                else:
                    store.read = failure if stage == 'messages' else lambda *args: {}
                self.refresh(index, ['chat'])
                self.assertEqual(index.snapshot(), {'chat': 4000})

    def test_incomplete_checkpoint_without_progress_is_not_retried_forever(self):
        attempts = []

        def read(identifiers, checkpoints):
            attempts.append(copy.deepcopy(checkpoints))
            if len(attempts) > 3:
                # 防止故障实现占满 CPU；这不是产品正常结束的条件。
                raise OSError('测试保护：相同 checkpoint 已重复读取三次')
            return {'chat': {'at': 4000, 'complete': False, 'checkpoint': {'offset': 12, 'at': 4000}}}

        index = self.index(FakeStore(read))
        self.refresh(index, ['chat'])
        self.assertLessEqual(len(attempts), 2, '没有扫描进展时应等待下次调度，不能立即重复读取')
        self.assertEqual(index.snapshot(), {'chat': 4000})


class MessageRecencyScanEdgeTests(TemporaryTests):
    def setUp(self):
        super().setUp()
        self.identifier = str(uuid.uuid4())
        self.path = self.directory / 'rollout.jsonl'
        self.reset_file()

    def reset_file(self, path=None, identifier=None):
        (path or self.path).write_text(json.dumps({
            'type': 'session_meta', 'payload': {'id': identifier or self.identifier}}) + '\n', encoding='utf-8')

    def message(self, at, text, identifier='message'):
        return {'type': 'response_item', 'timestamp': at, 'payload': {
            'type': 'message', 'id': identifier, 'role': 'assistant',
            'content': [{'type': 'output_text', 'text': text}]}}

    def append(self, value, path=None):
        with (path or self.path).open('ab') as stream:
            stream.write((json.dumps(value, ensure_ascii=False) + '\n').encode())

    def scan(self, previous=None, **kwargs):
        return reader.scan_message_recency(self.path, self.identifier, previous, normalize_item, **kwargs)

    def store(self):
        def read(identifiers, checkpoints):
            return {sid: reader.scan_message_recency(self.path, sid, checkpoints.get(sid), normalize_item)
                    for sid in identifiers}
        return FakeStore(read, [{'id': self.identifier, 'rollout_path': str(self.path), 'updated_at_ms': 1}])

    def test_replacement_or_truncation_can_lower_previously_high_message_time(self):
        for kind in ('replace', 'truncate'):
            with self.subTest(kind=kind):
                self.reset_file()
                self.append(self.message(BASE + 90000, '旧正文' * 100))
                index = self.index(self.store())
                self.refresh(index)
                self.assertEqual(index.snapshot(), {self.identifier: BASE + 90000})
                if kind == 'replace':
                    other = self.directory / 'replacement.jsonl'
                    self.reset_file(other)
                    self.append(self.message(BASE + 1000, '新正文'), other)
                    os.replace(other, self.path)
                else:
                    self.reset_file()
                    self.append(self.message(BASE + 1000, '新正文'))
                self.refresh(index, [self.identifier])
                self.assertEqual(index.snapshot(), {self.identifier: BASE + 1000},
                                 '已被替换或截断的消息时间不能作为单调上限保留')

    def test_partial_tail_is_deferred_then_resumed_without_spin(self):
        self.append(self.message(BASE + 1000, '已确认正文'))
        store = self.store()
        index = self.index(store)
        self.refresh(index)
        raw = json.dumps(self.message(BASE + 5000, '稍后补完的正文', 'next')).encode()
        with self.path.open('ab') as stream:
            stream.write(raw[:40])
        self.refresh(index, [self.identifier])
        self.assertEqual(index.snapshot(), {self.identifier: BASE + 1000})
        self.assertEqual(len(store.calls), 2, '没有写完的尾行应等待后续追加')
        with self.path.open('ab') as stream:
            stream.write(raw[40:] + b'\n')
        self.refresh(index, [self.identifier])
        self.assertEqual(index.snapshot(), {self.identifier: BASE + 5000})

    def test_oversized_tail_finishes_without_repeated_background_reads(self):
        self.append(self.message(BASE + 1000, '已确认正文'))
        with self.path.open('ab') as stream:
            stream.write(b'x' * 2200)
        store = self.store()
        with patch.object(reader, 'MAX_RECORD', 1024):
            index = self.index(store)
            self.refresh(index)
            self.assertEqual(index.snapshot(), {self.identifier: BASE + 1000})
            self.assertLessEqual(len(store.calls), 2)

    def test_finishing_oversized_partial_line_cannot_promote_its_json_shaped_suffix(self):
        self.append(self.message(BASE + 1000, '旧确认正文'))
        first = self.scan()
        with self.path.open('ab') as stream:
            stream.write(b'x' * 2200)
        with patch.object(reader, 'MAX_RECORD', 1024):
            pending = self.scan(first['checkpoint'])
            self.assertTrue(pending['complete'])
            # 没有先写换行：此 JSON 仍属于应被丢弃的同一超大记录。
            self.append(self.message(BASE + 90000, '超大行的后半段，不能成为独立发言', 'suffix'))
            self.append(self.message(BASE + 5000, '真正的新行正文', 'valid'))
            result = self.scan(pending['checkpoint'])
        self.assertEqual(result['at'], BASE + 5000, '追加后仍须跳过超大行的剩余部分')

    def test_checkpoint_cannot_transfer_time_to_another_path_or_thread(self):
        self.append(self.message(BASE + 90000, '原聊天正文'))
        checkpoint = self.scan()['checkpoint']
        original = copy.deepcopy(checkpoint)
        other = self.directory / 'another.jsonl'
        self.reset_file(other)
        self.append(self.message(BASE + 1000, '另一份文件的正文'), other)
        result = reader.scan_message_recency(other, self.identifier, checkpoint, normalize_item)
        self.assertEqual(result['at'], BASE + 1000)
        with self.assertRaises(ValueError):
            reader.scan_message_recency(self.path, str(uuid.uuid4()), checkpoint, normalize_item)
        self.assertEqual(checkpoint, original, '读取不能原地修改其他请求持有的 checkpoint')

    def test_persistent_cache_contains_only_metadata_and_checkpoints_are_chat_scoped(self):
        secret = '仅存在于合成消息正文中的标记-' + uuid.uuid4().hex
        self.append(self.message(BASE + 1000, secret * 100))
        path = self.directory / 'index.json'
        index = self.index(self.store(), path)
        self.refresh(index)
        index.close()
        encoded = path.read_text(encoding='utf-8')
        self.assertNotIn(secret, encoded)
        self.assertNotIn('output_text', encoded)
        value = json.loads(encoded)
        checkpoint = value['records'][self.identifier]['checkpoint']
        self.assertTrue(checkpoint['seen'])
        for seen in checkpoint['seen'].values():
            self.assertEqual(set(seen), {'hash', 'at'})
        other_id = str(uuid.uuid4())
        store = FakeStore(inventory=[{'id': self.identifier, 'updated_at_ms': 1}, {'id': other_id, 'updated_at_ms': 1}])
        restored = self.index(store, path)
        self.assertEqual(restored.snapshot(), {self.identifier: BASE + 1000})
        snapshot = restored.snapshot()
        snapshot[self.identifier] = BASE + 999999
        self.assertEqual(restored.snapshot(), {self.identifier: BASE + 1000})
        self.refresh(restored, [self.identifier, other_id])
        passed = store.calls[0][1]
        self.assertEqual(passed[self.identifier], checkpoint)
        self.assertNotIn(other_id, passed, '新聊天不能复用另一聊天的持久 checkpoint')


class OwnerEventRecencyEdgeTests(unittest.TestCase):
    def setUp(self):
        # 跳过启动、IPC 和维护线程，仍执行真实 Bridge._event、LiveSession 和索引。
        self.bridge = Bridge.__new__(Bridge)
        self.bridge.host = 'local'
        self.bridge.lock = threading.RLock()
        self.bridge.notification_dirty = set()
        self.bridge.notification_event = threading.Event()
        self.bridge.desktop_activity = SimpleNamespace(wake=lambda: None)
        self.bridge.subagent_activity = SimpleNamespace(wake=lambda: None)
        self.bridge.owner_goal = None
        self.bridge.goal = None
        self.bridge.recency_index = RecencyIndex(FakeStore())
        self.addCleanup(self.bridge.recency_index.close)
        self.session = LiveSession(str(uuid.uuid4()))
        self.session.owner = 'fixture-owner'
        self.bridge.live = {self.session.id: self.session}
        self.revision = 0

    def state(self, items=None):
        return {'id': self.session.id, 'cwd': '/fixture-project', 'modelProvider': 'fixture',
                'threadRuntimeStatus': {'type': 'active'}, 'turns': [{
                    'turnId': 'turn', 'status': 'inProgress', 'items': items if items is not None else [
                        {'id': 'user', 'type': 'userMessage', 'timestamp': BASE,
                         'content': [{'type': 'input_text', 'text': '用户问题'}]},
                        {'id': 'answer', 'type': 'agentMessage', 'timestamp': BASE + 1000,
                         'text': '已开始的助手正文'},
                    ]}]}

    def event(self, change, owner='fixture-owner'):
        self.revision += 1
        # 故意与所有消息原生时间不同，避免 record(now) 侥幸满足时间断言。
        with patch('bridge.app.service.time.time', return_value=(BASE + 900000) / 1000):
            self.bridge._event({'method': 'thread-stream-state-changed', 'version': 11,
                                'sourceClientId': owner, 'params': {
                                    'hostId': 'local', 'conversationId': self.session.id,
                                    'change': {**change, 'revision': self.revision}}})

    def snapshot(self, state):
        self.event({'type': 'snapshot', 'conversationState': copy.deepcopy(state)})
        self.assertTrue(self.session.connected, '合成 owner 快照必须被真实处理器接受')

    def patches(self, patches):
        self.event({'type': 'patches', 'baseRevision': self.session.revision, 'patches': patches})
        self.assertTrue(self.session.connected, '补丁必须实际应用，不能因拒绝事件而误通过')

    def baseline(self):
        self.snapshot(self.state())
        self.assertEqual(self.bridge.recency_index.snapshot(), {}, '首次读取只建立基线')
        self.bridge.recency_index.record(self.session.id, BASE + 1000)

    def recency(self):
        return self.bridge.recency_index.snapshot().get(self.session.id, 0)

    def test_initial_owner_snapshot_does_not_invent_interaction_time(self):
        value = self.state()
        value['turns'][0]['items'][1]['timestamp'] = BASE + 800000
        self.snapshot(value)
        self.assertEqual(self.bridge.recency_index.snapshot(), {})
        self.assertEqual(self.session.view()['turns'][0]['messages'][-1]['text'], '已开始的助手正文')

    def test_duplicate_text_and_timestamp_only_snapshots_do_not_advance(self):
        self.baseline()
        self.snapshot(self.session.state)
        self.patches([{'op': 'replace', 'path': ['turns', 0, 'items', 1, 'timestamp'],
                       'value': BASE + 50000}])
        self.assertEqual(self.recency(), BASE + 1000)

    def test_tool_reasoning_usage_and_runtime_changes_do_not_advance(self):
        self.baseline()
        self.patches([
            {'op': 'add', 'path': ['turns', 0, 'items', '-'], 'value': {
                'id': 'tool', 'type': 'commandExecution', 'command': 'fixture',
                'aggregatedOutput': '工具输出', 'timestamp': BASE + 50000}},
            {'op': 'add', 'path': ['turns', 0, 'items', '-'], 'value': {
                'id': 'thought', 'type': 'reasoning', 'summary': ['思考摘要'], 'timestamp': BASE + 60000}},
            {'op': 'add', 'path': ['latestTokenUsageInfo'], 'value': {'totalTokens': 9000}},
            {'op': 'replace', 'path': ['threadRuntimeStatus', 'type'], 'value': 'idle'},
            {'op': 'replace', 'path': ['turns', 0, 'status'], 'value': 'completed'},
        ])
        messages = self.session.view()['turns'][0]['messages']
        self.assertTrue(any(row['id'] == 'tool' and row['output'] == '工具输出' for row in messages))
        self.assertEqual(self.recency(), BASE + 1000)

    def test_existing_assistant_continues_after_user_supplement_using_native_timestamp(self):
        self.baseline()
        self.patches([{'op': 'add', 'path': ['turns', 0, 'items', '-'], 'value': {
            'id': 'supplement', 'type': 'steeringUserMessage', 'timestamp': BASE + 2000,
            'input': [{'type': 'input_text', 'text': '用户补充'}]}}])
        with self.subTest(event='用户补充'):
            self.assertEqual(self.recency(), BASE + 2000, '用户操作应采用消息原生时间')
        self.patches([
            {'op': 'replace', 'path': ['turns', 0, 'items', 1, 'text'], 'value': '已开始的助手正文继续增量'},
            {'op': 'replace', 'path': ['turns', 0, 'items', 1, 'timestamp'], 'value': BASE + 3000},
        ])
        self.assertEqual(self.session.state['turns'][0]['items'][-1]['id'], 'supplement')
        self.assertEqual(self.recency(), BASE + 3000, '仍在原位置增长的助手正文也应推进排序')

    def test_existing_assistant_outside_last_64_items_still_counts_when_streaming(self):
        self.baseline()
        self.patches([{'op': 'add', 'path': ['turns', 0, 'items', '-'], 'value': {
            'id': 'supplement-' + str(number), 'type': 'steeringUserMessage', 'timestamp': BASE + 2000,
            'input': [{'type': 'input_text', 'text': '补充 ' + str(number)}]}}
            for number in range(65)])
        self.patches([
            {'op': 'replace', 'path': ['turns', 0, 'items', 1, 'text'], 'value': '仍在同一正文条目继续输出'},
            {'op': 'replace', 'path': ['turns', 0, 'items', 1, 'timestamp'], 'value': BASE + 3000},
        ])
        self.assertEqual(self.session.state['turns'][0]['items'][1]['text'], '仍在同一正文条目继续输出')
        self.assertEqual(self.recency(), BASE + 3000, '不能因为消息已在 tail64 之外而漏记真实增量')

    def test_new_message_without_timestamp_does_not_use_event_arrival_time(self):
        self.baseline()
        self.patches([{'op': 'add', 'path': ['turns', 0, 'items', '-'], 'value': {
            'id': 'untimed', 'type': 'agentMessage', 'phase': 'commentary', 'text': '没有原生时间的进度'}}])
        self.assertEqual(self.session.state['turns'][0]['items'][-1]['text'], '没有原生时间的进度')
        self.assertEqual(self.recency(), BASE + 1000, '缺失时间应等待 JSONL 补齐，不能伪造当前时间')

    def test_changed_message_without_timestamp_does_not_use_event_arrival_time(self):
        self.baseline()
        self.patches([
            {'op': 'replace', 'path': ['turns', 0, 'items', 1, 'text'], 'value': '确有新正文但缺少原生时间'},
            {'op': 'remove', 'path': ['turns', 0, 'items', 1, 'timestamp']},
        ])
        self.assertEqual(self.recency(), BASE + 1000)

    def test_foreign_owner_cannot_publish_text_time(self):
        self.baseline()
        value = copy.deepcopy(self.session.state)
        value['turns'][0]['items'][1].update(text='其他 owner 的正文', timestamp=BASE + 50000)
        self.event({'type': 'snapshot', 'conversationState': value}, owner='unrelated-owner')
        self.assertEqual(self.session.owner, 'fixture-owner')
        self.assertEqual(self.session.state['turns'][0]['items'][1]['text'], '已开始的助手正文')
        self.assertEqual(self.recency(), BASE + 1000)


if __name__ == '__main__':
    unittest.main()
