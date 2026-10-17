import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

from bridge.features.sessions.projects import Projects
from bridge.clients.codex.remote import AppHosts


class ProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.folder = self.root/'workspace'
        self.folder.mkdir()
        self.projects = Projects(self.root/'gateway')
        self.value = {'id':str(uuid.uuid4()), 'name':'New Project', 'cwd':str(self.folder), 'sectionId':None}

    def test_missing_native_connection_cannot_create_gateway_only_project(self):
        self.assertFalse(self.projects.can_create)
        with self.assertRaisesRegex(ValueError, '原生项目创建接口'):
            self.projects.create(self.value, [], [])
        self.assertFalse(self.projects.path.exists())
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_native_delegate_receives_request_without_gateway_project_persistence(self):
        result = {'key':'local|native-project', 'host':'local', 'name':'New Project', 'cwd':str(self.folder)}
        self.projects.native_creator = Mock(return_value=result)
        self.assertEqual(self.projects.create(self.value, [], []), result)
        self.projects.native_creator.assert_called_once_with(self.value)
        self.assertFalse(self.projects.path.exists())

    def test_missing_relative_and_file_paths_are_rejected(self):
        self.projects.native_creator = Mock()
        file = self.root/'file'; file.write_text('private')
        for cwd in ('relative', str(file), str(self.root/'missing')):
            with self.subTest(cwd=cwd), self.assertRaises(ValueError):
                self.projects.create({**self.value,'cwd':cwd}, [], [])

    def test_sections_are_validated_before_native_dispatch(self):
        self.projects.native_creator = Mock(return_value={'key':'local|native'})
        state = {'electron-persisted-atom-state':{'sidebar-custom-sections-v3':{'account':{
            'sections':[{'id':'section','name':'Work','itemKeys':[]}]}}}}
        state_file = self.root/'.codex-global-state.json'
        state_file.write_text(json.dumps(state))
        before = state_file.read_bytes()
        hosts = AppHosts(self.root)
        with self.assertRaises(ValueError):
            self.projects.create({**self.value,'sectionId':'missing'}, [], hosts.sidebar()['sections'])
        self.projects.native_creator.assert_not_called()
        self.projects.create({**self.value,'sectionId':'section'}, [], hosts.sidebar()['sections'])
        self.assertEqual(self.projects.native_creator.call_args.args[0]['sectionId'], 'section')
        self.assertEqual(hosts.projects(), [])
        self.assertEqual(state_file.read_bytes(), before)

    def test_browser_returns_directories_only_and_parent(self):
        (self.folder/'child').mkdir(); (self.folder/'private.txt').write_text('private')
        result = self.projects.browse(str(self.folder))
        self.assertEqual([p['name'] for p in result['directories']], ['child'])
        self.assertEqual(result['parent'], str(self.root))
        self.assertNotIn('private', json.dumps(result))

    def test_corrupted_store_is_not_silently_overwritten(self):
        self.projects.path.parent.mkdir();self.projects.path.write_text('broken')
        with self.assertRaises(ValueError):
            self.projects.create(self.value, [], [])
        self.assertEqual(self.projects.path.read_text(), 'broken')
