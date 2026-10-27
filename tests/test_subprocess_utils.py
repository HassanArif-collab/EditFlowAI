"""Unit tests for subprocess_utils.py.

Verifies that on Windows, silent subprocess flags are applied to suppress console windows,
and that child processes execute properly and return expected output/returncodes.
"""
import subprocess
import sys
from backend.utils.subprocess_utils import silent_subprocess_kwargs, run_silent, popen_silent


def test_silent_subprocess_kwargs():
    kwargs = silent_subprocess_kwargs()
    if sys.platform == "win32":
        assert "creationflags" in kwargs
        assert kwargs["creationflags"] == 0x08000000
        assert "startupinfo" in kwargs
        si = kwargs["startupinfo"]
        assert isinstance(si, subprocess.STARTUPINFO)
        assert si.dwFlags & subprocess.STARTF_USESHOWWINDOW
        assert si.wShowWindow == subprocess.SW_HIDE
    else:
        assert kwargs == {}


def test_run_silent_executes_cleanly():
    res = run_silent(
        [sys.executable, "-c", "print('hello silent world')"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert res.returncode == 0
    assert res.stdout.strip() == "hello silent world"


def test_popen_silent_executes_cleanly():
    proc = popen_silent(
        [sys.executable, "-c", "import sys; print('popen silent')"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stdout, stderr = proc.communicate(timeout=10)
    assert proc.returncode == 0
    assert stdout.strip() == "popen silent"
