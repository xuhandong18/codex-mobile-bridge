import json
import tempfile
import unittest
from pathlib import Path

from bridge.features.sessions.model import normalize_state
from bridge.features.sessions.store import SessionStore


class SessionSettingsDisplayTests(unittest.TestCase):
    def test_desktop_null_label_preserves_verified_xhigh_and_full_access(self):
        # Desktop sends a null summary label even when detailed settings and the
        # active collaboration mode explicitly select xhigh.
        view = normalize_state({'latestModel': 'gpt-6.1-sol', 'latestReasoningEffort': None,
            'latestThreadSettings': {'model': 'gpt-6.1-sol', 'effort': 'xhigh',
                'approvalPolicy': 'never', 'approvalsReviewer': 'user',
                'sandboxPolicy': {'type': 'dangerFullAccess'},
                'activePermissionProfile': {'id': ':danger-full-access', 'extends': None},
                'collaborationMode': {'mode': 'default', 'settings': {
                    'model': 'gpt-6.1-sol', 'reasoning_effort': 'xhigh'}}},
            'turns': [{'turnId': 't', 'params': {'model': None, 'effort': None,
                'collaborationMode': {'mode': 'default', 'settings': {
                    'model': 'gpt-6.1-sol', 'reasoning_effort': 'xhigh'}},
                'approvalPolicy': 'never', 'permissions': ':danger-full-access',
                'sandboxPolicy': {'type': 'dangerFullAccess'}}}]})
        self.assertEqual((view['model'], view['effort'], view['permissionMode']),
                         ('gpt-6.1-sol', 'xhigh', 'full-access'))
        self.assertEqual(view['turns'][0]['effort'], 'xhigh')

    def test_current_chat_null_effort_and_nonpreset_permissions_have_display_facts(self):
        view = normalize_state({'latestModel': 'gpt-6.1-sol', 'latestReasoningEffort': None,
            'turns': [{'turnId': 't', 'params': {'approvalPolicy': 'on-request',
                'sandboxPolicy': {'type': 'dangerFullAccess'}}}]})
        self.assertIsNone(view['effort'])
        self.assertEqual(view['permissionMode'], 'custom')
        self.assertEqual(view['permissionDetails'], {'sandbox': 'dangerFullAccess', 'approvalPolicy': 'on-request'})

    def test_current_labels_take_priority_over_fallback_settings(self):
        view = normalize_state({'latestModel': 'current-model', 'latestReasoningEffort': 'max',
            'latestThreadSettings': {'model': 'old-model', 'effort': 'low'},
            'turns': [{'turnId': 't', 'params': {'model': 'turn-model', 'effort': 'medium'}}]})
        self.assertEqual((view['model'], view['effort']), ('current-model', 'max'))

    def test_latest_turn_and_collaboration_settings_are_supported(self):
        for state in [
            {'turns': [{'turnId': 't', 'params': {'model': 'fixture-model', 'reasoningEffort': 'high'}}]},
            {'latestCollaborationMode': {'mode': 'plan', 'settings': {'model': 'fixture-model', 'reasoning_effort': 'high'}}},
        ]:
            with self.subTest(state=state):
                view = normalize_state(state)
                self.assertEqual((view['model'], view['effort']), ('fixture-model', 'high'))

    def test_unknown_values_are_not_invented_from_other_turns(self):
        view = normalize_state({'turns': [
            {'turnId': 'old', 'params': {'model': 'old-model', 'effort': 'high'}},
            {'turnId': 'new', 'params': {}}]})
        self.assertIsNone(view['model'])
        self.assertIsNone(view['effort'])
        self.assertEqual(view['permissionMode'], 'custom')

    def test_live_permissions_override_recorded_turn_permissions(self):
        view = normalize_state({'latestThreadSettings': {'approvalPolicy': 'on-request',
            'sandboxPolicy': {'type': 'workspaceWrite'}, 'approvalsReviewer': 'user'},
            'turns': [{'turnId': 't', 'params': {'approvalPolicy': 'never',
                'sandboxPolicy': {'type': 'dangerFullAccess'}}}]})
        self.assertEqual(view['permissionMode'], 'ask')

    def test_native_settings_without_top_level_labels_are_displayed(self):
        view = normalize_state({'latestThreadSettings': {
            'model': 'fixture-model', 'reasoningEffort': 'high',
            'approvalPolicy': 'never', 'sandboxPolicy': {'type': 'dangerFullAccess'}}})
        self.assertEqual(view['model'], 'fixture-model')
        self.assertEqual(view['effort'], 'high')
        self.assertEqual(view['permissionMode'], 'full-access')

    def test_saved_turn_context_keeps_model_effort_and_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            rollout = home / 'sessions' / 'fixture.jsonl'
            rollout.parent.mkdir()
            records = [
                {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't'}},
                {'type': 'turn_context', 'payload': {'model': 'fixture-model', 'effort': 'high',
                    'approval_policy': 'never', 'sandbox_policy': {'type': 'danger-full-access'}}},
                {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
            ]
            rollout.write_text('\n'.join(json.dumps(record) for record in records), encoding='utf-8')
            store = SessionStore(home)
            view = normalize_state(store._history('fixture', {'rollout_path': str(rollout), 'cwd': '/fixture'}), False)
            self.assertEqual(view['model'], 'fixture-model')
            self.assertEqual(view['effort'], 'high')
            self.assertEqual(view['permissionMode'], 'full-access')
            self.assertEqual(normalize_state(store._history('fixture', {'rollout_path': str(rollout), 'cwd': '/fixture'}), False)['permissionMode'], 'full-access')


if __name__ == '__main__':
    unittest.main()
