"""Read-only discovery and owner-following of verifiable native side chats."""
import copy
import re
import sqlite3
import threading
import time
import uuid

from bridge.clients.codex.ipc import DesktopIPC, IPCError
from bridge.features.sessions.model import apply_patches
from bridge.features.sessions.store import StoreUnavailable
from bridge.features.workspace.files import path_identity
from bridge.platforms.desktop_logs import codex_log_files


class NativeSideChatSync:
    def __init__(self, endpoint, host, parent_lookup, save, disconnected, *, log_files=codex_log_files, ipc_factory=DesktopIPC):
        self.host, self.parent_lookup, self.save = host, parent_lookup, save
        self.mark_disconnected, self.log_files = disconnected, log_files
        self.ipc = ipc_factory(endpoint, self.event, self.disconnect)
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.worker = None
        self.following, self.states, self.offsets = {}, {}, {}
        self.pending = {}
        self.needs_snapshot = set()
        self.last_saved = None
        self.error = None

    def start(self):
        if self.host == 'local' and self.worker is None and not self.closed.is_set():
            self.worker = threading.Thread(target=self._run, daemon=True, name='native-side-backup')
            self.worker.start()

    def candidates(self):
        found = set()
        paths = self.log_files()
        for path in paths:
            stat = path.stat()
            identity = str(path)
            prior = self.offsets.get(identity)
            begin = max(0, stat.st_size-512*1024)
            aligned = prior and prior[0] == stat.st_ino and begin <= prior[1] <= stat.st_size
            if aligned:
                begin = max(begin, prior[1])
            with path.open('rb') as stream:
                stream.seek(begin)
                if begin and not aligned:
                    stream.readline()
                begin = stream.tell()
                data = stream.read(512*1024)
            end = data.rfind(b'\n')+1
            self.offsets[identity] = stat.st_ino, begin+end
            for line in data[:end].decode('utf-8', errors='replace').splitlines():
                if 'thread/inject_items' not in line and 'sideConversation' not in line:
                    continue
                for value in re.findall(r'(?:threadId|conversationId)["\s]*[=:]["\s]*([0-9a-f-]{36})', line):
                    try:
                        found.add(str(uuid.UUID(value)))
                    except ValueError:
                        pass
        self.offsets = {k: v for k, v in self.offsets.items() if any(str(p) == k for p in paths)}
        return sorted(found)[:32]

    def follow(self, child):
        with self.lock:
            if child in self.following or len(self.following) >= 32 or self.closed.is_set():
                return
        owner = self.ipc.owner(child, self.host)
        with self.lock:
            self.following[child] = owner
        try:
            self.ipc.follow(child, owner, host=self.host)
        except (OSError, IPCError):
            with self.lock:
                self.following.pop(child, None)
            raise

    def _run(self):
        while not self.closed.is_set():
            try:
                for child in self.candidates():
                    if len(self.pending) < 32:
                        self.pending.setdefault(child, 0)
                for child, retry in list(self.pending.items()):
                    if self.closed.is_set():
                        break
                    if time.monotonic() < retry:
                        continue
                    try:
                        self.follow(child)
                        self.pending.pop(child, None)
                    except (OSError, ValueError, IPCError):
                        self.pending[child] = time.monotonic()+30
                        continue
                with self.lock:
                    refresh = [(child, self.following.get(child)) for child in self.needs_snapshot]
                for child, owner in refresh:
                    if owner and not self.closed.is_set():
                        try:
                            self.ipc.follow(child, owner, host=self.host)
                        except (OSError, IPCError):
                            pass
            except (OSError, ValueError):
                self.error = '桌面原生侧边聊天自动发现暂不可用'
            self.closed.wait(5)

    def event(self, message):
        if message.get('method') == 'client-status-changed':
            params = message.get('params') or {}
            if params.get('status') == 'disconnected':
                with self.lock:
                    for child, owner in list(self.following.items()):
                        if owner == params.get('clientId'):
                            self.states.pop(child, None)
                            self.needs_snapshot.discard(child)
                            self.following.pop(child, None)
                            self.pending[child] = time.monotonic()+5
                            self.mark_disconnected(child)
            return
        if self.closed.is_set() or message.get('method') != 'thread-stream-state-changed' or message.get('version') != 11:
            return
        params = message.get('params') or {}
        child = params.get('conversationId')
        with self.lock:
            owner = self.following.get(child)
            if not owner or message.get('sourceClientId') != owner or params.get('hostId') != self.host:
                return
            change = params.get('change') or {}
            previous = self.states.get(child)
            revision = change.get('revision')
            if type(revision) is not int or previous and (revision < previous[0] or revision == previous[0] and child not in self.needs_snapshot):
                return
            try:
                if change.get('type') == 'snapshot':
                    state = copy.deepcopy(change['conversationState'])
                    if previous and revision == previous[0] and state != previous[1]:
                        return
                elif child in self.needs_snapshot:
                    return
                elif change.get('type') == 'patches' and previous and change.get('baseRevision') == previous[0]:
                    state = apply_patches(copy.deepcopy(previous[1]), change['patches'])
                else:
                    self.needs_snapshot.add(child)
                    self.mark_disconnected(child)
                    self.ipc.follow(child, owner, host=self.host)
                    return
                parent = str(uuid.UUID(state.get('forkedFromId', '')))
                if (state.get('id') != child or child == parent or state.get('hostId', self.host) != self.host
                        or state.get('ephemeral') is not True or state.get('sideConversation') is not True):
                    raise ValueError('Not a verified native side conversation')
                metadata = self.parent_lookup(parent)
                if (metadata.get('origin') != 'desktop' or not metadata.get('model_provider')
                        or metadata['model_provider'] != state.get('modelProvider')
                        or not state.get('cwd') or path_identity(metadata['cwd']) != path_identity(state['cwd'])):
                    raise ValueError('Native side conversation identity mismatch')
                self.last_saved = self.save(parent, child, state, revision)
                self.states[child] = revision, state
                self.needs_snapshot.discard(child)
                self.error = None
            except sqlite3.Error:
                self.needs_snapshot.add(child)
                self.mark_disconnected(child)
                self.error = '桌面原生侧边聊天未通过核验或保存失败'
            except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError, StoreUnavailable):
                self.states.pop(child, None)
                self.needs_snapshot.discard(child)
                self.following.pop(child, None)
                self.mark_disconnected(child)
                self.error = '桌面原生侧边聊天未通过核验或保存失败'
                try:
                    self.ipc.follow(child, owner, False, host=self.host)
                except (OSError, IPCError):
                    pass

    def disconnect(self):
        with self.lock:
            children = list(self.states)
            self.states.clear()
            self.needs_snapshot.clear()
            self.following.clear()
        for child in children:
            self.mark_disconnected(child)
        # Routing files may not change while the owner reconnects.
        self.offsets.clear()

    def status(self):
        with self.lock:
            count = len(self.states.keys()-self.needs_snapshot)
            return {'state': 'connected' if count else 'unavailable', 'savedAt': self.last_saved,
                    'message': self.error or ('已接入 '+str(count)+' 条原生侧边聊天' if count else '桌面原生侧边聊天未接入')}

    def close(self):
        self.closed.set()
        self.ipc.close()
        if self.worker:
            self.worker.join(timeout=8)
        self.disconnect()
