#!/usr/bin/env python3
"""Real Codex title protocol against a synthetic loopback provider; no credentials.

Run from the repository root: python -B scripts/smoke-auto-title.py
"""
import json
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from bridge.clients.codex.catalog import Catalog
from bridge.clients.codex.title_runtime import generate_title, TitleError

captured = []
request_started, release_request = threading.Event(), threading.Event()


class Handler(BaseHTTPRequestHandler):
    mode = 'success'
    def log_message(self, *args):
        pass

    def do_POST(self):
        captured.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
        if self.mode == 'wait':
            request_started.set()
            release_request.wait(5)
        text = '{"title":"修复侧边聊天跨端同步"}' if self.mode != 'invalid' else 'INVALID_JSON'
        item = {'id': 'msg_title', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        response = {'id': 'resp_title', 'object': 'response', 'created_at': 0, 'status': 'completed',
                    'model': 'fixture-model', 'output': [item],
                    'usage': {'input_tokens': 100, 'output_tokens': 15, 'total_tokens': 115}}
        events = [{'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                  {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'status': 'in_progress', 'content': []}},
                  {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
                  {'type': 'response.completed', 'response': response}]
        body = ''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # Expected when cancellation closes the native connection.


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
worker = threading.Thread(target=server.serve_forever, daemon=True)
worker.start()
try:
    with tempfile.TemporaryDirectory(dir=ROOT / '.tmp', prefix='title-native-') as folder:
        root = Path(folder)
        home = root / 'home'
        home.mkdir()
        config = f'''model="fixture-model"
model_provider="fixture"
[model_providers.fixture]
name="Title fixture"
base_url="http://127.0.0.1:{server.server_port}/v1"
wire_api="responses"
[mcp_servers.never-start]
command="THIS_MCP_MUST_NOT_START"
[analytics]
enabled=false
'''
        (home / 'config.toml').write_text(config, encoding='utf-8')
        (root / 'AGENTS.md').write_text('PRIVATE_PROJECT_INSTRUCTIONS_MUST_NOT_APPEAR', encoding='utf-8')
        before = set(home.rglob('rollout-*.jsonl'))
        try:
            result = generate_title(Catalog.find_runtime(), home, 'FIRST_MESSAGE_MARKER 请修复手机与平板之间侧边聊天丢失的问题。' + '字' * 2100 + 'TRUNCATED_TAIL_MARKER',
                                    'fixture-model', 'fixture', root)
        except Exception as error:
            if hasattr(error, 'rpc_error'):
                print('Synthetic RPC error:', error.rpc_error)
            raise
        assert result['title'] == '修复侧边聊天跨端同步', result
        assert len(captured) == 1, len(captured)
        body = captured[0]
        assert body['model'] == 'fixture-model'
        assert body.get('reasoning', {}).get('effort') == 'low'
        assert 'FIRST_MESSAGE_MARKER' in json.dumps(body, ensure_ascii=False)
        assert 'TRUNCATED_TAIL_MARKER' not in json.dumps(body, ensure_ascii=False)
        assert 'PRIVATE_PROJECT_INSTRUCTIONS_MUST_NOT_APPEAR' not in json.dumps(body)
        assert body.get('text', {}).get('format', {}).get('type') == 'json_schema', body.get('text')
        names = [tool.get('name') or tool.get('type') for tool in body.get('tools', [])]
        # Some native versions always advertise request_user_input. Our protocol
        # rejects it; no executable/file/network/connector tools may be exposed.
        assert set(names) <= {'request_user_input'}, 'Title task exposed execution tools: ' + repr(names)
        assert set(home.rglob('rollout-*.jsonl')) == before, 'Title thread was persisted'
        assert not list(root.glob('title-task-*')), 'Title workspace was not cleaned'
        assert (home / 'config.toml').read_text(encoding='utf-8') == config
        assert result['usage'], 'Native token usage was not captured'
        print('PASS: one real ephemeral title turn, same provider/model, low effort, JSON output, no execution tools/project instructions, usage captured, no rollout/config mutation, workspace/process cleanup.')
        generate_title(Catalog.find_runtime(), home, 'EARLY_TOPIC_MARKER ' + '字' * 3000 + ' LATEST_TOPIC_MARKER',
                       'fixture-model', 'fixture', root, conversation=True)
        conversation = json.dumps(captured[-1], ensure_ascii=False)
        assert len(captured) == 2 and 'EARLY_TOPIC_MARKER' in conversation and 'LATEST_TOPIC_MARKER' in conversation
        assert 'conversation' in conversation and 'FIRST_MESSAGE_MARKER' not in conversation
        assert set(home.rglob('rollout-*.jsonl')) == before and not list(root.glob('title-task-*'))
        print('PASS: explicit conversation title retains later messages beyond 2000 characters in an independent ephemeral request.')
        processes = []
        popen = subprocess.Popen

        def record_process(*args, **kwargs):
            process = popen(*args, **kwargs)
            processes.append(process)
            return process

        with patch('bridge.clients.codex.title_runtime.subprocess.Popen', side_effect=record_process):
            Handler.mode = 'invalid'
            try:
                generate_title(Catalog.find_runtime(), home, 'INVALID_RESULT_MARKER', 'fixture-model', 'fixture', root)
            except TitleError:
                pass
            else:
                raise AssertionError('Malformed title was accepted')
            Handler.mode = 'wait'
            cancel = threading.Event()
            canceller = threading.Thread(target=lambda: cancel.set() if request_started.wait(5) else None, daemon=True)
            canceller.start()
            try:
                generate_title(Catalog.find_runtime(), home, 'CANCEL_MARKER', 'fixture-model', 'fixture', root, cancel)
            except TitleError:
                pass
            else:
                raise AssertionError('Cancelled title was accepted')
            finally:
                release_request.set()
                canceller.join(timeout=1)
        assert cancel.is_set() and len(captured) == 4, 'Cancellation did not reach an actual model request'
        assert processes and all(process.poll() is not None for process in processes), 'A title process leaked'
        assert not list(root.glob('title-task-*')) and set(home.rglob('rollout-*.jsonl')) == before
        print('PASS: invalid output and in-flight cancellation never retry or leak runtime/history/workspace.')
finally:
    server.shutdown()
    server.server_close()
    worker.join()
