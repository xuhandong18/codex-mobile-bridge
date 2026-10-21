import json
import tempfile
import unittest
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

from bridge.features.sessions.message_index import MessageNavigation, read_window, scan_rollout
from bridge.features.sessions.model import normalize_item, normalize_state
from bridge.features.sessions.timeline import Timeline
from bridge.features.sessions.store import SessionStore
from bridge.resources import source_text


SOURCE_THREAD = '22222222-2222-4222-8222-222222222222'
BODY = '请继续核对本票的验收结果。'
ENVELOPE = ('<codex_delegation>\n  <source_thread_id>' + SOURCE_THREAD
            + '</source_thread_id>\n  <input>' + BODY + '</input>\n</codex_delegation>')


class CrossThreadMessageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / '.tmp')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / 'sessions' / 'rollout.jsonl'
        self.path.parent.mkdir()
        self.path.touch()
        self.thread = '11111111-1111-4111-8111-111111111111'
        self.navigation = MessageNavigation(
            lambda identifier, previous=None: scan_rollout(self.path, identifier, previous, normalize_item),
            lambda identifier, point, start, limit: read_window(self.path, identifier, point, start, limit))

    def incoming(self, **overrides):
        return {'type': 'function_call_output', 'id': 'incoming', 'namespace': 'codex_app',
                'name': 'send_message_to_thread', 'output': ENVELOPE, **overrides}

    def write(self, payload, kind='response_item'):
        with self.path.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'type': kind, 'payload': payload}) + '\n')

    def project(self, state):
        timeline = Timeline()
        timeline.update({**normalize_state(state), 'sequence': 1})
        return timeline

    def test_live_incoming_main_chat_message_is_visible_and_not_editable(self):
        state = {'turns': [{'turnId': 'turn', 'items': [
            {'id': 'incoming', 'type': 'functionCallOutput', 'name': 'send_message_to_thread',
             'namespace': 'codex_app', 'output': ENVELOPE},
        ]}]}
        timeline = Timeline()
        timeline.update({**normalize_state(state), 'sequence': 1})
        self.assertEqual(len(timeline.rows), 1)
        row = timeline.rows[0]
        self.assertEqual(row['role'], 'user')
        self.assertEqual(row['text'], BODY)
        self.assertFalse(row['editable'])
        self.assertEqual(row['sourceThreadId'], SOURCE_THREAD)

    def test_saved_incoming_main_chat_message_is_in_directory_and_body(self):
        self.write({'type': 'task_started', 'turn_id': 'turn'}, 'event_msg')
        self.write(self.incoming())
        page = self.navigation.page(self.thread)
        self.assertEqual([item['summary'] for item in page['items']], [BODY])
        window = self.navigation.window(self.thread, around=page['items'][0]['id'])
        row = next(row for row in self.project(window['state']).rows if row.get('navigationId') == page['items'][0]['id'])
        self.assertEqual(row['role'], 'user')
        self.assertEqual(row['text'], BODY)
        self.assertEqual(row['key'], page['items'][0]['rowKey'])
        self.assertFalse(row['editable'])

    def test_initial_handoff_and_live_output_wrapper_use_the_same_message_kind(self):
        for kind in ('function_call_output', 'functionCallOutput'):
            for name in ('create_thread', 'send_message_to_thread'):
                with self.subTest(kind=kind, name=name):
                    row = normalize_item(self.incoming(type=kind, name=name, output={'text': ENVELOPE}))
                    self.assertEqual((row['kind'], row['role'], row['text']), ('threadMessage', 'user', BODY))

    def test_subagent_notifications_stay_hidden_and_do_not_enter_the_directory(self):
        notification = '<subagent_notification>{"agent_id":"child","status":{"completed":"Done"}}</subagent_notification>'
        self.write({'type': 'task_started', 'turn_id': 'turn'}, 'event_msg')
        self.write({'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': notification}]})
        self.write(self.incoming())
        page = self.navigation.page(self.thread)
        self.assertEqual([entry['summary'] for entry in page['items']], [BODY])
        window = self.navigation.window(self.thread, around=page['items'][0]['id'])
        rows = self.project(window['state']).rows
        self.assertTrue(rows[0]['isUserContext'])
        self.assertFalse(rows[1].get('isUserContext', False))

    def test_tool_results_and_quoted_or_malformed_envelopes_are_not_main_chat_messages(self):
        rejected = [
            {'call_id': 'outgoing-call'}, {'callId': 'outgoing-call'},
            {'namespace': 'multi_agent_v1', 'name': 'send_input'},
            {'namespace': 'other'}, {'name': 'unknown'},
            {'output': 'Tool result: ' + ENVELOPE},
            {'output': ENVELOPE.replace(SOURCE_THREAD, 'not-a-thread-id')},
            {'output': ENVELOPE.replace('</codex_delegation>', '')},
            {'output': {'text': 123}},
        ]
        for overrides in rejected:
            with self.subTest(overrides=list(overrides)):
                item = self.incoming(**overrides)
                self.assertEqual(normalize_item(item)['role'], 'activity')
                self.write(item)
        self.assertEqual(self.navigation.page(self.thread)['items'], [])
        quoted = normalize_item({'type': 'userMessage', 'content': [{'type': 'input_text', 'text': ENVELOPE}]})
        self.assertEqual(quoted['text'], ENVELOPE)
        self.assertNotEqual(quoted['kind'], 'threadMessage')

    def test_main_chat_message_does_not_take_the_real_user_edit_action(self):
        timeline = self.project({'turns': [{'turnId': 'turn', 'items': [
            self.incoming(),
            {'id': 'human', 'type': 'userMessage', 'content': [{'type': 'text', 'text': '我的补充'}]},
        ]}]})
        self.assertEqual([row['editable'] for row in timeline.rows], [False, True])

    def test_append_retains_both_repeated_messages_and_navigation_ids(self):
        self.write({'type': 'task_started', 'turn_id': 'first'}, 'event_msg')
        self.write(self.incoming())
        first = self.navigation.page(self.thread)
        self.write({'type': 'task_started', 'turn_id': 'second'}, 'event_msg')
        self.write(self.incoming(id='incoming-2'))
        delta = self.navigation.page(self.thread, since=first['tailCursor'])
        complete = self.navigation.page(self.thread)
        self.assertEqual(delta['total'], 2)
        self.assertEqual(len(delta['items']), 1)
        self.assertEqual(complete['items'][0]['id'], first['items'][0]['id'])
        self.assertEqual([entry['summary'] for entry in complete['items']], [BODY, BODY])
        self.assertNotEqual(complete['items'][0]['id'], complete['items'][1]['id'])

    def test_recent_saved_history_keeps_body_and_source_without_modifying_records(self):
        self.write({'type': 'task_started', 'turn_id': 'turn'}, 'event_msg')
        self.write(self.incoming())
        store = SessionStore(self.root)
        metadata = {'rollout_path': str(self.path), 'title': 'Fixture', 'cwd': '/fixture'}
        before = self.path.read_bytes()
        with patch.object(store, 'get', return_value=metadata):
            timeline = self.project(store.history(self.thread))
        self.assertEqual(timeline.rows[0]['text'], BODY)
        self.assertEqual(timeline.rows[0]['sourceThreadId'], SOURCE_THREAD)
        self.assertFalse(timeline.rows[0]['editable'])
        self.assertEqual(self.path.read_bytes(), before)

    def test_ssh_source_recognizes_main_chat_messages_without_an_installed_package(self):
        self.write(self.incoming())
        source = source_text('features/sessions/model.py') + '\n' + source_text('features/sessions/message_index.py')
        source += '\npath = ' + repr(str(self.path)) + '\nthread = ' + repr(self.thread)
        source += '''
navigation = MessageNavigation(lambda identifier, previous=None: scan_rollout(path, identifier, previous, normalize_item),
    lambda identifier, point, start, limit: read_window(path, identifier, point, start, limit))
page = navigation.page(thread)
window = navigation.window(thread, around=page['items'][0]['id'])
print(json.dumps({'summary': page['items'][0]['summary'], 'state': normalize_state(window['state'])}))
'''
        result = subprocess.run([sys.executable, '-X', 'utf8', '-I', '-S', '-B', '-'], input=source,
                                cwd=self.root, text=True, encoding='utf-8', capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['summary'], BODY)
        self.assertEqual(output['state']['turns'][0]['messages'][0]['text'], BODY)


if __name__ == '__main__':
    unittest.main()
