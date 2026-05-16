from pathlib import Path

from backend.models.sqlite_registry import sqlite_registry
from backend.tools.phase1_registry_cleanup import analyze_registry, cleanup_registry


def test_phase1_cleanup_dry_run_reports_temp_rows_without_deleting(tmp_path: Path):
    sqlite_registry.initialize()
    sqlite_registry.execute(
        """
        INSERT INTO assets(id, path, name, asset_type, source_type, tags, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "asset_temp",
            r"C:\Users\Hassan Arif\AppData\Local\Temp\pytest-of-Hassan Arif\raw\6\two.mp4",
            "two.mp4",
            "video",
            "pytest",
            "[]",
            "{}",
            "now",
            "now",
        ),
    )
    sqlite_registry.execute(
        "INSERT INTO reference_roots(alias, path, description, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("raw", r"C:\Users\Hassan Arif\AppData\Local\Temp\pytest-of-Hassan Arif\raw", "", "{}", "now", "now"),
    )

    report = analyze_registry(sqlite_registry.db_path)

    assert report["assets"]["count"] == 1
    assert report["reference_roots"]["count"] == 1
    assert sqlite_registry.fetch_one("SELECT * FROM assets WHERE id = ?", ("asset_temp",))


def test_phase1_cleanup_apply_backs_up_and_deletes_temp_rows(tmp_path: Path):
    sqlite_registry.initialize()
    sqlite_registry.execute(
        """
        INSERT INTO assets(id, path, name, asset_type, source_type, tags, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("asset_keep", r"F:\UserProject\raw\real.mp4", "real.mp4", "video", "local", "[]", "{}", "now", "now"),
    )
    sqlite_registry.execute(
        """
        INSERT INTO assets(id, path, name, asset_type, source_type, tags, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ("asset_temp", r"C:\Users\Hassan Arif\AppData\Local\Temp\pytest-of-Hassan Arif\bad.mp4", "bad.mp4", "video", "pytest", "[]", "{}", "now", "now"),
    )
    sqlite_registry.execute(
        "INSERT INTO reference_roots(alias, path, description, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("raw", r"C:\Users\Hassan Arif\AppData\Local\Temp\pytest-of-Hassan Arif\raw", "", "{}", "now", "now"),
    )
    sqlite_registry.execute(
        "INSERT INTO premiere_bins(id, name, bin_path, item_id, child_count, depth, metadata, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("pbin_raw_6", "6", "Raw/6", "bin_raw_6", 0, 1, "{}", "now"),
    )

    report = cleanup_registry(sqlite_registry.db_path, apply=True, backup_dir=tmp_path / "backups")

    assert Path(report["backup_path"]).exists()
    assert sqlite_registry.fetch_one("SELECT * FROM assets WHERE id = ?", ("asset_keep",))
    assert sqlite_registry.fetch_one("SELECT * FROM assets WHERE id = ?", ("asset_temp",)) is None
    assert sqlite_registry.fetch_one("SELECT * FROM reference_roots WHERE alias = ?", ("raw",)) is None
    assert sqlite_registry.fetch_one("SELECT COUNT(*) AS count FROM premiere_bins")["count"] == 0
