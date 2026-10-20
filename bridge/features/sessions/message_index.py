"""Read-only rollout navigation; summaries and seek checkpoints, never full history.

The scanner and window reader deliberately use only the standard library so the
same source can run through the existing, non-installed SSH reader.
"""
import base64
import bisect
import hashlib
import hmac
import json
import os
import threading
import uuid
from collections import OrderedDict

MAX_RECORD = 16 * 1024 * 1024
CHECKPOINT_EVERY = 32


def _digest(value):
    return hashlib.sha256(value).hexdigest()


def _identity(stat):
    return [stat.st_dev, stat.st_ino]


def _guard(stream, offset):
    first = min(offset, 4096)
    stream.seek(0)
    head = _digest(stream.read(first))
    tail = min(offset, 4096)
    stream.seek(offset-tail)
    return {'length': offset, 'headLength': first, 'head': head, 'tailLength': tail, 'tail': _digest(stream.read(tail))}


def _matches(stream, checkpoint):
    stat = os.fstat(stream.fileno())
    if _identity(stat) != checkpoint['identity'] or stat.st_size < checkpoint['size']:
        return False
    if stat.st_size == checkpoint['size'] and stat.st_mtime_ns != checkpoint['mtime']:
        return False
    old = checkpoint['guard']
    stream.seek(0)
    if _digest(stream.read(old['headLength'])) != old['head']:
        return False
    stream.seek(old['length']-old['tailLength'])
    return _digest(stream.read(old['tailLength'])) == old['tail']


def _line(stream):
    raw = stream.readline(MAX_RECORD+1)
    if len(raw) > MAX_RECORD:
        raise ValueError('单条会话记录过大，暂时无法整理消息目录')
    return raw


def _item(record, ordinal):
    payload = record.get('payload', {})
    if record.get('type') == 'event_msg' and payload.get('type') == 'item_completed':
        item = payload.get('item', {})
        return dict(item, id=item.get('id', str(ordinal))) if item.get('type') in ('ImageView', 'imageView') else None
    if record.get('type') != 'response_item':
        return None
    kind = payload.get('type')
    if kind == 'message' and payload.get('role') in ('user', 'assistant'):
        if payload['role'] == 'user':
            return {'id': str(ordinal), 'type': 'userMessage', 'content': payload.get('content', []),
                    **{k: payload[k] for k in ('clientId', 'client_id', 'clientUserMessageId') if payload.get(k)}}
        return {'id': str(ordinal), 'type': 'agentMessage', 'phase': payload.get('phase'),
                'text': '\n'.join(x.get('text', '') for x in payload.get('content', []) if isinstance(x, dict))}
    if kind in ('userMessage', 'steeringUserMessage'):
        if kind == 'steeringUserMessage' and payload.get('status') != 'accepted':
            return None
        return dict(payload, id=payload.get('id', str(ordinal)))
    if kind in ('agent_message', 'agentMessage'):
        return dict(payload, id=payload.get('id', str(ordinal)), type='agentMessage')
    if kind == 'reasoning':
        return {'id': payload.get('id') or str(ordinal), 'type': 'reasoning', 'summary': payload.get('summary') or []}
    if kind in ('function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output'):
        return {'id': payload.get('call_id', str(ordinal)), **payload}
    return None


def _context(record, context):
    payload = record.get('payload', {})
    if record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
        context.update(turnId=payload.get('turn_id') or 'history', itemId=0, user=0, params={})
    elif record.get('type') == 'turn_context':
        settings = (payload.get('collaboration_mode') or {}).get('settings') or {}
        context['params'] = {'model': payload.get('model') or settings.get('model'),
                             'effort': payload.get('effort') or settings.get('reasoning_effort')}


def _anchor(thread_id, revision, offset, raw):
    return _digest(json.dumps([thread_id, revision, offset, _digest(raw)], separators=(',', ':')).encode())[:40]


