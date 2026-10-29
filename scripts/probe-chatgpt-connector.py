#!/usr/bin/env python3
"""Diagnose the original desktop; explicitly opt in to a fixed read-only probe."""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.clients.chatgpt.bootstrap import ProbeBlocked, existing_binding, launch_if_stopped, probe
from bridge.clients.chatgpt.connection import ProbeUnavailable
from bridge.clients.chatgpt.installation import UnsupportedInstallation, inspect_installation
from bridge.clients.codex.catalog import Catalog
from bridge.clients.desktop_app import DesktopApp
from bridge.platforms.windows.chatgpt import DebuggerUnavailable


def main():
    parser = argparse.ArgumentParser(description='Windows ChatGPT 第一阶段连接验证；不退出、不强杀原桌面')
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--probe', action='store_true', help='连接已启用调试的原窗口，执行固定读取探针')
    actions.add_argument('--launch-if-stopped', action='store_true', help='仅当原桌面已完全退出时带参数启动并验证')
    parser.add_argument('--thread', help='现有 ChatGPT 服务端聊天 ID；仅读取')
    parser.add_argument('--refresh', action='store_true', help='使用原生被动查询刷新指定聊天')
    parser.add_argument('--target-id', help='多个窗口时指定已确认的原应用调试目标')
    parser.add_argument('--executable', help='原 Codex / ChatGPT 桌面可执行文件')
    parser.add_argument('--codex-home', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')))
    args = parser.parse_args()
    if args.refresh and not args.thread:
        parser.error('--refresh 需要 --thread')
    if not (args.probe or args.launch_if_stopped) and (args.thread or args.refresh or args.target_id):
        parser.error('读取聊天需要 --probe 或 --launch-if-stopped')
    try:
        if sys.platform != 'win32':
            raise ProbeBlocked('第一阶段原生接入仅支持 Windows', state='unsupported')
        executable = args.executable or DesktopApp.scan(Catalog(args.codex_home).executable, args.codex_home)
        installation = inspect_installation(executable)
        if args.launch_if_stopped:
            launch_if_stopped(executable, args.codex_home)
        if args.probe or args.launch_if_stopped:
            result = asyncio.run(probe(executable, args.codex_home, thread_id=args.thread,
                                       refresh=args.refresh, target_id=args.target_id))
        else:
            binding = existing_binding(executable)
            result = {'state': 'debugger-available', 'version': installation.version,
                      'pid': binding.pid, 'runtimeGatePassed': False}
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get('runtimeGatePassed') else 3
    except ProbeBlocked as exc:
        print(json.dumps({'state': exc.state, 'reason': str(exc), 'runtimeGatePassed': False}, ensure_ascii=False))
    except (ProbeUnavailable, UnsupportedInstallation, DebuggerUnavailable) as exc:
        print(json.dumps({'state': 'blocked', 'reason': str(exc), 'runtimeGatePassed': False}, ensure_ascii=False))
    except (OSError, ValueError, RuntimeError) as exc:
        # Never serialize native exceptions that could include process arguments,
        # profile content, query errors, or renderer exception details.
        print(json.dumps({'state': 'blocked', 'reason': '连接验证未完成：' + type(exc).__name__,
                          'runtimeGatePassed': False}, ensure_ascii=False))
    return 3


if __name__ == '__main__':
    raise SystemExit(main())
