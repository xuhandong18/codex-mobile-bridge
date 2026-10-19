"""Request the selected Harness shell's normal Quit without terminating its Host."""
import base64
import json
import os
import re
import struct
import subprocess
import sys
from pathlib import Path, PurePosixPath

UNSUPPORTED = '当前 Harness 未提供可验证的后台退出通道，请更新桌面端后重试'
PROFILE_CHANGED = 'Harness 运行实例的数据目录无法核对，请重新扫描后重试'
FLAG = '--dsh-installer-quit'
PRODUCTS = {'dsh-plugin-desktop': 'DSH Desktop', 'dsh-plugin-desktop-beta': 'DSH Desktop Beta'}

# New Desktop releases put appExit inside a separate Node/utility Host. It
# disposes that profile, not Electron's shell. Invoke the shell's own menu; its
# before-quit handler owns task inspection, confirmation and Host teardown.
DESKTOP_QUIT_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshQuitWindows {
 public delegate bool Callback(IntPtr h, IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int size);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder text, int size);
 [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
 [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int index);
}
'@
$targetPid = [int]$env:CMB_DSH_GUI_PID
$expected = [long]$env:CMB_DSH_GUI_CREATED
$executable = $env:CMB_DSH_GUI_EXE
function Check-Process {
 $process = Get-Process -Id $targetPid -ErrorAction Stop
 if ($process.SessionId -ne (Get-Process -Id $PID).SessionId -or
     $process.StartTime.ToFileTimeUtc() -ne $expected -or
     -not [string]::Equals($process.MainModule.FileName, $executable, [StringComparison]::OrdinalIgnoreCase)) {
   throw 'Harness 进程已变化，请重新扫描后重试'
 }
}
function Get-Windows {
 $items = [Collections.Generic.List[IntPtr]]::new()
 [DshQuitWindows]::EnumWindows({param($handle,$unused)
   [uint32]$ownerPid = 0
   [void][DshQuitWindows]::GetWindowThreadProcessId($handle,[ref]$ownerPid)
   if ($ownerPid -eq $targetPid) { $items.Add($handle) }
   return $true
 },[IntPtr]::Zero) | Out-Null
 return $items.ToArray()
}
function Test-ToolWindow($handle) {
 if ([IntPtr]::Size -eq 8) { $style = [DshQuitWindows]::GetWindowLongPtr($handle,-20).ToInt64() }
 else { $style = [DshQuitWindows]::GetWindowLong($handle,-20) }
 return ($style -band 0x80) -ne 0
}
function Check-Window {
 Check-Process
 [uint32]$ownerPid = 0
 [void][DshQuitWindows]::GetWindowThreadProcessId($script:main,[ref]$ownerPid)
 if ($ownerPid -ne $targetPid -or -not [DshQuitWindows]::IsWindowEnabled($script:main)) {
   throw 'Harness 有待处理的原生窗口，请在电脑端处理后重试'
 }
 foreach ($handle in (Get-Windows)) {
   $class = [Text.StringBuilder]::new(128)
   [void][DshQuitWindows]::GetClassName($handle,$class,$class.Capacity)
   if ([DshQuitWindows]::IsWindowVisible($handle) -and
       ($class.ToString() -eq '#32770' -or
        ($class.ToString() -ne '#32768' -and -not (Test-ToolWindow $handle) -and
         [DshQuitWindows]::GetWindow($handle,4) -eq $script:main))) {
     throw 'Harness 有待处理的原生窗口，请在电脑端处理后重试'
   }
 }
}
function Find-Items($root,$names) {
 $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem)
 @($root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition) | Where-Object {
   $_.Current.ProcessId -eq $targetPid -and $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and $_.Current.Name -cin $names
 })
}
Check-Process
$candidates = @(foreach ($handle in (Get-Windows)) {
 $title = [Text.StringBuilder]::new(512)
 [void][DshQuitWindows]::GetWindowText($handle,$title,$title.Capacity)
 $class = [Text.StringBuilder]::new(128)
 [void][DshQuitWindows]::GetClassName($handle,$class,$class.Capacity)
 if ([DshQuitWindows]::GetWindow($handle,4) -eq [IntPtr]::Zero -and -not (Test-ToolWindow $handle) -and
     $class.ToString() -eq 'Chrome_WidgetWin_1' -and
     $title.Length -gt 0 -and $title.ToString() -notmatch '^(DevTools|Developer Tools|开发者工具)') { $handle }
})
if ($candidates.Count -ne 1) { throw '无法核对唯一的 Harness 主窗口，请在电脑端打开应用后重试' }
$script:main = $candidates[0]
Check-Window
if (-not [DshQuitWindows]::IsWindowVisible($main)) { [void][DshQuitWindows]::ShowWindow($main,4) }
$root = [Windows.Automation.AutomationElement]::FromHandle($main)
$timer = [Diagnostics.Stopwatch]::StartNew()
do {
 Check-Window
 $menus = @(Find-Items $root @('应用','Application') | Where-Object {
  ([Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($_)).Current.ControlType -eq [Windows.Automation.ControlType]::MenuBar
 })
 if ($menus.Count -gt 0) { break }
 Start-Sleep -Milliseconds 100
} while ($timer.Elapsed.TotalSeconds -lt 4)
if ($menus.Count -ne 1) { throw 'Harness 应用菜单尚未就绪，请在电脑端打开应用后重试' }
Check-Window
$pattern = $null
if ($menus[0].TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke() }
elseif ($menus[0].TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) { $pattern.Expand() }
else { throw 'Harness 应用菜单不支持正常展开' }
$timer = [Diagnostics.Stopwatch]::StartNew()
do {
 Check-Window
 $exits = @(Find-Items $root @('退出','Exit'))
 # Electron's native popup may be a separate top-level UIA window.
 foreach ($handle in (Get-Windows)) {
   if ($handle -eq $main) { continue }
   $class = [Text.StringBuilder]::new(128)
   [void][DshQuitWindows]::GetClassName($handle,$class,$class.Capacity)
   if ($class.ToString() -eq '#32768' -or
       ($class.ToString() -eq 'Chrome_WidgetWin_1' -and (Test-ToolWindow $handle))) {
     $exits += @(Find-Items ([Windows.Automation.AutomationElement]::FromHandle($handle)) @('退出','Exit'))
   }
 }
 # The same popup can appear both below the main UIA root and as an HWND.
 # Collapse only identical runtime identities; two distinct Exit items refuse.
 $unique = @{}
 foreach ($item in $exits) { $unique[($item.GetRuntimeId() -join ':')] = $item }
 $exits = @($unique.Values)
 if ($exits.Count -gt 0) { break }
 Start-Sleep -Milliseconds 100
} while ($timer.Elapsed.TotalSeconds -lt 4)
if ($exits.Count -ne 1) { throw 'Harness 退出菜单不可用或不唯一，请在电脑端检查后重试' }
$invoke = $exits[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
Check-Window
if (-not $exits[0].Current.IsEnabled -or $exits[0].Current.IsOffscreen) { throw 'Harness 退出菜单已变化，请重试' }
@{quitPhase='dispatching';pid=$targetPid} | ConvertTo-Json -Compress
[Console]::Out.Flush()
$invoke.Invoke()
@{quitState='submitted';pid=$targetPid} | ConvertTo-Json -Compress
'''


def desktop_quit_required(executable):
    """Current Desktop owns quit in Electron, even when its Host uses fork()."""
    try:
        package = json.loads(_member(Path(executable).parent/'resources', 'package.json'))
        return package.get('name') in ('@deepseek-ai/dsh-desktop', '@deepseek-ai/dsh-desktop-beta')
    except (OSError, ValueError, TypeError, AttributeError, struct.error):
        return False


def request_desktop_quit(app, state):
    """Invoke Quit once; uncertain delivery never falls back to appExit/kill."""
    if sys.platform != 'win32':
        raise ValueError(UNSUPPORTED)
    from .codex_quit import _creation_time
    main = state.get('mainPids', [])
    if state.get('unknown') or len(main) != 1:
        raise ValueError(PROFILE_CHANGED)
    executable = str(Path(app.executable).resolve())
    created = _creation_time(main[0])
    script = base64.b64encode(DESKTOP_QUIT_SCRIPT.encode('utf-16le')).decode('ascii')
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', script],
            env={**os.environ, 'CMB_DSH_GUI_PID': str(main[0]), 'CMB_DSH_GUI_CREATED': str(created),
                 'CMB_DSH_GUI_EXE': executable},
            capture_output=True, encoding='utf-8', timeout=18,
            creationflags=subprocess.CREATE_NO_WINDOW, check=False)
    except subprocess.TimeoutExpired:
        raise ValueError('Harness 原生退出请求结果未知，请在电脑端检查后重试；尚未强制结束进程') from None
    receipts = []
    for line in result.stdout.splitlines():
        try:
            receipt = json.loads(line)
        except ValueError:
            continue
        if isinstance(receipt, dict) and receipt.get('pid') == main[0]:
            receipts.append(receipt)
    if any(row.get('quitPhase') == 'dispatching' for row in receipts):
        # InvokePattern may throw after delivery as the application disappears.
        # Observe exit in the caller, without ever invoking a second command.
        return
    raise ValueError('无法调用 Harness 的正常退出菜单，请在电脑端检查原生窗口或提示后重试')


def _member(resources, name):
    parts = PurePosixPath(name.replace('\\', '/')).parts
    if not parts or any(part in ('..', '/') or ':' in part for part in parts):
        raise ValueError(UNSUPPORTED)
    folder = resources/'app'
    if (folder/'package.json').is_file():
        path = folder.joinpath(*parts).resolve()
        if not path.is_relative_to(folder.resolve()) or not 0 < path.stat().st_size <= 16*1024*1024:
            raise ValueError(UNSUPPORTED)
        return path.read_text('utf-8')
    with (resources/'app.asar').open('rb') as stream:
        header = stream.read(16)
        if len(header) != 16: raise ValueError(UNSUPPORTED)
        _, size, _, json_size = struct.unpack('<4I', header)
        if not 0 < json_size <= 8*1024*1024 or size < json_size+8:
            raise ValueError(UNSUPPORTED)
        node = json.loads(stream.read(json_size))
        for part in parts: node = node.get('files', {}).get(part, {})
        length, offset = node.get('size'), int(node.get('offset', -1))
        if node.get('unpacked') or node.get('link') or type(length) is not int or not 0 < length <= 16*1024*1024 or offset < 0:
            raise ValueError(UNSUPPORTED)
        stream.seek(size+8+offset)
        data = stream.read(length)
        if len(data) != length: raise ValueError(UNSUPPORTED)
        return data.decode('utf-8')


def installer_quit_product(executable):
    """Require the installed implementation, not a guessed version threshold.

    Both branches must return before showing a window or booting a profile.
    Unknown/minified implementations remain unsupported rather than receiving
    a flag they may ignore and interpret as a request to show the desktop.
    """
    try:
        resources = Path(executable).parent/'resources'
        package = json.loads(_member(resources, 'package.json'))
        product = PRODUCTS[package['name']]
        source = _member(resources, package['main'])
        predicate = re.search(r'''function\s+(\w+)\(\s*argv\s*,\s*platform\s*\)\s*\{\s*return\s+platform\s*===\s*["']win32["']\s*&&\s*argv\.includes\(["']--dsh-installer-quit["']\)\s*;?\s*\}''', source)
        if predicate is None: raise ValueError(UNSUPPORTED)
        check = re.escape(predicate[1])
        early = (r'async\s+function\s+start\(\)\s*\{\s*if\s*\(!app\.requestSingleInstanceLock\(\)\)\s*\{\s*app\.quit\(\);\s*return;\s*\}\s*'
                 r'if\s*\('+check+r'\(process\.argv,\s*process\.platform\)\)\s*\{\s*app\.quit\(\);\s*return;\s*\}')
        handoff = (r'''app\.on\(["']second-instance["'],\s*\(_event,\s*argv\)\s*=>\s*\{\s*if\s*\('''+check+
                   r'\(argv,\s*process\.platform\)\)\s*\{\s*requestQuit\(0\);\s*return;\s*\}')
        shutdown = r'const\s+requestQuit\s*=\s*\(code\)\s*=>\s*\{\s*shutdown\.request\(code\);\s*\}'
        if not all(re.search(pattern, source) for pattern in (early, handoff, shutdown)):
            raise ValueError(UNSUPPORTED)
        return product
    except (OSError, ValueError, TypeError, KeyError, AttributeError, struct.error):
        raise ValueError(UNSUPPORTED) from None


def _windows_argv(command):
    import ctypes
    if not command or sys.platform != 'win32': raise ValueError(PROFILE_CHANGED)
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    count = ctypes.c_int()
    arguments = shell.CommandLineToArgvW(command, ctypes.byref(count))
    if not arguments: raise ValueError(PROFILE_CHANGED)
    try: return [arguments[index] for index in range(count.value)]
    finally: kernel.LocalFree(ctypes.cast(arguments, ctypes.c_void_p))


def _profile(arguments):
    profiles = []
    for index, argument in enumerate(arguments):
        if argument == '--user-data-dir':
            profiles.append(arguments[index+1] if index+1 < len(arguments) else '')
        elif argument.startswith('--user-data-dir='):
            profiles.append(argument.partition('=')[2])
    if len(profiles) > 1 or profiles and (not profiles[0] or not Path(profiles[0]).is_absolute()):
        raise ValueError(PROFILE_CHANGED)
    return Path(profiles[0]).resolve() if profiles else None


def installer_quit_command(app, state, commands):
    product = installer_quit_product(app.executable)
    main, hosts = state.get('mainPids', []), state.get('runtimePids', [])
    if len(main) != 1 or len(hosts) != 1: raise ValueError(PROFILE_CHANGED)
    arguments = [_windows_argv(commands.get(pid, '')) for pid in (main[0], hosts[0])]
    if any(not row or os.path.normcase(str(Path(row[0]).resolve())) != os.path.normcase(str(app.executable)) for row in arguments):
        raise ValueError(PROFILE_CHANGED)
    explicit, actual = map(_profile, arguments)
    roaming = os.environ.get('APPDATA')
    expected = explicit or (Path(roaming)/product).resolve() if roaming or explicit else None
    if actual is None or expected is None or os.path.normcase(str(actual)) != os.path.normcase(str(expected)):
        raise ValueError(PROFILE_CHANGED)
    return [str(app.executable), *(['--user-data-dir='+str(explicit)] if explicit else []), FLAG]


def send_installer_quit(command):
    if sys.platform != 'win32': raise ValueError(UNSUPPORTED)
    environment = {key: value for key, value in os.environ.items() if key.upper() != 'ELECTRON_RUN_AS_NODE'}
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    child = subprocess.Popen(command, cwd=Path(command[0]).parent, env=environment,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW, startupinfo=startup, close_fds=True)
    try:
        result = child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        # This helper is itself a desktop executable; never force-kill it.
        raise ValueError('Harness 正常退出请求尚未完成，请稍后重试') from None
    if result != 0: raise ValueError('Harness 拒绝了正常退出请求，请在电脑端检查后重试')
