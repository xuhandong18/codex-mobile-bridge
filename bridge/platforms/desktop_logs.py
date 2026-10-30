"""Bounded discovery of Codex routing logs; never treats log text as authority."""
import datetime
import os
import sys
from pathlib import Path


def codex_log_files():
    if sys.platform == 'win32':
        root = Path(os.environ.get('LOCALAPPDATA', Path.home()/'AppData/Local'))/'Codex/Logs'
    elif sys.platform == 'darwin':
        root = Path.home()/'Library/Logs/Codex'
    else:
        root = Path(os.environ.get('XDG_STATE_HOME', Path.home()/'.local/state'))/'codex/logs'
    files = list(root.glob('*.log'))[:64]
    today = datetime.date.today()
    for days in (0, 1):
        day = today-datetime.timedelta(days=days)
        files.extend(list((root/day.strftime('%Y/%m/%d')).glob('*.log'))[:64])
    return sorted((p for p in files if p.is_file() and not p.is_symlink()),
                  key=lambda p: p.stat().st_mtime, reverse=True)[:8]
