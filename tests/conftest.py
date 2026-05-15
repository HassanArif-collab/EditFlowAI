"""Pytest configuration for EditFlow AI tests."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def isolate_v2_sqlite_registry(tmp_path):
    """Keep tests from writing Premiere/project fixtures into the real app DB."""
    from backend.models.sqlite_registry import sqlite_registry

    original_path = sqlite_registry.db_path
    original_initialized = sqlite_registry._initialized
    sqlite_registry.db_path = tmp_path / "editflow_v2_test.sqlite3"
    sqlite_registry._initialized = False
    try:
        yield
    finally:
        sqlite_registry.db_path = original_path
        sqlite_registry._initialized = original_initialized
