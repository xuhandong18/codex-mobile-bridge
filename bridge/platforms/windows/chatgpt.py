"""Fresh, same-user Windows process and loopback debugger evidence."""
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


class DebuggerUnavailable(ValueError):
    pass


@dataclass(frozen=True)
class DebuggerBinding:
    executable: Path
    pid: int
    started_at: str
    port: int


def validate_snapshot(snapshot, executable, *, port, expected=None):
    if type(port) is not int or not 1 <= port <= 65535:
        raise DebuggerUnavailable('本机调试端口无效')
    try:
        rows = snapshot['processes']
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError('ambiguous main process')
        row = rows[0]
        path = Path(executable).resolve()
        if (row['commandKnown'] is not True or
                os.path.normcase(str(Path(row['executable']).resolve())) != os.path.normcase(str(path)) or
                row['session'] != snapshot['currentSession'] or row['user'] != snapshot['currentUser'] or
                not isinstance(row['user'], str) or not row['user'] or
                type(row['pid']) is not int or row['pid'] <= 0 or
                not isinstance(row['startedAt'], str) or not row['startedAt'] or
                type(row['port']) is not int or row['port'] != port):
            raise ValueError('process identity mismatch')
        listeners = [item for item in snapshot['listeners'] if item.get('port') == port]
        if not listeners or any(item.get('pid') != row['pid'] or
                                item.get('address') not in ('127.0.0.1', '::1') for item in listeners):
            raise ValueError('listener identity mismatch')
        binding = DebuggerBinding(path, row['pid'], row['startedAt'], port)
        if expected is not None and binding != expected:
            raise ValueError('process instance changed')
        return binding
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        raise DebuggerUnavailable('无法确认同一用户、会话和桌面进程的本机调试连接') from exc


# Full command lines remain inside this read-only helper; never return them or
# query another user's process arguments. No user text is interpolated as code.
SNAPSHOT_SCRIPT = r'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$probeInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
$ownSession = (Get-Process -Id $PID).SessionId
$ownUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$processRows = @()
$allPids = @()
$ownedRows = @()
foreach ($entry in (Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,SessionId,CreationDate)) {
    if ($entry.SessionId -eq $ownSession -and -not $entry.ExecutablePath -and
        $entry.Name -eq [System.IO.Path]::GetFileName($probeInput.executable)) {
        throw 'Process path is unconfirmed'
    }
    if (-not $entry.ExecutablePath -or -not [string]::Equals($entry.ExecutablePath,
        $probeInput.executable, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
    $allPids += [int]$entry.ProcessId
    if ($entry.SessionId -ne $ownSession) { continue }
    if ($null -ne $probeInput.pid -and $entry.ProcessId -ne $probeInput.pid) { continue }
    $owner = Invoke-CimMethod -InputObject $entry -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $ownUser) { throw 'Process owner is unconfirmed' }
    $ownedRows += $entry
}
$commands = @{}
if ($ownedRows.Count -gt 128) { throw 'Process inventory is too large' }
if ($ownedRows.Count -gt 0) {
    $ownedFilter = ($ownedRows | ForEach-Object { 'ProcessId = ' + [int]$_.ProcessId }) -join ' OR '
    foreach ($commandRow in (Get-CimInstance Win32_Process -Filter $ownedFilter -Property ProcessId,CommandLine)) {
        $commands[[int]$commandRow.ProcessId] = $commandRow.CommandLine
    }
}
foreach ($entry in $ownedRows) {
    $command = $commands[[int]$entry.ProcessId]
    $known = -not [string]::IsNullOrWhiteSpace($command)
    if ($known -and $command -match '(?:^|\s)--type(?:=|\s)') { continue }
    $debugPort = $null
    if ($known -and $command -match '(?:^|\s)--remote-debugging-port(?:=|\s)(\d+)(?:$|\s)') {
        $debugPort = [int]$Matches[1]
    }
    $processRows += [pscustomobject]@{
        pid=[int]$entry.ProcessId; executable=$entry.ExecutablePath; session=[int]$entry.SessionId;
        user=$ownUser; startedAt=$entry.CreationDate.ToUniversalTime().ToString('o');
        commandKnown=$known; port=$debugPort
    }
}
$listenerRows = @()
if ($null -ne $probeInput.port) {
    $listenerRows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object LocalPort -eq $probeInput.port | ForEach-Object {
            [pscustomobject]@{pid=[int]$_.OwningProcess; address=$_.LocalAddress; port=[int]$_.LocalPort}
        })
}
@{currentSession=$ownSession; currentUser=$ownUser; processes=@($processRows);
  listeners=@($listenerRows); allPids=@($allPids)} | ConvertTo-Json -Depth 5 -Compress
'''


def read_snapshot(executable, *, port=None, pid=None):
    if os.name != 'nt':
        raise DebuggerUnavailable('当前 ChatGPT 接入探针仅支持 Windows')
    try:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT],
            input=json.dumps({'executable': str(Path(executable).resolve()), 'port': port, 'pid': pid}),
            capture_output=True, text=True, encoding='utf-8', timeout=25,
            creationflags=subprocess.CREATE_NO_WINDOW, check=True)
        value = json.loads(result.stdout)
        if not isinstance(value, dict):
            raise ValueError('invalid snapshot')
        return value
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise DebuggerUnavailable('无法读取当前 Windows 桌面进程及监听身份') from exc


def verify_debugger(executable, port, *, expected=None):
    return validate_snapshot(read_snapshot(executable, port=port, pid=expected.pid if expected else None),
                             executable, port=port, expected=expected)
