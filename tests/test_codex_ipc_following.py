"""Exercise subscription recovery through real length-prefixed IPC frames."""
import io
import json
import struct
import unittest

from bridge.clients.codex.ipc import DesktopIPC


def requested(host='local', identifier='chat', source='owner', **fields):
    return {'type': 'broadcast', 'sourceClientId': source,
            'method': 'thread-stream-following-status-requested', 'version': 1,
            'params': {'hostId': host, 'conversationId': identifier}, **fields}


class FramedSocket:
    def __init__(self, messages):
        frames = [json.dumps(message).encode() for message in messages]
        self.reader = io.BytesIO(b''.join(struct.pack('<I', len(frame)) + frame for frame in frames))
        self.sent = []

    def recv(self, length):
        return self.reader.read(length)

    def sendall(self, frame):
        self.sent.append(json.loads(frame[4:]))

    def close(self):
        pass


class FollowingRecoveryTests(unittest.TestCase):
    def run_stream(self, messages, subscriptions=(), on_event=None):
        sock = FramedSocket(messages)
        ipc = DesktopIPC('unused', on_event=on_event)
        ipc.client_id, ipc.socket = 'gateway', sock
        for host, identifier, owner in subscriptions:
            ipc.follow(identifier, owner, host=host)
        sock.sent.clear()
        ipc._read_loop(sock)
        return ipc, sock.sent

    def test_reannounces_existing_subscription_to_requesting_owner(self):
        events = []
        ipc, sent = self.run_stream([requested()], [('local', 'chat', None)], events.append)
        self.assertEqual(sent, [{
            'type': 'broadcast', 'sourceClientId': 'gateway',
            'method': 'thread-stream-following-changed', 'version': 1,
            'params': {'hostId': 'local', 'conversationId': 'chat', 'following': True},
            'targetClientIds': ['owner'],
        }])
        self.assertEqual(events, [requested()])
        self.assertEqual(ipc.following, {})  # Socket disconnect ends its subscriptions.

    def test_restores_remote_and_child_subscriptions_with_exact_host_and_owner(self):
        _, sent = self.run_stream([
            requested('remote:work', 'child'), requested('local', 'child'),
            requested('remote:work', 'child', 'another-owner'),
        ], [('remote:work', 'child', 'owner')])
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]['params'], {'hostId': 'remote:work', 'conversationId': 'child', 'following': True})
        self.assertEqual(sent[0]['targetClientIds'], ['owner'])

    def test_unknown_unfollowed_or_wrongly_targeted_requests_do_not_subscribe(self):
        _, sent = self.run_stream([
            requested(identifier='another-chat'), requested(targetClientIds=['another-client']),
            requested(version=2), requested(source=''),
        ], [('local', 'chat', 'owner')])
        self.assertEqual(sent, [])

    def test_cancellation_before_recovery_does_not_resurrect_subscription(self):
        sock = FramedSocket([requested()])
        ipc = DesktopIPC('unused')
        ipc.client_id, ipc.socket = 'gateway', sock
        ipc.follow('chat', 'owner')
        ipc.follow('chat', 'owner', False)
        sock.sent.clear()
        ipc._read_loop(sock)
        self.assertEqual(sock.sent, [])

    def test_malformed_status_requests_do_not_break_the_next_valid_frame(self):
        bad = [requested(params=value) for value in (['bad'], {'hostId': []}, {'hostId': 'local', 'conversationId': {}})]
        _, sent = self.run_stream([*bad, requested()], [('local', 'chat', 'owner')])
        self.assertEqual(len(sent), 1)

    def test_owner_reply_does_not_change_broadcast_subscription_identity(self):
        _, sent = self.run_stream([requested(), requested(source='new-owner')], [('local', 'chat', None)])
        self.assertEqual([value['targetClientIds'] for value in sent], [['owner'], ['new-owner']])
        self.assertTrue(all(value['type'] == 'broadcast' for value in sent))


if __name__ == '__main__':
    unittest.main()
