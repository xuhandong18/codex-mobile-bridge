"""Background conversation-time index. This cache is never execution authority."""
from collections import deque
import json
import logging
import os
from pathlib import Path
import threading


class RecencyIndex:
    VERSION = 2
    BATCH = 16

    def __init__(self, store, path=None):
        self.store, self.path = store, Path(path) if path else None
        self.lock = threading.RLock()
        self.save_lock = threading.Lock()
        self.worker = None
        self.closed = False
        self.priority = set()
        self.records, self.writes = {}, {}
        if self.path:
            try:
                value = json.loads(self.path.read_text(encoding='utf-8'))
                if value.get('version') == self.VERSION:
                    self.records = {sid:row for sid,row in value.get('records', {}).items()
                                    if isinstance(row, dict) and type(row.get('at')) is int and row['at'] >= 0}
                    self.writes = {sid:at for sid,at in value.get('writes', {}).items() if type(at) is int and at >= 0}
            except (OSError, ValueError, TypeError, AttributeError):
                pass

    def snapshot(self):
        with self.lock:
            result = {sid:row['at'] for sid,row in self.records.items() if row['at']}
            for sid, at in self.writes.items():
                result[sid] = max(at, result.get(sid, 0))
            return result

    def record(self, identifier, at):
        # Native event callbacks only touch memory; no file IO under owner locks.
        with self.lock:
            if not self.closed:
                self.writes[identifier] = max(int(at), self.writes.get(identifier, 0))

    def request(self, identifiers=()):
        with self.lock:
            if self.closed:
                return
            self.priority.update(identifiers)
            if self.worker and self.worker.is_alive():
                return
            self.worker = threading.Thread(target=self._refresh, daemon=True)
            self.worker.start()

    @staticmethod
    def _fingerprint(row):
        # Generic updated_at is a dirty signal only, never the sorting result.
        return [row.get(key) for key in ('rollout_path', 'rollout_size', 'rollout_mtime_ns', 'updated_at_ms', 'updated_at')]

    def _refresh(self):
        try:
            inventory = {row['id']:row for row in self.store.recency_inventory()}
            with self.lock:
                if self.closed:
                    return
                requested, self.priority = self.priority, set()
                candidates = [sid for sid,row in inventory.items()
                              if sid in requested or sid not in self.records
                              or self.records[sid].get('source') != self._fingerprint(row)
                              or not self.records[sid].get('complete') or self.records[sid].get('pending')]
            candidates.sort(key=lambda sid:(sid in requested,
                inventory[sid].get('updated_at_ms') or (inventory[sid].get('updated_at') or 0)*1000), reverse=True)
            queue, queued = deque(candidates), set(candidates)
            while queue:
                with self.lock:
                    if self.closed:
                        return
                    for sid in self.priority:
                        if sid in inventory and sid not in queued:
                            queue.appendleft(sid);queued.add(sid)
                    self.priority.clear()
                    batch = [queue.popleft() for _ in range(min(self.BATCH, len(queue)))]
                    checkpoints = {sid:self.records[sid]['checkpoint'] for sid in batch
                                   if sid in self.records and self.records[sid].get('checkpoint')}
                values = self.store.message_recencies(batch, checkpoints)
                with self.lock:
                    if self.closed:
                        return
                    for sid in batch:
                        value = values.get(sid)
                        if not isinstance(value, dict) or type(value.get('at')) is not int:
                            continue
                        self.records[sid] = {**value, 'source':self._fingerprint(inventory[sid])}
                        if not value.get('complete') and value.get('checkpoint') != checkpoints.get(sid):
                            queue.append(sid)
            self._save()
        except (OSError, ValueError, KeyError, TypeError, RuntimeError) as exc:
            # Keep the last verified value. No content or paths are logged.
            logging.getLogger(__name__).debug('Conversation-time index refresh unavailable: %s', type(exc).__name__)

    def _save(self):
        if not self.path:
            return
        with self.save_lock:
            self._save_locked()

    def _save_locked(self):
        with self.lock:
            if self.closed:
                return
            value = {'version':self.VERSION, 'records':dict(self.records), 'writes':dict(self.writes)}
        encoded = json.dumps(value, ensure_ascii=False)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        try:
            with os.fdopen(os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600), 'w', encoding='utf-8') as stream:
                stream.write(encoded)
            with self.lock:
                if not self.closed:
                    temporary.replace(self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def wait(self, timeout=None):
        with self.lock:
            worker = self.worker
        if worker and worker is not threading.current_thread():
            worker.join(timeout)

    def close(self):
        self._save()
        with self.lock:
            self.closed = True
        self.wait(2)
