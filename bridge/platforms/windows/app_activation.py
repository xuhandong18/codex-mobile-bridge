"""Activate a verified Store application with its original argument vector."""
import ctypes
import subprocess
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class ActivatedDesktop:
    # Lifecycle control must reverify the application, not terminate this handle.
    pid: int


class GUID(ctypes.Structure):
    _fields_ = [('data1', ctypes.c_uint32), ('data2', ctypes.c_uint16),
                ('data3', ctypes.c_uint16), ('data4', ctypes.c_ubyte * 8)]


def activate_application(app_id, arguments):
    ole = ctypes.WinDLL('ole32', use_last_error=True)
    ole.CoInitializeEx.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    ole.CoInitializeEx.restype = ctypes.c_long
    ole.CoCreateInstance.argtypes = [ctypes.POINTER(GUID), ctypes.c_void_p, ctypes.c_uint32,
                                    ctypes.POINTER(GUID), ctypes.POINTER(ctypes.c_void_p)]
    ole.CoCreateInstance.restype = ctypes.c_long
    ole.CoUninitialize.argtypes = []
    initialized = ole.CoInitializeEx(None, 2)
    owns_apartment = initialized in (0, 1)
    if initialized < 0 and initialized & 0xffffffff != 0x80010106:
        raise OSError('Windows 应用激活初始化失败')
    manager = ctypes.c_void_p()
    release = None
    try:
        clsid = GUID.from_buffer_copy(uuid.UUID('45ba127d-10a8-46ea-8ab7-56ea9078943c').bytes_le)
        iid = GUID.from_buffer_copy(uuid.UUID('2e941141-7f97-4756-ba1d-9decde894a3d').bytes_le)
        # The helper may exit immediately; the system's out-of-process COM host
        # owns the activation arguments until the target application consumes them.
        result = ole.CoCreateInstance(ctypes.byref(clsid), None, 4, ctypes.byref(iid), ctypes.byref(manager))
        if result < 0 or not manager.value:
            raise OSError('无法创建 Windows 应用激活接口；尚未启动应用')
        table = ctypes.cast(manager, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(table[2])
        activate = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_wchar_p,
                                     ctypes.c_wchar_p, ctypes.c_uint32,
                                     ctypes.POINTER(ctypes.c_uint32))(table[3])
        pid = ctypes.c_uint32()
        result = activate(manager, app_id, subprocess.list2cmdline(arguments), 0, ctypes.byref(pid))
        if result < 0 or pid.value == 0:
            raise OSError('Windows 应用激活结果尚未确认；没有重试启动')
        return pid.value
    finally:
        if release is not None:
            release(manager)
        if owns_apartment:
            ole.CoUninitialize()
