import unittest
from pathlib import Path
from unittest.mock import patch
from bridge.clients.codex.remote import AppHosts


class SidebarSyncTests(unittest.TestCase):
    def hosts(self, state):
        hosts = AppHosts(Path('/unused'))
        hosts.state = lambda: state
        return hosts

    def test_sections_keep_native_membership_order_and_empty_projects(self):
        state = {'local-projects': {'p': {'id': 'p', 'name': 'Project', 'rootPaths': ['/work']}},
                 'electron-persisted-atom-state': {'sidebar-custom-sections-v3': {'account': {
                     'sections': [{'id': 'a', 'name': 'Alpha', 'itemKeys': ['codex:project:p'], 'hostSectionIds': {'local': 'native-a'}},
                                  {'id': 'b', 'name': 'Beta', 'itemKeys': []}],
                     'sectionOrder': ['custom:b', 'custom:a'], 'collapsedSectionIds': ['a']}}}}
        result = self.hosts(state).sidebar()
        self.assertEqual([s['id'] for s in result['sections']], ['b', 'a'])
        self.assertTrue(result['sections'][1]['collapsed'])
        self.assertEqual(result['sections'][1]['hostSectionIds'], {'local': 'native-a'})
        self.assertEqual(result['projects'][0]['key'], 'local|p')
        state['electron-persisted-atom-state']['sidebar-custom-sections-v3']['account']['sections'][0]['name'] = 'Renamed'
        self.assertEqual(self.hosts(state).sidebar()['sections'][1]['name'], 'Renamed')

    def test_multiple_accounts_are_not_combined(self):
        hosts = self.hosts({'electron-persisted-atom-state': {'sidebar-custom-sections-v3': {
            'a': {'sections': [{'id': 'a', 'name': 'Private A'}]},
            'b': {'sections': [{'id': 'b', 'name': 'Private B'}]}}}})
        self.assertEqual(hosts.sidebar()['sections'], [])

    def test_native_project_membership_wins_over_cwd_and_legacy_assignment(self):
        hosts = self.hosts({'local-projects': {
            'a': {'id': 'a', 'name': 'A', 'rootPaths': ['/a']},
            'b': {'id': 'b', 'name': 'B', 'rootPaths': ['/b']}},
            'thread-project-assignments': {'thread': {'projectId': 'a'}}})
        row = hosts.decorate([{'id': 'thread', 'cwd': '/a', 'project_id': 'b',
                               'thread_section_id': 'native-b', 'is_pinned': 1}], 'local', 'Local')[0]
        self.assertEqual(row['projectKey'], 'local|b')
        self.assertEqual(row['thread_section_id'], 'native-b')
        self.assertEqual(row['is_pinned'], 1)

    def test_empty_native_project_preserves_explicit_desktop_project_assignment(self):
        hosts = self.hosts({'local-projects': {
            'p': {'id': 'p', 'name': 'Project', 'rootPaths': ['/project']}},
            'thread-project-assignments': {'thread': {'projectId': 'p', 'hostId': 'local'}}})
        row = hosts.decorate([{'id': 'thread', 'cwd': '/worktree', 'project_id': None,
                               'origin': 'desktop'}], 'local', 'Local')[0]
        self.assertEqual(row['projectKey'], 'local|p')

    def test_empty_native_project_preserves_directory_grouping_for_older_chats(self):
        hosts = self.hosts({'local-projects': {
            'p': {'id': 'p', 'name': 'Project', 'rootPaths': ['/project']}}})
        row = hosts.decorate([{'id': 'thread', 'cwd': '/project/sub', 'project_id': None,
                               'origin': 'desktop'}], 'local', 'Local')[0]
        self.assertEqual(row['projectKey'], 'local|p')

    def test_explicit_projectless_chat_does_not_rejoin_project_by_directory(self):
        hosts = self.hosts({'local-projects': {
            'p': {'id': 'p', 'name': 'Project', 'rootPaths': ['/project']}},
            'projectless-thread-ids': ['thread']})
        row = hosts.decorate([{'id': 'thread', 'cwd': '/project', 'project_id': None,
                               'origin': 'desktop'}], 'local', 'Local')[0]
        self.assertEqual(row['projectKey'], 'local|independent')

    def test_gateway_projectless_choice_prevents_only_directory_fallback(self):
        hosts = self.hosts({'local-projects': {
            'p': {'id': 'p', 'name': 'Project', 'rootPaths': ['/project']}}})
        for metadata in ({}, {'project_id': None}):
            with self.subTest(metadata=metadata):
                rows = hosts.decorate([
                    {'id': 'independent', 'cwd': '/project/data/independent-chats/request', 'origin': 'desktop', **metadata},
                    {'id': 'older-chat', 'cwd': '/project', 'origin': 'desktop', **metadata},
                ], 'local', 'Local', projectless_thread_ids={'independent'})
                self.assertEqual(rows[0]['projectKey'], 'local|independent')
                self.assertEqual(rows[1]['projectKey'], 'local|p')

    def test_explicit_desktop_project_move_overrides_gateway_projectless_creation(self):
        for metadata, assignments in (({'project_id': 'p'}, {}),
                                      ({'project_id': None}, {'thread': {'projectId': 'p', 'hostId': 'local'}})):
            with self.subTest(metadata=metadata, assignments=assignments):
                hosts = self.hosts({'local-projects': {
                    'p': {'id': 'p', 'name': 'Project', 'rootPaths': ['/project']}},
                    'thread-project-assignments': assignments})
                row = hosts.decorate([{'id': 'thread', 'cwd': '/other', 'origin': 'desktop', **metadata}],
                                     'local', 'Local', projectless_thread_ids={'thread'})[0]
                self.assertEqual(row['projectKey'], 'local|p')

    def test_windows_extended_cwd_matches_project_after_moving_chat(self):
        hosts = self.hosts({'local-projects': {
            'p': {'id': 'p', 'name': 'Project', 'rootPaths': [r'D:\AI\project']}}})
        for cwd, root in ((r'\\?\D:\AI\project', r'D:\AI\project'),
                          (r'd:\ai\project\child', r'\\?\D:\AI\project'),
                          (r'\\?\UNC\server\share\project\child', r'\\server\share\project')):
            hosts.state()['local-projects']['p']['rootPaths'] = [root]
            with self.subTest(cwd=cwd), patch('bridge.clients.codex.remote.os.name', 'nt'):
                row = hosts.decorate([{'id': 'thread', 'cwd': cwd, 'project_id': None,
                                       'origin': 'desktop'}], 'local', 'Local')[0]
                self.assertEqual(row['projectKey'], 'local|p')
                self.assertEqual(row['cwd'], cwd)

    def test_windows_extended_prefix_keeps_project_boundary_and_explicit_projectless(self):
        hosts = self.hosts({'local-projects': {
            'p': {'id': 'p', 'name': 'Project', 'rootPaths': [r'D:\AI\project']}},
            'projectless-thread-ids': ['independent']})
        with patch('bridge.clients.codex.remote.os.name', 'nt'):
            rows = hosts.decorate([
                {'id': 'thread', 'cwd': r'\\?\D:\AI\project-other', 'project_id': None, 'origin': 'desktop'},
                {'id': 'independent', 'cwd': r'\\?\D:\AI\project', 'project_id': None, 'origin': 'desktop'},
            ], 'local', 'Local')
        self.assertTrue(all(row['projectKey'] == 'local|independent' for row in rows))

    def test_windows_gateway_does_not_normalize_ssh_paths(self):
        hosts = self.hosts({'remote-projects': [
            {'id': 'p', 'hostId': 'remote', 'label': 'Project', 'remotePath': '/work/project'}]})
        with patch('bridge.clients.codex.remote.os.name', 'nt'):
            row = hosts.decorate([{'id': 'thread', 'cwd': '//?/work/project', 'project_id': None,
                                   'origin': 'desktop'}], 'remote', 'Server')[0]
        self.assertNotEqual(row['projectKey'], 'remote|p')


if __name__ == '__main__':
    unittest.main()
