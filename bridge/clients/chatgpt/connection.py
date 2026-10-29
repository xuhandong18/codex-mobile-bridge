"""A fixed read-only renderer probe, not an arbitrary CDP/RPC proxy."""
import asyncio
import json
import math
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit


class ProbeUnavailable(ValueError):
    pass


def _target(rows, port, target_id):
    if not isinstance(rows, list):
        raise ProbeUnavailable('调试窗口列表格式无效')
    candidates = []
    for row in rows:
        if not isinstance(row, dict) or row.get('type') != 'page':
            continue
        url = urlsplit(row.get('url', ''))
        if url.scheme == 'app' and url.netloc == '-' and (target_id is None or row.get('id') == target_id):
            candidates.append(row)
    if len(candidates) != 1:
        raise ProbeUnavailable('无法确认唯一原应用窗口，请明确选择调试目标')
    row = candidates[0]
    identifier = row.get('id')
    ws = urlsplit(row.get('webSocketDebuggerUrl', ''))
    if (not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', identifier) or
            ws.scheme != 'ws' or ws.hostname != '127.0.0.1' or ws.port != port or
            ws.username is not None or ws.password is not None or ws.query or ws.fragment or
            ws.path != '/devtools/page/' + identifier):
        raise ProbeUnavailable('调试窗口不属于已核验的本机端口')
    return row['webSocketDebuggerUrl']


