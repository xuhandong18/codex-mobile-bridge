"""Passive desktop metadata for list badges; never a writable session owner."""
import sys
import threading
import time

from bridge.clients.codex.desktop_tools import DesktopTools


class ActivityTools(DesktopTools):
    METHODS = {'list_projects', 'read_thread'}


class DesktopActivity:
    MAX_BATCH = 64
    MAX_AGE = 15
    REFRESH_INTERVAL = 5

    def __init__(self, bridge):
        self.bridge = bridge
        self.lock = threading.RLock()
        self.query_lock = threading.Lock()
        self.snapshots, self.retry_at = {}, {}
        self.worker = self.native = None
        self.closed = False

    @property
    def available(self):
        return sys.platform == 'win32' and self.bridge.host == 'local'

    def read(self, identifiers, *, timeout=0):
        if not self.available:
            return {}
        identifiers = list(dict.fromkeys(identifiers))[:self.MAX_BATCH]
        if timeout > 0:
            return self._wait_read(identifiers, timeout)
        now = time.monotonic()
        with self.lock:
            if self.closed:
                return {}
            self.snapshots = {sid: row for sid, row in self.snapshots.items() if now-row[0] <= self.MAX_AGE}
            self.retry_at = {sid: at for sid, at in self.retry_at.items() if now-at < self.MAX_AGE}
            pending = [sid for sid in identifiers if now >= self.retry_at.get(sid, 0)]
            pending.sort(key=lambda sid: self.snapshots.get(sid, (0,))[0])
            if pending and (self.worker is None or not self.worker.is_alive()):
                for sid in pending:
                    self.retry_at[sid] = now+self.REFRESH_INTERVAL
                self.worker = threading.Thread(target=self._refresh, args=(pending,), daemon=True)
                self.worker.start()
            return {sid: dict(self.snapshots[sid][1]) for sid in identifiers if sid in self.snapshots}

    def _wait_read(self, identifiers, timeout):
        deadline = time.monotonic()+timeout
        if not identifiers or not self.query_lock.acquire(timeout=max(0, deadline-time.monotonic())):
            return {}
        try:
            with self.lock:
                if self.closed:
                    return {}
                previous = self.worker
            if previous is not None and previous.is_alive():
                previous.join(max(0, deadline-time.monotonic()))
                if previous.is_alive():
                    return {}
            with self.lock:
                if self.closed or time.monotonic() >= deadline:
                    return {}
                for sid in identifiers:
                    self.snapshots.pop(sid, None)
                    self.retry_at[sid] = time.monotonic()+self.REFRESH_INTERVAL
                self.worker = threading.Thread(target=self._refresh, args=(identifiers,), kwargs={'deadline': deadline}, daemon=True)
                worker = self.worker
                worker.start()
            worker.join(max(0, deadline-time.monotonic()))
            with self.lock:
                return {} if self.closed else {sid: dict(self.snapshots[sid][1]) for sid in identifiers if sid in self.snapshots}
        finally:
            self.query_lock.release()

    def _connect(self, *, timeout=None):
        return ActivityTools.connect_profile(self.bridge, **({'timeout': timeout} if timeout is not None else {}))

    @staticmethod
    def _snapshot(value, identifier):
        thread = value.get('thread', {})
        status = thread.get('status', {}).get('type')
        if (thread.get('id') != identifier or thread.get('hostId') != 'local' or
                status not in ('notLoaded', 'idle', 'active', 'systemError')):
            raise ValueError('Invalid desktop activity identity or status')
        turns = value.get('turns') or []
        last = turns[0] if turns else {}
        turn_status = last.get('status')
        return {'status': status, 'turnId': last.get('id'),
                'turnStatus': turn_status if turn_status in ('inProgress', 'completed', 'interrupted', 'failed') else None}

    def _refresh(self, identifiers, *, deadline=None):
        native = None
        remaining = set(identifiers)
        gate = getattr(getattr(self.bridge, 'accounts', None), 'gate', None)
        bounded = deadline is not None
        deadline = deadline if bounded else time.monotonic()+5
        acquired = gate is None or gate.acquire(timeout=max(0, deadline-time.monotonic()))
        try:
            if acquired:
                with self.lock:
                    if self.closed or time.monotonic() >= deadline:
                        return
                native = self._connect(**({'timeout': max(.001, deadline-time.monotonic())} if bounded else {}))
                with self.lock:
                    if self.closed:
                        return
                    self.native = native
                for sid in identifiers:
                    with self.lock:
                        if self.closed or time.monotonic() >= deadline:
                            break
                    try:
                        value = native.call('read_thread', {'threadId': sid, 'hostId': 'local', 'turnLimit': 1,
                                                           'includeOutputs': False, 'maxOutputCharsPerItem': 500}, timeout=min(2, max(.001, deadline-time.monotonic())))
                        snapshot = self._snapshot(value, sid)
                        with self.lock:
                            if not self.closed and time.monotonic() < deadline:
                                self.snapshots[sid] = (time.monotonic(), snapshot)
                                remaining.discard(sid)
                    except (OSError, ValueError, TypeError, KeyError, AttributeError):
                        with self.lock:
                            self.snapshots.pop(sid, None)
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            pass
        finally:
            with self.lock:
                self.native = None
                for sid in remaining:
                    self.snapshots.pop(sid, None)
            if gate is not None and acquired:
                gate.release()
            if native:
                native.close()

    def close(self):
        with self.lock:
            self.closed = True
            self.snapshots.clear()
            native, worker = self.native, self.worker
        if native:
            native.close()
        if worker and worker is not threading.current_thread():
            worker.join(timeout=2)
