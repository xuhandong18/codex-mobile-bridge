"""Read-only discovery and history for existing Codex chats."""
import copy
import os
import re
import threading
from collections import OrderedDict
import json
import logging
import shutil
import sqlite3
import tempfile
from contextlib import closing, contextmanager, ExitStack
from pathlib import Path


class StoreUnavailable(RuntimeError):
    pass


class SessionStore:
    DESKTOP_ORIGINATORS = ('Codex Desktop', 'codex_work_desktop', 'codex_mobile_bridge')

    def __init__(self, codex_home, navigation_source=None):
        self.home = Path(codex_home).resolve()
        self.history_cache = OrderedDict()
        self.history_lock = threading.Lock()
        self.navigation_source = navigation_source

    def _navigation_source(self):
        if self.navigation_source is None:
            from types import SimpleNamespace
            from bridge.features.sessions.message_index import scan_rollout, read_window
            from bridge.features.sessions.model import normalize_item
            self.navigation_source = SimpleNamespace(scan=scan_rollout, window=read_window, summarize=normalize_item)
        return self.navigation_source

    def _navigation_path(self, thread_id):
        resolved = Path(self.get(thread_id)['rollout_path']).resolve()
        if not self._rollout_in_home(resolved):
            raise ValueError('会话记录路径不在 Codex 数据目录中')
        return resolved

    def navigation_scan(self, thread_id, checkpoint=None):
        source = self._navigation_source()
        try:
            return source.scan(self._navigation_path(thread_id), thread_id, checkpoint, source.summarize)
        except PermissionError as exc:
            raise PermissionError('无权读取此聊天的消息目录') from exc
        except OSError as exc:
            raise ValueError('会话记录暂不可用，请刷新目录后重试') from exc

    def navigation_window(self, thread_id, point, start, limit):
        try:
            return self._navigation_source().window(self._navigation_path(thread_id), thread_id, point, start, limit)
        except PermissionError as exc:
            raise PermissionError('无权读取此聊天的历史内容') from exc
        except OSError as exc:
            raise ValueError('会话记录暂不可用，请刷新目录后重试') from exc

    def message_times(self, thread_id, checkpoint=None):
        """Read native item start metadata without exposing event bodies.

        Start with a bounded tail, then follow complete lines incrementally.
        The checkpoint is internal read state, never a browser-supplied path.
        """
        path = self._navigation_path(thread_id)
        checkpoint = checkpoint or {}
        with path.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            prefix = stream.read(min(512, stat.st_size))
            previous_prefix = bytes.fromhex(checkpoint.get('prefix', ''))
            reset = (checkpoint.get('path') != str(path) or checkpoint.get('inode') != stat.st_ino
                     or stat.st_size < checkpoint.get('offset', 0)
                     or not prefix.startswith(previous_prefix)
                     or stat.st_size == checkpoint.get('size') and stat.st_mtime_ns != checkpoint.get('mtime'))
            tail = max(0, stat.st_size - 4 * 1024 * 1024)
            offset = tail if reset else max(tail, checkpoint['offset'])
            stream.seek(offset)
            if offset and (reset or offset != checkpoint['offset']):
                stream.readline()
            times = {}
            scanned = 0
            while stream.tell() < stat.st_size and scanned < 4 * 1024 * 1024:
                begin = stream.tell()
                raw = stream.readline(4 * 1024 * 1024 + 1)
                scanned += len(raw)
                if not raw.endswith(b'\n'):
                    # Leave an incomplete tail for the next read. Skip oversized
                    # records, whose payload is never needed by the time reader.
                    if len(raw) > 4 * 1024 * 1024:
                        stream.readline()
                    else:
                        stream.seek(begin)
                    break
                try:
                    record = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    continue
                payload = record.get('payload') or {}
                if record.get('type') == 'event_msg' and payload.get('type') == 'item_completed':
                    item = payload.get('item') or {}
                    if item.get('id') and payload.get('started_at_ms') is not None:
                        times[item['id']] = payload['started_at_ms']
            return {'reset': reset, 'times': times, 'checkpoint': {
                'path': str(path), 'inode': stat.st_ino, 'size': stat.st_size, 'mtime': stat.st_mtime_ns,
                'offset': stream.tell(), 'prefix': prefix.hex()}}

    @contextmanager
    def _connect(self):
        database = None
        try:
            databases = sorted(self.home.glob("state_*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not databases:
                raise StoreUnavailable("暂时找不到 Codex 会话数据库，请打开电脑 Codex 后重试。")
            database = databases[0]
            with ExitStack() as stack:
                target = database
                wal = Path(str(database) + '-wal')
                with database.open('rb') as source:
                    wal_mode = source.read(20)[18:20] == b'\x02\x02'
                if wal_mode and not wal.exists():
                    # macOS SQLite can fail on a read-only WAL database with no
                    # sidecars. Read a stable, private copy; never initialize or
                    # mark the live database immutable, which would miss WAL data.
                    def fingerprint():
                        stat = database.stat()
                        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
                    before = fingerprint()
                    folder = stack.enter_context(tempfile.TemporaryDirectory(prefix='codex-mobile-history-'))
                    target = Path(folder) / 'history.sqlite'
                    if wal.exists():
                        raise StoreUnavailable("Codex 会话数据库正在更新，请稍后重试。")
                    shutil.copyfile(database, target)
                    if wal.exists() or fingerprint() != before:
                        raise StoreUnavailable("Codex 会话数据库正在更新，请稍后重试。")
                mode = 'ro' if target == database else 'rw'
                conn = stack.enter_context(closing(sqlite3.connect(target.as_uri() + '?mode=' + mode, uri=True, timeout=3)))
                conn.row_factory = sqlite3.Row
                yield conn
        except (OSError, sqlite3.Error) as exc:
            logging.getLogger(__name__).warning('Session database read failed: database=%s sqlite=%s wal=%s shm=%s error=%s',
                database, getattr(exc, 'sqlite_errorname', type(exc).__name__),
                bool(database and Path(str(database) + '-wal').exists()),
                bool(database and Path(str(database) + '-shm').exists()), exc)
            raise StoreUnavailable("暂时无法读取 Codex 会话数据库，请稍后重试或重新打开电脑 Codex。") from exc

    def list(self, query="", limit=100, offset=0, archived=False, source='all', ids=None):
        if source not in ('all', 'desktop', 'cli'):
            raise ValueError('不支持的会话来源')
        if ids is not None:
            if not isinstance(ids, list) or not 1 <= len(ids) <= 50 or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f-]{36}', value) for value in ids):
                raise ValueError('会话标识列表无效')
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute("PRAGMA table_info(threads)")}
            fields = [name for name in ("id", "name", "title", "first_user_message", "cwd", "updated_at", "updated_at_ms", "recency_at", "recency_at_ms", "model_provider", "model", "originator", "source", "archived", "is_pinned", "thread_section_id", "section_position", "project_id") if name in columns]
            where = ["archived = ?"]
            params = [int(archived)]
            where.append(self._user_origin_filter(columns))
            if ids is not None:
                where.append('id IN (' + ','.join('?' for _ in ids) + ')')
                params.extend(ids)
            if "thread_source" in columns:
                where.append("COALESCE(thread_source, '') != 'subagent'")
            if "source" in columns:
                where.append("COALESCE(source, '') NOT LIKE '%\"subagent\"%'")
            if source != 'all':
                where.append(self._source_filter(columns, source))
            if query:
                search_fields = [name for name in ("name", "title", "cwd") if name in columns]
                where.append("(" + " OR ".join(name + " LIKE ?" for name in search_fields) + ")")
                params += ["%" + query + "%"] * len(search_fields)
            recency = "COALESCE(recency_at_ms, recency_at * 1000, updated_at * 1000)" if "recency_at_ms" in columns else "COALESCE(recency_at, updated_at)" if "recency_at" in columns else "updated_at"
            rows = conn.execute("SELECT " + ",".join(fields) + " FROM threads WHERE " + " AND ".join(where) + " ORDER BY " + recency + " DESC, id DESC LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
            return [dict(row, origin=self._origin(dict(row))) for row in rows]

    def available_sources(self):
        """Original sources across the complete visible inventory, independent of list filters."""
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute("PRAGMA table_info(threads)")}
            where = [self._user_origin_filter(columns)]
            if 'thread_source' in columns:
                where.append("COALESCE(thread_source, '') != 'subagent'")
            if 'source' in columns:
                where.append("COALESCE(source, '') NOT LIKE '%\"subagent\"%'")
            fields = [name for name in ('originator', 'source') if name in columns]
            if not fields:
                return []
            rows = conn.execute('SELECT DISTINCT ' + ','.join(fields) + ' FROM threads WHERE ' + ' AND '.join(where)).fetchall()
            return sorted({self._origin(dict(row)) for row in rows})

    @staticmethod
    def _source_filter(columns, source):
        if source == 'desktop':
            originators = "originator IN ('Codex Desktop', 'codex_work_desktop', 'codex_mobile_bridge')" if 'originator' in columns else '0'
            legacy = "(originator IS NULL AND source = 'vscode')" if 'originator' in columns and 'source' in columns else "source = 'vscode'" if 'source' in columns else '0'
            return '(' + originators + ' OR ' + legacy + ')'
        originators = "originator IN ('codex-tui', 'codex_cli_rs', 'codex-mobile-bridge-cli')" if 'originator' in columns else '0'
        legacy = "(originator IS NULL AND source = 'cli')" if 'originator' in columns and 'source' in columns else "source = 'cli'" if 'source' in columns else '0'
        return '(' + originators + ' OR ' + legacy + ')'

    @staticmethod
    def _user_origin_filter(columns):
        if 'originator' in columns:
            recognized = "originator IN ('Codex Desktop', 'codex_work_desktop', 'codex_mobile_bridge', 'codex-tui', 'codex_cli_rs', 'codex-mobile-bridge-cli')"
            if 'source' in columns:
                return '(' + recognized + " OR (originator IS NULL AND source IN ('vscode', 'cli')))"
            return recognized
        return "source IN ('vscode', 'cli')" if 'source' in columns else '0'

    @classmethod
    def _origin(cls, row):
        if row.get('thread_source') == 'subagent' or '"subagent"' in (row.get('source') or ''):
            return 'subagent'
        if row.get('originator') in cls.DESKTOP_ORIGINATORS or (row.get('originator') is None and row.get('source') == 'vscode'):
            return 'desktop'
        if row.get('originator') in ('codex-tui', 'codex_cli_rs', 'codex-mobile-bridge-cli') or (row.get('originator') is None and row.get('source') == 'cli'):
            return 'cli'
        return 'other'

    def notification_changes(self, since=0):
        """Only metadata changed since discovery; never read rollout history."""
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(threads)')}
            clocks = [name + ('' if name.endswith('_ms') else ' * 1000')
                      for name in ('updated_at', 'updated_at_ms', 'recency_at', 'recency_at_ms') if name in columns]
            clock = 'MAX(' + ','.join('COALESCE(' + c + ',0)' for c in clocks) + ',0)'
            owner = self._user_origin_filter(columns)
            filters = [owner, clock + ' >= ?']
            if 'thread_source' in columns:
                filters.append("COALESCE(thread_source, '') != 'subagent'")
            if 'source' in columns:
                filters.append("COALESCE(source, '') NOT LIKE '%\"subagent\"%'")
            return [dict(row) for row in conn.execute('SELECT id, ' + clock +
                    ' AS changed_at FROM threads WHERE ' + ' AND '.join(filters), (since,))]

    def lifecycle_threads(self):
        """Desktop roots and their complete agent subtree, using metadata only."""
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(threads)')}
            fields = [name for name in ('id', 'originator', 'source') if name in columns]
            rows = [dict(row) for row in conn.execute('SELECT ' + ','.join(fields) + ' FROM threads')]
        desktop = {row['id'] for row in rows if 'originator' not in columns
                   or row.get('originator') in ('Codex Desktop', 'codex_work_desktop', 'codex_mobile_bridge')
                   or (row.get('originator') is None and row.get('source') == 'vscode')}
        children = {}
        for row in rows:
            parent = self._agent_source(row).get('parent_thread_id')
            if isinstance(parent, str):
                children.setdefault(parent, []).append(row['id'])
        pending = list(desktop)
        while pending:
            for child in children.get(pending.pop(), []):
                if child not in desktop:
                    desktop.add(child)
                    pending.append(child)
        return [{'id': identifier} for identifier in sorted(desktop)]

    def recencies(self, identifiers):
        if not identifiers:
            return {}
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(threads)')}
            fields = [name for name in ('recency_at_ms', 'recency_at', 'updated_at_ms', 'updated_at') if name in columns]
            rows = conn.execute('SELECT id,' + ','.join(fields) + ' FROM threads WHERE id IN (' + ','.join('?' for _ in identifiers) + ')', identifiers)
            return {r['id']: next((r[k] * (1 if k.endswith('_ms') else 1000) for k in fields if r[k]), 0) for r in rows}

    def get(self, thread_id):
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)).fetchone()
            if not row:
                raise KeyError("找不到这个 Codex 会话")
            result = dict(row)
            origin = self._origin(result)
            if origin not in ('desktop', 'cli'):
                raise KeyError("不是可访问的 Codex 会话")
            result['origin'] = origin
            return result

    def _rollout_in_home(self, resolved):
        for base in (self.home / 'sessions', self.home / 'archived_sessions'):
            root = base.resolve()
            if root in resolved.parents:
                return True
            if os.name == 'nt':
                # Native Windows metadata may use \\?\ paths while CODEX_HOME
                # uses a drive path. Compare actual directories only in that case.
                for parent in resolved.parents:
                    try:
                        if root.samefile(parent):
                            return True
                    except OSError:
                        continue
        return False

    def record_path(self, thread_id):
        metadata = self.get(thread_id)
        path = Path(metadata['rollout_path']).resolve()
        if not self._rollout_in_home(path):
            raise ValueError('会话记录路径不在 Codex 数据目录中')
        if not path.is_file():
            raise ValueError('会话记录文件不存在，请刷新列表后重试')
        return str(path)

    def discovery_diagnostics(self, thread_id=None):
        """Return aggregate source and read status, never chat content or private paths."""
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(threads)')}
            fields = [name for name in ('id', 'originator', 'source', 'thread_source', 'archived', 'rollout_path') if name in columns]
            rows = [dict(row) for row in conn.execute('SELECT ' + ','.join(fields) + ' FROM threads')]
        counts = {'desktop': 0, 'cli': 0, 'other': 0, 'subagent': 0, 'visible': 0, 'archived': 0}
        target = None
        for row in rows:
            origin = self._origin(row)
            counts[origin] += 1
            if row.get('archived'):
                counts['archived'] += 1
            elif origin in ('desktop', 'cli'):
                counts['visible'] += 1
            if thread_id is not None and row['id'] == thread_id:
                target = row
        result = {'status': 'ok', 'phase': 'discovery', 'homeSource': 'provided', 'counts': counts,
                  'schema': {'originator': 'originator' in columns, 'source': 'source' in columns,
                             'threadSource': 'thread_source' in columns, 'rolloutPath': 'rollout_path' in columns}}
        if thread_id is not None:
            if target is None:
                result['target'] = {'found': False, 'origin': None, 'archived': None,
                                    'reason': 'missing', 'read': 'unavailable'}
            else:
                origin = self._origin(target)
                reason = 'subagent' if origin == 'subagent' else 'unsupported_origin' if origin == 'other' else 'readable'
                if reason == 'readable':
                    path = target.get('rollout_path')
                    if not path:
                        reason = 'rollout_missing'
                    else:
                        resolved = Path(path).resolve()
                        if not self._rollout_in_home(resolved):
                            reason = 'rollout_outside_home'
                        elif not resolved.is_file():
                            reason = 'rollout_missing'
                        else:
                            try:
                                with resolved.open('rb') as stream:
                                    stream.read(1)
                            except OSError:
                                reason = 'rollout_unreadable'
                result['target'] = {'found': True, 'origin': origin, 'archived': bool(target.get('archived')), 'reason': reason,
                                    'read': 'ready' if reason == 'readable' else 'unavailable'}
        return result

    @staticmethod
    def _recent_lines(path, turn_limit):
        """Read complete turns backwards without parsing the older rollout prefix."""
        if turn_limit is None:
            return path.read_bytes(), True
        with path.open('rb') as stream:
            stream.seek(0, 2)
            position = stream.tell()
            parts, pending, starts = [], b'', 0
            while position:
                size = min(position, 65536)
                position -= size
                stream.seek(position)
                chunk = stream.read(size) + pending
                lines = chunk.splitlines(keepends=True)
                pending = lines.pop(0) if position else b''
                for line in reversed(lines):
                    parts.append(line)
                    if b'"task_started"' not in line:
                        continue
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if record.get('type') == 'event_msg' and record.get('payload', {}).get('type') == 'task_started':
                        starts += 1
                        if starts >= turn_limit:
                            return b''.join(reversed(parts)), position == 0 and len(parts) == len(lines)
            return b''.join(reversed(parts)), True

    def history(self, thread_id, turn_limit=None):
        return self._history(thread_id, self.get(thread_id), turn_limit)

    @staticmethod
    def _agent_source(meta):
        try:
            source = json.loads(meta.get('source') or '{}')
            spawn = source.get('subagent', {}).get('thread_spawn', {})
            return spawn if isinstance(spawn, dict) else {}
        except (ValueError, AttributeError):
            return {}

    def subagents(self, thread_id):
        self.get(thread_id)  # Only a desktop parent can authorize this subtree.
        result, pending, seen = [], [thread_id], {thread_id}
        with self._connect() as conn:
            while pending and len(result) < 128:
                parent = pending.pop(0)
                rows = conn.execute("SELECT * FROM threads WHERE source LIKE ? ORDER BY updated_at DESC LIMIT 129", ('%' + parent + '%',))
                for row in rows:
                    meta = dict(row); spawn = self._agent_source(meta)
                    if spawn.get('parent_thread_id') != parent or meta['id'] in seen: continue
                    seen.add(meta['id']); pending.append(meta['id'])
                    result.append({'id': meta['id'], 'parentId': parent,
                                   'title': meta.get('name') or meta.get('title') or '子智能体',
                                   'nickname': meta.get('agent_nickname') or spawn.get('agent_nickname'),
                                   'role': meta.get('agent_role') or spawn.get('agent_role'),
                                   'path': meta.get('agent_path') or spawn.get('agent_path'),
                                   'updated': meta.get('updated_at'), 'archived': bool(meta.get('archived'))})
                    if len(result) >= 128: break
        return {'agents': result, 'limited': len(result) >= 128}

    def activity_tree(self, identifiers):
        """Authorize roots and discover descendants in one metadata-only read."""
        if not identifiers:
            return {}
        with self._connect() as conn:
            columns = {row[1] for row in conn.execute('PRAGMA table_info(threads)')}
            fields = [name for name in ('id', 'source', 'originator', 'thread_source') if name in columns]
            where = 'id IN (' + ','.join('?' for _ in identifiers) + ')'
            if 'source' in columns:
                where += ' OR source LIKE \'%"subagent"%\''
            rows = [dict(row) for row in conn.execute('SELECT ' + ','.join(fields) + ' FROM threads WHERE ' + where, identifiers)]
        by_id = {row['id']: row for row in rows}
        children = {}
        for row in rows:
            parent = self._agent_source(row).get('parent_thread_id')
            if isinstance(parent, str):
                children.setdefault(parent, []).append(row['id'])
        result = {}
        for root in identifiers:
            if root not in by_id or self._origin(by_id[root]) not in ('desktop', 'cli'):
                continue
            seen, pending, agents = {root}, [root], []
            while pending and len(agents) < 128:
                for child in children.get(pending.pop(), []):
                    if child in seen:
                        continue
                    seen.add(child);pending.append(child);agents.append(child)
                    if len(agents) == 128:
                        break
            result[root] = {'agents': agents, 'limited': len(agents) == 128}
        return result

    def subagent_history(self, thread_id, agent_id):
        self.get(thread_id)
        with self._connect() as conn:
            current = agent_id; seen = set(); target = None
            while current != thread_id:
                if current in seen or len(seen) >= 32: raise KeyError('子智能体不属于此聊天')
                seen.add(current)
                row = conn.execute('SELECT * FROM threads WHERE id = ?', (current,)).fetchone()
                if not row: raise KeyError('子智能体不存在')
                meta = dict(row)
                if target is None: target = meta
                current = self._agent_source(meta).get('parent_thread_id')
                if not current: raise KeyError('子智能体不属于此聊天')
        if target is None: raise KeyError('请选择子智能体')
        return self._history(agent_id, target, 10)

    def _history(self, thread_id, meta, turn_limit=None):
        path = Path(meta["rollout_path"])
        # The file path must be an actual rollout in this user's Codex home.
        resolved = path.resolve()
        if not self._rollout_in_home(resolved):
            raise ValueError("会话记录路径不在 Codex 数据目录中")
        stat = resolved.stat()
        cache_key = (str(resolved), stat.st_ino, stat.st_size, stat.st_mtime_ns, turn_limit)
        with self.history_lock:
            cached = self.history_cache.get(cache_key)
            if cached is not None:
                self.history_cache.move_to_end(cache_key)
                result = copy.deepcopy(cached)
                result.update(title=meta.get('name') or meta.get('title'), cwd=meta['cwd'])
                result['modelProvider'] = meta.get('model_provider')
                if meta.get('model'):
                    result['latestModel'] = meta['model']
                return result
        raw, complete = self._recent_lines(resolved, turn_limit)
        items, turns, current = [], [], None
        token_usage = None
        for line in raw.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload", {})
            previous_count = len(items)
            if record.get("type") == "event_msg" and payload.get("type") == "task_started":
                current = {"turnId": payload.get("turn_id"), "status": "inProgress", "items": []}
                turns.append(current)
                items = current["items"]
            elif record.get("type") == "event_msg" and payload.get("type") == "token_count":
                info = payload.get('info')
                if isinstance(info, dict) and isinstance(info.get('last_token_usage'), dict):
                    token_usage = {'last': {'totalTokens': info['last_token_usage'].get('total_tokens')},
                                   'modelContextWindow': info.get('model_context_window')}
            elif record.get("type") == "turn_context" and current is not None:
                settings = (payload.get('collaboration_mode') or {}).get('settings') or {}
                current['params'] = {'model':payload.get('model') or settings.get('model'),
                                     'effort':payload.get('effort') or settings.get('reasoning_effort')}
                # Recorded permissions describe this historical turn only.
                for source, target in [('approval_policy', 'approvalPolicy'), ('approvals_reviewer', 'approvalsReviewer')]:
                    if payload.get(source) is not None:
                        current['params'][target] = payload[source]
                policy = payload.get('sandbox_policy')
                if isinstance(policy, dict):
                    policy = copy.deepcopy(policy)
                    policy['type'] = {'danger-full-access': 'dangerFullAccess', 'workspace-write': 'workspaceWrite',
                                      'read-only': 'readOnly'}.get(policy.get('type'), policy.get('type'))
                    current['params']['sandboxPolicy'] = policy
            elif record.get("type") == "event_msg" and payload.get("type") in ("task_complete", "turn_aborted"):
                if current:
                    current["status"] = "completed" if payload["type"] == "task_complete" else "interrupted"
            elif record.get("type") == "event_msg" and payload.get("type") == "item_completed":
                item = payload.get("item", {})
                if current is not None and isinstance(item, dict) and item.get('id') and payload.get('started_at_ms') is not None:
                    current.setdefault('itemStartedAtMsById', {})[item['id']] = payload['started_at_ms']
                if isinstance(item, dict) and item.get("type") in ("ImageView", "imageView"):
                    # ImageView evidence only exists in event records. Preserve it
                    # so saved history can still render the image after restart.
                    if current is None:
                        current = {"turnId": "history", "status": "completed", "items": []}
                        turns.append(current)
                        items = current["items"]
                    items.append({"id": item.get("id", str(len(items))), "type": "ImageView", "path": item.get("path", "")})
            elif record.get("type") == "response_item":
                if current is None:
                    current = {"turnId": "history", "status": "completed", "items": []}
                    turns.append(current)
                    items = current["items"]
                if payload.get("type") == "message" and payload.get("role") in ("user", "assistant"):
                    role = payload["role"]
                    if role == "user":
                        items.append({"id": str(len(items)), "type": "userMessage", "content": payload.get("content", [])})
                    else:
                        items.append({"id": str(len(items)), "type": "agentMessage", "text": "\n".join(x.get("text", "") for x in payload.get("content", []) if isinstance(x, dict)), "phase": payload.get("phase")})
                elif payload.get("type") in ("agent_message", "agentMessage"):
                    items.append({"id": payload.get("id", str(len(items))), "type": "agentMessage", "text": payload.get("text", "")})
                elif payload.get("type") == "reasoning":
                    # Keep saved public summaries in their original position,
                    # without copying encrypted or other reasoning content.
                    items.append({"id": payload.get("id") or str(len(items)), "type": "reasoning",
                                  "summary": copy.deepcopy(payload.get("summary") or [])})
                elif payload.get("type") in ("function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"):
                    items.append({"id": payload.get("call_id", str(len(items))), "type": "storedToolEvent", **payload})
            if record.get('timestamp') is not None:
                for item in items[previous_count:]:
                    item['timestamp'] = record['timestamp']
        result = {"id": thread_id, "title": meta.get("name") or meta.get("title"), "cwd": meta["cwd"],
                "latestModel": meta.get('model') or next((t['params']['model'] for t in reversed(turns) if (t.get('params') or {}).get('model')), None),
                "latestReasoningEffort": next((t['params']['effort'] for t in reversed(turns) if (t.get('params') or {}).get('effort')), None),
                "modelProvider": meta.get("model_provider"),
                "latestTokenUsageInfo": token_usage, "tokenUsageFromHistory": True,
                "turns": turns, "turnsPagination": {"hasLoadedOldest": complete}, "requests": [], "threadRuntimeStatus": {"type": "notLoaded"}}
        with self.history_lock:
            if len(raw) <= 4 * 1024 * 1024:
                self.history_cache[cache_key] = result
            while len(self.history_cache) > 8:
                self.history_cache.popitem(last=False)
        return copy.deepcopy(result)
