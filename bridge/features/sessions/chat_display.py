"""Gateway-owned conversation display preferences; no native session actions."""
import threading
from pathlib import Path

from bridge.features.notifications.channels import read_json, write_json


class ChatDisplaySettings:
    FIELDS = {'showProcess', 'showReasoning'}

    def __init__(self, directory):
        self.path = Path(directory) / 'chat-display.json' if directory else None
        self.lock = threading.RLock()
        self.state = read_json(self.path, {'revision': 0, 'settings': {}}) if self.path else {'revision': 0, 'settings': {}}

    def read(self):
        with self.lock:
            return {'revision': self.state['revision'], 'settings': dict(self.state['settings'])}

    def save(self, body):
        if (not isinstance(body, dict) or set(body) != {'revision', 'changes'}
                or type(body['revision']) is not int or not 0 <= body['revision'] < 2 ** 53
                or not isinstance(body['changes'], dict) or not body['changes']
                or body['changes'].keys() - self.FIELDS
                or any(type(value) is not bool for value in body['changes'].values())):
            raise ValueError('对话显示设置格式无效')
        with self.lock:
            if body['revision'] != self.state['revision']:
                return 409, {'error': '对话显示设置已在其他设备修改，请核对后重试。', **self.read()}
            state = {'revision': self.state['revision'] + 1, 'settings': {**self.state['settings'], **body['changes']}}
            if self.path:
                write_json(self.path, state)
            self.state = state
            return 200, self.read()
