"""Capability probe for filesystem-link fixtures, without changing OS policy."""
import tempfile
import unittest
from pathlib import Path


def require_symlink_support():
    root = Path(__file__).resolve().parents[1]/'.tmp'
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=root) as folder:
        directory = Path(folder)
        link = directory/'probe'
        try:
            link.symlink_to(directory, target_is_directory=True)
        except OSError as error:
            if getattr(error, 'winerror', None) == 1314:
                raise unittest.SkipTest('Current Windows account cannot create symbolic links (WinError 1314)') from None
            raise
        finally:
            if link.is_symlink():
                link.unlink()
