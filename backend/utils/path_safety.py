"""Path safety helpers for keeping test fixtures out of the real registry
and for validating user-supplied paths reaching the filesystem / FFmpeg.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable

from fastapi import HTTPException


TEST_PATH_MARKERS = (
    "pytest-of-",
    "appdata/local/temp/pytest",
    "appdata\\local\\temp\\pytest",
    "/tmp/pytest",
    "\\tmp\\pytest",
)

DEFAULT_VIDEO_EXTS: tuple = (".mp4", ".mov", ".mkv")
DEFAULT_MEDIA_EXTS: tuple = (
    ".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm",
    ".wav", ".mp3", ".flac", ".ogg", ".m4a",
)


def test_mode_enabled() -> bool:
    return os.getenv("EDITFLOW_TEST_MODE", "").strip().lower() in {"1", "true", "yes", "on"}


def is_test_like_path(value: Any) -> bool:
    text = str(value or "")
    if not text:
        return False
    lowered = text.lower().replace("\\", "/")
    return any(marker.replace("\\", "/") in lowered for marker in TEST_PATH_MARKERS)


def assert_not_test_like_path(value: Any, label: str = "path") -> None:
    if test_mode_enabled():
        return
    if is_test_like_path(value):
        raise ValueError(
            f"Refusing to store test/temp {label} in the real EditFlow registry: {value}"
        )


def safe_dir_path(user_path: str, *, label: str = "directory") -> Path:
    """Resolve and validate a user-supplied directory path.

    Rejects: empty values, unresolvable paths, non-directories, drive roots,
    and (outside EDITFLOW_TEST_MODE) test-fixture paths.

    Raises HTTPException on rejection. Returns the resolved Path on success.
    """
    if not user_path or not str(user_path).strip():
        raise HTTPException(status_code=400, detail=f"{label} is required")

    try:
        resolved = Path(user_path).expanduser().resolve()
    except (OSError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid {label}: {e}")

    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"{label} not found: {user_path}")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"{label} must be a directory")
    if resolved == Path(resolved.anchor):
        raise HTTPException(status_code=400, detail=f"Refusing to operate on a drive root ({label})")

    try:
        assert_not_test_like_path(resolved, label=label)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return resolved


def safe_file_path(
    user_path: str,
    *,
    label: str = "file",
    allow_extensions: Iterable[str] = DEFAULT_MEDIA_EXTS,
) -> Path:
    """Resolve and validate a user-supplied path that must point at an existing file."""
    if not user_path or not str(user_path).strip():
        raise HTTPException(status_code=400, detail=f"{label} is required")

    try:
        resolved = Path(user_path).expanduser().resolve()
    except (OSError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid {label}: {e}")

    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"{label} not found: {user_path}")
    if allow_extensions and resolved.suffix.lower() not in {e.lower() for e in allow_extensions}:
        raise HTTPException(
            status_code=400,
            detail=f"{label} must end with one of {tuple(allow_extensions)}",
        )

    try:
        assert_not_test_like_path(resolved, label=label)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    return resolved


def safe_output_path(
    user_path: str,
    base_dir: Path,
    *,
    allow_extensions: Iterable[str] = DEFAULT_VIDEO_EXTS,
) -> Path:
    """Resolve a user-supplied output path inside base_dir.

    Relative paths resolve against base_dir; absolute paths must already sit
    within base_dir or the request is rejected. The parent directory is created
    so callers do not have to.
    """
    if not user_path or not str(user_path).strip():
        raise HTTPException(status_code=400, detail="output_path is required")

    try:
        base = base_dir.resolve()
    except (OSError, RuntimeError) as e:
        raise HTTPException(status_code=500, detail=f"Output base dir invalid: {e}")

    raw = Path(user_path).expanduser()
    try:
        candidate = (base / raw).resolve() if not raw.is_absolute() else raw.resolve()
    except (OSError, RuntimeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid output_path: {e}")

    try:
        candidate.relative_to(base)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"output_path must be within {base}",
        )

    if allow_extensions and candidate.suffix.lower() not in {e.lower() for e in allow_extensions}:
        raise HTTPException(
            status_code=400,
            detail=f"output_path must end with one of {tuple(allow_extensions)}",
        )

    candidate.parent.mkdir(parents=True, exist_ok=True)
    return candidate
