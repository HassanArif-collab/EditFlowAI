import pytest
from pathlib import Path
from backend.utils.error_helpers import clean_system_error, check_and_prune_disk_space


def test_clean_system_error_disk_full(tmp_path):
    target = tmp_path / "output.mov"
    msg = clean_system_error(
        "[vost#0:0/prores_ks @ 000001c0dbc38bc0] Error submitting a packet to the muxer: No space left on device",
        target_path=target,
    )
    assert "Out of disk space" in msg
    assert "000001c0dbc38bc0" not in msg
    assert "Please free up disk space" in msg


def test_clean_system_error_file_locked(tmp_path):
    target = tmp_path / "locked.wav"
    msg = clean_system_error(
        "[WinError 32] The process cannot access the file because it is being used by another process",
        target_path=target,
    )
    assert "File in use" in msg
    assert "locked.wav" in msg


def test_clean_system_error_gpu_oom():
    msg = clean_system_error("RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB")
    assert "GPU memory is full" in msg
    assert "switch Whisper to CPU" in msg


def test_clean_system_error_strips_ffmpeg_pointers():
    raw = "[out#0/mov @ 0x7f9a8b100] Error muxing a packet [libx264 @ 0x7f9a8b200]"
    msg = clean_system_error(raw)
    assert "0x7f9a8b100" not in msg
    assert "0x7f9a8b200" not in msg


def test_check_and_prune_disk_space(tmp_path):
    # Should pass without error for min_mb=1 on any valid drive
    check_and_prune_disk_space(tmp_path, min_mb=1, auto_prune=False)

    # Create dummy files to test pruning logic
    for i in range(5):
        (tmp_path / f"test_{i}.tmp").write_bytes(b"x" * 100)

    # Calling check_and_prune_disk_space with keep_count=2
    # will prune if space < 1500MB (or if forced)
    check_and_prune_disk_space(tmp_path, min_mb=1, auto_prune=True, prune_pattern="*.tmp", keep_count=2)

    # Test error raised when min_mb is impossibly large
    with pytest.raises(RuntimeError) as exc_info:
        check_and_prune_disk_space(tmp_path, min_mb=999_999_999, auto_prune=False)
    assert "Out of disk space" in str(exc_info.value)
