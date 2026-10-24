"""Installation hints never replace fresh desktop/profile verification."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from bridge.clients.codex.activity import ActivityTools
from bridge.clients.codex.desktop_tools import ToolError


class DesktopToolProfileTests(unittest.TestCase):
    def setUp(self):
        self.folder = self.enterContext(TemporaryDirectory())
        self.gui = Path(self.folder)/'ChatGPT.exe'
        self.gui.touch()
        self.bridge = SimpleNamespace(
            codex_home=Path(self.folder)/'profile',
            accounts=SimpleNamespace(index={}),
            catalog_reader=SimpleNamespace(executable=Path(self.folder)/'codex.exe'),
            hosts=SimpleNamespace(projects=Mock(return_value=[{'host': 'local', 'key': 'local|project'}])),
            store=SimpleNamespace(list=Mock(return_value=[{'id': 'context'}])))
        self.scan = self.enterContext(patch('bridge.clients.desktop_app.DesktopApp.scan', return_value=str(self.gui)))
        self.connect = self.enterContext(patch.object(ActivityTools, 'connect', return_value=Mock()))

    def test_repeated_reads_skip_installation_scan_but_reverify_the_connection_and_profile(self):
        ActivityTools.connect_profile(self.bridge, timeout=5)
        self.bridge.hosts.projects.return_value = [{'host': 'local', 'key': 'local|new-project'}]
        self.bridge.store.list.return_value = [{'id': 'new-context'}]
        ActivityTools.connect_profile(self.bridge, timeout=5)
        self.scan.assert_called_once()
        self.assertEqual(self.connect.call_count, 2)
        self.assertEqual(self.connect.call_args.args, (str(self.gui), 'new-context', {'new-project'}))

    def test_slow_discovery_cannot_extend_deadline_but_next_query_reuses_its_path(self):
        clock = [100.0]
        def slow_scan(*args):
            clock[0] += 6
            return str(self.gui)
        self.scan.side_effect = slow_scan
        with patch('bridge.clients.codex.desktop_tools.time.monotonic', side_effect=lambda: clock[0]):
            with self.assertRaises(ToolError):
                ActivityTools.connect_profile(self.bridge, timeout=5)
            self.connect.assert_not_called()
            ActivityTools.connect_profile(self.bridge, timeout=5)
        self.scan.assert_called_once()
        self.assertEqual(self.connect.call_args.kwargs, {'timeout': 5})

    def test_removed_application_is_discovered_again(self):
        ActivityTools.connect_profile(self.bridge)
        self.gui.unlink()
        replacement = Path(self.folder)/'new-ChatGPT.exe'
        replacement.touch()
        self.scan.return_value = str(replacement)
        ActivityTools.connect_profile(self.bridge)
        self.assertEqual(self.scan.call_count, 2)
        self.assertEqual(self.connect.call_args.args[0], str(replacement))

    def test_changed_runtime_discards_automatic_hint(self):
        ActivityTools.connect_profile(self.bridge)
        self.bridge.catalog_reader.executable = Path(self.folder)/'new-codex.exe'
        ActivityTools.connect_profile(self.bridge)
        self.assertEqual(self.scan.call_count, 2)

    def test_explicit_selection_always_takes_precedence(self):
        ActivityTools.connect_profile(self.bridge)
        self.bridge.accounts.index['desktopExecutable'] = 'selected.exe'
        ActivityTools.connect_profile(self.bridge)
        self.scan.assert_called_once()
        self.assertEqual(self.connect.call_args.args[0], 'selected.exe')

    def test_failed_connection_invalidates_hint_without_retrying_inside_the_request(self):
        ActivityTools.connect_profile(self.bridge)
        self.connect.side_effect = ToolError('different desktop identity')
        with self.assertRaises(ToolError):
            ActivityTools.connect_profile(self.bridge)
        self.assertEqual(self.connect.call_count, 2)
        self.scan.assert_called_once()
        self.connect.side_effect = None
        ActivityTools.connect_profile(self.bridge)
        self.assertEqual(self.scan.call_count, 2)

    def test_hint_cannot_bypass_missing_profile_context(self):
        ActivityTools.connect_profile(self.bridge)
        self.bridge.store.list.return_value = []
        with self.assertRaises(ToolError):
            ActivityTools.connect_profile(self.bridge)
        self.connect.assert_called_once()
