import json
import tempfile
import unittest
from pathlib import Path

from bridge.features.sessions.model import normalize_item, normalize_state
from bridge.features.sessions.store import SessionStore
from bridge.features.sessions.timeline import Timeline


class ReasoningSummaryTests(unittest.TestCase):
    def test_only_public_summary_text_is_displayed(self):
        samples = [
            (['Public first', 'Public second'], 'Public first\nPublic second'),
            ([{'type': 'summary_text', 'text': 'Public saved summary'}], 'Public saved summary'),
            ('Public summary', 'Public summary'),
            (None, ''),
            ([], ''),
            ([{'type': 'reasoning_text', 'text': 'private fixture'}], ''),
        ]
        for summary, expected in samples:
            with self.subTest(summary=summary):
                item = normalize_item({'id': 'reason', 'type': 'reasoning', 'summary': summary,
                                       'encrypted_content': 'encrypted fixture',
                                       'content': [{'type': 'reasoning_text', 'text': 'private fixture'}]})
                self.assertEqual(item['text'], expected)
                self.assertNotIn('encrypted_content', item)
                self.assertNotIn('attachments', item)

    def test_saved_public_summary_reaches_timeline_detail_in_order(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / '.tmp') as folder:
            home = Path(folder)
            rollout = home / 'sessions' / 'chat.jsonl'
            rollout.parent.mkdir()
            records = [
                {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'turn'}},
                {'type': 'response_item', 'payload': {'id': 'reason', 'type': 'reasoning',
                    'summary': [{'type': 'summary_text', 'text': 'Public first'},
                                {'type': 'summary_text', 'text': 'Public second'}],
                    'encrypted_content': 'encrypted fixture'}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant',
                    'content': [{'type': 'output_text', 'text': 'Final reply'}]}},
                {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
            ]
            rollout.write_text('\n'.join(json.dumps(row) for row in records), encoding='utf-8')
            store = SessionStore(home)
            history = store._history('chat', {'rollout_path': str(rollout), 'cwd': '/fixture'})
            timeline = Timeline()
            timeline.update({**normalize_state(history, connected=False), 'sequence': 1})
            self.assertEqual([row['kind'] for row in timeline.rows], ['reasoning', 'agentMessage'])
            row = timeline.rows[0]
            self.assertEqual(timeline.detail(timeline.cursor(row['key']))['text'], 'Public first\nPublic second')
            self.assertNotIn('encrypted fixture', json.dumps(history))


if __name__ == '__main__':
    unittest.main()
