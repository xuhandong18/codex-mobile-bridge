"""Discover local app-tool pipes and verify their server before protocol use."""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path


def endpoints():
    prefix = '\\\\.\\pipe\\'
    names = os.listdir(prefix)
    current = [name for name in names if name.startswith('codex-app-tools-')]
    legacy = [name for name in names if name.startswith('codex-browser-use-')]
    return [prefix + name for name in current + legacy][:32]


def verify_server(stream, executable):
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetNamedPipeServerProcessId.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)]
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.ProcessIdToSessionId.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    pid = wintypes.ULONG()
    if not kernel.GetNamedPipeServerProcessId(stream.handle, ctypes.byref(pid)):
        raise OSError('无法核验桌面工具管道')
    own, peer = wintypes.DWORD(), wintypes.DWORD()
    if (not kernel.ProcessIdToSessionId(os.getpid(), ctypes.byref(own)) or
            not kernel.ProcessIdToSessionId(pid.value, ctypes.byref(peer)) or own.value != peer.value):
        raise OSError('桌面工具不属于当前 Windows 会话')
    handle = kernel.OpenProcess(0x1000, False, pid.value)
    if not handle:
        raise OSError('无法核验桌面工具进程')
    try:
        path, length = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
        if not kernel.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(length)):
            raise OSError('无法读取桌面工具进程身份')
        if os.path.normcase(str(Path(path.value).resolve())) != os.path.normcase(str(Path(executable).resolve())):
            raise OSError('桌面工具进程与所选 Codex 不一致')
    finally:
        kernel.CloseHandle(handle)
    return pid.value
