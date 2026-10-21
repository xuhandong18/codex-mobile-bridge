"""Isolated sidebar fixtures; no real desktop pipe, window or write is used."""
import asyncio
import copy
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import Mock, patch

from bridge.clients.codex.desktop_tools import DesktopTools, ToolError
from bridge.clients.codex.sidebar import NativeSidebar
from bridge.features.sessions.sidebar import SidebarManagement, validate
from bridge.features.sessions.sidebar_preferences import SidebarPreferences
from bridge.features.notifications.channels import write_json


PROJECT_ID = 'local-d624b5a4be8bbf318b7dfd7646ea7d8f'
PROJECT_KEY = 'local|' + PROJECT_ID
CONTEXT = str(uuid.uuid4())
WRITES = {'create_sidebar_section', 'rename_sidebar_section', 'delete_sidebar_section',
          'reorder_sidebar_sections', 'move_project_to_sidebar_section'}


def command(kind='section', action='rename', **fields):
    return {'id': str(uuid.uuid4()), 'kind': kind, 'action': action, **fields}


class HeldGate:
    def __init__(self):
        self.held = False

    def __enter__(self):
        if self.held:
            raise AssertionError('gate already held')
        self.held = True

    def __exit__(self, *args):
        self.held = False


class DesktopFixture:
    def __init__(self, root):
        self.calls = []
        self.closed = False
        self.sync = True
        self.after_write_error = None
        self.on_project_read = None
        self.project_reads = 0
        self.project = {'projectId': PROJECT_ID, 'projectKind': 'local',
                        'label': 'Project', 'path': str(root / 'workspace')}
        self.projects = [self.project.copy()]
        self.sections = [
            {'sectionId': 'pinned', 'name': 'Pinned', 'itemKeys': []},
            {'sectionId': 'threads', 'name': 'Threads', 'itemKeys': ['codex:project:' + PROJECT_ID]},
            *[{'sectionId': key, 'name': key.upper(), 'itemKeys': []} for key in ('a', 'b', 'c')],
        ]
        self.saved = {'sections': [{'id': k, 'name': k.upper(), 'itemKeys': []} for k in ('a', 'b', 'c')],
                      'projects': [{'key': PROJECT_KEY, 'host': 'local', 'name': 'Project',
                                    'cwd': self.project['path']}], 'pinnedProjectIds': []}
        self.gate = HeldGate()
        self.store = SimpleNamespace(
            list=Mock(return_value=[{'id': CONTEXT, 'origin': 'desktop'}]),
            get=Mock(return_value={'id': CONTEXT, 'origin': 'desktop'}))
        self.bridge = SimpleNamespace(host='local', data_dir=root / 'data', codex_home=root / 'codex',
            store=self.store, accounts=SimpleNamespace(gate=self.gate, index={'desktopExecutable': 'Codex.exe'}),
            catalog_reader=SimpleNamespace(executable='runtime'),
            hosts=SimpleNamespace(sidebar=lambda: copy.deepcopy(self.saved),
                                  projects=lambda: copy.deepcopy(self.saved['projects'])))

    def persist(self):
        if not self.sync:
            return
        self.saved['sections'] = [{'id': s['sectionId'], 'name': s['name'], 'itemKeys': s['itemKeys'][:]}
                                  for s in self.sections if s['sectionId'] not in ('pinned', 'threads')]
        self.saved['projects'] = [{'key': 'local|' + p['projectId'], 'host': 'local',
                                  'name': p['label'], 'cwd': p['path']} for p in self.projects]
        pinned = next(s for s in self.sections if s['sectionId'] == 'pinned')
        self.saved['pinnedProjectIds'] = [p['projectId'] for p in self.projects
                                         if 'codex:project:' + p['projectId'] in pinned['itemKeys']]

    def call(self, method, arguments, **kwargs):
        if not self.gate.held:
            raise AssertionError('native call outside accounts.gate')
        self.calls.append((method, copy.deepcopy(arguments)))
        if method == 'list_projects':
            self.project_reads += 1
            if self.on_project_read:
                self.on_project_read(self.project_reads)
            return {'projects': copy.deepcopy(self.projects)}
        if method == 'list_threads':
            return {'sections': copy.deepcopy(self.sections)}
        if method == 'create_sidebar_section':
            self.sections.append({'sectionId': 'new', 'name': arguments['name'], 'itemKeys': []})
        elif method == 'rename_sidebar_section':
            next(s for s in self.sections if s['sectionId'] == arguments['sectionId'])['name'] = arguments['name']
        elif method == 'delete_sidebar_section':
            self.sections = [s for s in self.sections if s['sectionId'] != arguments['sectionId']]
        elif method == 'reorder_sidebar_sections':
            by_id = {s['sectionId']: s for s in self.sections}
            self.sections = [by_id['pinned'], by_id['threads']] + [by_id[k] for k in arguments['sectionIds']]
        elif method == 'move_project_to_sidebar_section':
            item = 'codex:project:' + arguments['projectId']
            for section in self.sections:
                section['itemKeys'] = [k for k in section['itemKeys'] if k != item]
                if section['sectionId'] == (arguments['sectionId'] or 'threads'):
                    section['itemKeys'].append(item)
        else:
            raise AssertionError('unexpected desktop tool: ' + method)
        self.persist()
        if self.after_write_error:
            raise self.after_write_error
        return {'sectionId': 'new'} if method == 'create_sidebar_section' else {}

    def close(self):
        self.closed = True

    def edit(self, executable, action, project, name=None):
        if not self.gate.held:
            raise AssertionError('project editor outside accounts.gate')
        if action == 'rename':
            next(p for p in self.projects if p['projectId'] == project['projectId'])['label'] = name
        elif action == 'delete':
            self.projects = [p for p in self.projects if p['projectId'] != project['projectId']]
        else:
            raise AssertionError('unexpected editor action')
        self.persist()
        return {'submitted': True}


class SidebarOperationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = DesktopFixture(Path(self.temp.name))
        self.bridge = self.fixture.bridge

    async def finish(self, manager, value):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            receipt = manager.operation(value['id'])
            if receipt['status'] in ('completed', 'unknown', 'failed'):
                return receipt
            await asyncio.sleep(.005)
        self.fail('sidebar worker did not complete')

    async def test_native_project_move_resets_shared_placement_without_browser_poll(self):
        preferences = SidebarPreferences(self.bridge.data_dir)
        self.addCleanup(preferences.close)
        key = json.dumps(['placement', 'project', 'local', PROJECT_KEY], separators=(',', ':'))
        preferences.save({'changes': [{'key': key, 'value': {'target': 'section:a'}, 'version': 0}]})
        manager = SidebarManagement(self.bridge, executor=lambda *_: {})
        value = command('project', 'move', targetId=PROJECT_KEY, sectionId='b')
        await manager.submit(value, preferences)
        self.assertEqual((await self.finish(manager, value))['status'], 'completed')
        self.assertEqual(preferences.read()['fields'][key], {'value': None, 'version': 2})
        revision = preferences.read()['revision']
        await manager.submit(value, preferences)
        self.assertEqual(preferences.read()['revision'], revision)

    async def test_unknown_native_project_move_does_not_clear_shared_placement(self):
        preferences = SidebarPreferences(self.bridge.data_dir)
        self.addCleanup(preferences.close)
        key = json.dumps(['placement', 'project', 'local', PROJECT_KEY], separators=(',', ':'))
        preferences.save({'changes': [{'key': key, 'value': {'target': 'section:a'}, 'version': 0}]})
        def execute(*_):
            raise ToolError('合成断线', unknown=True)
        manager = SidebarManagement(self.bridge, executor=execute)
        value = command('project', 'move', targetId=PROJECT_KEY, sectionId='b')
        await manager.submit(value, preferences)
        self.assertEqual((await self.finish(manager, value))['status'], 'unknown')
        self.assertEqual(preferences.read()['fields'][key]['value'], {'target': 'section:a'})

    async def test_native_completion_preserves_a_newer_explicit_device_placement(self):
        preferences = SidebarPreferences(self.bridge.data_dir)
        self.addCleanup(preferences.close)
        key = json.dumps(['placement', 'project', 'local', PROJECT_KEY], separators=(',', ':'))
        def execute(*_):
            preferences.save({'changes': [{'key': key, 'value': {'target': 'section:c'}, 'version': 0}]})
            return {}
        manager = SidebarManagement(self.bridge, executor=execute)
        value = command('project', 'move', targetId=PROJECT_KEY, sectionId='b')
        await manager.submit(value, preferences)
        self.assertEqual((await self.finish(manager, value))['status'], 'completed')
        self.assertEqual(preferences.read()['fields'][key]['value'], {'target': 'section:c'})

    async def test_pending_and_completed_duplicates_do_not_replay_and_fingerprint_is_fixed(self):
        started, release = threading.Event(), threading.Event()
        value = command(targetId='a', name='Renamed')
        def execute(body, progress):
            persisted = json.loads((self.bridge.data_dir / 'sidebar-operations.json').read_text(encoding='utf-8'))
            self.assertEqual(persisted[body['id']]['status'], 'pending')
            started.set()
            release.wait(2)
            progress('verifying', 'checking')
            return {'targetId': 'a', 'section': {'id': 'a', 'name': body['name']}}
        fake = Mock(side_effect=execute)
        manager = SidebarManagement(self.bridge, fake)
        try:
            self.assertEqual((await manager.submit(value))['status'], 'pending')
            await asyncio.to_thread(started.wait, 1)
            self.assertEqual((await manager.submit(value))['status'], 'pending')
            with self.assertRaisesRegex(ValueError, '不能修改'):
                await manager.submit({**value, 'name': 'Different'})
        finally:
            release.set()
        receipt = await self.finish(manager, value)
        self.assertEqual(receipt['status'], 'completed')
        self.fixture.saved['sections'] = []
        self.assertEqual((await manager.submit(value))['status'], 'completed')
        fake.assert_called_once()
        self.assertNotIn('fingerprint', receipt)
        receipt['section']['name'] = 'Changed by caller'
        self.assertEqual(manager.operation(value['id'])['section']['name'], 'Renamed')
        self.assertEqual(sorted(p.name for p in self.bridge.data_dir.iterdir()), ['sidebar-operations.json'])

    async def test_restart_changes_all_unfinished_receipts_to_unknown_without_replay(self):
        fake = Mock()
        manager = SidebarManagement(self.bridge, fake)
        values = [command(targetId='a', name='Name') for _ in range(5)]
        statuses = ['pending', 'applying', 'verifying', 'completed', 'failed']
        write_json(manager.path, {v['id']: {'id': v['id'], 'status': s, 'fingerprint': 'stored'}
                                  for v, s in zip(values, statuses)})
        restored = SidebarManagement(self.bridge, fake)
        expected = ['unknown', 'unknown', 'unknown', 'completed', 'failed']
        self.assertEqual([restored.operation(v['id'])['status'] for v in values], expected)
        self.assertEqual([r['status'] for r in json.loads(manager.path.read_text(encoding='utf-8')).values()], expected)
        fake.assert_not_called()

    async def test_unknown_and_failed_receipts_never_replay(self):
        for error, expected in [(ToolError('sent', unknown=True), 'unknown'),
                                (OSError('disconnected'), 'unknown'),
                                (ValueError('preflight business validation'), 'failed'),
                                (ToolError('not sent'), 'failed')]:
            with self.subTest(error=error):
                value = command(targetId='a', name='Name')
                fake = Mock(side_effect=error)
                manager = SidebarManagement(self.bridge, fake)
                await manager.submit(value)
                self.assertEqual((await self.finish(manager, value))['status'], expected)
                await manager.submit(value)
                fake.assert_called_once()
                if expected == 'unknown':
                    with self.assertRaisesRegex(ValueError, '未确认'):
                        await manager.submit({**value, 'id': str(uuid.uuid4())})
                # Separate cases deliberately use separate receipt stores.
                self.bridge.data_dir = self.bridge.data_dir / 'next'

    async def test_all_supported_actions_accept_only_their_schema_and_legacy_project_key(self):
        cases = [command('section', 'create', name='新分区'),
                 command('section', 'rename', targetId='a', name='新名称'),
                 command('section', 'move', targetId='a', beforeId=None),
                 command('section', 'delete', targetId='a', confirmed=True),
                 command('project', 'rename', targetId=PROJECT_KEY, name='新项目名称'),
                 command('project', 'move', targetId=PROJECT_KEY, sectionId='a'),
                 command('project', 'delete', targetId=PROJECT_KEY, confirmed=True)]
        fake = Mock(return_value={'targetId': 'a'})
        manager = SidebarManagement(self.bridge, fake)
        for value in cases:
            await manager.submit(value)
            self.assertEqual((await self.finish(manager, value))['status'], 'completed')
        self.assertEqual(fake.call_count, len(cases))

    async def test_bad_schema_and_stale_or_builtin_targets_never_queue(self):
        base = command(targetId='a', name='Good')
        invalid = [None, [], {}, {**base, 'id': 42}, {**base, 'id': 'invalid'},
            {**base, 'contextId': None}, {**base, 'contextId': 'invalid'},
            {**base, 'kind': []}, {**base, 'action': {}}, {**base, 'extra': True},
            {**base, 'name': ''}, {**base, 'name': ' '}, {**base, 'name': 'x' * 121},
            {**base, 'name': 'x\ny'}, {**base, 'name': 'x\x00y'},
            {k: v for k, v in base.items() if k != 'name'},
            {**base, 'targetId': 'missing'}, {**base, 'targetId': 'pinned'},
            command('section', 'create', name='Name', targetId='a'),
            command('section', 'move', targetId='a', beforeId='a'),
            command('section', 'move', targetId='a', beforeId='pinned'),
            command('section', 'move', targetId='a', beforeId=1),
            command('section', 'move', targetId='a'),
            command('section', 'delete', targetId='a', confirmed=1),
            command('section', 'delete', targetId='a', confirmed=False),
            command('section', 'delete', targetId='a', confirmed=True, name='Name'),
            command('project', 'create', name='Name'),
            command('project', 'move', targetId=PROJECT_KEY, sectionId='missing'),
            command('project', 'move', targetId='local|missing', sectionId=None),
            *[command('project', 'rename', targetId=k, name='Name') for k in
              ('remote|id', 'cli|local|id', 'local|', 'local|../escape', 'local|a|b', 'local|a b', 'local|a\x00')]]
        fake = Mock(return_value={})
        manager = SidebarManagement(self.bridge, fake)
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                await manager.submit(value)
        fake.assert_not_called()
        self.assertFalse(manager.path.exists())

    async def test_name_boundary_context_and_unavailable_executor(self):
        value = command('section', 'create', name='字' * 120, contextId=CONTEXT)
        self.assertEqual(validate(value), value)
        fake = SimpleNamespace(available=False, execute=Mock())
        with self.assertRaisesRegex(ValueError, '不支持'):
            await SidebarManagement(self.bridge, fake).submit(value)
        fake.execute.assert_not_called()

    async def test_persistence_failure_cannot_dispatch(self):
        fake = Mock(return_value={})
        manager = SidebarManagement(self.bridge, fake)
        value = command(targetId='a', name='Name')
        with patch('bridge.features.sessions.sidebar.write_json', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                await manager.submit(value)
        self.assertEqual(manager.operations, {})
        fake.assert_not_called()

    async def test_completed_receipt_survives_sync_asyncio_run_route(self):
        manager = SidebarManagement(self.bridge, Mock(return_value={'targetId': 'a'}))
        value = command(targetId='a', name='Name')
        receipt = await asyncio.to_thread(lambda: asyncio.run(manager.submit(value)))
        self.assertEqual(receipt['status'], 'pending')
        self.assertEqual((await self.finish(manager, value))['status'], 'completed')
        restored = SidebarManagement(self.bridge, Mock(side_effect=AssertionError('replayed')))
        self.assertEqual((await restored.submit(value))['status'], 'completed')


class NativeSidebarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = DesktopFixture(Path(self.temp.name))
        self.bridge = self.fixture.bridge
        self.connect = self.enterContext(patch.object(DesktopTools, 'connect', side_effect=self.connect_native))
        self.enterContext(patch.object(DesktopTools, 'METHODS', DesktopTools.METHODS | WRITES))
        self.enterContext(patch('bridge.clients.codex.sidebar.sys.platform', 'win32'))
        self.editor = Mock(side_effect=self.fixture.edit)
        self.executor = NativeSidebar(self.bridge, self.editor, verify_timeout=0, poll_interval=0)

    def connect_native(self, executable, context_id, project_ids):
        self.assertTrue(self.fixture.gate.held)
        self.assertEqual((executable, context_id), ('Codex.exe', CONTEXT))
        self.assertIn(PROJECT_ID, project_ids)
        return self.fixture

    def run_native(self, value):
        result = self.executor.execute(value, Mock())
        self.assertNotIn('sidebar', result)
        self.assertTrue(self.fixture.closed)
        self.assertFalse(self.fixture.gate.held)
        return result

    def native_writes(self):
        return [(m, a) for m, a in self.fixture.calls if m in WRITES]

    def test_section_create_and_rename_read_both_sources(self):
        result = self.run_native(command('section', 'create', name='New'))
        self.assertEqual(result['section'], {'id': 'new', 'name': 'New', 'itemKeys': []})
        self.assertEqual(result['targetId'], 'new')
        result = self.run_native(command(targetId='a', name='Renamed'))
        self.assertEqual(result['section']['name'], 'Renamed')
        self.assertEqual(self.native_writes(), [('create_sidebar_section', {'name': 'New'}),
                                              ('rename_sidebar_section', {'sectionId': 'a', 'name': 'Renamed'})])

    def test_move_sends_every_custom_section_once_and_no_builtin(self):
        self.run_native(command('section', 'move', targetId='c', beforeId='a'))
        self.assertEqual(self.native_writes(), [('reorder_sidebar_sections', {'sectionIds': ['c', 'a', 'b']})])
        self.run_native(command('section', 'move', targetId='c', beforeId=None))
        self.assertEqual(self.native_writes()[-1][1], {'sectionIds': ['a', 'b', 'c']})

    def test_section_delete_requires_confirmation_and_reads_absence(self):
        value = command('section', 'delete', targetId='b', confirmed=False)
        with self.assertRaisesRegex(ToolError, '确认'):
            self.executor.execute(value, Mock())
        self.assertEqual(self.native_writes(), [])
        result = self.run_native({**value, 'confirmed': True})
        self.assertEqual(result['targetId'], 'b')
        self.assertNotIn('section', result)

    def test_project_move_to_custom_default_and_pinned_is_native(self):
        for destination in ['a', None, 'pinned', 'threads']:
            with self.subTest(destination=destination):
                result = self.run_native(command('project', 'move', targetId=PROJECT_KEY, sectionId=destination))
                self.assertEqual(result['project']['key'], PROJECT_KEY)
                self.assertEqual(self.native_writes()[-1], ('move_project_to_sidebar_section',
                    {'projectId': PROJECT_ID, 'sectionId': destination}))
        self.editor.assert_not_called()

    def test_editor_receives_verified_native_record_inside_gate(self):
        original = self.fixture.project.copy()
        result = self.run_native(command('project', 'rename', targetId=PROJECT_KEY, name='Renamed'))
        self.editor.assert_called_once_with('Codex.exe', 'rename', original, name='Renamed')
        self.assertEqual(result['project']['name'], 'Renamed')
        self.assertGreaterEqual(self.fixture.project_reads, 2)
        self.assertEqual(self.native_writes(), [])

    def test_default_windows_editor_is_used_without_real_window_operations(self):
        with patch('bridge.platforms.windows.projects.edit_project', self.editor):
            self.executor = NativeSidebar(self.bridge, verify_timeout=0)
            self.run_native(command('project', 'rename', targetId=PROJECT_KEY, name='Default helper'))
        self.editor.assert_called_once()

    def test_project_delete_only_removes_metadata_and_reports_retained_files_and_chats(self):
        folder = Path(self.fixture.project['path'])
        folder.mkdir()
        content = folder / 'keep.txt'
        content.write_text('workspace remains', encoding='utf-8')
        result = self.run_native(command('project', 'delete', targetId=PROJECT_KEY, confirmed=True))
        self.assertTrue(content.is_file())
        self.assertIn('文件和聊天均保留', result['message'])
        self.assertNotIn('project', result)
        self.assertEqual([m for m, _ in self.fixture.calls].count('list_projects'), 2)
        self.assertEqual(self.native_writes(), [])

    def test_duplicate_local_labels_or_new_label_collision_never_calls_editor(self):
        for label, name in [('Project', 'Changed'), ('Different', 'Different')]:
            with self.subTest(label=label):
                self.fixture.projects = [self.fixture.project.copy(),
                    {**self.fixture.project, 'projectId': 'other', 'label': label}]
                with self.assertRaisesRegex(ToolError, '同名|相同'):
                    self.executor.execute(command('project', 'rename', targetId=PROJECT_KEY, name=name), Mock())
        self.editor.assert_not_called()

    def test_target_id_label_path_and_kind_must_match_current_saved_record(self):
        for field, new in [('projectId', 'another'), ('label', 'Stale'), ('path', str(Path(self.temp.name) / 'other')),
                           ('projectKind', 'remote')]:
            with self.subTest(field=field):
                self.fixture.projects = [{**self.fixture.project, field: new}]
                with self.assertRaisesRegex(ToolError, '不一致'):
                    self.executor.execute(command('project', 'rename', targetId=PROJECT_KEY, name='Name'), Mock())
        self.editor.assert_not_called()

    def test_profile_connect_failure_and_unverified_sections_prevent_any_write(self):
        self.connect.side_effect = ToolError('wrong profile')
        with self.assertRaisesRegex(ToolError, 'profile'):
            self.executor.execute(command('project', 'delete', targetId=PROJECT_KEY, confirmed=True), Mock())
        self.editor.assert_not_called()
        self.connect.side_effect = self.connect_native
        self.fixture.sections.append({'sectionId': 'unseen', 'name': 'Unseen'})
        with self.assertRaisesRegex(ToolError, '不一致'):
            self.executor.execute(command('section', 'move', targetId='a', beforeId=None), Mock())
        self.assertEqual(self.native_writes(), [])

    def test_invalid_context_never_connects_or_sends_chat(self):
        self.bridge.store.get.return_value = {'id': CONTEXT, 'origin': 'cli'}
        with self.assertRaisesRegex(ToolError, '本机.*桌面聊天'):
            self.executor.execute(command(targetId='a', name='Name', contextId=CONTEXT), Mock())
        self.connect.assert_not_called()
        self.assertEqual(self.fixture.calls, [])
        self.bridge.store.list.return_value = [{'id': CONTEXT, 'origin': 'desktop', 'host': 'remote'}]
        with self.assertRaises(ToolError):
            self.executor.execute(command(targetId='a', name='Name'), Mock())
        self.connect.assert_not_called()

    def test_saved_executable_scan_is_fallback_and_stays_inside_gate(self):
        self.bridge.accounts.index = {}
        def scan(runtime, home):
            self.assertTrue(self.fixture.gate.held)
            self.assertEqual(runtime, 'runtime')
            return 'Codex.exe'
        with patch('bridge.clients.codex.sidebar.DesktopApp.scan', side_effect=scan) as scanning:
            self.run_native(command(targetId='a', name='Name'))
        scanning.assert_called_once()

    def test_missing_gate_profile_anchor_or_callback_is_clear_and_prevents_write(self):
        self.executor.project_editor = False
        with self.assertRaisesRegex(ToolError, '尚未接通'):
            self.executor.execute(command('project', 'rename', targetId=PROJECT_KEY, name='Name'), Mock())
        self.bridge.accounts.gate = None
        self.connect.reset_mock()
        with self.assertRaisesRegex(ToolError, '操作锁'):
            self.executor.execute(command(targetId='a', name='Name'), Mock())
        self.connect.assert_not_called()
        self.bridge.accounts.gate = self.fixture.gate
        self.bridge.hosts.projects = lambda: []
        with self.assertRaisesRegex(ToolError, '核验'):
            self.executor.execute(command(targetId='a', name='Name'), Mock())
        self.connect.assert_not_called()
        self.assertEqual(self.native_writes(), [])

    def test_write_and_readback_failures_are_unknown_and_never_replayed(self):
        self.fixture.after_write_error = ValueError('failure after native write')
        with self.assertRaises(ToolError) as caught:
            self.executor.execute(command(targetId='a', name='Name'), Mock())
        self.assertTrue(caught.exception.unknown)
        self.assertEqual(len(self.native_writes()), 1)
        self.assertTrue(self.fixture.closed)

    def test_stale_persisted_state_is_unknown_for_sections_and_projects(self):
        self.fixture.sync = False
        for value in [command(targetId='a', name='Renamed'),
                      command('project', 'rename', targetId=PROJECT_KEY, name='Renamed')]:
            with self.subTest(kind=value['kind']), self.assertRaises(ToolError) as caught:
                self.executor.execute(value, Mock())
            self.assertTrue(caught.exception.unknown)
        self.assertEqual(len(self.native_writes()), 1)
        self.editor.assert_called_once()

    def test_delayed_native_project_readback_is_polled_without_reinvoking_helper(self):
        def deferred_editor(executable, action, project, name=None):
            self.assertTrue(self.fixture.gate.held)
            def read(count):
                if count >= 3:
                    self.fixture.projects[0]['label'] = name
                    self.fixture.persist()
            self.fixture.on_project_read = read
        self.executor = NativeSidebar(self.bridge, Mock(side_effect=deferred_editor), verify_timeout=.5, poll_interval=0)
        result = self.run_native(command('project', 'rename', targetId=PROJECT_KEY, name='Delayed'))
        self.assertEqual(result['project']['name'], 'Delayed')
        self.executor.project_editor.assert_called_once()
        self.assertEqual(self.fixture.project_reads, 3)

    def test_editor_failure_unknown_marker_and_post_editor_read_error(self):
        for unknown in (False, True):
            error = ValueError('helper rejected or uncertain')
            error.unknown = unknown
            self.executor.project_editor = Mock(side_effect=error)
            with self.assertRaises(ToolError) as caught:
                self.executor.execute(command('project', 'rename', targetId=PROJECT_KEY, name='Name'), Mock())
            self.assertEqual(caught.exception.unknown, unknown)
            self.executor.project_editor.assert_called_once()
        self.executor.project_editor = self.editor
        self.fixture.on_project_read = lambda count: (_ for _ in ()).throw(ValueError('bad read')) if count > 3 else None
        with self.assertRaises(ToolError) as caught:
            self.executor.execute(command('project', 'rename', targetId=PROJECT_KEY, name='Name'), Mock())
        self.assertTrue(caught.exception.unknown)
        self.editor.assert_called_once()

    def test_unavailable_method_is_explicit_failure_before_dispatch(self):
        with patch.object(DesktopTools, 'METHODS', {'list_projects', 'list_threads'}):
            with self.assertRaisesRegex(ToolError, '白名单') as caught:
                self.executor.execute(command(targetId='a', name='Name'), Mock())
        self.assertFalse(caught.exception.unknown)
        self.assertEqual(self.native_writes(), [])


if __name__ == '__main__':
    unittest.main()
