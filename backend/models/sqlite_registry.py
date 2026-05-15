"""
SQLite registry for EditFlow AI v2.
Stores assets, transcripts, speech candidates, scripts, visual maps, edit plans, and jobs.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from ..config import Settings


class SQLiteRegistry:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings()
        self.db_path = Path(self.settings.DB_PATH)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialized = False

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def initialize(self):
        with self._lock:
            if self._initialized:
                return
            with self.connect() as conn:
                self._create_tables(conn)
            self._initialized = True

    def _create_tables(self, conn: sqlite3.Connection):
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                asset_type TEXT NOT NULL,
                source_type TEXT NOT NULL,
                duration REAL DEFAULT 0,
                width INTEGER DEFAULT 0,
                height INTEGER DEFAULT 0,
                fps REAL DEFAULT 0,
                has_audio INTEGER DEFAULT 0,
                file_size INTEGER DEFAULT 0,
                fingerprint TEXT DEFAULT '',
                status TEXT DEFAULT 'registered',
                tags TEXT DEFAULT '[]',
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transcripts (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL UNIQUE,
                language TEXT DEFAULT '',
                duration REAL DEFAULT 0,
                full_text TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS transcript_segments (
                id TEXT PRIMARY KEY,
                transcript_id TEXT NOT NULL,
                asset_id TEXT NOT NULL,
                start REAL NOT NULL,
                end REAL NOT NULL,
                text TEXT NOT NULL,
                words TEXT DEFAULT '[]',
                FOREIGN KEY(transcript_id) REFERENCES transcripts(id) ON DELETE CASCADE,
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS scenes (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL,
                start REAL NOT NULL,
                end REAL NOT NULL,
                scene_type TEXT NOT NULL,
                confidence REAL DEFAULT 1,
                metadata TEXT DEFAULT '{}',
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS speech_candidates (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL,
                start REAL NOT NULL,
                end REAL NOT NULL,
                transcript_excerpt TEXT NOT NULL,
                cleaned_excerpt TEXT NOT NULL,
                reason TEXT NOT NULL,
                warnings TEXT DEFAULT '[]',
                scores TEXT DEFAULT '{}',
                metadata TEXT DEFAULT '{}',
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS scripts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                source_type TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS script_lines (
                id TEXT PRIMARY KEY,
                script_id TEXT NOT NULL,
                line_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                meaning_summary TEXT DEFAULT '',
                priority TEXT DEFAULT 'normal',
                desired_duration REAL,
                visual_requirement TEXT DEFAULT '',
                FOREIGN KEY(script_id) REFERENCES scripts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS visual_maps (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                source_type TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS visual_map_entries (
                id TEXT PRIMARY KEY,
                visual_map_id TEXT NOT NULL,
                row_index INTEGER NOT NULL,
                script_line_or_keyword TEXT NOT NULL,
                visual_folder TEXT NOT NULL,
                visual_type TEXT DEFAULT '',
                placement_note TEXT DEFAULT '',
                priority TEXT DEFAULT 'normal',
                matched_asset_ids TEXT DEFAULT '[]',
                FOREIGN KEY(visual_map_id) REFERENCES visual_maps(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS edit_plans (
                id TEXT PRIMARY KEY,
                operation TEXT NOT NULL,
                sources TEXT DEFAULT '[]',
                script_id TEXT,
                visual_map_id TEXT,
                target TEXT DEFAULT '@new_sequence',
                cleanup_style TEXT DEFAULT 'natural_clean',
                matching TEXT DEFAULT 'best_meaning_match',
                visual_density TEXT DEFAULT 'script_guided_balanced',
                constraints TEXT DEFAULT '{}',
                status TEXT DEFAULT 'planned',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                job_type TEXT NOT NULL,
                status TEXT NOT NULL,
                target_id TEXT,
                progress REAL DEFAULT 0,
                message TEXT DEFAULT '',
                result TEXT DEFAULT '{}',
                error TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS script_runs (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL,
                plan_id TEXT,
                run_type TEXT NOT NULL,
                script_body TEXT DEFAULT '',
                result TEXT DEFAULT '{}',
                logs TEXT DEFAULT '[]',
                error TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS premiere_snapshots (
                id TEXT PRIMARY KEY,
                snapshot_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reference_roots (
                alias TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                description TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS premiere_bins (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                bin_path TEXT NOT NULL UNIQUE,
                item_id TEXT DEFAULT '',
                child_count INTEGER DEFAULT 0,
                depth INTEGER DEFAULT 0,
                metadata TEXT DEFAULT '{}',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS premiere_project_items (
                id TEXT PRIMARY KEY,
                item_id TEXT DEFAULT '',
                name TEXT NOT NULL,
                media_path TEXT DEFAULT '',
                media_type TEXT DEFAULT '',
                bin_path TEXT DEFAULT '',
                duration REAL DEFAULT 0,
                has_video INTEGER DEFAULT 0,
                has_audio INTEGER DEFAULT 0,
                metadata TEXT DEFAULT '{}',
                updated_at TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS editflow_fts USING fts5(
                entity_type,
                entity_id,
                title,
                body,
                tags
            );
            """
        )

    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        self.initialize()
        with self._lock, self.connect() as conn:
            cur = conn.execute(sql, tuple(params))
            return cur.rowcount

    def fetch_one(self, sql: str, params: Iterable[Any] = ()) -> Optional[Dict[str, Any]]:
        self.initialize()
        with self._lock, self.connect() as conn:
            row = conn.execute(sql, tuple(params)).fetchone()
            return self._decode_row(row) if row else None

    def fetch_all(self, sql: str, params: Iterable[Any] = ()) -> List[Dict[str, Any]]:
        self.initialize()
        with self._lock, self.connect() as conn:
            rows = conn.execute(sql, tuple(params)).fetchall()
            return [self._decode_row(row) for row in rows]

    def upsert_fts(self, entity_type: str, entity_id: str, title: str, body: str, tags: str = ""):
        self.initialize()
        with self._lock, self.connect() as conn:
            conn.execute(
                "DELETE FROM editflow_fts WHERE entity_type = ? AND entity_id = ?",
                (entity_type, entity_id),
            )
            conn.execute(
                "INSERT INTO editflow_fts(entity_type, entity_id, title, body, tags) VALUES (?, ?, ?, ?, ?)",
                (entity_type, entity_id, title, body, tags),
            )

    def search(self, query: str, limit: int = 20) -> List[Dict[str, Any]]:
        self.initialize()
        if not query.strip():
            return []
        with self._lock, self.connect() as conn:
            try:
                rows = conn.execute(
                    """
                    SELECT entity_type, entity_id, title, body, tags, bm25(editflow_fts) AS rank
                    FROM editflow_fts
                    WHERE editflow_fts MATCH ?
                    ORDER BY rank
                    LIMIT ?
                    """,
                    (query, limit),
                ).fetchall()
            except sqlite3.OperationalError:
                like_query = f"%{query}%"
                rows = conn.execute(
                    """
                    SELECT entity_type, entity_id, title, body, tags, 0 AS rank
                    FROM editflow_fts
                    WHERE title LIKE ? OR body LIKE ? OR tags LIKE ?
                    LIMIT ?
                    """,
                    (like_query, like_query, like_query, limit),
                ).fetchall()
            return [self._decode_row(row) for row in rows]

    def health(self) -> Dict[str, Any]:
        try:
            self.initialize()
            with self.connect() as conn:
                conn.execute("SELECT 1").fetchone()
            return {"connected": True, "path": str(self.db_path)}
        except Exception as e:
            return {"connected": False, "path": str(self.db_path), "error": str(e)}

    @staticmethod
    def dumps(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, default=str)

    @staticmethod
    def loads(value: Any, default: Any):
        if value in (None, ""):
            return default
        try:
            return json.loads(value)
        except Exception:
            return default

    def _decode_row(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {key: row[key] for key in row.keys()}


sqlite_registry = SQLiteRegistry()
