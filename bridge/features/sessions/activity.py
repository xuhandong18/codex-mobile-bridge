"""Passive descendant activity for list display, separate from writable sessions."""
import threading
import time

from bridge.clients.codex.ipc import DesktopIPC, IPCError
from bridge.clients.codex.remote import RemoteUnavailable
from bridge.features.sessions.model import apply_patches, ordered_turns, pending_requests
from bridge.features.sessions.store import StoreUnavailable


class SubagentActivity:
    MAX_FOLLOWERS = 1024

    def __init__(self, store, endpoint, host):
        self.store, self.endpoint, self.host = store, endpoint, host
        self.lock = threading.RLock()
        self.trees, self.records = {}, {}
        self.ipc = None
        self.worker = None
        self.closed = False

    def read(self, identifiers):
        identifiers = list(dict.fromkeys(identifiers))
        with self.lock:
            if not self.closed and identifiers and (self.worker is None or not self.worker.is_alive()):
                self.worker = threading.Thread(target=self._refresh, args=(identifiers,), daemon=True)
                self.worker.start()
            result = {}
            for identifier in identifiers:
                tree = self.trees.get(identifier)
                running, unknown = 0, tree is None or bool(tree.get('limited'))
                for child in tree.get('agents', []) if tree else []:
                    record = self.records.get(child, {})
                    if record.get('absent'):
                        continue
                    if not record.get('connected'):
                        unknown = True
                        continue
                    try:
                        state = record['state']
                        runtime = state.get('threadRuntimeStatus', {}).get('type')
                        busy = runtime in ('active', 'running', 'waiting', 'busy') or pending_requests(state) or any(
                            turn.get('status') == 'inProgress' for turn in ordered_turns(state))
                    except (KeyError, TypeError, AttributeError, ValueError):
                        unknown = True
                        continue
                    running += bool(busy)
                    unknown |= not busy and runtime != 'idle'
                result[identifier] = {'runningSubagents': running, 'subagentsKnown': not unknown}
            return result

    def _refresh(self, identifiers):
        try:
            trees = self.store.activity_tree(identifiers)
        except (OSError, ValueError, KeyError, StoreUnavailable, RemoteUnavailable):
            with self.lock:
                for identifier in identifiers:
                    self.trees.pop(identifier, None)
            return
        self.prune()
        with self.lock:
            if self.closed:
                return
            now = time.monotonic()
            pending = []
            for sid in identifiers:
                tree = trees.get(sid, {'agents': [], 'limited': True})
                self.trees[sid] = {**tree, 'touched': now}
                for child in tree['agents']:
                    if child not in self.records:
                        if len(self.records) >= self.MAX_FOLLOWERS:
                            continue
                        self.records[child] = {'touched': now, 'retry': 0}
                    record = self.records[child]
                    record['touched'] = now
                    if not record.get('connected') and now >= record['retry']:
                        record['retry'] = now + 15
                        pending.append(child)
            if pending and self.ipc is None:
                self.ipc = DesktopIPC(self.endpoint(), on_event=self._event, on_disconnect=self._disconnected)
            ipc = self.ipc
        for child in pending:
            try:
                with self.lock:
                    if self.closed:
                        return
                ipc.connect()
                owner = ipc.owner(child, host=self.host)
                if not isinstance(owner, str) or not owner:
                    raise IPCError('Missing desktop owner')
                with self.lock:
                    if self.closed:
                        return
                    self.records[child].update(owner=owner, absent=False, revision=None, connected=False)
                ipc.follow(child, owner, host=self.host)
            except IPCError as exc:
                with self.lock:
                    record = self.records.get(child)
                    if record is not None:
                        record.update(connected=False, absent=str(exc) == 'no-client-found', owner=None, revision=None)

    def _event(self, message):
        params = message.get('params', {})
        with self.lock:
            if self.closed:
                return
            if message.get('method') == 'client-status-changed':
                if params.get('status') == 'disconnected':
                    for record in self.records.values():
                        if record.get('owner') == params.get('clientId'):
                            record.update(connected=False, absent=False, retry=0, owner=None, revision=None)
                return
            if message.get('method') != 'thread-stream-state-changed' or params.get('hostId') != self.host:
                return
            identifier = params.get('conversationId')
            record = self.records.get(identifier)
            if record is None or not record.get('owner') or record['owner'] != message.get('sourceClientId'):
                return
            try:
                change = params['change']
                revision = change.get('revision')
                if message.get('version') != 11 or type(revision) is not int or revision < 0:
                    raise ValueError('Invalid stream version')
                if record.get('revision') is not None and revision < record['revision']:
                    raise ValueError('Stale revision')
                if change.get('type') == 'snapshot':
                    state = change['conversationState']
                elif change.get('type') == 'patches' and record.get('connected') and type(change.get('baseRevision')) is int and change['baseRevision'] == record.get('revision'):
                    state = apply_patches(record['state'], change['patches'])
                else:
                    raise ValueError('Missing snapshot')
                if not isinstance(state, dict) or state.get('id') != identifier:
                    raise ValueError('Thread mismatch')
                record.update(state=state, revision=revision, connected=True, absent=False)
            except (KeyError, TypeError, ValueError, IndexError, AttributeError):
                record.update(connected=False, absent=False, retry=0, owner=None, revision=None)

    def _disconnected(self):
        with self.lock:
            for record in self.records.values():
                record.update(connected=False, absent=False, retry=0, owner=None, revision=None)

    def prune(self):
        with self.lock:
            now = time.monotonic()
            expired = [(sid, row) for sid, row in self.records.items() if now - row['touched'] > 300]
            for sid, record in expired:
                self.records.pop(sid, None)
                if self.ipc and record.get('owner'):
                    try:
                        self.ipc.follow(sid, record['owner'], False, host=self.host)
                    except IPCError:
                        pass
            self.trees = {sid: tree for sid, tree in self.trees.items() if now - tree['touched'] <= 300}

    def close(self):
        with self.lock:
            self.closed = True
            ipc, worker = self.ipc, self.worker
        if ipc:
            ipc.close()
        if worker and worker is not threading.current_thread():
            worker.join(timeout=2)
