"""One-time Phase 1 registry cleanup for stale pytest/temp reference data."""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from ..config import get_settings
from ..utils.path_safety import is_test_like_path


TEMP_TEXT_SQL = """
    lower(replace(coalesce({column}, ''), '\\', '/')) LIKE '%pytest-of-%'
    OR lower(replace(coalesce({column}, ''), '\\', '/')) LIKE '%appdata/local/temp/pytest%'
    OR lower(replace(coalesce({column}, ''), '\\', '/')) LIKE '%/tmp/pytest%'
"""


def analyze_registry(db_path: str | Path) -> dict[str, Any]:
    db_path = Path(db_path)
    if not db_path.exists():
        return _empty_report(db_path, "Database file does not exist.")

    with _connect(db_path) as conn:
        return _build_report(conn, db_path)


def cleanup_registry(
    db_path: str | Path,
    apply: bool = False,
    backup_dir: str | Path | None = None,
) -> dict[str, Any]:
    db_path = Path(db_path)
    report = analyze_registry(db_path)
    if not apply or not db_path.exists():
        report["applied"] = False
        return report

    backup_root = Path(backup_dir) if backup_dir else db_path.parent / "backups"
    backup_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = backup_root / f"editflow_v2_before_phase1_cleanup_{timestamp}.sqlite3"
    _backup_sqlite(db_path, backup_path)

    with _connect(db_path) as conn:
        _delete_rows(conn, report)
        conn.commit()

    report = analyze_registry(db_path)
    report["applied"] = True
    report["backup_path"] = str(backup_path)
    return report


def _build_report(conn: sqlite3.Connection, db_path: Path) -> dict[str, Any]:
    bad_asset_ids = _ids_for_temp_rows(conn, "assets", "id", ["path", "name", "tags", "metadata"])
    bad_reference_aliases = _ids_for_temp_rows(
        conn,
        "reference_roots",
        "alias",
        ["path", "description", "metadata"],
    )
    bad_visual_map_ids = _ids_for_temp_rows(conn, "visual_maps", "id", ["title", "content", "metadata"])
    bad_visual_map_entry_ids = _ids_for_temp_rows(
        conn,
        "visual_map_entries",
        "id",
        ["script_line_or_keyword", "visual_folder", "placement_note", "matched_asset_ids"],
    )
    if bad_visual_map_ids:
        bad_visual_map_entry_ids.extend(
            _column_values(
                conn,
                "SELECT id FROM visual_map_entries WHERE visual_map_id IN ({})".format(
                    _placeholders(bad_visual_map_ids)
                ),
                bad_visual_map_ids,
            )
        )
    bad_visual_map_entry_ids = sorted(set(bad_visual_map_entry_ids))

    bad_plan_ids = _ids_for_temp_rows(conn, "edit_plans", "id", ["sources", "target", "constraints"])
    if bad_asset_ids:
        bad_plan_ids.extend(_ids_containing_any(conn, "edit_plans", "id", ["sources", "constraints"], bad_asset_ids))
    if bad_visual_map_ids:
        bad_plan_ids.extend(
            _column_values(
                conn,
                "SELECT id FROM edit_plans WHERE visual_map_id IN ({})".format(_placeholders(bad_visual_map_ids)),
                bad_visual_map_ids,
            )
        )
    bad_plan_ids = sorted(set(bad_plan_ids))

    bad_job_ids = _ids_for_temp_rows(conn, "jobs", "id", ["target_id", "message", "result", "error"])
    if bad_asset_ids or bad_plan_ids:
        bad_job_ids.extend(
            _ids_containing_any(conn, "jobs", "id", ["target_id", "message", "result", "error"], bad_asset_ids + bad_plan_ids)
        )
    bad_job_ids = sorted(set(bad_job_ids))

    bad_script_run_ids = _ids_for_temp_rows(conn, "script_runs", "id", ["script_body", "result", "logs", "error"])
    if bad_plan_ids:
        bad_script_run_ids.extend(
            _column_values(
                conn,
                "SELECT id FROM script_runs WHERE plan_id IN ({})".format(_placeholders(bad_plan_ids)),
                bad_plan_ids,
            )
        )
    if bad_job_ids:
        bad_script_run_ids.extend(
            _column_values(
                conn,
                "SELECT id FROM script_runs WHERE job_id IN ({})".format(_placeholders(bad_job_ids)),
                bad_job_ids,
            )
        )
    bad_script_run_ids = sorted(set(bad_script_run_ids))

    bad_fts_rowids = _temp_fts_rowids(conn)
    bad_fts_rowids.extend(_fts_rowids_for_entities(conn, "asset", bad_asset_ids))
    bad_fts_rowids.extend(_fts_rowids_for_entities(conn, "reference_root", bad_reference_aliases))
    bad_fts_rowids.extend(_fts_rowids_for_entities(conn, "visual_map", bad_visual_map_ids))
    bad_fts_rowids.extend(_fts_rowids_for_entities(conn, "visual_map_entry", bad_visual_map_entry_ids))
    bad_fts_rowids.extend(_fts_rowids_for_entities(conn, "premiere_bin", _all_ids(conn, "premiere_bins", "id")))
    bad_fts_rowids.extend(_fts_rowids_for_entities(conn, "premiere_project_item", _all_ids(conn, "premiere_project_items", "id")))
    bad_fts_rowids = sorted(set(bad_fts_rowids))

    premiere_bin_ids = _all_ids(conn, "premiere_bins", "id")
    premiere_item_ids = _all_ids(conn, "premiere_project_items", "id")

    return {
        "db_path": str(db_path),
        "applied": False,
        "backup_path": "",
        "assets": _section(bad_asset_ids),
        "reference_roots": _section(bad_reference_aliases),
        "visual_maps": _section(bad_visual_map_ids),
        "visual_map_entries": _section(bad_visual_map_entry_ids),
        "edit_plans": _section(bad_plan_ids),
        "jobs": _section(bad_job_ids),
        "script_runs": _section(bad_script_run_ids),
        "editflow_fts": _section([str(rowid) for rowid in bad_fts_rowids]),
        "premiere_bins": _section(premiere_bin_ids),
        "premiere_project_items": _section(premiere_item_ids),
    }


