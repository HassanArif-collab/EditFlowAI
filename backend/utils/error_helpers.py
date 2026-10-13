"""Error formatting and system resource validation utilities.

Converts cryptic OS, FFmpeg, and runtime exceptions into clear, actionable,
human-readable guidance for end users in Premiere Pro.
"""
from __future__ import annotations

import logging
import re
import shutil
from pathlib import Path

logger = logging.getLogger(__name__)


def clean_system_error(err: Exception | str, target_path: Path | str | None = None) -> str:
    """Transform low-level errors and FFmpeg traces into clean, user-friendly messages."""
    raw = str(err).strip() if err else "An unexpected error occurred."

    # Extract drive letter if available
    drive_str = ""
    if target_path:
        try:
            p = Path(target_path)
            if p.drive:
                drive_str = f" on drive {p.drive}"
        except Exception:
            pass

    # 1. Out of disk space
    if any(pat in raw.lower() for pat in [
        "no space left on device", "not enough space on the disk",
        "winerror 112", "enospc", "error submitting a packet to the muxer"
    ]):
        return (f"Out of disk space{drive_str}. "
                f"The drive ran out of space while saving media. "
                f"Please free up disk space and try again.")

    # 2. File locked / permission denied
    if any(pat in raw.lower() for pat in [
        "permission denied", "winerror 32", "winerror 5",
        "used by another process", "being used by another process"
    ]):
        filename = ""
        if target_path:
            try:
                filename = f" '{Path(target_path).name}'"
            except Exception:
                pass
        return (f"File in use{filename}: Cannot write or access the file because "
                f"it is currently open or locked by Premiere Pro or another application.")

    # 3. GPU / Out of Memory
    if any(pat in raw.lower() for pat in [
        "cuda out of memory", "out of memory", "cuda error: out of memory", "cufft_alloc_failed"
    ]):
        return ("GPU memory is full. Please close other GPU-intensive applications "
                "or switch Whisper to CPU in Settings.")

    # 4. Missing / offline media files
    if any(pat in raw.lower() for pat in [
        "no such file or directory", "winerror 2", "could not open file", "does not exist"
    ]):
        return ("Media file offline or not found. Please verify that all clips "
                "in your active sequence are linked and online in Premiere Pro.")

    # 5. Broken pipe / FFmpeg interrupted
    if any(pat in raw.lower() for pat in ["broken pipe", "brokenpipeerror", "pipe is being closed"]):
        return ("Video encoding process was interrupted unexpectedly. "
                "Check that disk space is available and sequence resolution is supported.")

    # 6. Clean up raw FFmpeg stderr noise (e.g. [vost#0:0/prores_ks @ 000001c0dbc38bc0] ...)
    if "@ 0x" in raw or "@ 000" in raw or "[" in raw:
        # Strip internal pointers like @ 000001c0dbc38bc0 or @ 0x7fa...
        cleaned = re.sub(r"@\s*[0-9a-fA-FxX]+", "", raw)
        # Strip FFmpeg stream prefix brackets like [vost#0:0/prores_ks ] or [out#0/mov ]
        cleaned = re.sub(r"\[[a-zA-Z0-9#_/:.\s]+\]", "", cleaned)
        # Strip repeated "Last message repeated N times"
        cleaned = re.sub(r"Last message repeated \d+ times", "", cleaned)
        cleaned = " ".join(cleaned.split()).strip()
        if cleaned:
            return f"Video encoder error: {cleaned[:240]}"

    # Fallback: single-line normalized string capped to 260 chars
    cleaned = " ".join(raw.split()).strip()
    return cleaned[:260]


def check_and_prune_disk_space(
    target_dir: Path | str,
    min_mb: int = 250,
    auto_prune: bool = True,
    prune_pattern: str = "*.mov",
    keep_count: int = 5,
) -> None:
    """Verify target directory has adequate disk space, auto-pruning old cache if low."""
    try:
        p = Path(target_dir)
        p.mkdir(parents=True, exist_ok=True)
        usage = shutil.disk_usage(p)

        # If free space is below 1.5 GB, proactively prune older files
        if auto_prune and usage.free < 1500 * 1024 * 1024:
            stale_files = sorted(p.glob(prune_pattern), key=lambda f: f.stat().st_mtime)
            if len(stale_files) > keep_count:
                for f in stale_files[:-keep_count]:
                    try:
                        f.unlink(missing_ok=True)
                    except OSError:
                        pass
            usage = shutil.disk_usage(p)

        min_bytes = min_mb * 1024 * 1024
        if usage.free < min_bytes:
            free_mb = round(usage.free / (1024 * 1024), 1)
            drive_label = f"drive {p.drive}" if p.drive else "disk"
            raise RuntimeError(
                f"Out of disk space: {drive_label} only has {free_mb} MB free. "
                f"Operation requires at least {min_mb} MB free space. "
                f"Please free up space on {drive_label}."
            )
    except RuntimeError:
        raise
    except Exception as e:
        logger.debug("check_and_prune_disk_space check skipped: %s", e)
