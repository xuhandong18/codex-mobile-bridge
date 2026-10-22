"""Message timestamps follow native records across saved/live projections."""
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from bridge.app.service import Bridge, LiveSession
from bridge.features.sessions.model import normalize_state
from bridge.features.sessions.store import SessionStore
from bridge.features.sessions.message_index import _item
from bridge.features.sessions.timeline import Timeline


class MessageTimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / '.tmp')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / 'sessions').mkdir()
        self.path = self.home / 'sessions' / 'rollout.jsonl'
        self.path.touch()
        self.store = SessionStore(self.home)
        self.store.get = lambda _: {'rollout_path': str(self.path), 'cwd': '/fixture'}

    def append(self, record):
        with self.path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(record) + '\n')

    def event(self, identifier, start):
        return {'type': 'event_msg', 'payload': {'type': 'item_completed', 'started_at_ms': start,
                'item': {'id': identifier, 'type': 'Reasoning', 'raw_content': 'NEVER DISPLAY'}}}

    def test_native_times_keep_item_order_and_do_not_guess_followup_user_time(self):
        state = {'turns': [{'turnId': 't', 'turnStartedAtMs': 1792699819000,
                 'aeonAssistantMessageStartedAtMsById': {'a': 1792699820000},
                 'commandExecutionStartedAtMsById': {'c': 1792699821000},
                 'itemStartedAtMsById': {'r': 1792699822000}, 'items': [
                    {'id': 'u', 'type': 'userMessage'}, {'id': 'a', 'type': 'agentMessage'},
                    {'id': 'c', 'type': 'commandExecution'},
                    {'id': 'r', 'type': 'reasoning', 'summary': ['公开摘要'], 'content': ['NEVER DISPLAY']},
                    {'id': 'u2', 'type': 'userMessage'}]}]}
        original = copy.deepcopy(state)
        rows = normalize_state(state)['turns'][0]['messages']
        self.assertEqual([row.get('timestamp') for row in rows],
                         [1792699819000, 1792699820000, 1792699821000, 1792699822000, None])
        self.assertNotIn('NEVER DISPLAY', json.dumps(rows))
        self.assertEqual(state, original)

    def test_saved_history_and_navigation_keep_record_times(self):
        stamp = '2026-10-23T01:02:03.456Z'
        self.append({'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't'}})
        records = [
            {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '提问'}]},
            {'type': 'message', 'role': 'assistant', 'phase': 'commentary', 'content': []},
            {'type': 'reasoning', 'id': 'r', 'summary': ['摘要']},
            {'type': 'custom_tool_call', 'call_id': 'c', 'name': 'tool', 'input': 'input'},
            {'type': 'custom_tool_call_output', 'call_id': 'c', 'output': 'result'},
            {'type': 'message', 'role': 'assistant', 'content': []}]
        for ordinal, payload in enumerate(records):
            record = {'type': 'response_item', 'timestamp': stamp, 'payload': payload}
            self.append(record)
            self.assertEqual(_item(record, ordinal)['timestamp'], stamp)
        rows = normalize_state(self.store.history('thread'))['turns'][0]['messages']
        self.assertEqual(len(rows), 5)
        self.assertTrue(all(row['timestamp'] == stamp for row in rows))
        self.assertEqual(rows[3]['output'], 'result')

    def test_incremental_time_reader_handles_partial_tail_and_replacement(self):
        self.append(self.event('r', 1792699822000))
        first = self.store.message_times('thread')
        self.assertTrue(first['reset'])
        self.assertEqual(first['times'], {'r': 1792699822000})
        self.assertNotIn('NEVER DISPLAY', json.dumps(first))
        unchanged = self.store.message_times('thread', first['checkpoint'])
        self.assertFalse(unchanged['reset'])
        self.assertEqual(unchanged['times'], {})
        partial = json.dumps(self.event('c', 1792699823000))
        with self.path.open('a', encoding='utf-8') as stream:
            stream.write(partial[:25])
        pending = self.store.message_times('thread', unchanged['checkpoint'])
        self.assertEqual(pending['times'], {})
        with self.path.open('a', encoding='utf-8') as stream:
            stream.write(partial[25:] + '\n')
        ready = self.store.message_times('thread', pending['checkpoint'])
        self.assertEqual(ready['times'], {'c': 1792699823000})
        self.path.write_text(json.dumps(self.event('new', 1792699824000)) + '\n', encoding='utf-8')
        replacement = self.store.message_times('thread', ready['checkpoint'])
        self.assertTrue(replacement['reset'])
        self.assertEqual(replacement['times'], {'new': 1792699824000})

    def test_time_reader_keeps_codex_home_boundary(self):
        self.store.get = lambda _: {'rollout_path': str(self.home.parent / 'outside.jsonl')}
        with self.assertRaisesRegex(ValueError, 'Codex'):
            self.store.message_times('thread')

    def test_other_client_projections_keep_native_event_time(self):
        from bridge.clients.claude.model import transcript
        from bridge.clients.deepseek.adapter import messages
        stamp = '2026-10-23T01:02:03Z'
        claude = transcript([{'type': 'assistant', 'timestamp': stamp, 'message': {
            'role': 'assistant', 'content': [{'type': 'text', 'text': '回复'},
                                           {'type': 'thinking_summary', 'text': '摘要'},
                                           {'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'pwd'}}]}}])
        deepseek = messages([{'event': {'seq': 1, 'type': 'assistant/message', 'timestamp': stamp,
                                       'data': {'content': [{'type': 'text', 'text': '回复'}]}}},
                             {'event': {'seq': 2, 'type': 'tool/call', 'timestamp': stamp, 'data': {'name': 'tool'}}}])
        self.assertEqual(len(claude), 3)
        self.assertEqual(len(deepseek), 2)
        self.assertTrue(all(row['timestamp'] == stamp for row in claude + deepseek))

    def test_large_rollout_is_bounded_and_reader_can_run_as_ssh_source(self):
        self.append({'type': 'response_item', 'payload': {'encrypted_content': 'x' * (5 * 1024 * 1024)}})
        self.append(self.event('recent', 1792699822000))
        namespace = {}
        source = Path('bridge/features/sessions/store.py').read_text(encoding='utf-8')
        exec(compile(source, 'injected-store.py', 'exec'), namespace)
        store = namespace['SessionStore'](self.home)
        store.get = self.store.get
        result = store.message_times('thread')
        self.assertEqual(result['times'], {'recent': 1792699822000})
        self.assertLess(len(json.dumps(result)), 1500)

    def test_timestamp_only_update_preserves_row_identity_and_content_version(self):
        session = LiveSession('thread')
        session.state = {'turns': [{'turnId': 't', 'items': [{'id': 'r', 'type': 'reasoning', 'summary': ['摘要']}]}]}
        timeline = Timeline()
        timeline.update(session.view())
        first = dict(timeline.rows[0])
        with session.condition:
            session.message_times = {'r': 1792699822000}
            session.changed()
        timeline.update(session.view())
        self.assertEqual(timeline.rows[0]['key'], first['key'])
        self.assertEqual(timeline.rows[0]['version'], first['version'])
        self.assertEqual(timeline.rows[0]['timestamp'], 1792699822000)
        self.assertEqual(len(timeline.changes(0, timeline.epoch, None)['rows']), 1)

    def test_background_reader_merges_only_metadata_and_finishes_after_close(self):
        session = LiveSession('thread')
        entered, release = threading.Event(), threading.Event()
        def reader(*_):
            entered.set(); release.wait(2)
            return {'reset': True, 'times': {'r': 1792699822000}, 'checkpoint': {}}
        bridge = SimpleNamespace(store=SimpleNamespace(message_times=reader), closed=threading.Event())
        Bridge._refresh_message_times(bridge, session)
        self.assertTrue(entered.wait(1))
        Bridge._refresh_message_times(bridge, session)
        bridge.closed.set(); release.set()
        with session.condition:
            session.condition.wait_for(lambda: not session.message_time_reading, timeout=.1)
        self.assertEqual(session.message_times, {})


if __name__ == '__main__':
    unittest.main()