def scan_rollout(path, thread_id, previous=None, summarize=None):
    with open(path, 'rb') as stream:
        stat = os.fstat(stream.fileno())
        reset = previous is None or not _matches(stream, previous)
        context = {'turnId': 'history', 'itemId': 0, 'user': 0, 'params': {}} if reset else dict(previous['context'])
        offset, count = (0, 0) if reset else (previous['offset'], previous['count'])
        revision = uuid.uuid4().hex if reset else previous['revision']
        stream.seek(offset)
        entries, points, statuses = [], [], {}
        while stream.tell() < stat.st_size:
            begin = stream.tell()
            raw = _line(stream)
            if not raw.endswith(b'\n'):
                break  # A writer may still be finishing the final JSON record.
            try:
                record = json.loads(raw)
            except (ValueError, UnicodeDecodeError) as exc:
                raise ValueError('消息目录中的记录无法读取，请重试') from exc
            if record.get('type') == 'session_meta' and record.get('payload', {}).get('id') != thread_id:
                raise ValueError('会话记录不属于这个聊天，请刷新列表')
            _context(record, context)
            payload = record.get('payload', {})
            if record.get('type') == 'event_msg' and payload.get('type') == 'task_started':
                statuses[context['turnId']] = 'inProgress'
            if record.get('type') == 'event_msg' and payload.get('type') in ('task_complete', 'turn_aborted'):
                statuses[context['turnId']] = 'completed' if payload['type'] == 'task_complete' else 'interrupted'
            item = _item(record, context['itemId'])
            if item is not None:
                if count % CHECKPOINT_EVERY == 0:
                    points.append({'offset': begin, 'item': count, **context})
                if item['type'] in ('userMessage', 'steeringUserMessage'):
                    row = summarize(item) if summarize else {}
                    text = row.get('text') or ''
                    content = item.get('content', item.get('input', []))
                    attachments = row.get('attachments') or (content if isinstance(content, list) else [])
                    names = [str(x.get('name') or x.get('path') or x.get('type') or '').replace('\\', '/').rsplit('/', 1)[-1]
                             for x in attachments if isinstance(x, dict)]
                    summary = ' '.join(text.split())[:100] or '、'.join(n for n in names if n)[:100] or '消息'
                    base = _digest(json.dumps([context['turnId'], item['id'], item['type']], ensure_ascii=False, separators=(',', ':')).encode())[:24]
                    entries.append({'id': _anchor(thread_id, revision, begin, raw), 'turnId': context['turnId'],
                                    'rowKey': base+'-0', 'summary': summary, 'requestId': row.get('requestId'),
                                    'messageId': item['id'], 'kind': item['type'], 'isUserContext': row.get('isUserContext', False),
                                    'offset': begin, 'digest': _digest(raw), 'item': count})
                    context['user'] += 1
                context['itemId'] += 1
                count += 1
            offset = stream.tell()
        checkpoint = {'revision': revision, 'identity': _identity(stat), 'size': stat.st_size, 'mtime': stat.st_mtime_ns,
                      'offset': offset, 'count': count, 'context': context, 'guard': _guard(stream, offset)}
        return {'reset': reset, 'checkpoint': checkpoint, 'entries': entries, 'points': points, 'statuses': statuses}


def read_window(path, thread_id, point, start, limit):
    checkpoint = point['source']
    with open(path, 'rb') as stream:
        if not _matches(stream, checkpoint):
            raise ValueError('会话记录已变化，请刷新消息目录')
        expected = point.get('expected')
        if expected:
            stream.seek(expected['offset'])
            if _digest(_line(stream)) != expected['digest']:
                raise ValueError('这条消息已变化，请刷新消息目录')
        context = {k: point[k] for k in ('turnId', 'itemId', 'user', 'params')}
        stream.seek(point['offset'])
        count, end = point['item'], min(checkpoint['count'], start+limit)
        turns, current = [], None
        while count < end and stream.tell() < checkpoint['offset']:
            begin = stream.tell()
            raw = _line(stream)
            record = json.loads(raw)
            _context(record, context)
            item = _item(record, context['itemId'])
            if item is None:
                continue
            if count >= start:
                if current is None or current['turnId'] != context['turnId']:
                    current = {'turnId': context['turnId'], 'status': 'completed', 'actionable': False,
                               'params': context['params'], 'items': []}
                    turns.append(current)
                if item['type'] in ('userMessage', 'steeringUserMessage'):
                    item['navigationId'] = _anchor(thread_id, checkpoint['revision'], begin, raw)
                item['navigationPosition'] = count
                current['items'].append(item)
            context['itemId'] += 1
            count += 1
        return {'start': start, 'end': count, 'state': {'id': thread_id, 'turns': turns, 'requests': [],
                'threadRuntimeStatus': {'type': 'notLoaded'}, 'turnsPagination': {'hasLoadedOldest': start == 0}}}


