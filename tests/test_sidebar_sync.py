import unittest
from pathlib import Path
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


if __name__ == '__main__':
    unittest.main()
