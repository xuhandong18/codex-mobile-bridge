"""A read acknowledgement identifies exactly the terminal turn the user saw."""
import uuid


def validate_read_state(body, *, codex=False):
    fields = {'id', 'turnId', 'turnStatus'} | ({'host'} if codex else set())
    if not isinstance(body, dict) or set(body) != fields:
        raise ValueError('聊天已读参数无效')
    if not isinstance(body['id'], str):
        raise ValueError('聊天已读操作标识无效')
    uuid.UUID(body['id'])
    if (not isinstance(body['turnId'], str) or not 0 < len(body['turnId']) <= 512
            or body['turnStatus'] not in ('completed', 'failed', 'interrupted')):
        raise ValueError('只能同步已经查看的已结束轮次')
    if codex and (not isinstance(body['host'], str) or not body['host']):
        raise ValueError('聊天主机无效')
