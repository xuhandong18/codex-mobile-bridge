"""Creation must work when a runtime cannot list turns on an empty thread."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from bridge.features.sessions.create import CreationError, create_empty


ROOT = Path(__file__).resolve().parents[1]


class EmptyThreadRuntimeCompatibility(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(dir=ROOT / '.tmp')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.thread_id = str(uuid.uuid4())
        self.calls_path = self.root / 'calls.json'
        self.rollout = self.root / 'rollout.jsonl'

    def runtime(self, error='list_turns is not supported yet', *, persist=True,
                metadata_error=None, metadata_id=None, include_path=True):
        script = self.root / 'runtime.py'
        config = {'thread_id': self.thread_id, 'error': error, 'persist': persist,
                  'metadata_error': metadata_error, 'metadata_id': metadata_id or self.thread_id,
                  'path': str(self.rollout) if include_path else None,
                  'calls_path': str(self.calls_path)}
        script.write_text('import json, sys\nconfig = ' + repr(config) + '''
from pathlib import Path
calls = []
metadata_read = False
for line in sys.stdin:
    request = json.loads(line)
    calls.append(request)
    if 'id' not in request:
        continue
    response = {'id': request['id']}
    if request['method'] == 'thread/read' and request['params'].get('includeTurns') and config['error']:
        response['error'] = {'code': -32603, 'message': config['error']}
    elif request['method'] == 'thread/read' and config['metadata_error']:
        response['error'] = {'code': -32603, 'message': config['metadata_error']}
    elif request['method'] == 'thread/read':
        metadata_read = True
        response['result'] = {'thread': {'id': config['metadata_id'], 'path': config['path']}}
    else:
        response['result'] = {'thread': {'id': config['thread_id']}}
    print(json.dumps(response), flush=True)
if metadata_read and config['persist'] and config['path']:
    Path(config['path']).write_text(json.dumps({'type': 'session_meta', 'payload': {'id': config['thread_id']}}))
Path(config['calls_path']).write_text(json.dumps(calls))
''', encoding='utf-8')
        real_popen = subprocess.Popen

        def spawn(argv, **kwargs):
            self.assertEqual(argv, ['runtime', 'app-server', '--listen', 'stdio://'])
            if os.name == 'nt':
                self.assertEqual(kwargs.get('creationflags'), subprocess.CREATE_NO_WINDOW)
            return real_popen([sys.executable, str(script)], **kwargs)

        return patch('bridge.features.sessions.create.subprocess.Popen', side_effect=spawn)

    def calls(self):
        return json.loads(self.calls_path.read_text())

    def create(self, title='Test'):
        return create_empty('runtime', self.root, str(self.root), title)

    def test_empty_creation_survives_unsupported_turn_listing(self):
        with self.runtime():
            self.assertEqual(self.create(), self.thread_id)
        self.assertTrue(self.rollout.is_file())
        calls = self.calls()
        self.assertEqual(sum(call['method'] == 'thread/start' for call in calls), 1)
        self.assertFalse(any(call['method'] in ('turn/start', 'thread/resume') for call in calls))
        reads = [call['params'] for call in calls if call['method'] == 'thread/read']
        self.assertEqual(reads, [{'threadId': self.thread_id, 'includeTurns': True},
                                 {'threadId': self.thread_id, 'includeTurns': False}])

    def test_automatic_title_works_without_naming_or_starting_a_turn(self):
        with self.runtime():
            self.assertEqual(self.create(None), self.thread_id)
        self.assertFalse(any(call['method'] in ('thread/name/set', 'turn/start') for call in self.calls()))

    def test_supported_runtime_keeps_the_existing_materialization_path(self):
        with self.runtime(error=None):
            self.assertEqual(self.create(), self.thread_id)
        self.assertEqual(sum(call['method'] == 'thread/read' for call in self.calls()), 1)

    def test_unrelated_read_failure_stays_uncertain(self):
        with self.runtime(error='history database unavailable'):
            with self.assertRaisesRegex(CreationError, 'history database unavailable'):
                self.create()
        self.assertEqual(sum(call['method'] == 'thread/read' for call in self.calls()), 1)

    def test_metadata_read_failure_is_not_reported_as_success(self):
        with self.runtime(metadata_error='metadata unavailable'):
            with self.assertRaisesRegex(CreationError, 'metadata unavailable'):
                self.create()

    def test_metadata_must_identify_the_created_thread(self):
        with self.runtime(metadata_id=str(uuid.uuid4())):
            with self.assertRaisesRegex(CreationError, '信息不一致'):
                self.create()

    def test_unsaved_thread_stays_uncertain_after_runtime_exits(self):
        for options in ({'persist': False}, {'include_path': False}):
            with self.subTest(options=options), self.runtime(**options):
                with self.assertRaisesRegex(CreationError, '尚未确认保存'):
                    self.create()

    def test_bridge_records_the_same_id_and_does_not_repeat_creation(self):
        from bridge.app.service import Bridge
        with patch('bridge.clients.codex.catalog.Catalog.find_runtime', return_value=None):
            bridge = Bridge(self.root, self.root / 'data')
        self.addCleanup(bridge.close)
        bridge.catalog_reader.executable = 'runtime'
        bridge.hosts.projects = lambda: [{'key': 'local|p', 'host': 'local', 'cwd': str(self.root)}]
        bridge.ipc.connect = lambda: None
        request_id = str(uuid.uuid4())
        with self.runtime() as spawned, patch('bridge.app.service.open_in_desktop') as opened:
            for _ in range(2):
                self.assertEqual(bridge.create_chat('local|p', 'Test', request_id)['id'], self.thread_id)
            self.assertEqual(opened.call_args.args, (self.thread_id, 'local'))
            self.assertEqual(spawned.call_count, 1)
        self.assertEqual(sum(call['method'] == 'thread/start' for call in self.calls()), 1)
        self.assertEqual(json.loads(bridge.creations_path.read_text())[request_id]['id'], self.thread_id)

    def test_bridge_does_not_replay_a_failed_persistence_check(self):
        from bridge.app.service import Bridge
        with patch('bridge.clients.codex.catalog.Catalog.find_runtime', return_value=None):
            bridge = Bridge(self.root, self.root / 'data')
        self.addCleanup(bridge.close)
        bridge.catalog_reader.executable = 'runtime'
        bridge.hosts.projects = lambda: [{'key': 'local|p', 'host': 'local', 'cwd': str(self.root)}]
        bridge.ipc.connect = lambda: None
        request_id = str(uuid.uuid4())
        with self.runtime(persist=False) as spawned, patch('bridge.app.service.open_in_desktop') as opened:
            for _ in range(2):
                with self.assertRaises(CreationError):
                    bridge.create_chat('local|p', 'Test', request_id)
            opened.assert_not_called()
            self.assertEqual(spawned.call_count, 1)
        self.assertEqual(sum(call['method'] == 'thread/start' for call in self.calls()), 1)


if __name__ == '__main__':
    unittest.main()
