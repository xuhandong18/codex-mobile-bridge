"""侧聊天排序策略复现：使用真实 SideChat 和内存运行时，不启动客户端。"""
import unittest
import uuid
from unittest.mock import patch

from bridge.features.sessions.side_chat import SideChat, SideChatError
from test_side_chat import RuntimeFixture


class SideChatRecencyPolicyTests(unittest.TestCase):
    def setUp(self):
        self.chat = SideChat(
            'fixture-runtime', '/fixture-home', str(uuid.uuid4()), '/fixture-project',
            {'model': 'fixture', 'modelProvider': 'custom'}, RuntimeFixture)
        self.addCleanup(self.chat.close)
        self.runtime = self.chat.runtime
        self.submission = str(uuid.uuid4())
        with patch('bridge.features.sessions.side_chat.time.time', return_value=10):
            self.assertEqual(self.chat.send('用户问题', self.submission)['status'], 'accepted')
        self.assertEqual(self.chat.view()['recency'], 10000)

    def emit(self, at, method, **params):
        with patch('bridge.features.sessions.side_chat.time.time', return_value=at):
            self.runtime.emit(method, timestamp=at, **params)

    def request(self, at, identifier, method, **params):
        with patch('bridge.features.sessions.side_chat.time.time', return_value=at):
            self.chat._event({'id': identifier, 'method': method, 'params': {
                'threadId': self.chat.id, 'turnId': 'turn', **params}})

    def test_accepted_send_counts_once_and_reads_or_rename_do_not_count(self):
        before = list(self.runtime.calls)
        with patch('bridge.features.sessions.side_chat.time.time', return_value=20):
            self.assertEqual(self.chat.send('用户问题', self.submission)['status'], 'accepted')
            self.chat.rename('只改名称')
            self.chat.view()
            self.chat.activity()
        self.assertEqual(self.chat.view()['recency'], 10000)
        self.assertEqual(self.runtime.calls, before)

    def test_native_user_and_steering_messages_count(self):
        for at, kind, field in ((20, 'userMessage', 'content'), (30, 'steeringUserMessage', 'input')):
            with self.subTest(kind=kind):
                self.emit(at, 'item/started', turnId='turn', item={
                    'id': kind, 'type': kind, field: [{'type': 'text', 'text': '新的用户发言'}]})
                self.assertEqual(self.chat.view()['recency'], at * 1000)

    def test_agent_commentary_plain_body_and_final_answer_count(self):
        for at, phase in ((20, 'commentary'), (30, None), (40, 'final_answer')):
            with self.subTest(phase=phase):
                item = {'id': 'agent-' + str(at), 'type': 'agentMessage', 'text': '独立文字进度或正文'}
                if phase is not None:
                    item['phase'] = phase
                self.emit(at, 'item/started', turnId='turn', item=item)
                self.assertEqual(self.chat.view()['recency'], at * 1000)
                message = next(row for row in self.chat.view()['turns'][0]['messages'] if row['id'] == item['id'])
                self.assertEqual(message['text'], item['text'])
                self.assertEqual(message.get('phase'), phase)

    def test_nonempty_agent_deltas_count_but_empty_deltas_do_not(self):
        self.emit(20, 'item/agentMessage/delta', turnId='turn', itemId='reply', delta='新增正文')
        self.assertEqual(self.chat.view()['recency'], 20000)
        for delta in ('', None):
            with self.subTest(delta=delta):
                self.emit(30, 'item/agentMessage/delta', turnId='turn', itemId='reply', delta=delta)
                self.assertEqual(self.chat.view()['recency'], 20000)
        self.assertEqual(self.chat.view()['turns'][0]['messages'][1]['text'], '新增正文')

    def test_empty_agent_placeholders_do_not_count(self):
        for at, text in ((20, ''), (30, None)):
            with self.subTest(text=text):
                self.emit(at, 'item/started', turnId='turn', item={
                    'id': 'empty-' + str(at), 'type': 'agentMessage', 'phase': 'commentary', 'text': text})
                self.assertEqual(self.chat.view()['recency'], 10000)

    def test_same_text_item_snapshots_and_status_only_completion_do_not_count(self):
        self.emit(20, 'item/agentMessage/delta', turnId='turn', itemId='reply', delta='同一段正文')
        item = {'id': 'reply', 'type': 'agentMessage', 'text': '同一段正文'}
        self.emit(30, 'item/completed', turnId='turn', item=item)
        self.assertEqual(self.chat.view()['recency'], 20000)
        self.emit(40, 'item/completed', turnId='turn', item={**item, 'status': 'completed'})
        self.assertEqual(self.chat.view()['recency'], 20000, '消息完成只改状态，不能成为新发言')
        self.emit(50, 'item/completed', turnId='turn', item={**item, 'status': 'completed'})
        self.assertEqual(self.chat.view()['recency'], 20000)

    def test_completed_turn_snapshot_with_same_text_does_not_count(self):
        self.emit(20, 'item/agentMessage/delta', turnId='turn', itemId='reply', delta='已有正文')
        self.emit(30, 'turn/completed', turn={'id': 'turn', 'status': 'completed', 'items': [
            {'id': 'user', 'type': 'userMessage', 'content': [{'type': 'text', 'text': '用户问题'}]},
            {'id': 'reply', 'type': 'agentMessage', 'text': '已有正文', 'status': 'completed'},
        ]})
        self.assertEqual(self.chat.activity()['status'], 'idle')
        self.assertEqual(self.chat.view()['recency'], 20000)

    def test_completed_turn_snapshot_with_new_body_counts(self):
        self.emit(20, 'turn/completed', turn={'id': 'turn', 'status': 'completed', 'items': [
            {'id': 'reply', 'type': 'agentMessage', 'phase': 'final_answer', 'text': '只在完成快照到达的正文'},
        ]})
        self.assertEqual(self.chat.view()['recency'], 20000)
        self.assertEqual(self.chat.view()['turns'][0]['messages'][-1]['text'], '只在完成快照到达的正文')

    def test_tool_command_file_and_reasoning_items_do_not_count(self):
        items = [
            {'type': 'commandExecution', 'command': 'echo fixture', 'aggregatedOutput': '命令输出'},
            {'type': 'fileChange', 'changes': [{'path': 'fixture.txt', 'diff': '+文件内容'}]},
            {'type': 'reasoning', 'summary': [{'type': 'summary_text', 'text': '公开思考摘要'}]},
            {'type': 'mcpToolCall', 'server': 'fixture', 'tool': 'read', 'arguments': {'path': 'fixture.txt'}},
            {'type': 'dynamicToolCall', 'tool': 'fixture', 'arguments': {'text': '工具结果'}},
        ]
        for at, item in enumerate(items, 20):
            item = {**item, 'id': item['type']}
            for method, status in (('item/started', 'inProgress'), ('item/completed', 'completed')):
                with self.subTest(kind=item['type'], method=method):
                    self.emit(at, method, turnId='turn', item={**item, 'status': status})
                    self.assertTrue(any(row['id'] == item['id'] for row in self.chat.view()['turns'][0]['messages']),
                                    '排除排序计时不能丢弃工具或思考记录')
                    self.assertEqual(self.chat.view()['recency'], 10000)

    def test_command_output_delta_does_not_count(self):
        self.emit(10, 'item/started', turnId='turn', item={
            'id': 'command', 'type': 'commandExecution', 'command': 'echo fixture', 'aggregatedOutput': ''})
        self.emit(20, 'item/commandExecution/outputDelta', turnId='turn', itemId='command', delta='执行输出')
        command = next(row for row in self.chat.view()['turns'][0]['messages'] if row['id'] == 'command')
        self.assertEqual(command['output'], '执行输出', '工具输出仍正常展示')
        self.assertEqual(self.chat.view()['recency'], 10000)

    def test_request_arrival_does_not_count(self):
        requests = [
            ('item/commandExecution/requestApproval', {'availableDecisions': ['accept', 'decline']}),
            ('item/fileChange/requestApproval', {}),
            ('item/permissions/requestApproval', {'permissions': {'network': {'enabled': True}}}),
            ('item/tool/requestUserInput', {'questions': [{'id': 'q', 'question': '选哪个？'}]}),
        ]
        for identifier, (method, params) in enumerate(requests, 70):
            with self.subTest(method=method):
                self.request(20, identifier, method, **params)
                self.assertTrue(any(str(row['id']) == str(identifier) for row in self.chat.view()['requests']))
                self.assertEqual(self.chat.view()['recency'], 10000)

    def test_successful_approval_and_question_response_count_once(self):
        responses = [
            (70, 'item/commandExecution/requestApproval', {}, {'decision': 'accept'}),
            (71, 'item/tool/requestUserInput', {'questions': [{'id': 'q', 'question': '选哪个？'}]},
             {'answers': {'q': ['已选答案']}}),
        ]
        for at, (identifier, method, params, response) in enumerate(responses, 30):
            with self.subTest(method=method):
                self.request(20, identifier, method, **params)
                with patch('bridge.features.sessions.side_chat.time.time', return_value=at):
                    self.chat.respond(identifier, response)
                self.assertEqual(self.chat.view()['recency'], at * 1000)
                self.assertEqual(self.runtime.responses[-1]['id'], identifier)
                before = len(self.runtime.responses)
                with patch('bridge.features.sessions.side_chat.time.time', return_value=at + 10):
                    with self.assertRaises(ValueError):
                        self.chat.respond(identifier, response)
                self.assertEqual(len(self.runtime.responses), before)
                self.assertEqual(self.chat.view()['recency'], at * 1000)

    def test_server_resolved_request_without_local_response_does_not_count(self):
        self.request(10, 70, 'item/commandExecution/requestApproval')
        self.emit(20, 'serverRequest/resolved', requestId=70)
        self.assertFalse(self.chat.view()['requests'])
        self.assertEqual(self.chat.view()['recency'], 10000)

    def test_runtime_and_turn_status_only_changes_do_not_count(self):
        self.emit(20, 'turn/completed', turn={'id': 'turn', 'status': 'completed'})
        self.assertEqual(self.chat.activity()['status'], 'idle')
        with self.subTest(event='turn/completed'):
            self.assertEqual(self.chat.view()['recency'], 10000)
        self.emit(30, 'turn/started', turn={'id': 'next', 'status': 'inProgress'})
        self.assertEqual(self.chat.activity()['status'], 'active')
        with self.subTest(event='turn/started'):
            self.assertEqual(self.chat.view()['recency'], 10000)

    def test_error_status_does_not_count(self):
        self.emit(20, 'error', error={'message': '合成错误'}, willRetry=False)
        self.assertTrue(self.chat.view()['error'])
        self.assertEqual(self.chat.activity()['status'], 'unknown')
        self.assertEqual(self.chat.view()['recency'], 10000)

    def test_usage_reads_and_foreign_thread_messages_do_not_count(self):
        before = list(self.runtime.calls)
        self.emit(20, 'thread/tokenUsage/updated', tokenUsage={'totalTokens': 500})
        with patch('bridge.features.sessions.side_chat.time.time', return_value=30):
            self.chat.view()
            self.chat.activity()
            self.chat._event({'method': 'item/started', 'params': {
                'threadId': str(uuid.uuid4()), 'turnId': 'foreign',
                'item': {'id': 'foreign', 'type': 'agentMessage', 'text': '别人的新发言'}}})
        self.assertEqual(self.chat.view()['recency'], 10000)
        self.assertEqual(self.runtime.calls, before)

    def test_unknown_send_is_not_replayed_by_retry_reads_or_runtime_completion(self):
        self.emit(10, 'turn/completed', turn={'id': 'turn', 'status': 'completed'})
        self.runtime.fail_send = True
        submission = str(uuid.uuid4())
        before = sum(method == 'turn/start' for method, _ in self.runtime.calls)
        with patch('bridge.features.sessions.side_chat.time.time', return_value=20):
            self.assertEqual(self.chat.send('回执未知的发送', submission)['status'], 'unknown')
        with patch('bridge.features.sessions.side_chat.time.time', return_value=30):
            self.assertEqual(self.chat.send('回执未知的发送', submission)['status'], 'unknown')
            self.chat.view()
            self.chat.activity()
        self.assertEqual(sum(method == 'turn/start' for method, _ in self.runtime.calls), before + 1)
        self.assertEqual(self.chat.view()['recency'], 10000)
        self.emit(40, 'turn/completed', turn={'id': 'late', 'status': 'completed'})
        self.assertEqual(self.chat.view()['recency'], 10000)
        self.assertEqual(sum(method == 'turn/start' for method, _ in self.runtime.calls), before + 1)

    def test_unknown_response_is_not_replayed_by_reading(self):
        self.request(10, 70, 'item/commandExecution/requestApproval')
        with patch.object(self.runtime, 'write', side_effect=SideChatError('写入回执未知')) as write:
            with patch('bridge.features.sessions.side_chat.time.time', return_value=20):
                with self.assertRaises(SideChatError):
                    self.chat.respond(70, {'decision': 'accept'})
            with patch('bridge.features.sessions.side_chat.time.time', return_value=30):
                for _ in range(3):
                    self.chat.view()
                    self.chat.activity()
            self.assertEqual(write.call_count, 1, '被动读取不能重放审批写入')
        self.assertEqual(self.chat.view()['recency'], 10000)


if __name__ == '__main__':
    unittest.main()
