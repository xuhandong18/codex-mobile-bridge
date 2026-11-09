import concurrent.futures
import json
import tempfile
import unittest
from pathlib import Path

from bridge.features.sessions.sidebar_preferences import SidebarPreferences
from bridge.clients.codex.remote import AppHosts
from relay.protocol import validate
import test_bridge


ROOT = Path(__file__).resolve().parents[1]
PIN = json.dumps(['pin', 'local|project', 'chat'], separators=(',', ':'))
ORDER = json.dumps(['order', 'work'], separators=(',', ':'))
PLACEMENT = json.dumps(['placement', 'project', 'local', 'local|project'], separators=(',', ':'))


def change(key=PIN, value=True, version=0):
    return {'key': key, 'value': value, 'version': version}


class SidebarPreferenceStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / '.tmp')
        self.store = SidebarPreferences(self.temp.name)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_pin_project_order_and_placement_survive_restart(self):
        status, saved = self.store.save({'changes': [change(), change(ORDER, ['local|b', 'local|a']),
                                                    change(PLACEMENT, {'target': 'section:work'})]})
        self.assertEqual(status, 200)
        self.store.close()
        self.store = SidebarPreferences(self.temp.name)
        self.assertEqual(self.store.read(), saved)
        self.assertEqual(saved['fields'][PIN]['value'], True)

    def test_stale_device_cannot_overwrite_a_changed_setting(self):
        self.store.save({'changes': [change()]})
        self.assertEqual(self.store.save({'changes': [change(value=False)]})[0], 409)
        self.assertTrue(self.store.read()['fields'][PIN]['value'])

    def native_sidebar(self, target='home'):
        return {'projects': [{'key': 'local|project', 'host': 'local'}],
                'sections': [{'id': 'money', 'itemKeys': ['codex:project:project'] if target == 'section:money' else []}],
                'pinnedProjectIds': ['project'] if target == 'pinned' else []}

    def test_desktop_move_clears_legacy_pin_and_retains_a_deletion_version(self):
        self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned', 'previous': 'home'})]})
        self.store.close()
        sidebar = self.native_sidebar()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        self.assertEqual(self.store.read()['fields'][PLACEMENT]['value']['target'], 'pinned')
        sidebar.update(self.native_sidebar('section:money'))
        snapshot = self.store.read()
        self.assertIsNone(snapshot['fields'][PLACEMENT]['value'], '桌面移到赚钱分区后，旧网关置顶必须让位')
        self.assertEqual(snapshot['fields'][PLACEMENT]['version'], 2)
        self.assertEqual(snapshot['revision'], 2)
        self.assertEqual(self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned', 'previous': 'home'})]})[0], 409)

    def test_new_pin_survives_refresh_but_desktop_moves_clear_it_permanently(self):
        sidebar = self.native_sidebar('section:money')
        self.store.close()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned', 'previous': 'section:money'})]})
        self.assertEqual(self.store.read()['fields'][PLACEMENT]['value']['target'], 'pinned')
        self.store.close()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        self.assertEqual(self.store.read()['fields'][PLACEMENT]['value']['target'], 'pinned')
        sidebar.update(self.native_sidebar('home'))
        self.assertIsNone(self.store.read()['fields'][PLACEMENT]['value'])
        sidebar.update(self.native_sidebar('section:money'))
        self.assertIsNone(self.store.read()['fields'][PLACEMENT]['value'], '桌面移回来也不能恢复旧置顶')

    def test_desktop_changes_only_reset_the_affected_project_placement(self):
        sidebar = self.native_sidebar()
        self.store.close()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        thread = json.dumps(['placement', 'thread', 'local', 'chat'], separators=(',', ':'))
        self.store.save({'changes': [change(PLACEMENT, {'target': 'section:money'}),
                                    change(thread, {'target': 'pinned'}), change(), change(ORDER, ['local|project'])]})
        sidebar.update(self.native_sidebar('pinned'))
        snapshot = self.store.read()['fields']
        self.assertIsNone(snapshot[PLACEMENT]['value'])
        self.assertEqual(snapshot[thread]['value'], {'target': 'pinned'})
        self.assertTrue(snapshot[PIN]['value'])
        self.assertEqual(snapshot[ORDER]['value'], ['local|project'])

    def test_unavailable_native_project_does_not_clear_verified_preferences(self):
        sidebar = self.native_sidebar()
        self.store.close()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        _, saved = self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned', 'previous': 'home'})]})
        for missing in ({}, {'projects': [], 'sections': [], 'pinnedProjectIds': []},
                        {**self.native_sidebar('section:money'), 'sectionsAvailable': False}):
            sidebar.clear()
            sidebar.update(missing)
            self.assertEqual(self.store.read(), saved)
        sidebar.clear()
        sidebar.update(self.native_sidebar('section:money'))
        self.assertIsNone(self.store.read()['fields'][PLACEMENT]['value'])

    def test_legacy_pin_from_a_display_override_is_not_mistaken_for_a_desktop_move(self):
        self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned', 'previous': 'home'})]})
        self.store.close()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: self.native_sidebar('section:money'))
        self.assertEqual(self.store.read()['fields'][PLACEMENT]['value']['target'], 'pinned')

    def test_two_listeners_reconcile_a_desktop_move_only_once(self):
        sidebar = self.native_sidebar()
        self.store.close()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned'})]})
        other = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        try:
            sidebar.update(self.native_sidebar('section:money'))
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                snapshots = list(pool.map(lambda store: store.read(), (self.store, other)))
            self.assertEqual(snapshots[0], snapshots[1])
            self.assertEqual(snapshots[0]['fields'][PLACEMENT], {'value': None, 'version': 2})
            self.assertEqual(snapshots[0]['revision'], 2)
        finally:
            other.close()

    def test_a_new_explicit_choice_after_a_desktop_move_uses_the_new_baseline(self):
        sidebar = self.native_sidebar()
        self.store.close()
        self.store = SidebarPreferences(self.temp.name, native_sidebar=lambda: sidebar)
        self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned', 'previous': 'home'})]})
        sidebar.update(self.native_sidebar('section:money'))
        status, result = self.store.save({'changes': [change(PLACEMENT, {'target': 'home'}, 1)]})
        self.assertEqual(status, 409)
        self.assertIsNone(result['fields'][PLACEMENT]['value'])
        self.assertEqual(self.store.save({'changes': [change(PLACEMENT, {'target': 'pinned', 'previous': 'section:money'}, 2)]})[0], 200)
        self.assertEqual(self.store.read()['fields'][PLACEMENT]['value']['target'], 'pinned')

    def test_independent_devices_merge_different_pins_and_placements(self):
        keys = [json.dumps(['pin', 'ssh|project', str(i)], separators=(',', ':')) for i in range(8)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda key: self.store.save({'changes': [change(key)]}), keys))
            conflicts = list(pool.map(lambda _: self.store.save({'changes': [change()]}), range(8)))
        self.assertTrue(all(status == 200 for status, _ in results))
        self.assertEqual(sum(status == 200 for status, _ in conflicts), 1)
        self.assertEqual(len(self.store.read()['fields']), 9)

    def test_cleared_values_retain_versions_to_prevent_old_device_import(self):
        self.store.save({'changes': [change(), change(PLACEMENT, {'target': 'pinned', 'previous': 'section:work'})]})
        self.store.save({'changes': [change(value=False, version=1), change(PLACEMENT, None, 1)]})
        self.assertEqual(self.store.save({'changes': [change()]})[0], 409)
        snapshot = self.store.read()['fields']
        self.assertFalse(snapshot[PIN]['value'])
        self.assertIsNone(snapshot[PLACEMENT]['value'])
        self.assertEqual(snapshot[PLACEMENT]['version'], 2)

    def test_conflicting_batch_is_atomic_and_does_not_remove_other_keys(self):
        self.store.save({'changes': [change()]})
        self.assertEqual(self.store.save({'changes': [change(), change(ORDER, ['local|b', 'local|a'])]})[0], 409)
        self.assertNotIn(ORDER, self.store.read()['fields'])
        self.assertEqual(self.store.save({'changes': [change(ORDER, ['local|b', 'local|a'])]})[0], 200)
        self.assertIn(PIN, self.store.read()['fields'])

    def test_gateway_host_kind_and_project_are_separate(self):
        self.store.save({'changes': [change()]})
        for parts in (['pin', 'ssh|project', 'chat'], ['pin', 'local|other', 'chat'],
                      ['placement', 'thread', 'local', 'chat']):
            self.assertNotIn(json.dumps(parts, separators=(',', ':')), self.store.read()['fields'])
        other = SidebarPreferences(None)
        try:
            self.assertEqual(other.read()['fields'], {})
        finally:
            other.close()

    def test_separate_connections_cannot_both_accept_the_same_version(self):
        stores = [SidebarPreferences(self.temp.name) for _ in range(4)]
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda store: store.save({'changes': [change()]}), stores))
            self.assertEqual(sum(status == 200 for status, _ in results), 1)
            self.assertEqual(self.store.read()['fields'][PIN]['version'], 1)
        finally:
            for store in stores:
                store.close()

    def test_invalid_keys_values_versions_and_excessive_batches_are_rejected(self):
        invalid = [change('not-json'), change(json.dumps(['native', 'execute'])),
                   change(value=1), change(ORDER, ['same', 'same']), change(ORDER, [1]),
                   change(PLACEMENT, {'target': 'section:'}), change(PLACEMENT, {'target': 'pinned', 'extra': True}),
                   change(version=True), change(version=-1), change(version=2 ** 53)]
        for row in invalid:
            with self.subTest(row=row), self.assertRaises(ValueError):
                self.store.save({'changes': [row]})
        for body in ({}, {'changes': []}, {'changes': [change()] * 1001}, {'changes': [change(), change()]}):
            with self.assertRaises(ValueError):
                self.store.save(body)
        self.assertEqual(self.store.read(), {'revision': 0, 'fields': {}})


class SidebarPreferenceHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_bridge.HttpTests.setUpClass.__func__)
    setUp = test_bridge.HttpTests.setUp
    tearDown = test_bridge.HttpTests.tearDown
    request = test_bridge.HttpTests.request
    login = test_bridge.HttpTests.login

    def test_a_desktop_move_reaches_both_devices_through_the_real_list_response(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.tmp') as directory:
            home = Path(directory)
            state = {'local-projects': {'project': {'id': 'project', 'name': 'QuantDinger-board',
                                                   'rootPaths': [r'D:\AI\QuantDinger-board']}},
                     'electron-persisted-atom-state': {'sidebar-custom-sections-v3': {'account': {
                         'sections': [{'id': 'money', 'name': '赚钱', 'itemKeys': []}]}}}}
            path = home / '.codex-global-state.json'
            path.write_text(json.dumps(state), encoding='utf-8')
            self.server.bridge.hosts = AppHosts(home)
            phone, computer = self.login(), self.login()
            status, _, _ = self.request('POST', '/api/sidebar-preferences', {'changes': [
                change(PLACEMENT, {'target': 'pinned', 'previous': 'home'})]}, phone)
            self.assertEqual(status, 200)
            route = '/api/sessions?scope=host&host=local&versioned=1'
            status, _, before = self.request('GET', route, headers=phone)
            self.assertEqual(status, 200)
            state['electron-persisted-atom-state']['sidebar-custom-sections-v3']['account']['sections'][0]['itemKeys'] = ['codex:project:project']
            path.write_text(json.dumps(state), encoding='utf-8')
            for device in (phone, computer):
                status, _, listing = self.request('GET', route + '&knownVersion=' + before['version'], headers=device)
                self.assertEqual(status, 200)
                self.assertFalse(listing.get('unchanged'))
                self.assertEqual(listing['sidebar']['sections'][0]['name'], '赚钱')
                self.assertIsNone(listing['sidebarPreferences']['fields'][PLACEMENT]['value'])
                self.assertEqual(listing['sidebarPreferences']['fields'][PLACEMENT]['version'], 2)

    def test_two_authenticated_devices_share_settings_with_no_native_operations(self):
        phone, computer = self.login(), self.login()
        status, _, saved = self.request('POST', '/api/sidebar-preferences', {'changes': [change()]}, phone)
        self.assertEqual(status, 200)
        status, _, read = self.request('GET', '/api/sidebar-preferences', headers=computer)
        self.assertEqual(status, 200)
        self.assertEqual(read, saved)
        self.assertFalse(hasattr(self.server.bridge, 'last_list'))
        status, _, listing = self.request('GET', '/api/sessions?scope=host&host=local', headers=computer)
        self.assertEqual(status, 200)
        self.assertEqual(listing['sidebarPreferences'], saved)
        status, _, _ = self.request('POST', '/api/sidebar-preferences', {'changes': [change(value=False)]}, computer)
        self.assertEqual(status, 409)

    def test_login_origin_and_csrf_are_required(self):
        body = {'changes': [change()]}
        self.assertEqual(self.request('GET', '/api/sidebar-preferences')[0], 401)
        self.assertEqual(self.request('POST', '/api/sidebar-preferences', body)[0], 401)
        headers = self.login()
        self.assertEqual(self.request('POST', '/api/sidebar-preferences', body, {'Cookie': headers['Cookie']})[0], 403)
        self.assertEqual(self.request('POST', '/api/sidebar-preferences', body, {**headers, 'Origin': 'https://foreign.example'})[0], 403)
        self.assertEqual(self.server.sidebar_preferences.read()['fields'], {})

    def test_shared_listener_retains_the_same_store_after_it_closes(self):
        from bridge.api.httpd import GatewayServer
        listener = GatewayServer(('127.0.0.1', 0), None, {}, ROOT / 'web', shared=self.server)
        self.assertIs(listener.sidebar_preferences, self.server.sidebar_preferences)
        listener.server_close()
        self.assertEqual(self.server.sidebar_preferences.read()['revision'], 0)

    def test_relay_allows_only_exact_preference_route(self):
        validate('GET', '/api/sidebar-preferences')
        validate('POST', '/api/sidebar-preferences', 100)
        for route in ['/api/sidebar-preferences/extra', '/api/sidebar-preferences/../sidebar-management']:
            with self.assertRaises(PermissionError):
                validate('POST', route, 100)
