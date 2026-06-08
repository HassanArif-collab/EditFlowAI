"""
SQLite registry for EditFlow AI.
Stores assets, transcripts, scripts, visual maps, cutting results, jobs,
and Premiere capability probes.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from ..config import Settings, get_settings


class SQLiteRegistry:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
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
                asset_type TEXT NOT NULL DEFAULT 'video',
                source_type TEXT NOT NULL DEFAULT 'local_file',
                duration REAL DEFAULT 0,
                width INTEGER DEFAULT 0,
                height INTEGER DEFAULT 0,
                fps REAL DEFAULT 0,
                has_audio INTEGER DEFAULT 0,
                file_size INTEGER DEFAULT 0,
                fingerprint TEXT DEFAULT '',
                audio_fingerprint TEXT DEFAULT '',
                status TEXT DEFAULT 'registered',
                language TEXT DEFAULT '',
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

            CREATE TABLE IF NOT EXISTS audio_cache (
                fingerprint TEXT PRIMARY KEY,
                audio_fingerprint TEXT DEFAULT '',
                source_path TEXT NOT NULL,
                prepared_wav_path TEXT NOT NULL,
                duration REAL DEFAULT 0,
                sample_rate INTEGER DEFAULT 16000,
                channels INTEGER DEFAULT 1,
                file_size INTEGER DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sequence_transcripts (
                id TEXT PRIMARY KEY,
                sequence_id TEXT DEFAULT '',
                sequence_name TEXT NOT NULL,
                language TEXT DEFAULT '',
                clips_analyzed INTEGER DEFAULT 0,
                words_indexed INTEGER DEFAULT 0,
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sequence_words (
                id TEXT PRIMARY KEY,
                sequence_transcript_id TEXT NOT NULL,
                sequence_id TEXT DEFAULT '',
                sequence_name TEXT NOT NULL,
                track_index INTEGER NOT NULL,
                clip_index INTEGER NOT NULL,
                clip_name TEXT DEFAULT '',
                media_path TEXT NOT NULL,
                source_start REAL NOT NULL,
                source_end REAL NOT NULL,
                timeline_start REAL NOT NULL,
                timeline_end REAL NOT NULL,
                word TEXT NOT NULL,
                normalized_word TEXT NOT NULL,
                probability REAL DEFAULT 0,
                FOREIGN KEY(sequence_transcript_id) REFERENCES sequence_transcripts(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS speech_candidates (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL,
                start REAL NOT NULL,
                end REAL NOT NULL,
                transcript_excerpt TEXT NOT NULL,
                cleaned_excerpt TEXT NOT NULL,
                reason TEXT NOT NULL,
                filler_words TEXT DEFAULT '[]',
                has_pause INTEGER DEFAULT 0,
                has_repetition INTEGER DEFAULT 0,
                delivery_score REAL DEFAULT 0,
                warnings TEXT DEFAULT '[]',
                scores TEXT DEFAULT '{}',
                metadata TEXT DEFAULT '{}',
                FOREIGN KEY(asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS scripts (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT 'pasted',
                language TEXT DEFAULT 'en',
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
                source_type TEXT NOT NULL DEFAULT 'pasted',
                script_id TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS visual_map_entries (
                id TEXT PRIMARY KEY,
                visual_map_id TEXT NOT NULL,
                line_number INTEGER NOT NULL,
                line_text TEXT DEFAULT '',
                visual_file TEXT NOT NULL,
                placement_note TEXT DEFAULT '',
                FOREIGN KEY(visual_map_id) REFERENCES visual_maps(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS cutting_results (
                id TEXT PRIMARY KEY,
                script_id TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                total_segments INTEGER DEFAULT 0,
                matched_segments INTEGER DEFAULT 0,
                unmatched_lines TEXT DEFAULT '[]',
                cuts TEXT DEFAULT '[]',
                output_path TEXT DEFAULT '',
                duration_before REAL DEFAULT 0,
                duration_after REAL DEFAULT 0,
                message TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
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

            CREATE VIRTUAL TABLE IF NOT EXISTS editflow_fts USING fts5(
                entity_type,
                entity_id,
                title,
                body,
                tags
            );

            -- Phase A.1: Capability probe persistence
            -- Cache per (premiere_version, panel_version) so the probe
            -- only runs when one changes.
            CREATE TABLE IF NOT EXISTS premiere_capabilities (
                premiere_version TEXT NOT NULL,
                panel_version TEXT NOT NULL,
                capabilities_json TEXT NOT NULL,
                probed_at TEXT NOT NULL,
                PRIMARY KEY (premiere_version, panel_version)
            );

            -- Phase B: Source file registry (content-addressed)
            -- Replaces the old assets table for pipeline source files.
            -- Keyed by content_hash so that moving/renaming a file does not
            -- invalidate downstream caches.
            CREATE TABLE IF NOT EXISTS source_files (
                content_hash TEXT PRIMARY KEY,
                path TEXT NOT NULL,
                original_name TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                duration REAL NOT NULL DEFAULT 0,
                has_audio INTEGER NOT NULL DEFAULT 1,
                audio_stream_index INTEGER NOT NULL DEFAULT 0,
                audio_channel_layout TEXT NOT NULL DEFAULT 'mono',
                clip_kind TEXT NOT NULL DEFAULT 'basic',
                bin_path TEXT DEFAULT '',
                fingerprint TEXT DEFAULT '',
                audio_fingerprint TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'discovered',
                warnings TEXT DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- Phase B: Transcript persistence (replaces old transcripts table)
            -- One row per unique transcription of a (content_hash, range, engine, model).
            CREATE TABLE IF NOT EXISTS source_transcripts (
                id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                range_in REAL NOT NULL DEFAULT 0,
                range_out REAL NOT NULL DEFAULT 0,
                audio_offset REAL NOT NULL DEFAULT 0,
                language TEXT DEFAULT '',
                engine TEXT NOT NULL DEFAULT 'faster_whisper',
                model TEXT NOT NULL DEFAULT '',
                model_revision TEXT DEFAULT '',
                duration REAL DEFAULT 0,
                full_text TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                warnings TEXT DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(content_hash) REFERENCES source_files(content_hash)
            );

            -- Phase B: Word-level transcript data
            CREATE TABLE IF NOT EXISTS transcript_words (
                id TEXT PRIMARY KEY,
                transcript_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                word_index INTEGER NOT NULL,
                word TEXT NOT NULL,
                normalized_word TEXT NOT NULL,
                start REAL NOT NULL,
                end REAL NOT NULL,
                probability REAL DEFAULT 0,
                is_filler INTEGER DEFAULT 0,
                speaker_id TEXT DEFAULT '',
                FOREIGN KEY(transcript_id) REFERENCES source_transcripts(id) ON DELETE CASCADE
            );

            -- Phase B: VAD segments from silero-vad (produced alongside transcription)
            CREATE TABLE IF NOT EXISTS transcript_vad (
                id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                range_in REAL NOT NULL DEFAULT 0,
                range_out REAL NOT NULL DEFAULT 0,
                segment_index INTEGER NOT NULL,
                start REAL NOT NULL,
                end REAL NOT NULL,
                is_speech INTEGER NOT NULL DEFAULT 1,
                confidence REAL DEFAULT 1.0,
                created_at TEXT NOT NULL
            );

            -- Phase B: Cut plan persistence
            -- Plans are also saved as JSON files, but the DB table enables
            -- queries like "find all plans for this bin" without loading every file.
            CREATE TABLE IF NOT EXISTS cut_plans (
                plan_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                bin_reference TEXT DEFAULT '',
                script_hash TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'generated',
                engine TEXT DEFAULT '',
                matcher_model TEXT DEFAULT '',
                summary TEXT DEFAULT '{}',
                plan_json_path TEXT DEFAULT '',
                updated_at TEXT NOT NULL
            );

            -- Take favouriting and exclusion (cross-cutting)
            -- Per-bin persistent flags: pin (preferred), mute (never use), note.
            CREATE TABLE IF NOT EXISTS take_user_flags (
                take_id TEXT NOT NULL,
                project_path TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                muted INTEGER NOT NULL DEFAULT 0,
                note TEXT DEFAULT '',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (take_id, project_path)
            );
            """
        )
        self._migrate_schema(conn)
        self._create_indexes(conn)

    def _migrate_schema(self, conn: sqlite3.Connection):
        """Apply lightweight migrations for databases created by older builds."""
        self._add_column_if_missing(conn, "assets", "audio_fingerprint", "TEXT DEFAULT ''")
        self._add_column_if_missing(conn, "audio_cache", "audio_fingerprint", "TEXT DEFAULT ''")
        self._add_column_if_missing(conn, "source_files", "audio_fingerprint", "TEXT DEFAULT ''")

    def _add_column_if_missing(
        self,
        conn: sqlite3.Connection,
        table_name: str,
        column_name: str,
        column_definition: str,
    ):
        columns = {
            row["name"]
            for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        }
        if column_name not in columns:
            conn.execute(
                f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"
            )

    def _create_indexes(self, conn: sqlite3.Connection):
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_assets_fingerprint
                ON assets(fingerprint);

            CREATE INDEX IF NOT EXISTS idx_assets_audio_fingerprint
                ON assets(audio_fingerprint);

            CREATE INDEX IF NOT EXISTS idx_sequence_words_lookup
                ON sequence_words(sequence_id, sequence_name, timeline_start);

            CREATE INDEX IF NOT EXISTS idx_sequence_words_media_path
                ON sequence_words(media_path);

            CREATE INDEX IF NOT EXISTS idx_source_files_path
                ON source_files(path);

            CREATE INDEX IF NOT EXISTS idx_source_files_fingerprint
                ON source_files(fingerprint);

            CREATE INDEX IF NOT EXISTS idx_source_transcripts_cache_key
                ON source_transcripts(content_hash, range_in, range_out, engine, model);

            CREATE INDEX IF NOT EXISTS idx_transcript_words_lookup
                ON transcript_words(content_hash, start);

            CREATE INDEX IF NOT EXISTS idx_transcript_words_transcript
                ON transcript_words(transcript_id, word_index);

            CREATE INDEX IF NOT EXISTS idx_transcript_vad_lookup
                ON transcript_vad(content_hash, range_in, range_out);

            CREATE INDEX IF NOT EXISTS idx_cut_plans_bin
                ON cut_plans(bin_reference);

            CREATE INDEX IF NOT EXISTS idx_cut_plans_status
                ON cut_plans(status);
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
                # FTS5 isn't available — fall back to LIKE. Escape the LIKE
                # metacharacters (%, _) so a user query like "100%" doesn't
                # turn into an unbounded wildcard scan.
                escaped = (
                    query.replace("\\", "\\\\")
                    .replace("%", "\\%")
                    .replace("_", "\\_")
                )
                like_query = f"%{escaped}%"
                rows = conn.execute(
                    """
                    SELECT entity_type, entity_id, title, body, tags, 0 AS rank
                    FROM editflow_fts
                    WHERE title LIKE ? ESCAPE '\\'
                       OR body LIKE ? ESCAPE '\\'
                       OR tags LIKE ? ESCAPE '\\'
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

    # ── Phase B: Cut plan persistence ──

    def upsert_cut_plan(self, plan_id, created_at, bin_reference="", script_hash="",
                        status="generated", engine="", matcher_model="", summary="{}",
                        plan_json_path=""):
        from ..models.schemas import utc_now
        now = utc_now()
        self.execute(
            """INSERT OR REPLACE INTO cut_plans
            (plan_id, created_at, bin_reference, script_hash, status, engine,
             matcher_model, summary, plan_json_path, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (plan_id, created_at, bin_reference, script_hash, status, engine,
             matcher_model, summary, plan_json_path, now),
        )

    def find_cut_plan(self, plan_id):
        return self.fetch_one("SELECT * FROM cut_plans WHERE plan_id = ? LIMIT 1", (plan_id,))

    # ── Phase B: Take favouriting and exclusion ──

    def upsert_take_flag(self, take_id, project_path, pinned=False, muted=False, note=""):
        from ..models.schemas import utc_now
        now = utc_now()
        self.execute(
            """INSERT OR REPLACE INTO take_user_flags
            (take_id, project_path, pinned, muted, note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)""",
            (take_id, project_path, 1 if pinned else 0, 1 if muted else 0, note, now),
        )

    def find_take_flags(self, project_path):
        return self.fetch_all(
            "SELECT * FROM take_user_flags WHERE project_path = ?",
            (project_path,),
        )

    def find_take_flag(self, take_id, project_path):
        return self.fetch_one(
            "SELECT * FROM take_user_flags WHERE take_id = ? AND project_path = ?",
            (take_id, project_path),
        )

    # ── Phase B: Fingerprint-based lookups ──

    def find_asset_by_fingerprint(self, file_fingerprint: str) -> Optional[Dict[str, Any]]:
        """Look up an asset by its content fingerprint.

        Returns the first matching asset dict, or None if no asset has
        this fingerprint.  This enables transcribe-once-per-source-file:
        if an asset with this fingerprint already exists, we can reuse
        its transcript instead of re-transcribing.
        """
        if not file_fingerprint:
            return None
        return self.fetch_one(
            "SELECT * FROM assets WHERE fingerprint = ? LIMIT 1",
            (file_fingerprint,),
        )

    def find_assets_by_audio_fingerprint(self, audio_fingerprint: str) -> List[Dict[str, Any]]:
        """Look up all assets sharing the same audio fingerprint.

        This finds all files whose *decoded audio content* is identical,
        even if they have different containers or paths.
        """
        if not audio_fingerprint:
            return []
        return self.fetch_all(
            "SELECT * FROM assets WHERE audio_fingerprint = ?",
            (audio_fingerprint,),
        )

    def upsert_audio_cache(
        self,
        fingerprint: str,
        audio_fingerprint: str,
        source_path: str,
        prepared_wav_path: str,
        duration: float,
        sample_rate: int = 16000,
        channels: int = 1,
        file_size: int = 0,
    ) -> None:
        """Insert or update an audio cache entry keyed by file fingerprint."""
        from ..models.schemas import utc_now
        self.execute(
            """INSERT OR REPLACE INTO audio_cache
            (fingerprint, audio_fingerprint, source_path, prepared_wav_path,
             duration, sample_rate, channels, file_size, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (fingerprint, audio_fingerprint, source_path, prepared_wav_path,
             duration, sample_rate, channels, file_size, utc_now()),
        )

    def find_audio_cache(self, fingerprint: str) -> Optional[Dict[str, Any]]:
        """Look up a cached audio preparation by file fingerprint."""
        if not fingerprint:
            return None
        return self.fetch_one(
            "SELECT * FROM audio_cache WHERE fingerprint = ? LIMIT 1",
            (fingerprint,),
        )

    # ── Phase A.1: Capability probe persistence ──

    def upsert_capabilities(
        self,
        premiere_version: str,
        panel_version: str,
        capabilities_json: str,
        probed_at: str,
    ) -> None:
        """Insert or replace a capability probe result keyed by version pair.

        The CEP panel probes Premiere at boot and POSTs the result.  We
        persist it so that (a) the probe doesn't re-run for the same
        version pair and (b) the backend survives restarts.
        """
        self.execute(
            """INSERT OR REPLACE INTO premiere_capabilities
            (premiere_version, panel_version, capabilities_json, probed_at)
            VALUES (?, ?, ?, ?)""",
            (premiere_version, panel_version, capabilities_json, probed_at),
        )

    def find_capabilities(
        self,
        premiere_version: str,
        panel_version: str,
    ) -> Optional[Dict[str, Any]]:
        """Look up a previously stored capability probe by version pair.

        Returns the row dict or None if no probe has been stored for this
        (premiere_version, panel_version) combination.
        """
        return self.fetch_one(
            """SELECT * FROM premiere_capabilities
            WHERE premiere_version = ? AND panel_version = ?
            LIMIT 1""",
            (premiere_version, panel_version),
        )

    def find_latest_capabilities(self) -> Optional[Dict[str, Any]]:
        """Return the most recently probed capabilities, regardless of version.

        Useful as a fallback when version info is not available from the
        CEP panel.
        """
        return self.fetch_one(
            "SELECT * FROM premiere_capabilities ORDER BY probed_at DESC LIMIT 1"
        )

    # ── Phase B: Source file registry (content-addressed) ──

    def upsert_source_file(
        self,
        content_hash: str,
        path: str,
        original_name: str,
        file_size: int = 0,
        duration: float = 0.0,
        has_audio: bool = True,
        audio_stream_index: int = 0,
        audio_channel_layout: str = "mono",
        clip_kind: str = "basic",
        bin_path: str = "",
        fingerprint: str = "",
        audio_fingerprint: str = "",
        status: str = "discovered",
        warnings: str = "[]",
    ) -> None:
        """Insert or update a source file entry keyed by content_hash."""
        from ..models.schemas import utc_now
        now = utc_now()
        self.execute(
            """INSERT OR REPLACE INTO source_files
            (content_hash, path, original_name, file_size, duration, has_audio,
             audio_stream_index, audio_channel_layout, clip_kind, bin_path,
             fingerprint, audio_fingerprint, status, warnings, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (content_hash, path, original_name, file_size, duration,
             1 if has_audio else 0, audio_stream_index, audio_channel_layout,
             clip_kind, bin_path, fingerprint, audio_fingerprint, status,
             warnings, now, now),
        )

    def find_source_file(self, content_hash: str) -> Optional[Dict[str, Any]]:
        """Look up a source file by its content hash."""
        if not content_hash:
            return None
        return self.fetch_one(
            "SELECT * FROM source_files WHERE content_hash = ? LIMIT 1",
            (content_hash,),
        )

    def find_source_file_by_path(self, path: str) -> Optional[Dict[str, Any]]:
        """Look up a source file by its current filesystem path."""
        if not path:
            return None
        return self.fetch_one(
            "SELECT * FROM source_files WHERE path = ? LIMIT 1",
            (path,),
        )

    # ── Phase B: Transcript persistence ──

    def upsert_source_transcript(
        self,
        transcript_id: str,
        content_hash: str,
        range_in: float = 0.0,
        range_out: float = 0.0,
        audio_offset: float = 0.0,
        language: str = "",
        engine: str = "faster_whisper",
        model: str = "",
        model_revision: str = "",
        duration: float = 0.0,
        full_text: str = "",
        status: str = "completed",
        warnings: str = "[]",
    ) -> None:
        """Insert or update a source transcript."""
        from ..models.schemas import utc_now
        now = utc_now()
        self.execute(
            """INSERT OR REPLACE INTO source_transcripts
            (id, content_hash, range_in, range_out, audio_offset, language,
             engine, model, model_revision, duration, full_text, status,
             warnings, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (transcript_id, content_hash, range_in, range_out, audio_offset,
             language, engine, model, model_revision, duration, full_text,
             status, warnings, now, now),
        )

    def find_transcript_by_cache_key(
        self,
        content_hash: str,
        range_in: float = 0.0,
        range_out: float = 0.0,
        engine: str = "faster_whisper",
        model: str = "",
    ) -> Optional[Dict[str, Any]]:
        """Look up a transcript by the full cache key.

        This is the primary lookup for the transcribe-once guarantee:
        the cache key is (content_hash, range_in, range_out, engine, model).
        """
        return self.fetch_one(
            """SELECT * FROM source_transcripts
            WHERE content_hash = ? AND range_in = ? AND range_out = ?
              AND engine = ? AND model = ?
            LIMIT 1""",
            (content_hash, range_in, range_out, engine, model),
        )

    # ── Phase B: Word-level transcript data ──

    def insert_transcript_word(
        self,
        word_id: str,
        transcript_id: str,
        content_hash: str,
        word_index: int,
        word: str,
        normalized_word: str,
        start: float,
        end: float,
        probability: float = 0.0,
        is_filler: bool = False,
        speaker_id: str = "",
    ) -> None:
        """Insert a single transcript word."""
        self.execute(
            """INSERT OR REPLACE INTO transcript_words
            (id, transcript_id, content_hash, word_index, word, normalized_word,
             start, end, probability, is_filler, speaker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (word_id, transcript_id, content_hash, word_index, word,
             normalized_word, start, end, probability,
             1 if is_filler else 0, speaker_id),
        )

    def find_transcript_words(
        self, content_hash: str, start: float | None = None, end: float | None = None,
    ) -> List[Dict[str, Any]]:
        """Look up transcript words for a source file, optionally filtered by time range."""
        if start is not None and end is not None:
            return self.fetch_all(
                """SELECT * FROM transcript_words
                WHERE content_hash = ? AND start >= ? AND end <= ?
                ORDER BY word_index""",
                (content_hash, start, end),
            )
        return self.fetch_all(
            """SELECT * FROM transcript_words
            WHERE content_hash = ?
            ORDER BY word_index""",
            (content_hash,),
        )

    # ── Phase B: VAD segments ──

    def insert_vad_segment(
        self,
        segment_id: str,
        content_hash: str,
        range_in: float,
        range_out: float,
        segment_index: int,
        start: float,
        end: float,
        is_speech: bool = True,
        confidence: float = 1.0,
    ) -> None:
        """Insert a single VAD segment."""
        from ..models.schemas import utc_now
        self.execute(
            """INSERT OR REPLACE INTO transcript_vad
            (id, content_hash, range_in, range_out, segment_index,
             start, end, is_speech, confidence, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (segment_id, content_hash, range_in, range_out, segment_index,
             start, end, 1 if is_speech else 0, confidence, utc_now()),
        )

    def find_vad_segments(
        self, content_hash: str, range_in: float = 0.0, range_out: float = 0.0,
    ) -> List[Dict[str, Any]]:
        """Look up VAD segments for a source file + range."""
        return self.fetch_all(
            """SELECT * FROM transcript_vad
            WHERE content_hash = ? AND range_in = ? AND range_out = ?
            ORDER BY segment_index""",
            (content_hash, range_in, range_out),
        )

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
