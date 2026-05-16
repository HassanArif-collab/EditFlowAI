"""Pytest configuration for EditFlow AI tests."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def isolate_v2_sqlite_registry(tmp_path, monkeypatch):
    """Keep tests from writing Premiere/project fixtures into the real app DB."""
    from backend import config
    from backend.models.sqlite_registry import sqlite_registry

    monkeypatch.setenv("EDITFLOW_TEST_MODE", "1")
    original_path = sqlite_registry.db_path
    original_initialized = sqlite_registry._initialized
    original_settings = config._settings_instance
    sqlite_registry.db_path = tmp_path / "editflow_v2_test.sqlite3"
    sqlite_registry._initialized = False
    config._settings_instance = config.Settings(
        DATA_DIR=tmp_path / "data",
        CATALOG_DIR=tmp_path / "data" / "catalogs",
        TEMPLATE_DIR=tmp_path / "data" / "templates",
        MEDIA_CACHE_DIR=tmp_path / "data" / "media_cache",
        EDL_DIR=tmp_path / "data" / "edl",
        DB_PATH=sqlite_registry.db_path,
    )
    try:
        yield
    finally:
        sqlite_registry.db_path = original_path
        sqlite_registry._initialized = original_initialized
        config._settings_instance = original_settings
