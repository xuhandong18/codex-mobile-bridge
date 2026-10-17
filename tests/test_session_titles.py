import unittest
from contextlib import closing
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

from bridge.features.sessions.model import normalize_state, session_title


class SessionTitleTests(unittest.TestCase):
    def test_partial_live_history_keeps_saved_title_and_does_not_change_ipc_state(self):
        from bridge.app.service import LiveSession
        session = LiveSession('thread')
        session.saved_view = normalize_state({'id': 'thread', 'title': '已保存标题', 'turns': []}, False)
        session.state = {'id': 'thread', 'title': None, 'turnsPagination': {'hasLoadedOldest': False},
                         'turns': [{'turnId': 'recent', 'items': [{'type': 'userMessage',
                             'content': [{'type': 'text', 'text': '把重置额度也显示出来'}]}]}]}
        session.connected = True
        for _ in range(3):
            view = session.view()
            self.assertEqual(view['title'], '已保存标题')
            self.assertEqual(view['titleSource'], 'native')
        self.assertIsNone(session.state['title'])
        session.state['title'] = '真正的新标题'
        self.assertEqual(session.view()['title'], '真正的新标题')

    def test_message_title_is_identified_as_fallback(self):
        view = normalize_state({'turns': [{'turnId': 'recent', 'items': [{'type': 'userMessage',
            'content': [{'type': 'text', 'text': '当前分页里的消息'}]}]}]})
        self.assertEqual(view['titleSource'], 'message')

    def test_native_preview_is_used_until_the_name_arrives(self):
        state = {'id': 'thread', 'title': None, 'preview': '请帮我整理项目', 'turns': []}
        self.assertEqual(normalize_state(state)['title'], '请帮我整理项目')

    def test_loaded_first_message_supplies_a_title_without_a_preview(self):
        state = {'id': 'thread', 'turns': [{'turnId': 'turn', 'items': [
            {'id': 'user', 'type': 'userMessage', 'content': [{'type': 'text', 'text': '请帮我整理项目'}]}
        ]}]}
        self.assertEqual(normalize_state(state)['title'], '请帮我整理项目')

    def test_explicit_name_takes_precedence_over_the_first_message(self):
        self.assertEqual(normalize_state({'id': 'thread', 'title': '我的名称', 'preview': '首条消息'})['title'], '我的名称')

    def test_empty_chat_still_has_a_placeholder(self):
        self.assertEqual(normalize_state({'id': 'thread', 'turns': []})['title'], '未命名聊天')

    def test_title_preview_is_a_bounded_single_line_and_native_names_win(self):
        self.assertEqual(session_title({'first_user_message': '  第一行\n 第二行  '}), '第一行 第二行')
        self.assertEqual(session_title({'preview': '字' * 100}), '字' * 80 + '…')
        self.assertEqual(session_title({'name': '原生标题', 'title': '旧标题', 'preview': '首条消息'}), '原生标题')

    def test_list_uses_first_message_metadata_without_reading_rollout_or_exposing_the_prompt(self):
        from bridge.app.service import Bridge
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory(dir=root / '.tmp') as folder:
            home = Path(folder)
            with closing(sqlite3.connect(home / 'state_5.sqlite')) as connection:
                connection.execute('CREATE TABLE threads(id TEXT, title TEXT, first_user_message TEXT, cwd TEXT, updated_at INTEGER, source TEXT, originator TEXT, archived INTEGER)')
                connection.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?)',
                                   ('thread', '', '首条消息的摘要', str(home), 10, 'vscode', 'Codex Desktop', 0))
                connection.commit()
            with patch('bridge.clients.codex.catalog.Catalog.find_runtime', return_value=None):
                bridge = Bridge(home, home / 'data')
            try:
                bridge.hosts.state = lambda: {'local-projects': {'p': {'id': 'p', 'name': 'Project', 'rootPaths': [str(home)]}}}
                with patch.object(bridge.store, 'history', side_effect=AssertionError('List must not read rollout')):
                    row = bridge.list(local_only=True)[0]
                self.assertEqual(row['title'], '首条消息的摘要')
                self.assertEqual(row['titleSource'], 'preview')
                self.assertNotIn('first_user_message', row)
            finally:
                bridge.close()
