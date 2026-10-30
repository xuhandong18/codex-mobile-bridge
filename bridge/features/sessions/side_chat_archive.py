"""Durable, display-only side-chat records. Never restores an executor."""
import hashlib
import copy
import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path


def identifier(value):
    return str(uuid.UUID(str(value)))


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


class SideChatArchive:
    META = ('title', 'titleRevision', 'titleSource', 'cwd', 'model', 'provider', 'effort',
            'permissionMode', 'permissionDetails', 'collaborationMode', 'contextUsage',
            'recency', 'historyComplete', 'error')

    def __init__(self, directory, home, host):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.profile = hashlib.sha256(os.path.normcase(str(Path(home).resolve())).encode()).hexdigest()
        self.host = host
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(self.directory/'side-chats.sqlite3'), check_same_thread=False, timeout=3)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS chats (
                profile TEXT NOT NULL, host TEXT NOT NULL, parent TEXT NOT NULL, child TEXT NOT NULL,
                slot TEXT NOT NULL, source TEXT NOT NULL, revision INTEGER NOT NULL,
                saved_at INTEGER NOT NULL, sync_state TEXT NOT NULL, metadata TEXT NOT NULL,
                PRIMARY KEY(profile,host,parent,child));
            CREATE INDEX IF NOT EXISTS chats_parent ON chats(profile,host,parent,saved_at DESC,child);
            CREATE TABLE IF NOT EXISTS records (
                profile TEXT NOT NULL, host TEXT NOT NULL, parent TEXT NOT NULL, child TEXT NOT NULL,
                kind TEXT NOT NULL, turn TEXT NOT NULL, item TEXT NOT NULL, position INTEGER NOT NULL,
                payload TEXT NOT NULL, PRIMARY KEY(profile,host,parent,child,kind,turn,item));
            CREATE TABLE IF NOT EXISTS imports (
                profile TEXT NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL, digest TEXT NOT NULL,
                PRIMARY KEY(profile,host,path));
        ''')
        self.db.commit()
        scope = hashlib.sha256((self.profile+'|'+host).encode()).hexdigest()[:24]
        self.files = self.directory/'side-chat-files'/scope
        self.files.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _key(self, parent, child):
        return self.profile, self.host, identifier(parent), identifier(child)

    def save(self, parent, slot, view, *, source='gateway', revision=None, sync_state='live', saved_at=None, recovered=False):
        key = self._key(parent, view['id'])
        slot = identifier(slot) if slot else ''
        if source not in ('gateway', 'desktop') or sync_state not in ('live', 'offline', 'ended'):
            raise ValueError('侧边聊天存档状态无效')
        metadata = encoded({k: view[k] for k in self.META if k in view} | {
            'hasBody': any(turn.get('messages') for turn in view.get('turns', [])), 'recovered': recovered})
        now = int(time.time()*1000) if saved_at is None else saved_at
        with self.lock, self.db:
            prior = self.db.execute('SELECT revision,saved_at FROM chats WHERE profile=? AND host=? AND parent=? AND child=?', key).fetchone()
            if revision is not None and prior and revision <= prior['revision']:
                return prior['saved_at']
            revision = revision if revision is not None else prior['revision']+1 if prior else 1
            self.db.execute('INSERT INTO chats VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(profile,host,parent,child) '
                            'DO UPDATE SET slot=excluded.slot,source=excluded.source,revision=excluded.revision,'
                            'saved_at=excluded.saved_at,sync_state=excluded.sync_state,metadata=excluded.metadata',
                            (*key, slot, source, revision, now, sync_state, metadata))
            # Compare each row, updating only changed messages instead of a growing transcript blob.
            existing = {(r['kind'], r['turn'], r['item']): (r['position'], r['payload']) for r in self.db.execute(
                'SELECT kind,turn,item,position,payload FROM records WHERE profile=? AND host=? AND parent=? AND child=?', key)}
            seen = set()
            def put(kind, turn, item, position, payload):
                identity = kind, turn, item
                body = encoded(payload)
                seen.add(identity)
                if existing.get(identity) != (position, body):
                    self.db.execute('INSERT INTO records VALUES (?,?,?,?,?,?,?,?,?) '
                                    'ON CONFLICT(profile,host,parent,child,kind,turn,item) '
                                    'DO UPDATE SET position=excluded.position,payload=excluded.payload',
                                    (*key, kind, turn, item, position, body))
            for position, turn in enumerate(view.get('turns', [])):
                tid = str(turn.get('id') or turn.get('turnId') or position)
                put('turn', tid, '', position, {k: v for k, v in turn.items() if k != 'messages'})
                for index, message in enumerate(turn.get('messages', [])):
                    put('message', tid, str(message.get('id') or index), index, message)
            for index, request in enumerate(view.get('requests', [])):
                put('request', '', str(request.get('id', index)), index, {**request, 'supported': False})
            for index, submission in enumerate(view.get('submissions', [])):
                put('submission', '', str(submission['id']), index, submission)
            for index, response in enumerate(view.get('historyResponses', [])):
                put('response', '', str(response['id']), index, response)
            # A complete turn snapshot may replace an item or remove an echoed duplicate.
            # Historical requests remain inert evidence after they disappear from live state.
            for kind, turn, item in existing.keys()-seen:
                if kind not in ('request', 'response') and (view.get('historyComplete', True) or any(k[1] == turn for k in seen)):
                    self.db.execute('DELETE FROM records WHERE profile=? AND host=? AND parent=? AND child=? '
                                    'AND kind=? AND turn=? AND item=?', (*key, kind, turn, item))
        return now

    @staticmethod
    def _summary(row):
        meta = json.loads(row['metadata'])
        return {k: meta[k] for k in ('title', 'titleRevision', 'titleSource', 'recency', 'hasBody') if k in meta} | {
            'id': row['child'], 'archiveId': row['child'], 'slot': row['slot'], 'source': row['source'],
            'syncState': row['sync_state'], 'savedAt': row['saved_at']}

    def read(self, parent, child=None, *, slot=''):
        parent = identifier(parent)
        with self.lock:
            if child:
                row = self.db.execute('SELECT * FROM chats WHERE profile=? AND host=? AND parent=? AND child=?',
                                      self._key(parent, child)).fetchone()
            else:
                row = self.db.execute('SELECT * FROM chats WHERE profile=? AND host=? AND parent=? AND slot=? '
                                      'ORDER BY saved_at DESC,child DESC LIMIT 1',
                                      (self.profile, self.host, parent, slot)).fetchone()
            if row is None:
                return None
            records = list(self.db.execute('SELECT * FROM records WHERE profile=? AND host=? AND parent=? AND child=? '
                                          'ORDER BY position,item', self._key(parent, row['child'])))
            turns, messages = [], {}
            for record in records:
                if record['kind'] == 'message':
                    messages.setdefault(record['turn'], []).append(json.loads(record['payload']))
            for record in records:
                if record['kind'] == 'turn':
                    turn = json.loads(record['payload'])
                    turn['messages'] = messages.get(record['turn'], [])
                    turns.append(turn)
            meta = json.loads(row['metadata'])
            return {**meta, **self._summary(row), 'parentId': parent, 'turns': turns,
                    'connected': False, 'readOnly': True, 'expired': True, 'status': 'unknown',
                    'waitingForUser': False, 'requests': [],
                    'submissions': [json.loads(r['payload']) for r in records if r['kind'] == 'submission'],
                    'historyRequests': [json.loads(r['payload']) for r in records if r['kind'] == 'request'],
                    'historyResponses': [json.loads(r['payload']) for r in records if r['kind'] == 'response'],
                    'historyComplete': meta.get('historyComplete', True), 'slots': []}

    def list(self, parent, offset=0, limit=30):
        if type(offset) is not int or not 0 <= offset <= 100000:
            raise ValueError('历史页码无效')
        with self.lock:
            rows = list(self.db.execute('SELECT * FROM chats WHERE profile=? AND host=? AND parent=? '
                                       'ORDER BY saved_at DESC,child DESC LIMIT ? OFFSET ?',
                                       (self.profile, self.host, identifier(parent), limit+1, offset)))
        return {'items': [self._summary(row) for row in rows[:limit]],
                'nextOffset': offset+limit if len(rows) > limit else None}

    def disconnect(self, child=None, *, ended=False):
        with self.lock, self.db:
            sql = 'UPDATE chats SET sync_state=? WHERE profile=? AND host=? AND sync_state!=?'
            args = ['ended' if ended else 'offline', self.profile, self.host, 'ended']
            if child:
                sql += ' AND child=?'
                args.append(identifier(child))
            self.db.execute(sql, args)

    def import_snapshots(self, parent_lookup=None):
        root = self.directory/'side-chat-recovery'
        if not root.is_dir():
            return
        candidates = []
        for path in root.rglob('*.json'):
            try:
                candidates.append((path.stat().st_mtime, path))
            except OSError:
                continue
        for _, path in sorted(candidates, key=lambda item: item[0], reverse=True)[:2000]:
            try:
                if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or path.stat().st_size > 32*1024*1024:
                    continue
                data = path.read_bytes()
                digest = hashlib.sha256(data).hexdigest()
                with self.lock:
                    prior = self.db.execute('SELECT digest FROM imports WHERE profile=? AND host=? AND path=?',
                                            (self.profile, self.host, str(path))).fetchone()
                if prior and prior[0] == digest:
                    continue
                payload = json.loads(data)
                for row in self._snapshot_rows(payload):
                    try:
                        self._import_row(row, parent_lookup, int(path.stat().st_mtime*1000))
                    except (ValueError, KeyError, TypeError):
                        continue
                with self.lock, self.db:
                    self.db.execute('INSERT OR REPLACE INTO imports VALUES (?,?,?,?)',
                                    (self.profile, self.host, str(path), digest))
            except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
                # An unavailable or unrelated file must not prevent starting the gateway.
                continue

    @staticmethod
    def _snapshot_rows(payload):
        if isinstance(payload, list):
            for row in payload:
                yield from SideChatArchive._snapshot_rows(row)
        elif isinstance(payload, dict):
            if isinstance(payload.get('view'), dict):
                yield payload
            elif payload.get('parentId') and isinstance(payload.get('sideChats'), list):
                for row in payload['sideChats']:
                    if isinstance(row, dict) and isinstance(row.get('state'), dict):
                        yield {'parent': payload['parentId'], 'slot': row.get('slot', ''), 'view': row['state']}
            elif payload.get('parentId') and payload.get('id'):
                yield {'parent': payload['parentId'], 'slot': payload.get('slot', ''), 'view': payload}
            elif isinstance(payload.get('response'), dict):
                for row in SideChatArchive._snapshot_rows(payload['response']):
                    yield {**row, 'slot': (payload.get('request') or {}).get('slot', row.get('slot', ''))}

    def _import_row(self, row, parent_lookup, saved_at):
        parent, view = identifier(row['parent']), row['view']
        child = identifier(view['id'])
        if parent == child or not view.get('cwd') or not view.get('provider'):
            return
        if parent_lookup:
            meta = parent_lookup(parent)
            if os.path.normcase(os.path.normpath(meta['cwd'])) != os.path.normcase(os.path.normpath(view['cwd'])) or meta['model_provider'] != view['provider']:
                return
        existing = self.read(parent, child)
        if existing and not existing.get('recovered'):
            return  # A recovery file cannot replace a record captured by the running gateway.
        slot = row.get('slot', '')
        if existing:
            if existing['savedAt'] >= saved_at:
                slot = existing['slot']
            old, new = (view, existing) if existing['savedAt'] >= saved_at else (existing, view)
            # Merge overlapping saved pages by identity, preserving distinct repeated messages.
            turns = {str(t.get('id', t.get('turnId', i))): copy.deepcopy(t) for i, t in enumerate(old.get('turns', []))}
            for i, turn in enumerate(new.get('turns', [])):
                tid = str(turn.get('id', turn.get('turnId', i)))
                before = turns.get(tid, {})
                messages = {str(m.get('id', j)): m for j, m in enumerate(before.get('messages', []))}
                messages.update({str(m.get('id', j)): m for j, m in enumerate(turn.get('messages', []))})
                turns[tid] = {**before, **turn, 'messages': list(messages.values())}
            view = {**old, **new, 'turns': list(turns.values())}
            for field in ('submissions', 'historyResponses'):
                rows = {str(r['id']): r for r in old.get(field, [])}
                rows.update({str(r['id']): r for r in new.get(field, [])})
                view[field] = list(rows.values())
            requests = {}
            for source in (old, new):
                for request in source.get('historyRequests', [])+source.get('requests', []):
                    requests[str(request['id'])] = request
            view['requests'] = list(requests.values())
            saved_at = max(existing['savedAt'], saved_at)
        self.save(parent, slot, view, sync_state='offline', saved_at=saved_at, recovered=True)

    def import_titles(self, parent_lookup):
        """Only read receipts establish a title-only child's parent; never guess it."""
        receipts = self.directory/'chat-read-state.sqlite3'
        names = self.directory/'auto-titles.json'
        if not parent_lookup or not receipts.is_file() or not names.is_file():
            return
        try:
            titles = json.loads(names.read_text(encoding='utf-8'))
            db = sqlite3.connect(receipts.resolve().as_uri()+'?mode=ro', uri=True, timeout=3)
            try:
                chats = list(db.execute('SELECT DISTINCT chat FROM completions WHERE host=? LIMIT 2000', (self.host,)))
            finally:
                db.close()
            for (chat,) in chats:
                if '/side/' not in chat:
                    continue
                try:
                    parent, child = map(identifier, chat.split('/side/'))
                    title = titles.get('side:'+child, {}).get('title')
                    if not title or self.read(parent, child):
                        continue
                    meta = parent_lookup(parent)
                    if meta.get('origin') != 'desktop' or not meta.get('model_provider'):
                        continue
                    self.save(parent, child, {'id': child, 'title': title, 'cwd': meta['cwd'],
                        'provider': meta['model_provider'], 'turns': []}, sync_state='offline', recovered=True)
                except (ValueError, KeyError, TypeError):
                    continue
        except (OSError, ValueError, sqlite3.Error):
            return

    def close(self):
        with self.lock:
            self.db.close()