class ProbeConnection:
    def __init__(self, session, websocket, binding, installation, verify, timeout):
        self.session, self.websocket = session, websocket
        self.binding, self.installation, self.verify = binding, installation, verify
        self.timeout, self.pending, self.sequence = timeout, {}, 0
        self.account_key = self.function_id = None
        self.invalidated = False
        self.reader = asyncio.create_task(self._receive())

    @classmethod
    async def connect(cls, installation, binding, *, verify, target_id=None, timeout=10):
        try:
            import aiohttp
        except ImportError as exc:
            raise ProbeUnavailable('ChatGPT 接入需要项目已有的 aiohttp 依赖') from exc
        session = None
        client = None
        try:
            if verify() != binding:
                raise ProbeUnavailable('桌面进程身份已变化')
            trace = aiohttp.TraceConfig()
            async def reject_redirect(*args):
                raise ProbeUnavailable('调试连接拒绝重定向')
            trace.on_request_redirect.append(reject_redirect)
            session = aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=timeout),
                                            trace_configs=[trace])
            async with session.get(f'http://127.0.0.1:{binding.port}/json/list', allow_redirects=False) as response:
                if response.status != 200:
                    raise ProbeUnavailable('调试窗口读取失败或发生重定向')
                raw = bytearray()
                async for chunk in response.content.iter_chunked(16 * 1024):
                    raw.extend(chunk)
                    if len(raw) > 256 * 1024:
                        raise ProbeUnavailable('调试窗口列表过大')
                endpoint = _target(json.loads(raw), binding.port, target_id)
            websocket = await session.ws_connect(endpoint, max_msg_size=1024 * 1024)
            client = cls(session, websocket, binding, installation, verify, timeout)
            client._verify()
            await client._rpc('Runtime.enable', {})
            source = Path(__file__).with_name('probe.js').read_text(encoding='utf-8')
            result = await client._rpc('Runtime.evaluate', {'expression': source, 'returnByValue': False})
            client.function_id = result.get('result', {}).get('objectId')
            if result.get('exceptionDetails') or not isinstance(client.function_id, str):
                raise ProbeUnavailable('原窗口不接受受限读取探针')
            return client
        except BaseException as exc:
            if client is not None:
                await client.close()
            elif session is not None:
                await session.close()
            if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                raise
            if isinstance(exc, ProbeUnavailable):
                raise
            raise ProbeUnavailable('无法连接已核验的 ChatGPT 调试窗口') from exc

    def _verify(self):
        try:
            if self.verify() != self.binding:
                raise ValueError('changed process')
        except Exception as exc:
            raise ProbeUnavailable('桌面进程或调试监听身份已变化') from exc

    async def _receive(self):
        try:
            async for message in self.websocket:
                if message.type.name != 'TEXT':
                    break
                value = json.loads(message.data)
                if value.get('method') in ('Runtime.executionContextsCleared', 'Inspector.detached'):
                    break
                future = self.pending.get(value.get('id'))
                if future is not None and not future.done():
                    future.set_result(value)
        except (OSError, ValueError, TypeError, asyncio.CancelledError):
            pass
        finally:
            self.invalidated = True
            for future in list(self.pending.values()):
                if not future.done():
                    future.set_exception(ProbeUnavailable('原窗口连接已断开；没有重放请求'))

    async def _rpc(self, method, params):
        # All callers are fixed below; no HTTP endpoint accepts method or script.
        if self.invalidated or self.reader.done() or self.websocket.closed:
            raise ProbeUnavailable('原窗口连接已失效，请重新核验；没有重放请求')
        self.sequence += 1
        identifier = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        try:
            await self.websocket.send_json({'id': identifier, 'method': method, 'params': params})
            value = await asyncio.wait_for(future, self.timeout)
            if value.get('error') or not isinstance(value.get('result'), dict):
                raise ProbeUnavailable('原窗口未完成受限读取请求')
            return value['result']
        except (OSError, asyncio.TimeoutError) as exc:
            raise ProbeUnavailable('原窗口读取超时或断开；没有重放请求') from exc
        finally:
            self.pending.pop(identifier, None)

    async def snapshot(self, thread_id=None, *, refresh=False):
        if thread_id is not None:
            try:
                if str(uuid.UUID(thread_id)) != thread_id:
                    raise ValueError('noncanonical id')
            except (ValueError, TypeError, AttributeError) as exc:
                raise ProbeUnavailable('只读探针需要有效的 ChatGPT 服务端聊天 ID') from exc
        if type(refresh) is not bool or refresh and thread_id is None:
            raise ProbeUnavailable('刷新必须指定有效聊天')
        self._verify()
        result = await self._rpc('Runtime.callFunctionOn', {
            'objectId': self.function_id,
            'functionDeclaration': 'async function(request) { return await this(request); }',
            'arguments': [{'value': {'modules': dict(self.installation.modules),
                                     'threadId': thread_id, 'refresh': refresh}}],
            'returnByValue': True, 'awaitPromise': True})
        self._verify()
        value = result.get('result', {}).get('value')
        if (result.get('exceptionDetails') or not isinstance(value, dict) or
                set(value) != {'protocolVersion', 'windowType', 'scopeReady', 'mutationVerified',
                               'accountKey', 'route', 'thread'} or
                value.get('protocolVersion') != 1 or value.get('windowType') != 'primary' or
                value.get('scopeReady') is not True or value.get('mutationVerified') is not False or
                not isinstance(value.get('accountKey'), str) or not re.fullmatch(r'[0-9a-f]{64}', value['accountKey'])):
            raise ProbeUnavailable('原窗口上下文、账号身份或探针响应尚未核验')
        if value['route'] is not None and (not isinstance(value['route'], str) or len(value['route']) > 4096):
            raise ProbeUnavailable('原窗口路由格式尚未核验')
        thread = value['thread']
        if thread_id is None:
            if thread is not None:
                raise ProbeUnavailable('探针返回了未请求的聊天')
        else:
            if (not isinstance(thread, dict) or set(thread) != {
                    'id', 'cachePresent', 'hasData', 'accountVerified', 'queryStatus',
                    'fetchStatus', 'dataUpdatedAt', 'updatedAt'} or thread['id'] != thread_id or
                    any(type(thread[key]) is not bool for key in ('cachePresent', 'hasData', 'accountVerified')) or
                    thread['queryStatus'] not in (None, 'pending', 'error', 'success') or
                    thread['fetchStatus'] not in (None, 'idle', 'fetching', 'paused') or
                    any(thread[key] is not None and (type(thread[key]) not in (int, float) or
                        not math.isfinite(thread[key]) or thread[key] < 0) for key in ('dataUpdatedAt', 'updatedAt')) or
                    thread['accountVerified'] and (not refresh or not thread['hasData'] or thread['queryStatus'] != 'success')):
                raise ProbeUnavailable('目标聊天身份或读取状态尚未核验')
        if self.account_key is not None and self.account_key != value['accountKey']:
            raise ProbeUnavailable('当前 ChatGPT 账号已变化，请重新连接')
        self.account_key = value['accountKey']
        return value

    async def close(self):
        # Closing a WebSocket is deliberately the only desktop-related cleanup.
        # Never send Browser.close, Target.closeTarget or terminateExecution.
        try:
            await self.websocket.close()
        finally:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
            await self.session.close()
