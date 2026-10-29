"""Bounded recovery of newly observed Codex capacity failures, via the original owner."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
from pathlib import Path
import threading
import time
import uuid

from bridge.features.notifications.channels import read_json


CAPACITY_MESSAGE = 'Selected model is at capacity. Please try a different model.'
LOG = logging.getLogger(__name__)


def capacity_error(error):
    if not isinstance(error, dict):
        return False
    code = error.get('codexErrorInfo')
    return code == 'serverOverloaded' if code is not None else error.get('message') == CAPACITY_MESSAGE


def _write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            temporary.chmod(0o600)
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def settings(directory):
    value = read_json(Path(directory) / 'codex-recovery.json', {'enabled': True})
    if not isinstance(value, dict) or type(value.get('enabled')) is not bool:
        raise ValueError('Codex 自动继续开关格式不正确')
    return {'enabled': value['enabled']}


def validate_settings(value):
    if not isinstance(value, dict) or set(value) != {'enabled'} or type(value['enabled']) is not bool:
        raise ValueError('Codex 自动继续开关格式不正确')
    return {'enabled': value['enabled']}


def save_settings(directory, value):
    _write(Path(directory) / 'codex-recovery.json', validate_settings(value))


def identity(row):
    return tuple(row.get(key) for key in ('owner', 'cwd', 'provider', 'runtime'))


class Recovery:
    INTERVAL = 600
    LIMIT = 3
    ACTIVE = ('waiting', 'sending', 'awaiting', 'tracking')

    def __init__(self, bridge, directory, *, clock=time.monotonic):
        self.bridge, self.directory, self.clock = bridge, Path(directory), clock
        self.path = self.directory / 'codex-recovery-ledger.json'
        self.records = read_json(self.path, {})
        # A restart establishes a fresh baseline, never replays pending writes.
        for record in self.records.values():
            if record['status'] in self.ACTIVE:
                record['status'] = 'unknown' if record['status'] == 'sending' else 'cancelled'
        self.lock = threading.RLock()
        self.events, self.seen, self.enqueued = deque(), {}, {}
        self.ran, self.failed = {}, {}
        self.enabled = None
        self.closed, self.wakeup = threading.Event(), threading.Event()
        self.executor = self.worker = self.discovery_worker = None
        self.futures = set()
        self.cursors, self.candidates, self.held = {}, {}, {}
        self.generation = 0

    @staticmethod
    def key(row):
        return row['host'] + '|' + row['id']

    def observe(self, row):
        """IPC callbacks enqueue only a small, deduplicated status projection."""
        with self.lock:
            if not self.enabled or self.closed.is_set():
                return
            key = self.key(row)
            if self.enqueued.get(key) == row:
                return
            self.enqueued[key] = dict(row)
            self.events.append(dict(row))
        self.wakeup.set()

    def intervene(self, host, identifier):
        with self.lock:
            record = self.records.get(host + '|' + identifier)
            if record and record['status'] in self.ACTIVE:
                record['status'] = 'cancelled'
                self.events.append({'cancel': True})
        self.wakeup.set()

    def _save(self):
        _write(self.path, self.records)

    def _finish(self, record, status='cancelled'):
        record['status'] = status
        record.pop('scheduled', None)
        self._save()

    def _handle(self, row):
        key = self.key(row)
        if not row['connected']:
            return  # A disconnected placeholder cannot establish a baseline.
        previous, self.seen[key] = self.seen.get(key), row
        if row['turnStatus'] == 'inProgress':
            self.ran[key] = row['turnId']
        if previous is None:
            if row['turnStatus'] == 'failed':
                self.failed[key] = row['turnId']
            return
        record = self.records.get(key)
        if identity(row) != identity(previous):
            if record and record['status'] in self.ACTIVE:
                self._finish(record)
            return
        if record and record['status'] == 'sending':
            return  # Reconcile the latest snapshot once the write returns.
        if record and record['status'] != 'cancelled':
            automatic_ids = {attempt['id'] for attempt in record['attempts']}
            last = record['attempts'][-1] if record['attempts'] else {}
            different_turn = row['turnId'] != record['turnId']
            automatic = row.get('requestId') in automatic_ids or bool(
                last.get('turnId') and last['turnId'] == row['turnId'])
            manual = bool(row.get('requestId') and row['requestId'] not in automatic_ids)
            if record['status'] in ('exhausted', 'unknown'):
                if not (different_turn and manual):
                    return
                self._finish(record)
            elif different_turn:
                if automatic:
                    record.update(turnId=row['turnId'], inputId=row['inputId'], status='tracking')
                    last['turnId'] = row['turnId']
                elif manual:
                    self._finish(record)
                elif row['active']:
                    return  # Wait for the user item or confirmed start-turn ID.
                else:
                    self._finish(record, 'unknown')
                    return
            elif record['status'] == 'awaiting':
                return  # The failed source turn is still visible after acceptance.
            elif row['inputId'] != record['inputId'] and record['inputId'] is not None:
                self._finish(record)
                return
            elif record['inputId'] is None:
                record['inputId'] = row['inputId']
            if record['status'] != 'cancelled':
                if row['waiting'] or row['turnStatus'] in ('completed', 'interrupted') or (
                        row['turnStatus'] == 'failed' and not row['overloaded']):
                    self._finish(record)
                elif row['active']:
                    record.update(status='tracking', due=None)
                    self._save()
                elif row['turnStatus'] == 'failed' and row['overloaded']:
                    if record['status'] != 'waiting':
                        self._schedule(record)
                return
        if record and record['status'] == 'cancelled' and any(
                row.get('requestId') == attempt['id'] or
                attempt.get('turnId') and row['turnId'] == attempt['turnId'] for attempt in record['attempts']):
            return  # A cancelled automatic continuation cannot create a fresh budget.
        fresh_failure = self.failed.get(key) != row['turnId'] and (
            row['turnId'] != previous['turnId'] or self.ran.get(key) == row['turnId'])
        if fresh_failure and row['turnId'] and row['turnStatus'] == 'failed' and row['overloaded'] and not (
                row['active'] or row['waiting']):
            record = {'host': row['host'], 'id': row['id'], 'cycle': str(uuid.uuid4()),
                      'turnId': row['turnId'], 'inputId': row['inputId'],
                      'identity': list(identity(row)), 'attempts': [], 'status': 'tracking'}
            self.records[key] = record
            self.failed[key] = row['turnId']
            self._schedule(record)

    def _schedule(self, record):
        count = len(record['attempts'])
        if count >= self.LIMIT:
            self._finish(record, 'exhausted')
            LOG.warning('Codex 自动继续已达三次，需人工处理 host=%s thread=%s turn=%s attempts=%s',
                        record['host'], record['id'], record['turnId'], count)
        else:
            record.update(status='waiting', due=self.clock() + (self.INTERVAL if count else 0))
            record.pop('scheduled', None)
            self._save()

    def scan(self):
        jobs = []
        try:
            enabled = settings(self.directory)['enabled']
        except (OSError, ValueError):
            enabled = False
            LOG.error('Codex 自动继续配置不可用，已停止自动处理')
        with self.lock:
            if enabled != self.enabled:
                self.enabled = enabled
                self.generation += 1
                self.seen.clear()
                self.ran.clear()
                self.failed.clear()
                self.enqueued.clear()
                self.events.clear()
                self.cursors.clear()
                self.candidates.clear()
                for record in self.records.values():
                    if record['status'] in self.ACTIVE and record['status'] != 'sending':
                        record['status'] = 'cancelled'
                self._save()
            while self.events:
                row = self.events.popleft()
                if row.get('cancel'):
                    self._save()
                else:
                    self._handle(row)
            if not enabled or self.closed.is_set():
                return
            for key, record in list(self.records.items()):
                if record['status'] == 'waiting' and not record.get('scheduled') and record['due'] <= self.clock():
                    expected = self.seen.get(key)
                    if expected is None or not expected['connected']:
                        continue
                    record['scheduled'] = True
                    jobs.append((record, dict(expected), self.generation))
        for job in jobs:
            if self.executor is None:
                self._attempt(*job)
            else:
                with self.lock:
                    if not self.closed.is_set():
                        future = self.executor.submit(self._attempt, *job)
                        self.futures.add(future)
                        future.add_done_callback(self._done)

    def _done(self, future):
        with self.lock:
            self.futures.discard(future)

    def _attempt(self, record, expected, generation):
        identifier, claimed = str(uuid.uuid4()), False

        def claim():
            nonlocal claimed
            with self.lock:
                if (self.closed.is_set() or not self.enabled or generation != self.generation or
                        not settings(self.directory)['enabled'] or record['status'] != 'waiting' or
                        record['due'] > self.clock() or record['turnId'] != expected['turnId'] or
                        len(record['attempts']) >= self.LIMIT or list(identity(expected)) != record['identity']):
                    return False
                record['attempts'].append({'id': identifier, 'status': 'unknown'})
                record['status'] = 'sending'
                self._save()
                claimed = True
                return True

        try:
            result = self.bridge.for_host(record['host']).recovery_send(expected, identifier, claim)
            with self.lock:
                if claimed:
                    attempt = record['attempts'][-1]
                    attempt['status'] = result['status']
                    if result.get('turnId'):
                        attempt['turnId'] = result['turnId']
                    if record['status'] != 'cancelled':
                        record['status'] = 'awaiting' if result['status'] == 'accepted' else 'unknown'
                    self._save()
                    LOG.info('Codex 自动继续 host=%s thread=%s turn=%s attempts=%s result=%s',
                             record['host'], record['id'], record['turnId'], len(record['attempts']), result['status'])
                    row = self.seen.get(self.key(record))
                    if row:
                        self._handle(row)
                elif result['status'] == 'unavailable':
                    record.update(due=self.clock() + 3)
                else:
                    self._finish(record)
        except Exception:
            with self.lock:
                if claimed:
                    self._finish(record, 'unknown')
                elif record['status'] == 'waiting':
                    record.update(due=self.clock() + 3)
            LOG.warning('Codex 自动继续已停止 host=%s thread=%s reason=%s',
                        record['host'], record['id'], 'unknown_write' if claimed else 'unavailable')
        finally:
            with self.lock:
                record.pop('scheduled', None)

    def start(self):
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='codex-recovery-send')
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.discovery_worker = threading.Thread(target=self._discover, daemon=True)
        self.worker.start()
        self.discovery_worker.start()

    def _run(self):
        while not self.closed.is_set():
            try:
                self.scan()
            except Exception:
                LOG.error('Codex 自动继续巡检失败，等待下一轮')
            self.wakeup.wait(3)
            self.wakeup.clear()

    def _discover(self):
        """Implemented with the bridge's passive subscription helpers."""
        while not self.closed.wait(3):
            try:
                self.discover()
            except Exception:
                LOG.warning('Codex 自动继续状态发现暂不可用')

    def discover(self):
        with self.lock:
            enabled, generation = self.enabled, self.generation
        if enabled and not self.closed.is_set():
            sources = [self.bridge]
            if self.bridge.host == 'local':
                for host in self.bridge.hosts.hosts():
                    try:
                        sources.append(self.bridge.for_host(host))
                    except (KeyError, OSError, ValueError):
                        LOG.warning('Codex 自动继续主机暂不可用 host=%s', host)
            for source in sources:
                source.recovery = self
                with self.lock:
                    cursor = self.cursors.setdefault(source.host, {'value': 0, 'boundary': set(), 'at': 0})
                    poll = self.clock() >= cursor['at']
                if poll:
                    try:
                        changes = source.store.notification_changes(cursor['value'])
                        with self.lock:
                            if generation != self.generation:
                                return
                            for row in changes:
                                if row['changed_at'] > cursor['value'] or row['id'] not in cursor['boundary']:
                                    self.candidates[(source.host, row['id'])] = source
                            value = max([cursor['value']] + [r['changed_at'] for r in changes])
                            cursor.update(value=value, boundary={r['id'] for r in changes if r['changed_at'] == value},
                                          at=self.clock() + 30)
                    except Exception:
                        cursor['at'] = self.clock() + 30
                        LOG.warning('Codex 自动继续元数据暂不可用 host=%s', source.host)
                with self.lock:
                    for key, row in self.seen.items():
                        if row['host'] == source.host and (row['active'] or
                                self.records.get(key, {}).get('status') in self.ACTIVE):
                            pair = (source.host, row['id'])
                            if pair not in self.held:
                                self.candidates[pair] = source
            # Bound cold probes, while existing live tasks remain independently subscribed.
            with self.lock:
                candidates = list(self.candidates.items())[:16]
            for (host, identifier), source in candidates:
                if self.closed.is_set() or generation != self.generation:
                    break
                with self.lock:
                    self.candidates.pop((host, identifier), None)
                try:
                    row = source.recovery_session(identifier)
                    self.held[(host, identifier)] = (source, self.clock() + 10)
                    self.observe(row)
                except Exception:
                    source.release_recovery_session(identifier)
                    LOG.info('Codex 自动继续跳过不可访问聊天 host=%s thread=%s', host, identifier)
        for key, (source, until) in list(self.held.items()):
            row = source.recovery_poll(key[1])
            if row:
                self.observe(row)
            with self.lock:
                record = self.records.get(key[0] + '|' + key[1], {})
                keep = self.enabled and not self.closed.is_set() and row and (
                    row['active'] or record.get('status') in self.ACTIVE or
                    row['connected'] and self.seen.get(self.key(row)) != row or
                    not row['connected'] and self.clock() < until)
            if not keep and source.release_recovery_session(key[1]):
                self.held.pop(key, None)

    def close(self):
        self.closed.set()
        self.wakeup.set()
        for worker in (self.worker, self.discovery_worker):
            if worker:
                worker.join(timeout=10)
        if self.executor:
            self.executor.shutdown(wait=True, cancel_futures=True)
        for (host, identifier), (source, _until) in list(self.held.items()):
            source.release_recovery_session(identifier)
