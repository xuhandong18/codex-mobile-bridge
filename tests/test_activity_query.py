"""Bounded passive activity queries; synthetic desktops and HTTP only."""
import threading
import time
import unittest
from concurrent.futures import Future, ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock, patch

from bridge.features.sessions.activity import ActivityQueries
import test_bridge


class ActivityQueryTests(unittest.TestCase):
    def reader(self, callback):
        reader = ActivityQueries(callback)
        self.addCleanup(reader.close)
        return reader

    def test_concurrent_identical_queries_wait_for_one_fresh_result(self):
        entered, release, joined = threading.Event(), threading.Event(), threading.Event()
        count = []
        class ObservedFuture(Future):
            def result(self, timeout=None):
                count.append(1)
                if len(count) == 2:
                    joined.set()
                return super().result(timeout)
        def read(ids, deadline):
            entered.set();release.wait(1)
            return [{'id': ids[0], 'status': 'idle'}]
        callback = Mock(side_effect=read)
        reader = self.reader(callback)
        with patch('bridge.features.sessions.activity.Future', ObservedFuture), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(reader.query, ['chat', 'chat'], .8)
            self.assertTrue(entered.wait(.3))
            second = pool.submit(reader.query, ['chat'], .8)
            try:
                self.assertTrue(joined.wait(.3))
                self.assertFalse(first.done());self.assertFalse(second.done())
            finally:
                release.set()
            self.assertEqual(first.result(), second.result())
        callback.assert_called_once()

    def test_a_later_query_does_not_reuse_the_completed_result(self):
        callback = Mock(side_effect=lambda ids, deadline: [{'status': 'active' if callback.call_count == 1 else 'idle'}])
        reader = self.reader(callback)
        self.assertEqual(reader.query(['chat'])[0]['status'], 'active')
        self.assertEqual(reader.query(['chat'])[0]['status'], 'idle')
        self.assertEqual(callback.call_count, 2)

    def test_a_new_visible_chat_does_not_queue_behind_an_unrelated_slow_query(self):
        entered, release = threading.Event(), threading.Event()
        def read(ids, deadline):
            if ids == ['old']:
                entered.set();release.wait(1)
            return [{'id': ids[0], 'status': 'idle'}]
        reader = self.reader(read)
        with ThreadPoolExecutor(max_workers=1) as pool:
            older = pool.submit(reader.query, ['old'], .8)
            try:
                self.assertTrue(entered.wait(.3))
                self.assertEqual(reader.query(['new'], .15)[0]['id'], 'new')
                self.assertFalse(older.done(), 'The original slow request should still be blocked')
            finally:
                release.set();older.result(1)

    def test_parallel_queries_stay_bounded_and_a_freed_slot_serves_the_next_query(self):
        entered = {sid: threading.Event() for sid in ('one', 'two', 'three')}
        releases = {sid: threading.Event() for sid in ('one', 'two')}
        queued, callers = threading.Event(), []
        class ObservedFuture(Future):
            def result(self, timeout=None):
                callers.append(1)
                if len(callers) == 3:
                    queued.set()
                return super().result(timeout)
        def read(ids, deadline):
            sid = ids[0];entered[sid].set()
            if sid in releases:
                releases[sid].wait(1)
            return [{'id': sid, 'status': 'idle'}]
        reader = self.reader(read);reader.MAX_WORKERS = 2
        with patch('bridge.features.sessions.activity.Future', ObservedFuture), ThreadPoolExecutor(max_workers=3) as pool:
            first = pool.submit(reader.query, ['one'], .8)
            second = pool.submit(reader.query, ['two'], .8)
            third = None
            try:
                self.assertTrue(entered['one'].wait(.3));self.assertTrue(entered['two'].wait(.3))
                third = pool.submit(reader.query, ['three'], .8)
                self.assertTrue(queued.wait(.3));self.assertFalse(entered['three'].is_set())
                releases['one'].set()
                self.assertEqual(third.result(.3)[0]['id'], 'three')
                self.assertFalse(second.done())
            finally:
                for event in releases.values():event.set()
                first.result(1);second.result(1)
                if third is not None:third.result(1)

    def test_timeout_bounds_the_request_even_if_native_io_has_not_returned(self):
        entered, release = threading.Event(), threading.Event()
        def read(ids, deadline):
            entered.set();release.wait(1);return [{'status': 'idle'}]
        callback = Mock(side_effect=read);reader = self.reader(callback)
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                reader.query(['chat'], .04)
            self.assertTrue(entered.is_set());self.assertLess(time.monotonic()-started, .3)
            with self.assertRaises(TimeoutError):
                reader.query(['chat'], .04)
            callback.assert_called_once()
        finally:
            release.set()
            for worker in tuple(reader.workers):
                worker.join(1)

    def test_queued_query_expires_without_starting_extra_native_io(self):
        entered, release = threading.Event(), threading.Event()
        def read(ids, deadline):
            entered.set();release.wait(1);return []
        callback = Mock(side_effect=read);reader = self.reader(callback);reader.MAX_WORKERS = 1
        try:
            with self.assertRaises(TimeoutError):
                reader.query(['first'], .03)
            with self.assertRaises(TimeoutError):
                reader.query(['second'], .03)
        finally:
            release.set()
            for worker in tuple(reader.workers):
                worker.join(1)
        callback.assert_called_once()

    def test_closing_wakes_waiters_and_discards_a_late_result(self):
        entered, release = threading.Event(), threading.Event()
        def read(ids, deadline):
            entered.set();release.wait(1);return []
        reader = self.reader(read)
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(reader.query, ['chat'], .8)
            try:
                self.assertTrue(entered.wait(.3));reader.close()
                with self.assertRaises(TimeoutError):
                    waiting.result(.3)
            finally:
                release.set()
        with self.assertRaises(TimeoutError):
            reader.query(['chat'])


class ActivityHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    tearDownClass = classmethod(test_bridge.HttpTests.tearDownClass.__func__)
    setUp = test_bridge.HttpTests.setUp
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_single_http_request_waits_for_the_desktop_result_and_leaves_other_routes_available(self):
        headers = self.login();entered, release = threading.Event(), threading.Event()
        def read(ids, timeout):
            entered.set();release.wait(1)
            return [{'id': ids[0], 'host': 'local', 'status': 'idle'}]
        source = SimpleNamespace(activity=Mock(side_effect=read))
        with patch.object(self.server.bridge, 'for_host', return_value=source), ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(self.request, 'POST', '/api/activity', {'hosts': {'local': ['chat']}}, headers)
            try:
                self.assertTrue(entered.wait(.3));self.assertFalse(waiting.done())
                self.assertEqual(self.request('GET', '/api/auth')[0], 200)
            finally:
                release.set()
            status, _, result = waiting.result(1)
        self.assertEqual(status, 200);self.assertEqual(result['sessions'][0]['status'], 'idle')
        self.assertFalse(result['timedOut']);source.activity.assert_called_once()

    def test_multiple_hosts_share_one_request_deadline(self):
        headers = self.login();release = threading.Event();entered = [threading.Event(), threading.Event()]
        def source(host, index):
            def read(ids, timeout):
                entered[index].set();release.wait(1);return []
            return SimpleNamespace(activity=Mock(side_effect=read), activity_timeout_rows=lambda ids: [
                {'id': sid, 'host': host, 'status': 'unknown', 'activityError': 'timeout'} for sid in ids])
        sources = {'local': source('local', 0), 'ssh': source('ssh', 1)}
        started = time.monotonic()
        try:
            with patch.object(self.server.bridge, 'for_host', side_effect=sources.__getitem__), \
                    patch.object(ActivityQueries, 'TIMEOUT', .08):
                status, _, result = self.request('POST', '/api/activity', {'hosts': {'local': ['a'], 'ssh': ['b']}}, headers)
            self.assertEqual(status, 200);self.assertTrue(result['timedOut'])
            self.assertTrue(all(event.is_set() for event in entered));self.assertEqual(len(result['sessions']), 2)
            self.assertLess(time.monotonic()-started, .4)
        finally:
            release.set()

    def test_activity_still_requires_login_csrf_and_valid_identifiers(self):
        value = {'hosts': {'local': ['chat']}};headers = self.login()
        self.assertEqual(self.request('POST', '/api/activity', value)[0], 401)
        self.assertEqual(self.request('POST', '/api/activity', value, {'Cookie': headers['Cookie']})[0], 403)
        for ids in (None, 'chat', [{}], ['chat']*501):
            self.assertEqual(self.request('POST', '/api/activity', {'hosts': {'local': ids}}, headers)[0], 400)
