"""Passive descendant activity for list display, separate from writable sessions."""
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor

from bridge.clients.codex.ipc import DesktopIPC, IPCError
from bridge.clients.codex.remote import RemoteUnavailable
from bridge.features.sessions.model import apply_patches, ordered_turns, pending_requests, waiting_for_user
from bridge.features.sessions.store import StoreUnavailable


class ActivityQueries:
    """Bounded parallel passive queries; identical callers share their result."""
    TIMEOUT = 5
    MAX_WORKERS = 4

    def __init__(self, read):
        self.read = read
        self.lock = threading.Lock()
        self.pending, self.queue = {}, []
        self.workers = set()
        self.closed = False

    def query(self, identifiers, timeout=TIMEOUT):
        deadline = time.monotonic()+max(0, timeout)
        key = tuple(sorted(set(identifiers)))
        with self.lock:
            if self.closed or time.monotonic() >= deadline:
                raise TimeoutError('Activity query timed out')
            future = self.pending.get(key)
            if future is not None and future.done():
                future = None
            if future is None:
                if len(self.pending) >= 64:
                    raise TimeoutError('Activity reader is busy')
                future = self.pending[key] = Future()
                self.queue.append((key, deadline, future))
                if len(self.workers) < self.MAX_WORKERS:
                    worker = threading.Thread(target=self._run, daemon=True)
                    self.workers.add(worker)
                    worker.start()
        return future.result(timeout=max(0, deadline-time.monotonic()))

    def _run(self):
        while True:
            with self.lock:
                if self.closed or not self.queue:
                    self.workers.discard(threading.current_thread())
                    return
                key, deadline, future = self.queue.pop(0)
            try:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Activity query timed out')
                value = self.read(list(key), deadline)
                if time.monotonic() >= deadline:
                    raise TimeoutError('Activity query timed out')
            except Exception as exc:
                with self.lock:
                    if not future.done():
                        future.set_exception(exc)
            else:
                with self.lock:
                    if not future.done():
                        future.set_result(value)
            finally:
                with self.lock:
                    if self.pending.get(key) is future:
                        del self.pending[key]

    def close(self):
        with self.lock:
            self.closed = True
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(TimeoutError('Activity reader closed'))
            self.pending.clear()
            self.queue.clear()


def query_activity(bridge, groups):
    """Read the selected hosts in parallel within one HTTP request deadline."""
    deadline = time.monotonic()+ActivityQueries.TIMEOUT
    sources = [(bridge.for_host(host), identifiers) for host, identifiers in groups.items()]
    rows = []
    if sources:
        def read(source, identifiers):
            remaining = deadline-time.monotonic()
            return source.activity(identifiers, remaining) if remaining > 0 else source.activity_timeout_rows(identifiers)
        executor = ThreadPoolExecutor(max_workers=min(4, len(sources)))
        reads = [executor.submit(read, source, identifiers) for source, identifiers in sources]
        try:
            for (source, identifiers), read in zip(sources, reads):
                try:
                    rows.extend(read.result(timeout=max(0, deadline-time.monotonic())))
                except TimeoutError:
                    rows.extend(source.activity_timeout_rows(identifiers))
        finally:
            for read in reads:
                read.cancel()
            executor.shutdown(wait=False)
    return {'sessions': rows, 'timedOut': any(row.get('activityError') == 'timeout' for row in rows)}


class SubagentActivity:
    MAX_FOLLOWERS = 1024

    def __init__(self, store, endpoint, host):
        self.store, self.endpoint, self.host = store, endpoint, host
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.trees, self.records = {}, {}
        self.ipc = None
        self.worker = None
        self.worker_done = None
        self.closed = False

    def read(self, identifiers, *, force=False):
        identifiers = list(dict.fromkeys(identifiers))
        with self.lock:
            if not self.closed and identifiers and (self.worker is None or not self.worker.is_alive()):
                self.worker_identifiers = set(identifiers)
                done = self.worker_done = threading.Event()
                def refresh():
                    try:
                        self._refresh(identifiers, force=force)
                    finally:
                        with self.condition:
                            done.set()
                            self.condition.notify_all()
                self.worker = threading.Thread(target=refresh, daemon=True)
                self.worker.start()
            return self._summary(identifiers)

    def wake(self):
        with self.condition:
            self.condition.notify_all()

    def _summary(self, identifiers):
        with self.lock:
            result = {}
            for identifier in identifiers:
                tree = self.trees.get(identifier)
                running, waiting, unknown = 0, 0, tree is None or bool(tree.get('limited'))
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
                        awaiting = waiting_for_user(state)
                        busy = runtime in ('active', 'running', 'waiting', 'busy') or pending_requests(state) or any(
                            turn.get('status') == 'inProgress' for turn in ordered_turns(state))
                    except (KeyError, TypeError, AttributeError, ValueError):
                        unknown = True
                        continue
                    running += bool(busy)
                    waiting += awaiting
                    unknown |= not busy and runtime != 'idle'
                result[identifier] = {'runningSubagents': running, 'subagentsKnown': not unknown,
                                      'waitingSubagents': waiting if waiting or not unknown else None}
            return result

    def wait(self, identifiers, deadline, *, confirmed=None):
        confirmed = confirmed or (lambda: False)
        for attempt in range(2):
            with self.condition:
                done = self.worker_done
                covered = set(identifiers) <= getattr(self, 'worker_identifiers', set())
                self.condition.wait_for(lambda: self.closed or confirmed() or done is None or done.is_set(),
                                        timeout=max(0, deadline-time.monotonic()))
                if self.closed or confirmed():
                    return {sid: {**row, 'subagentsKnown': False} for sid, row in self._summary(identifiers).items()}
                if done is not None and not done.is_set():
                    return {sid: {'runningSubagents': 0, 'subagentsKnown': False, 'waitingSubagents': None} for sid in identifiers}
            if covered or attempt or time.monotonic() >= deadline:
                break
            self.read(identifiers, force=True)
        def pending():
            return any(record.get('owner') and not record.get('connected') for sid in identifiers
                       for child in self.trees.get(sid, {}).get('agents', [])
                       for record in [self.records.get(child, {})])
        with self.condition:
            self.condition.wait_for(lambda: self.closed or confirmed() or not pending(), timeout=max(0, deadline-time.monotonic()))
            return self._summary(identifiers)

    def _refresh(self, identifiers, *, force=False):
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
                    if not record.get('connected') and (force or now >= record['retry']):
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
        with self.condition:
            self._apply_event(message)
            self.condition.notify_all()

    def _apply_event(self, message):
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
            self.condition.notify_all()

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
            self.condition.notify_all()
            ipc, worker = self.ipc, self.worker
        if ipc:
            ipc.close()
        if worker and worker is not threading.current_thread():
            worker.join(timeout=2)
