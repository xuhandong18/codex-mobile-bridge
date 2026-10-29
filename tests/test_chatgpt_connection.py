"""Exercise the restricted probe over a real loopback HTTP/WebSocket fixture."""
import asyncio
import copy
import importlib.util
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from bridge.clients.chatgpt.connection import ProbeConnection, ProbeUnavailable

AIOHTTP = importlib.util.find_spec('aiohttp') is not None


@unittest.skipUnless(AIOHTTP, 'Requires the existing aiohttp dependency in requirements-relay.txt')
class ChatGptConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from aiohttp import web
        self.web = web
        self.commands, self.peers = [], []
        self.reply = {'protocolVersion': 1, 'windowType': 'primary', 'accountKey': 'a' * 64,
                      'route': '/threads/fixture', 'scopeReady': True, 'thread': None,
                      'mutationVerified': False}
        self.payload = None
        self.redirect = False
        self.silent = self.ws_redirect = False
        self.fragmented = False
        app = web.Application()
        app.router.add_get('/json/list', self.inventory)
        app.router.add_get('/devtools/page/fixture', self.websocket)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]
        self.binding = SimpleNamespace(port=self.port, pid=42, started_at='fixture')
        self.installation = SimpleNamespace(modules={'primary': 'assets/primary.js', 'initial': 'assets/initial.js'})
        self.verifications = 0

    async def asyncTearDown(self):
        await self.runner.cleanup()

    def verify(self):
        self.verifications += 1
        return self.binding

    async def inventory(self, request):
        if self.redirect:
            raise self.web.HTTPFound('http://example.invalid/json/list')
        rows = self.payload if self.payload is not None else [{
            'id': 'fixture', 'type': 'page', 'url': 'app://-/index.html',
            'webSocketDebuggerUrl': f'ws://127.0.0.1:{self.port}/devtools/page/fixture'}]
        if not self.fragmented:
            return self.web.json_response(rows)
        response = self.web.StreamResponse(headers={'Content-Type': 'application/json'})
        await response.prepare(request)
        payload = json.dumps(rows).encode('utf-8')
        await response.write(payload[:10])
        await asyncio.sleep(.01)
        await response.write(payload[10:])
        await response.write_eof()
        return response

    async def websocket(self, request):
        if self.ws_redirect:
            raise self.web.HTTPFound('http://example.invalid/redirected')
        ws = self.web.WebSocketResponse()
        await ws.prepare(request)
        self.peers.append(ws)
        async for message in ws:
            value = message.json()
            self.commands.append(value)
            if value['method'] == 'Runtime.enable':
                await ws.send_json({'id': value['id'], 'result': {}})
            elif value['method'] == 'Runtime.evaluate':
                await ws.send_json({'id': value['id'], 'result': {'result': {'objectId': 'probe-function'}}})
            elif value['method'] == 'Runtime.callFunctionOn' and not self.silent:
                await ws.send_json({'method': 'Runtime.consoleAPICalled', 'params': {}})
                await ws.send_json({'id': value['id'], 'result': {'result': {'value': copy.deepcopy(self.reply)}}})
        return ws

    async def connect(self, **kwargs):
        return await ProbeConnection.connect(self.installation, self.binding, verify=self.verify, **kwargs)

    async def test_probe_is_structured_and_disconnect_never_closes_the_desktop(self):
        client = await self.connect()
        try:
            value = await client.snapshot()
            self.assertEqual(value['accountKey'], 'a' * 64)
            self.assertGreaterEqual(self.verifications, 3)
        finally:
            await client.close()
        self.assertEqual([r['method'] for r in self.commands],
                         ['Runtime.enable', 'Runtime.evaluate', 'Runtime.callFunctionOn'])
        self.assertTrue(self.peers[0].closed)

    async def test_account_change_and_non_primary_window_are_rejected(self):
        client = await self.connect()
        try:
            await client.snapshot()
            self.reply['accountKey'] = 'b' * 64
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot()
        finally:
            await client.close()
        self.reply['windowType'] = 'detached'
        client = await self.connect()
        try:
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot()
        finally:
            await client.close()

    async def test_process_change_after_connection_rejects_the_read(self):
        client = await self.connect()
        def changed():
            raise ValueError('process changed')
        client.verify = changed
        try:
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot()
        finally:
            await client.close()

    async def test_foreign_debugger_url_or_ambiguous_application_target_is_rejected(self):
        for rows in ([{'id': 'fixture', 'type': 'page', 'url': 'app://-/index.html',
                       'webSocketDebuggerUrl': 'ws://example.invalid/devtools/page/fixture'}],
                     [{'id': name, 'type': 'page', 'url': 'app://-/index.html',
                       'webSocketDebuggerUrl': f'ws://127.0.0.1:{self.port}/devtools/page/{name}'}
                      for name in ('fixture', 'second')]):
            with self.subTest(rows=rows):
                self.payload = rows
                with self.assertRaises(ProbeUnavailable):
                    await self.connect()
        self.assertEqual(self.commands, [])

    async def test_http_redirect_is_rejected_before_loading_any_target(self):
        self.redirect = True
        with self.assertRaises(ProbeUnavailable):
            await self.connect()
        self.assertEqual(self.commands, [])

    async def test_read_timeout_never_replays_a_command(self):
        client = await self.connect(timeout=.1)
        self.silent = True
        try:
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot()
        finally:
            await client.close()
        self.assertEqual(sum(r['method'] == 'Runtime.callFunctionOn' for r in self.commands), 1)

    async def test_websocket_redirect_is_rejected_without_changing_the_endpoint(self):
        self.ws_redirect = True
        with self.assertRaises(ProbeUnavailable):
            await self.connect()
        self.assertEqual(self.commands, [])

    async def test_window_reload_invalidates_the_connection_without_another_command(self):
        client = await self.connect()
        try:
            await self.peers[0].send_json({'method': 'Runtime.executionContextsCleared', 'params': {}})
            await asyncio.wait_for(client.reader, 1)
            before = len(self.commands)
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot()
            self.assertEqual(len(self.commands), before)
        finally:
            await client.close()

    async def test_unexpected_response_data_and_mismatched_chat_are_rejected(self):
        client = await self.connect()
        try:
            self.reply['privateBody'] = 'must not escape the connector'
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot()
            del self.reply['privateBody']
            self.reply['thread'] = {'id': 'another-chat', 'accountVerified': True}
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot('00000000-0000-4000-8000-000000000001', refresh=True)
        finally:
            await client.close()

    async def test_fresh_chat_metadata_matches_the_requested_server_id(self):
        identifier = '00000000-0000-4000-8000-000000000001'
        self.reply['thread'] = {'id': identifier, 'cachePresent': True, 'hasData': True,
                               'accountVerified': True, 'queryStatus': 'success', 'fetchStatus': 'idle',
                               'dataUpdatedAt': 100, 'updatedAt': 50}
        client = await self.connect()
        try:
            result = await client.snapshot(identifier, refresh=True)
            self.assertEqual(result['thread']['id'], identifier)
            with self.assertRaises(ProbeUnavailable):
                await client.snapshot(identifier, refresh=False)
        finally:
            await client.close()

    async def test_fragmented_target_inventory_is_read_to_completion(self):
        self.fragmented = True
        client = await self.connect()
        try:
            self.assertTrue((await client.snapshot())['scopeReady'])
        finally:
            await client.close()


if __name__ == '__main__':
    unittest.main()
