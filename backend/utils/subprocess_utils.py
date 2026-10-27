"""EditFlow AI - Subprocess Execution Utilities for Windows & Cross-Platform.

Suppresses flashing console windows (conhost.exe, cmd.exe, ffmpeg.exe, nvidia-smi.exe)
on Windows when invoking subprocesses from background threads or windowless environments.
"""
from __future__ import annotations

import subprocess
import sys
from typing import Any, Dict


def silent_subprocess_kwargs() -> Dict[str, Any]:
    """Return keyword arguments for subprocess.run/Popen that suppress
    console window allocation on Windows.

    Uses both CREATE_NO_WINDOW (0x08000000) and STARTUPINFO with SW_HIDE
    to guarantee child processes (e.g. ffmpeg, ffprobe, nvidia-smi) run
    100% silently in the background without UI interruption.
    """
    kwargs: Dict[str, Any] = {}
    if sys.platform == "win32":
        # CREATE_NO_WINDOW flag tells the Windows process manager not to allocate
        # a new console window for the child process.
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

        # STARTUPINFO with SW_HIDE explicitly forces the window to be invisible
        # even if child processes request console allocation.
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= getattr(subprocess, "STARTF_USESHOWWINDOW", 0x00000001)
        startupinfo.wShowWindow = getattr(subprocess, "SW_HIDE", 0)
        kwargs["startupinfo"] = startupinfo

    return kwargs


def run_silent(cmd: Any, **kwargs: Any) -> subprocess.CompletedProcess:
    """Drop-in replacement for subprocess.run that never flashes a console window on Windows."""
    flags = silent_subprocess_kwargs()
    # Allow callers to override or extend flags if needed
    flags.update(kwargs)
    return subprocess.run(cmd, **flags)


def popen_silent(cmd: Any, **kwargs: Any) -> subprocess.Popen:
    """Drop-in replacement for subprocess.Popen that never flashes a console window on Windows."""
    flags = silent_subprocess_kwargs()
    flags.update(kwargs)
    return subprocess.Popen(cmd, **flags)