class MessageNavigation:
    """Per-host cache, also usable with the selected host's SSH scan callbacks."""
    def __init__(self, scan, window):
        self.scan, self.read_window = scan, window
        self.cache, self.lock, self.secret = OrderedDict(), threading.RLock(), os.urandom(32)

    def _refresh(self, identifier):
        value = self.cache.get(identifier)
        delta = self.scan(identifier, value['checkpoint'] if value else None)
        if value is None or delta['reset']:
            value = {'entries': [], 'points': [], 'statuses': {}}
        value['entries'].extend(delta['entries'])
        value['points'].extend(delta['points'])
        value['statuses'].update(delta['statuses'])
        value['checkpoint'] = delta['checkpoint']
        self.cache[identifier] = value
        self.cache.move_to_end(identifier)
        while len(self.cache) > 8:
            self.cache.popitem(last=False)
        return value

    def _token(self, identifier, revision, position, kind):
        data = base64.urlsafe_b64encode(json.dumps([identifier, revision, position, kind], separators=(',', ':')).encode()).decode().rstrip('=')
        return 'nav.'+data+'.'+hmac.new(self.secret, data.encode(), hashlib.sha256).hexdigest()[:32]

    def _position(self, token, identifier, revision, kind):
        try:
            if len(token) > 2048:
                raise ValueError()
            prefix, data, signature = token.split('.')
            expected = hmac.new(self.secret, data.encode(), hashlib.sha256).hexdigest()[:32]
            if prefix != 'nav' or not hmac.compare_digest(signature, expected):
                raise ValueError()
            tid, rev, position, actual_kind = json.loads(base64.urlsafe_b64decode(data+'='*(-len(data)%4)))
            if tid != identifier or rev != revision or actual_kind != kind or type(position) is not int or position < 0:
                raise ValueError()
            return position
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError('消息目录已变化，请重新读取') from exc

    def page(self, identifier, cursor=None, limit=200, excluded=(), since=None):
        with self.lock:
            value = self._refresh(identifier) if since or not cursor or identifier not in self.cache else self.cache[identifier]
            revision = value['checkpoint']['revision']
            reset = False
            try:
                position = self._position(cursor or since, identifier, revision, 'index') if cursor or since else 0
            except ValueError:
                if not since:
                    raise
                position, reset = 0, True
            entries = [entry for entry in value['entries'] if not entry.get('isUserContext') and entry.get('requestId') not in excluded]
            if position > len(entries):
                position, reset = 0, True
            end = min(len(entries), position+max(1, min(200, limit)))
            fields = ('id', 'turnId', 'rowKey', 'summary')
            return {'revision': revision, 'status': 'ready', 'complete': True, 'total': len(entries), 'reset': reset,
                    'items': [{**{k: entry[k] for k in fields}, 'order': i} for i, entry in enumerate(entries[position:end], position)],
                    'nextCursor': self._token(identifier, revision, end, 'index') if end < len(entries) else None,
                    'tailCursor': self._token(identifier, revision, end, 'index')}

    def window(self, identifier, around=None, before=None, after=None, limit=100, excluded=()):
        with self.lock:
            if sum(bool(v) for v in (around, before, after)) != 1:
                raise ValueError('请选择有效的消息位置')
            value = self._refresh(identifier)
            source = value['checkpoint']
            limit = max(1, min(100, limit))
            expected = None
            if around:
                expected = next((entry for entry in value['entries'] if entry['id'] == around), None)
                if expected is None:
                    raise ValueError('这条消息已变化，请刷新消息目录')
                start = max(0, expected['item']-min(10, limit//3))
            else:
                position = self._position(before or after, identifier, source['revision'], 'window')
                start = max(0, position-limit) if before else position
                if before:
                    limit = position-start
            if start > source['count'] or not value['points']:
                raise ValueError('消息位置已失效，请刷新目录')
            positions = [point['item'] for point in value['points']]
            point = {**value['points'][max(0, bisect.bisect_right(positions, start)-1)], 'source': source}
            if expected:
                point['expected'] = expected
            try:
                result = self.read_window(identifier, point, start, limit)
            except ValueError:
                # A middle record can change while the append guards still
                # match. Force the next directory read to verify it all again.
                self.cache.pop(identifier, None)
                raise
            users = [entry for entry in value['entries'] if not entry.get('isUserContext') and entry.get('requestId') not in excluded]
            first_users = {}
            for entry in users:
                if entry['kind'] == 'userMessage':
                    first_users.setdefault(entry['turnId'], entry['messageId'])
            for turn in result['state']['turns']:
                turn['status'] = value['statuses'].get(turn['turnId'], turn['status'])
                turn['firstUserMessageId'] = first_users.get(turn['turnId'])
                turn['actionable'] = turn['turnId'] != 'history'
            result.update(revision=source['revision'], before=self._token(identifier, source['revision'], start, 'window') if start else None,
                          after=self._token(identifier, source['revision'], result['end'], 'window') if result['end'] < source['count'] else None,
                          latestUserTurnId=users[-1]['turnId'] if users else None,
                          targetId=around, navigationWindow=True)
            return result

    def range_cursors(self, identifier, revision, start, end):
        with self.lock:
            value = self.cache.get(identifier)
            if value is None or value['checkpoint']['revision'] != revision:
                raise ValueError('消息目录已变化，请重新读取')
            return {'before': self._token(identifier, revision, start, 'window') if start else None,
                    'after': self._token(identifier, revision, end, 'window') if end < value['checkpoint']['count'] else None}
