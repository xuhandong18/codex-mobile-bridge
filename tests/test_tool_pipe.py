import unittest
from unittest.mock import patch

from bridge.platforms.windows.tool_pipe import endpoints


class ToolPipeDiscoveryTests(unittest.TestCase):
    def test_current_app_tool_endpoint_is_not_starved_by_unrelated_browser_pipes(self):
        pipes = [f'codex-browser-use-{i}' for i in range(48)] + ['codex-app-tools-current', 'unrelated']
        with patch('bridge.platforms.windows.tool_pipe.os.listdir', return_value=pipes):
            found = endpoints()
        self.assertEqual(found[0], r'\\.\pipe\codex-app-tools-current')
        self.assertLessEqual(len(found), 32)
        self.assertFalse(any(name.endswith('unrelated') for name in found))
