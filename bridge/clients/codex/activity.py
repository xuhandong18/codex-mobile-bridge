"""Passive desktop metadata for list badges; never a writable session owner."""
from contextlib import nullcontext
import sys
import threading
import time

from bridge.clients.codex.desktop_tools import DesktopTools, ToolError
from bridge.clients.desktop_app import DesktopApp


class ActivityTools(DesktopTools):
    METHODS = {'list_projects', 'read_thread'}


class DesktopActivity:
    MAX_BATCH = 64
    MAX_AGE = 15
    REFRESH_INTERVAL = 5

    def __init__(self, bridge):
        self.bridge = bridge
        self.lock = threading.RLock()
        self.snapshots, self.retry_at = {}, {}
        self.worker = self.native = None
        self.closed = False

    @property
    def available(self):
        return sys.platform == 'win32' and self.bridge.host == 'local'

    def read(self, identifiers):
        if not self.available:
            return {}
        identifiers = list(dict.fromkeys(identifiers))[:self.MAX_BATCH]
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

    def _connect(self):
        bridge = self.bridge
        projects = {p['key'].split('|', 1)[1] for p in bridge.hosts.projects() if p['host'] == 'local'}
        contexts = bridge.store.list(limit=1, source='desktop')
        if not projects or not contexts:
            raise ToolError('No verified desktop profile context')
        executable = bridge.accounts.index.get('desktopExecutable') or DesktopApp.scan(bridge.catalog_reader.executable, bridge.codex_home)
        return ActivityTools.connect(executable, contexts[0]['id'], projects)

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

    def _refresh(self, identifiers):
        native = None
        remaining = set(identifiers)
        gate = getattr(getattr(self.bridge, 'accounts', None), 'gate', None)
        try:
            with gate if gate is not None else nullcontext():
                with self.lock:
                    if self.closed:
                        return
                native = self._connect()
                with self.lock:
                    if self.closed:
                        return
                    self.native = native
                deadline = time.monotonic()+5
                for sid in identifiers:
                    with self.lock:
                        if self.closed or time.monotonic() >= deadline:
                            break
                    try:
                        value = native.call('read_thread', {'threadId': sid, 'hostId': 'local', 'turnLimit': 1,
                                                           'includeOutputs': False, 'maxOutputCharsPerItem': 500}, timeout=2)
                        snapshot = self._snapshot(value, sid)
                        with self.lock:
                            if not self.closed:
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
