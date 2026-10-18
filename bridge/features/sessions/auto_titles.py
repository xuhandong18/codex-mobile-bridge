"""Bounded, once-per-chat title jobs. Reads never enqueue model requests."""
import hashlib
import json
import logging
import queue
import threading
from pathlib import Path


class AutoTitles:
    def __init__(self, directory):
        self.path = Path(directory) / 'auto-titles.json'
        self.lock = threading.RLock()
        self.jobs = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {}
        for row in self.jobs.values():
            if row['status'] in ('queued', 'running'):
                row['status'] = 'unknown'  # Never replay a pre-restart request.
        self.queue = queue.Queue(maxsize=32)
        self.cancels = {}
        self.worker = None
        self.closed = False

    def _save(self):
        target = self.path.with_suffix('.tmp')
        target.write_text(json.dumps(self.jobs, ensure_ascii=False), encoding='utf-8')
        target.chmod(0o600)
        target.replace(self.path)

    def protected(self, key):
        with self.lock:
            return self.closed or bool(self.jobs.get(key, {}).get('manual'))

    def protect(self, key):
        with self.lock:
            if self.closed:
                return
            row = self.jobs.setdefault(key, {})
            row.update(status='manual', manual=True)
            if key in self.cancels:
                self.cancels[key].set()
            self._save()

    def submit(self, key, text, generate, apply):
        with self.lock:
            if self.closed or key in self.jobs or self.queue.full() or not text.strip():
                return False
            cancel = self.cancels[key] = threading.Event()
            self.jobs[key] = {'status': 'queued', 'digest': hashlib.sha256(text.encode()).hexdigest()}
            self._save()  # Record before scheduling any external work.
            self.queue.put_nowait((key, generate, apply, cancel))
            if self.worker is None:
                self.worker = threading.Thread(target=self._run, daemon=True)
                self.worker.start()
            return True

    def _run(self):
        while True:
            task = self.queue.get()
            if task is None:
                return
            key, generate, apply, cancel = task
            with self.lock:
                if cancel.is_set():
                    self.cancels.pop(key, None)
                    continue
                self.jobs[key]['status'] = 'running'
                self._save()
            try:
                result = generate(cancel)
                applied = not cancel.is_set() and apply(result['title'])
                with self.lock:
                    if not self.jobs[key].get('manual'):
                        self.jobs[key].update(status='complete' if applied else 'skipped', **result)
            except Exception as error:
                with self.lock:
                    if not self.jobs[key].get('manual'):
                        self.jobs[key]['status'] = 'unknown'
                # The message may contain provider details. Log only the class.
                logging.getLogger(__name__).info('Automatic title stopped: %s', type(error).__name__)
            finally:
                with self.lock:
                    self.cancels.pop(key, None)
                    self._save()

    def close(self):
        with self.lock:
            self.closed = True
            for cancel in self.cancels.values():
                cancel.set()
            if self.worker:
                # Drain queued work, retaining its ledger so it cannot replay.
                while True:
                    try:
                        self.queue.get_nowait()
                    except queue.Empty:
                        break
                self.queue.put_nowait(None)
        if self.worker:
            self.worker.join(timeout=6)