def _delete_rows(conn: sqlite3.Connection, report: dict[str, Any]) -> None:
    _delete_by_ids(conn, "script_runs", "id", report["script_runs"]["ids"])
    _delete_by_ids(conn, "jobs", "id", report["jobs"]["ids"])
    _delete_by_ids(conn, "edit_plans", "id", report["edit_plans"]["ids"])
    _delete_by_ids(conn, "visual_map_entries", "id", report["visual_map_entries"]["ids"])
    _delete_by_ids(conn, "visual_maps", "id", report["visual_maps"]["ids"])
    _delete_by_ids(conn, "assets", "id", report["assets"]["ids"])
    _delete_by_ids(conn, "reference_roots", "alias", report["reference_roots"]["ids"])
    conn.execute("DELETE FROM premiere_project_items")
    conn.execute("DELETE FROM premiere_bins")
    _delete_by_ids(conn, "editflow_fts", "rowid", report["editflow_fts"]["ids"])


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _backup_sqlite(db_path: Path, backup_path: Path) -> None:
    try:
        with sqlite3.connect(str(db_path)) as src, sqlite3.connect(str(backup_path)) as dst:
            src.backup(dst)
    except sqlite3.Error:
        shutil.copy2(db_path, backup_path)


def _ids_for_temp_rows(conn: sqlite3.Connection, table: str, id_column: str, columns: list[str]) -> list[str]:
    existing_columns = set(_table_columns(conn, table))
    filters = [f"({TEMP_TEXT_SQL.format(column=column)})" for column in columns if column in existing_columns]
    if not filters:
        return []
    sql = f"SELECT {id_column} AS id FROM {table} WHERE " + " OR ".join(filters)
    return _column_values(conn, sql)


def _ids_containing_any(
    conn: sqlite3.Connection,
    table: str,
    id_column: str,
    columns: list[str],
    needles: Iterable[str],
) -> list[str]:
    needles = [str(item) for item in needles if str(item)]
    if not needles:
        return []
    rows = conn.execute(f"SELECT {id_column} AS id, {', '.join(columns)} FROM {table}").fetchall()
    found: list[str] = []
    for row in rows:
        haystack = " ".join(str(row[column] or "") for column in columns).lower()
        if any(needle.lower() in haystack for needle in needles):
            found.append(str(row["id"]))
    return found


def _temp_fts_rowids(conn: sqlite3.Connection) -> list[int]:
    rows = conn.execute("SELECT rowid, title, body, tags FROM editflow_fts").fetchall()
    return [
        int(row["rowid"])
        for row in rows
        if any(is_test_like_path(row[column]) for column in ["title", "body", "tags"])
    ]


def _fts_rowids_for_entities(conn: sqlite3.Connection, entity_type: str, entity_ids: Iterable[str]) -> list[int]:
    ids = [str(item) for item in entity_ids if str(item)]
    if not ids:
        return []
    sql = "SELECT rowid FROM editflow_fts WHERE entity_type = ? AND entity_id IN ({})".format(_placeholders(ids))
    return [int(value) for value in _column_values(conn, sql, [entity_type, *ids])]


def _all_ids(conn: sqlite3.Connection, table: str, id_column: str) -> list[str]:
    return _column_values(conn, f"SELECT {id_column} AS id FROM {table}")


def _column_values(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> list[str]:
    return [str(row[0]) for row in conn.execute(sql, list(params)).fetchall()]


def _delete_by_ids(conn: sqlite3.Connection, table: str, id_column: str, ids: Iterable[str]) -> None:
    ids = [str(item) for item in ids if str(item)]
    if not ids:
        return
    conn.execute(
        f"DELETE FROM {table} WHERE {id_column} IN ({_placeholders(ids)})",
        ids,
    )


def _placeholders(values: Iterable[Any]) -> str:
    return ", ".join("?" for _ in values) or "NULL"


def _table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def _section(ids: list[str]) -> dict[str, Any]:
    return {"count": len(ids), "ids": sorted(str(item) for item in ids)}


def _empty_report(db_path: Path, message: str) -> dict[str, Any]:
    return {
        "db_path": str(db_path),
        "applied": False,
        "backup_path": "",
        "message": message,
        "assets": _section([]),
        "reference_roots": _section([]),
        "visual_maps": _section([]),
        "visual_map_entries": _section([]),
        "edit_plans": _section([]),
        "jobs": _section([]),
        "script_runs": _section([]),
        "editflow_fts": _section([]),
        "premiere_bins": _section([]),
        "premiere_project_items": _section([]),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Clean stale pytest/temp rows from EditFlow v2 registry.")
    parser.add_argument("--db", default=str(get_settings().DB_PATH), help="SQLite registry path")
    parser.add_argument("--apply", action="store_true", help="Apply cleanup. Default is dry-run only.")
    parser.add_argument("--backup-dir", default="", help="Optional backup directory")
    args = parser.parse_args()

    report = cleanup_registry(
        args.db,
        apply=args.apply,
        backup_dir=args.backup_dir or None,
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
