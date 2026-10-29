"""Read bounded ASAR members without modifying the installed application."""
import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType


PROFILES = {
    '26.1021.31345': {
        'modules': {'primary': 'assets/app-primary-844e405f2b90.js',
                    'initial': 'assets/app-initial-438d1df57f70.js'},
        'sha256': {
            'webview/assets/app-primary-844e405f2b90.js':
                '298f4c7bafe278563aa82ef8d8d4c1afe3f581d54915917849065085f7f621d2',
            'webview/assets/app-initial-438d1df57f70.js':
                'd7b10b8bc54277eb3cb3a7a742c5b4c054a640530bbb7c1878e17097c0fc6d01',
        },
    },
}
MAX_HEADER = 8 * 1024 * 1024
MAX_MEMBER = 16 * 1024 * 1024


class UnsupportedInstallation(ValueError):
    pass


@dataclass(frozen=True)
class Installation:
    executable: Path
    archive: Path
    version: str
    modules: object


def inspect_installation(executable):
    executable = Path(executable).resolve()
    archive = executable.parent / 'resources/app.asar'
    try:
        if not executable.is_file():
            raise ValueError('missing executable')
        with archive.open('rb') as stream:
            before = archive.stat()
            raw = stream.read(16)
            if len(raw) != 16:
                raise ValueError('incomplete header')
            _, header_size, _, json_size = struct.unpack('<4I', raw)
            if not 0 < json_size <= MAX_HEADER or not json_size + 8 <= header_size <= json_size + 16:
                raise ValueError('invalid header')
            base = header_size + 8
            tree = json.loads(stream.read(json_size))

            def member(name, maximum=MAX_MEMBER):
                node = tree
                for part in name.split('/'):
                    node = node['files'][part]
                size, offset = node['size'], int(node['offset'])
                if (node.get('unpacked') or 'link' in node or type(size) is not int or
                        not 0 < size <= maximum or offset < 0 or base + offset + size > before.st_size):
                    raise ValueError('invalid member range')
                stream.seek(base + offset)
                result = stream.read(size)
                if len(result) != size:
                    raise ValueError('incomplete member')
                return result

            metadata = json.loads(member('package.json', 64 * 1024))
            if metadata.get('name') != 'openai-codex-electron':
                raise UnsupportedInstallation('所选程序不是已核验的 Codex / ChatGPT 桌面')
            version = metadata.get('version')
            profile = PROFILES.get(version)
            if profile is None:
                raise UnsupportedInstallation('当前 ChatGPT 桌面版本尚未适配')
            required = {'webview/' + name for name in profile['modules'].values()}
            if required != set(profile['sha256']):
                raise ValueError('incomplete profile')
            for name, expected in profile['sha256'].items():
                if hashlib.sha256(member(name)).hexdigest() != expected:
                    raise UnsupportedInstallation('ChatGPT 桌面模块指纹不匹配，尚未连接')
            after = archive.stat()
            if ((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) !=
                    (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
                raise UnsupportedInstallation('ChatGPT 桌面正在更新，请稍后重新核验')
        return Installation(executable, archive, version, MappingProxyType(dict(profile['modules'])))
    except UnsupportedInstallation:
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError, struct.error) as exc:
        raise UnsupportedInstallation('无法核验 ChatGPT 安装包，尚未连接') from exc
