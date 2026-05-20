"""Path safety helpers for keeping test fixtures out of the real registry."""
from __future__ import annotations

import os
from typing import Any


TEST_PATH_MARKERS = (
    "pytest-of-",
    "appdata/local/temp/pytest",
    "appdata\\local\\temp\\pytest",
    "/tmp/pytest",
    "\\tmp\\pytest",
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
