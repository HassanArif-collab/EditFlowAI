"""
EditFlow AI v2 service layer.
Implements durable asset registration, analysis records, script ingestion, visual maps,
edit plans, dry runs, and job ledger behavior.
"""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import get_settings
from ..models.sqlite_registry import sqlite_registry as db
from ..models.v2_schemas import (
    AssetAnalyzeRequest,
    AssetRegisterRequest,
    DryRunResult,
    EditPlanCreateRequest,
    FolderScanRequest,
    ScriptIngestRequest,
    VisualMapIngestRequest,
    utc_now,
)
from ..services.whisper_service import whisper_service
from ..utils.ffmpeg_utils import get_media_info, scan_directory
from ..utils.path_safety import assert_not_test_like_path


MEDIA_EXTS = {
    ".mp4": "video",
    ".mov": "video",
    ".m4v": "video",
    ".mkv": "video",
    ".avi": "video",
    ".webm": "video",
    ".mp3": "audio",
    ".wav": "audio",
    ".m4a": "audio",
    ".flac": "audio",
    ".jpg": "image",
    ".jpeg": "image",
    ".png": "image",
    ".webp": "image",
}

FILLERS = {
    "um",
    "uh",
    "umm",
    "ah",
    "like",
    "you know",
    "i mean",
    "sort of",
    "kind of",
}


class V2RegistryService:
    CAPABILITIES = [
        {"name": "asset_register", "status": "available"},
        {"name": "folder_scan", "status": "available"},
        {"name": "sqlite_fts_search", "status": "available"},
        {"name": "whisper_transcription", "status": "available_when_dependency_installed"},
        {"name": "speech_candidate_generation", "status": "available"},
        {"name": "script_ingest", "status": "available"},
        {"name": "visual_map_ingest", "status": "available"},
        {"name": "visual_folder_asset_linking", "status": "available"},
        {"name": "reference_resolution", "status": "available"},
        {"name": "edit_plan_create", "status": "available"},
        {"name": "edit_plan_dry_run", "status": "available"},
        {"name": "combine_assets_new_sequence", "status": "available"},
        {"name": "premiere_template_edl_generation", "status": "available"},
        {"name": "premiere_bridge_execution", "status": "available_in_cep"},
        {"name": "premiere_verify", "status": "available_with_sequence_snapshot"},
        {"name": "generated_jsx_fallback", "status": "planned"},
        {"name": "multimodal_visual_ranking", "status": "planned"},
    ]

    def health(self) -> Dict[str, Any]:
        return db.health()

    def capabilities(self) -> List[Dict[str, str]]:
        return list(self.CAPABILITIES)

    def register_asset(self, request: AssetRegisterRequest) -> Dict[str, Any]:
        path = Path(request.path).expanduser()
        resolved = path.resolve() if path.exists() else path
        assert_not_test_like_path(resolved, "asset path")
        suffix = resolved.suffix.lower()
        asset_type = request.asset_type or MEDIA_EXTS.get(suffix, "file")
        name = request.name or resolved.name
        now = utc_now()
        info = get_media_info(resolved) if resolved.exists() and asset_type in {"video", "audio"} else {}
        stat = resolved.stat() if resolved.exists() and resolved.is_file() else None
        file_size = int(info.get("file_size") or (stat.st_size if stat else 0))
        fingerprint = self._fingerprint(resolved, file_size)

        existing = db.fetch_one("SELECT * FROM assets WHERE path = ?", (str(resolved),))
        asset_id = existing["id"] if existing else self._id("asset")
        db.execute(
            """
            INSERT INTO assets(
                id, path, name, asset_type, source_type, duration, width, height, fps,
                has_audio, file_size, fingerprint, status, tags, metadata, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
                name=excluded.name,
                asset_type=excluded.asset_type,
                source_type=excluded.source_type,
                duration=excluded.duration,
                width=excluded.width,
                height=excluded.height,
                fps=excluded.fps,
                has_audio=excluded.has_audio,
                file_size=excluded.file_size,
                fingerprint=excluded.fingerprint,
                tags=excluded.tags,
                metadata=excluded.metadata,
                updated_at=excluded.updated_at
            """,
            (
                asset_id,
                str(resolved),
                name,
                asset_type,
                request.source_type,
                float(info.get("duration") or 0),
                int(info.get("width") or 0),
                int(info.get("height") or 0),
                float(info.get("fps") or 0),
                1 if info.get("has_audio") else 0,
                file_size,
                fingerprint,
                "registered",
                db.dumps(request.tags),
                db.dumps(request.metadata),
                existing["created_at"] if existing else now,
                now,
            ),
        )
        asset = self.get_asset(asset_id)
        self._index_asset(asset)
        return asset

    def scan_folder(self, request: FolderScanRequest) -> Dict[str, Any]:
        root = Path(request.path).expanduser().resolve()
        assert_not_test_like_path(root, "folder scan path")
        extensions = request.extensions or sorted(MEDIA_EXTS.keys())
        files = scan_directory(root, extensions) if request.recursive else [
            p for p in root.iterdir() if p.is_file() and p.suffix.lower() in extensions
        ]
        assets = []
        for file_path in files:
            assets.append(
                self.register_asset(
                    AssetRegisterRequest(
                        path=str(file_path),
                        source_type=request.source_type,
                        tags=request.tags,
                    )
                )
            )
        return {"success": True, "folder": str(root), "count": len(assets), "assets": assets}

    def get_asset(self, asset_id: str) -> Dict[str, Any]:
        row = db.fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
        if not row:
            raise KeyError(f"Asset not found: {asset_id}")
        return self._decode_asset(row)

    def search_assets(self, query: str, limit: int = 20) -> Dict[str, Any]:
        hits = db.search(query, limit)
        return {"query": query, "count": len(hits), "results": hits}

    async def analyze_asset(self, asset_id: str, request: AssetAnalyzeRequest) -> Dict[str, Any]:
        asset = self.get_asset(asset_id)
        existing = db.fetch_one("SELECT * FROM transcripts WHERE asset_id = ?", (asset_id,))
        if existing and not request.force:
            candidates = self.get_speech_candidates(asset_id)
            return {
                "success": True,
                "cached": True,
                "asset": asset,
                "transcript_id": existing["id"],
                "candidate_count": len(candidates),
            }

        transcript_id = None
        if request.transcribe and asset["asset_type"] in {"video", "audio"}:
            transcript = await whisper_service.transcribe(
                asset["path"],
                language=request.language,
                word_timestamps=True,
                vad_filter=True,
            )
            transcript_id = self._save_transcript(asset_id, transcript)

        if request.create_candidates:
            self._create_speech_candidates(asset_id)

        db.execute(
            "UPDATE assets SET status = ?, updated_at = ? WHERE id = ?",
            ("analyzed", utc_now(), asset_id),
        )
        candidates = self.get_speech_candidates(asset_id)
        return {
            "success": True,
            "cached": False,
            "asset": self.get_asset(asset_id),
            "transcript_id": transcript_id,
            "candidate_count": len(candidates),
        }

    def get_transcript(self, asset_id: str) -> Dict[str, Any]:
        transcript = db.fetch_one("SELECT * FROM transcripts WHERE asset_id = ?", (asset_id,))
        if not transcript:
            return {"asset_id": asset_id, "segments": [], "full_text": ""}
        segments = db.fetch_all(
            "SELECT * FROM transcript_segments WHERE asset_id = ? ORDER BY start",
            (asset_id,),
        )
        return {
            "id": transcript["id"],
            "asset_id": asset_id,
            "language": transcript["language"],
            "duration": transcript["duration"],
            "full_text": transcript["full_text"],
            "segments": [self._decode_segment(s) for s in segments],
        }

    def get_speech_candidates(self, asset_id: str) -> List[Dict[str, Any]]:
        rows = db.fetch_all(
            "SELECT * FROM speech_candidates WHERE asset_id = ? ORDER BY start",
            (asset_id,),
        )
        return [self._decode_candidate(row) for row in rows]

    def ingest_script(self, request: ScriptIngestRequest) -> Dict[str, Any]:
        script_id = self._id("script")
        now = utc_now()
        db.execute(
            "INSERT INTO scripts(id, title, content, source_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (script_id, request.title, request.content, request.source_type, db.dumps(request.metadata), now),
        )
        lines = self._split_script_lines(script_id, request.content)
        for line in lines:
            db.execute(
                """
                INSERT INTO script_lines(
                    id, script_id, line_index, text, meaning_summary, priority, desired_duration, visual_requirement
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    line["id"],
                    script_id,
                    line["line_index"],
                    line["text"],
                    line["meaning_summary"],
                    line["priority"],
                    line["desired_duration"],
                    line["visual_requirement"],
                ),
            )
            db.upsert_fts("script_line", line["id"], f"{request.title} line {line['line_index']}", line["text"])
        db.upsert_fts("script", script_id, request.title, request.content)
        return {"id": script_id, "title": request.title, "line_count": len(lines), "lines": lines}

    def get_script_lines(self, script_id: str) -> List[Dict[str, Any]]:
        return db.fetch_all("SELECT * FROM script_lines WHERE script_id = ? ORDER BY line_index", (script_id,))

    def ingest_visual_map(self, request: VisualMapIngestRequest) -> Dict[str, Any]:
        assert_not_test_like_path(request.content, "visual map content")
        visual_map_id = self._id("vmap")
        now = utc_now()
        db.execute(
            "INSERT INTO visual_maps(id, title, content, source_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (visual_map_id, request.title, request.content, request.source_type, db.dumps(request.metadata), now),
        )
        entries = self._parse_visual_map_entries(visual_map_id, request.content)
        for entry in entries:
            matched_assets = self._register_visual_folder(entry.get("visual_folder", ""))
            entry["matched_asset_ids"] = [a["id"] for a in matched_assets]
            db.execute(
                """
                INSERT INTO visual_map_entries(
                    id, visual_map_id, row_index, script_line_or_keyword, visual_folder,
                    visual_type, placement_note, priority, matched_asset_ids
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry["id"],
                    visual_map_id,
                    entry["row_index"],
                    entry["script_line_or_keyword"],
                    entry["visual_folder"],
                    entry["visual_type"],
                    entry["placement_note"],
                    entry["priority"],
                    db.dumps(entry["matched_asset_ids"]),
                ),
            )
            db.upsert_fts(
                "visual_map_entry",
                entry["id"],
                entry["script_line_or_keyword"],
                " ".join([entry["visual_folder"], entry["visual_type"], entry["placement_note"]]),
                entry["priority"],
            )
        db.upsert_fts("visual_map", visual_map_id, request.title, request.content)
        return {"id": visual_map_id, "title": request.title, "entry_count": len(entries), "entries": entries}

    def get_visual_map_entries(self, visual_map_id: str) -> List[Dict[str, Any]]:
        rows = db.fetch_all(
            "SELECT * FROM visual_map_entries WHERE visual_map_id = ? ORDER BY row_index",
            (visual_map_id,),
        )
        for row in rows:
            row["matched_asset_ids"] = db.loads(row.get("matched_asset_ids"), [])
        return rows

    def create_edit_plan(self, request: EditPlanCreateRequest) -> Dict[str, Any]:
        plan_id = self._id("plan")
        now = utc_now()
        db.execute(
            """
            INSERT INTO edit_plans(
                id, operation, sources, script_id, visual_map_id, target, cleanup_style,
                matching, visual_density, constraints, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan_id,
                request.operation,
                db.dumps(request.sources),
                request.script_id,
                request.visual_map_id,
                request.target,
                request.cleanup_style,
                request.matching,
                request.visual_density,
                db.dumps(request.constraints),
                "planned",
                now,
            ),
        )
        job = self.create_job("edit_plan", plan_id, "planned", "Edit plan created")
        plan = self.get_edit_plan(plan_id)
        plan["job"] = job
        return plan

    def get_edit_plan(self, plan_id: str) -> Dict[str, Any]:
        row = db.fetch_one("SELECT * FROM edit_plans WHERE id = ?", (plan_id,))
        if not row:
            raise KeyError(f"Edit plan not found: {plan_id}")
        row["sources"] = db.loads(row.get("sources"), [])
        row["constraints"] = db.loads(row.get("constraints"), {})
        return row

    def dry_run_plan(self, plan_id: str) -> Dict[str, Any]:
        plan = self.get_edit_plan(plan_id)
        timeline_items = self._timeline_items_for_asset_sequence(plan)
        coverage = [] if timeline_items else self._match_script_to_candidates(plan)
        placements = [] if timeline_items else self._match_visuals_to_lines(plan, coverage)
        missing = [item for item in coverage if item.get("warning")]
        estimated_duration = round(
            sum((item.get("duration") or 0) for item in timeline_items)
            or sum((item.get("end", 0) - item.get("start", 0)) for item in coverage if item.get("candidate_id")),
            2,
        )
        result = DryRunResult(
            plan_id=plan_id,
            would_change=len(timeline_items) + len([item for item in coverage if item.get("candidate_id")]) + len(placements),
            estimated_duration=estimated_duration,
            timeline_items=timeline_items,
            script_coverage=coverage,
            visual_placements=placements,
            missing_lines=missing,
            warnings=self._dry_run_warnings(plan, timeline_items, coverage),
        ).model_dump()
        job = self.create_job("dry_run", plan_id, "completed", "Dry run generated", result)
        db.execute("UPDATE edit_plans SET status = ? WHERE id = ?", ("dry_run_ready", plan_id))
        result["job"] = job
        return result

    def execute_plan(self, plan_id: str) -> Dict[str, Any]:
        plan = self.get_edit_plan(plan_id)
        dry_run = self.dry_run_plan(plan_id)
        edl = self._build_edl_from_dry_run(plan, dry_run)
        settings = get_settings()
        settings.EDL_DIR.mkdir(parents=True, exist_ok=True)
        edl_path = settings.EDL_DIR / f"{edl['id']}.json"
        with edl_path.open("w", encoding="utf-8") as f:
            json.dump(edl, f, ensure_ascii=True, indent=2)

        result = {
            "success": True,
            "plan_id": plan_id,
            "status": "submitted",
            "message": "Template EDL generated. The CEP panel/Premiere bridge must execute the EDL and then verify the sequence.",
            "edl_id": edl["id"],
            "edl_path": str(edl_path),
            "clip_count": len(edl["clips"]),
            "requires_premiere_execution": True,
            "warnings": edl["warnings"],
            "virtual_edit_spec": edl,
        }
        job = self.create_job("execute", plan_id, "submitted", result["message"], result)
        db.execute(
            """
            INSERT INTO script_runs(id, job_id, plan_id, run_type, script_body, result, logs, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                self._id("run"),
                job["id"],
                plan_id,
                "template_edl",
                db.dumps(edl),
                db.dumps(result),
                "[]",
                "",
                utc_now(),
            ),
        )
        db.execute("UPDATE edit_plans SET status = ? WHERE id = ?", ("submitted", plan_id))
        result["job"] = job
        return result

    def execute_plan_placeholder(self, plan_id: str) -> Dict[str, Any]:
        return self.execute_plan(plan_id)

    def verify_plan(
        self,
        plan_id: str,
        premiere_result: Optional[Dict[str, Any]] = None,
        sequence_state: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        self.get_edit_plan(plan_id)
        premiere_result = premiere_result or {}
        edl = self._latest_edl_for_plan(plan_id)
        sequence_state = sequence_state or self._latest_sequence_snapshot()
        warnings = []
        missing = []

        if premiere_result and premiere_result.get("success") is False:
            warnings.append(premiere_result.get("error") or "Premiere reported execution failure")

        if not edl:
            warnings.append("No submitted EDL found for this plan")

        if not sequence_state:
            warnings.append("No sequence snapshot available for verification")

        if edl and sequence_state:
            missing = self._missing_edl_clips(edl, sequence_state)
            if missing:
                warnings.append(f"{len(missing)} expected clip(s) were not found in the sequence snapshot")

        verified = not warnings
        result = {
            "success": verified,
            "plan_id": plan_id,
            "verified": verified,
            "expected_clip_count": len(edl.get("clips", [])) if edl else 0,
            "missing": missing,
            "warnings": warnings,
            "message": "Verification passed." if verified else "Verification found mismatches or missing data.",
        }
        job = self.create_job("verify", plan_id, "completed" if verified else "failed", result["message"], result)
        db.execute("UPDATE edit_plans SET status = ? WHERE id = ?", ("verified" if verified else "verify_failed", plan_id))
        result["job"] = job
        return result

    def verify_plan_placeholder(self, plan_id: str) -> Dict[str, Any]:
        return self.verify_plan(plan_id)

    def create_job(
        self,
        job_type: str,
        target_id: Optional[str],
        status: str,
        message: str = "",
        result: Optional[Dict[str, Any]] = None,
        error: str = "",
        progress: float = 0.0,
    ) -> Dict[str, Any]:
        job_id = self._id("job")
        now = utc_now()
        db.execute(
            """
            INSERT INTO jobs(id, job_type, status, target_id, progress, message, result, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (job_id, job_type, status, target_id, progress, message, db.dumps(result or {}), error, now, now),
        )
        return self.get_job(job_id)

    def update_job(
        self,
        job_id: str,
        status: Optional[str] = None,
        progress: Optional[float] = None,
        message: Optional[str] = None,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> Dict[str, Any]:
        existing = self.get_job(job_id)
        db.execute(
            """
            UPDATE jobs
            SET status = ?, progress = ?, message = ?, result = ?, error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                status if status is not None else existing.get("status", ""),
                progress if progress is not None else existing.get("progress", 0.0),
                message if message is not None else existing.get("message", ""),
                db.dumps(result if result is not None else existing.get("result", {})),
                error if error is not None else existing.get("error", ""),
                utc_now(),
                job_id,
            ),
        )
        return self.get_job(job_id)

    def get_job(self, job_id: str) -> Dict[str, Any]:
        row = db.fetch_one("SELECT * FROM jobs WHERE id = ?", (job_id,))
        if not row:
            raise KeyError(f"Job not found: {job_id}")
        row["result"] = db.loads(row.get("result"), {})
        return row

    def recent_jobs(self, limit: int = 20) -> List[Dict[str, Any]]:
        rows = db.fetch_all("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))
        for row in rows:
            row["result"] = db.loads(row.get("result"), {})
        return rows

    def save_premiere_snapshot(self, snapshot_type: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        snapshot_id = self._id("snap")
        now = utc_now()
        db.execute(
            "INSERT INTO premiere_snapshots(id, snapshot_type, payload, created_at) VALUES (?, ?, ?, ?)",
            (snapshot_id, snapshot_type, db.dumps(payload), now),
        )
        return {"id": snapshot_id, "snapshot_type": snapshot_type, "created_at": now}

    def _timeline_items_for_asset_sequence(self, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
        if plan.get("operation") not in {"combine_assets_new_sequence", "combine_folder_videos_new_sequence"}:
            return []

        items = []
        cursor = 0.0
        for index, source_ref in enumerate(plan.get("sources", [])):
            asset_id = self._ref_id(source_ref)
            try:
                asset = self.get_asset(asset_id)
            except KeyError:
                items.append({
                    "asset_id": asset_id,
                    "index": index,
                    "start_time": cursor,
                    "duration": 0.0,
                    "warning": "Asset not found",
                })
                continue

            duration = float(asset.get("duration") or 0)
            if duration <= 0:
                duration = float((plan.get("constraints") or {}).get("default_clip_duration") or 5.0)
            item = {
                "asset_id": asset["id"],
                "name": asset["name"],
                "path": asset["path"],
                "asset_type": asset["asset_type"],
                "start_time": round(cursor, 3),
                "in_point": 0.0,
                "out_point": round(duration, 3),
                "duration": round(duration, 3),
                "track_index": 0,
                "notes": "Append asset to new sequence",
                "warning": None,
            }
            items.append(item)
            cursor += duration
        return items

    def _dry_run_warnings(
        self,
        plan: Dict[str, Any],
        timeline_items: List[Dict[str, Any]],
        coverage: List[Dict[str, Any]],
    ) -> List[str]:
        warnings = [item["warning"] for item in timeline_items if item.get("warning")]
        if plan.get("operation") in {"combine_assets_new_sequence", "combine_folder_videos_new_sequence"}:
            if not timeline_items:
                warnings.append("No assets were resolved for the sequence.")
            return warnings
        return warnings if coverage else ["No script/candidate coverage could be generated."]

    def _build_edl_from_dry_run(self, plan: Dict[str, Any], dry_run: Dict[str, Any]) -> Dict[str, Any]:
        edl_id = self._id("edl")
        clips = []
        warnings = list(dry_run.get("warnings") or [])
        line_timing: Dict[str, Dict[str, float]] = {}
        cursor = 0.0

        for item in dry_run.get("timeline_items", []):
            asset = self.get_asset(item["asset_id"])
            start_time = float(item.get("start_time") or 0)
            in_point = float(item.get("in_point") or 0)
            out_point = float(item.get("out_point") or item.get("duration") or 0)
            if out_point <= in_point:
                warnings.append(f"Timeline item has no usable duration: {item.get('asset_id')}")
                continue

            base_clip = {
                "action": "add",
                "source_path": asset["path"],
                "in_point": in_point,
                "out_point": out_point,
                "start_time": round(start_time, 3),
                "scale": 100,
                "speed": 1.0,
                "notes": item.get("notes", ""),
            }
            clips.append({
                **base_clip,
                "id": f"{item['asset_id']}_v",
                "clip_type": "a_roll" if asset["asset_type"] == "video" else "b_roll",
                "track_index": 0,
            })
            if asset.get("has_audio") or asset["asset_type"] == "audio":
                clips.append({
                    **base_clip,
                    "id": f"{item['asset_id']}_a",
                    "clip_type": "a_audio",
                    "track_index": 0,
                })

        for item in dry_run.get("script_coverage", []):
            candidate_id = item.get("candidate_id")
            if not candidate_id:
                warnings.append(f"Missing spoken candidate for script line {item.get('script_line_id')}")
                continue

            asset = self.get_asset(item["asset_id"])
            source_start = float(item.get("start") or 0)
            source_end = float(item.get("end") or source_start)
            duration = max(0.0, source_end - source_start)
            if duration <= 0:
                warnings.append(f"Candidate {candidate_id} has no usable duration")
                continue

            line_timing[item["script_line_id"]] = {"start": cursor, "duration": duration}
            base_clip = {
                "action": "add",
                "source_path": asset["path"],
                "in_point": source_start,
                "out_point": source_end,
                "start_time": round(cursor, 3),
                "scale": 100,
                "speed": 1.0,
                "notes": item.get("text", ""),
            }
            clips.append({
                **base_clip,
                "id": f"{candidate_id}_v",
                "clip_type": "a_roll",
                "track_index": 0,
            })
            if asset.get("has_audio"):
                clips.append({
                    **base_clip,
                    "id": f"{candidate_id}_a",
                    "clip_type": "a_audio",
                    "track_index": 0,
                })
            cursor += duration

        for index, placement in enumerate(dry_run.get("visual_placements", [])):
            asset_id = placement.get("visual_asset_id")
            timing = line_timing.get(placement.get("script_line_id"))
            if not timing:
                warnings.append(f"Visual placement skipped because the script line is missing: {placement.get('keyword')}")
                continue
            if not asset_id:
                warnings.append(f"No usable visual asset found for: {placement.get('keyword')}")
                continue

            asset = self.get_asset(asset_id)
            desired_duration = max(0.5, float(timing["duration"]))
            source_duration = float(asset.get("duration") or desired_duration)
            visual_duration = min(desired_duration, source_duration) if source_duration > 0 else desired_duration
            clips.append({
                "id": f"{asset_id}_v{index}",
                "action": "add",
                "clip_type": "b_roll",
                "source_path": asset["path"],
                "in_point": 0.0,
                "out_point": round(visual_duration, 3),
                "start_time": round(timing["start"], 3),
                "track_index": 1,
                "scale": 100,
                "speed": 1.0,
                "notes": placement.get("placement_note", ""),
            })

        return {
            "id": edl_id,
            "plan_id": plan["id"],
            "operation": plan["operation"],
            "target": plan["target"],
            "undo_group": f"EditFlow AI - {plan['operation']}",
            "created_at": utc_now(),
            "clips": clips,
            "script_coverage": dry_run.get("script_coverage", []),
            "visual_placements": dry_run.get("visual_placements", []),
            "missing_lines": dry_run.get("missing_lines", []),
            "warnings": warnings,
        }

    def _latest_edl_for_plan(self, plan_id: str) -> Dict[str, Any]:
        row = db.fetch_one(
            """
            SELECT script_body FROM script_runs
            WHERE plan_id = ? AND run_type = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (plan_id, "template_edl"),
        )
        return db.loads(row.get("script_body"), {}) if row else {}

    def _latest_sequence_snapshot(self) -> Dict[str, Any]:
        row = db.fetch_one(
            """
            SELECT payload FROM premiere_snapshots
            WHERE snapshot_type = ?
            ORDER BY created_at DESC
            LIMIT 1
            """,
            ("sequence",),
        )
        return db.loads(row.get("payload"), {}) if row else {}

    def _missing_edl_clips(self, edl: Dict[str, Any], sequence_state: Dict[str, Any]) -> List[Dict[str, Any]]:
        actual_clips = sequence_state.get("clips") or []
        missing = []
        for expected in edl.get("clips", []):
            if not self._sequence_contains_expected_clip(expected, actual_clips):
                missing.append({
                    "id": expected.get("id"),
                    "source_path": expected.get("source_path"),
                    "start_time": expected.get("start_time"),
                    "track_index": expected.get("track_index"),
                    "clip_type": expected.get("clip_type"),
                })
        return missing

    def _sequence_contains_expected_clip(self, expected: Dict[str, Any], actual_clips: List[Dict[str, Any]]) -> bool:
        expected_path = str(expected.get("source_path") or "")
        expected_name = Path(expected_path).name.lower()
        expected_start = float(expected.get("start_time") or 0)
        expected_track = int(expected.get("track_index") or 0)
        expected_type = "audio" if expected.get("clip_type") == "a_audio" else "video"

        for clip in actual_clips:
            clip_path = str(clip.get("path") or clip.get("mediaPath") or "")
            clip_name = str(clip.get("name") or "").lower()
            path_matches = (
                bool(expected_path and clip_path and clip_path.lower() == expected_path.lower())
                or bool(expected_name and expected_name in clip_name)
                or bool(expected_name and clip_path.lower().endswith(expected_name))
            )
            if not path_matches:
                continue

            track_type = str(clip.get("track_type") or clip.get("trackType") or expected_type).lower()
            if track_type != expected_type:
                continue

            track_index = int(float(clip.get("track_index", clip.get("trackIndex", 0)) or 0))
            if track_index != expected_track:
                continue

            start = float(clip.get("start_time", clip.get("startTime", 0)) or 0)
            if abs(start - expected_start) <= 0.25:
                return True
        return False

    def _save_transcript(self, asset_id: str, transcript: Any) -> str:
        db.execute("DELETE FROM transcripts WHERE asset_id = ?", (asset_id,))
        transcript_id = self._id("tx")
        now = utc_now()
        db.execute(
            "INSERT INTO transcripts(id, asset_id, language, duration, full_text, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (transcript_id, asset_id, transcript.language, transcript.duration, transcript.full_text, "{}", now),
        )
        for idx, segment in enumerate(transcript.segments):
            segment_id = self._id("seg")
            words = [w.dict() for w in getattr(segment, "words", [])]
            db.execute(
                "INSERT INTO transcript_segments(id, transcript_id, asset_id, start, end, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (segment_id, transcript_id, asset_id, segment.start, segment.end, segment.text, db.dumps(words)),
            )
            db.upsert_fts("transcript_segment", segment_id, f"{asset_id} segment {idx}", segment.text)
        db.upsert_fts("transcript", transcript_id, asset_id, transcript.full_text)
        return transcript_id

    def _create_speech_candidates(self, asset_id: str):
        db.execute("DELETE FROM speech_candidates WHERE asset_id = ?", (asset_id,))
        segments = db.fetch_all(
            "SELECT * FROM transcript_segments WHERE asset_id = ? ORDER BY start",
            (asset_id,),
        )
        for segment in segments:
            text = segment["text"].strip()
            if not text:
                continue
            candidate_id = self._id("cand")
            warnings = self._candidate_warnings(text, segment["end"] - segment["start"])
            scores = self._score_candidate(text, warnings)
            reason = "clean_speech" if not warnings else "usable_with_warnings"
            db.execute(
                """
                INSERT INTO speech_candidates(
                    id, asset_id, start, end, transcript_excerpt, cleaned_excerpt,
                    reason, warnings, scores, metadata
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate_id,
                    asset_id,
                    segment["start"],
                    segment["end"],
                    text,
                    self._clean_text(text),
                    reason,
                    db.dumps(warnings),
                    db.dumps(scores),
                    "{}",
                ),
            )
            db.upsert_fts(
                "speech_candidate",
                candidate_id,
                f"{asset_id} candidate",
                text,
                " ".join(warnings),
            )

    def _match_script_to_candidates(self, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not plan.get("script_id"):
            return []
        lines = self.get_script_lines(plan["script_id"])
        candidates = []
        for source_ref in plan.get("sources", []):
            asset_id = self._ref_id(source_ref)
            candidates.extend(self.get_speech_candidates(asset_id))
        coverage = []
        for line in lines:
            best = self._best_candidate_for_line(line["text"], candidates)
            if not best:
                coverage.append({
                    "script_line_id": line["id"],
                    "text": line["text"],
                    "candidate_id": None,
                    "warning": "No matching spoken candidate found",
                })
                continue
            coverage.append({
                "script_line_id": line["id"],
                "text": line["text"],
                "candidate_id": best["id"],
                "asset_id": best["asset_id"],
                "start": best["start"],
                "end": best["end"],
                "transcript_excerpt": best["transcript_excerpt"],
                "match_score": best["_match_score"],
                "delivery_score": best["scores"].get("delivery_quality", 0.0),
                "warning": None if best["_match_score"] >= 0.12 else "Weak meaning match",
            })
        return coverage

    def _match_visuals_to_lines(self, plan: Dict[str, Any], coverage: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not plan.get("visual_map_id"):
            return []
        entries = self.get_visual_map_entries(plan["visual_map_id"])
        placements = []
        for entry in entries:
            target = self._find_coverage_for_visual(entry, coverage)
            if not target:
                continue
            asset_ids = entry.get("matched_asset_ids") or []
            placements.append({
                "script_line_id": target["script_line_id"],
                "keyword": entry["script_line_or_keyword"],
                "visual_folder": entry["visual_folder"],
                "visual_asset_id": asset_ids[0] if asset_ids else None,
                "placement_note": entry["placement_note"],
                "priority": entry["priority"],
                "warning": None if asset_ids else "No usable visual assets found in folder",
            })
        return placements

    def _find_coverage_for_visual(self, entry: Dict[str, Any], coverage: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        keyword = self._tokenize(entry.get("script_line_or_keyword", ""))
        if not keyword:
            return coverage[0] if coverage else None
        best = None
        best_score = 0.0
        for item in coverage:
            score = self._overlap_score(keyword, self._tokenize(item.get("text", "")))
            if score > best_score:
                best = item
                best_score = score
        return best if best_score > 0 else (coverage[0] if coverage else None)

    def _best_candidate_for_line(self, line_text: str, candidates: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        line_tokens = self._tokenize(line_text)
        best = None
        best_score = 0.0
        for candidate in candidates:
            candidate_tokens = self._tokenize(candidate["transcript_excerpt"])
            semantic = self._overlap_score(line_tokens, candidate_tokens)
            final_score = 0.7 * semantic + 0.3 * candidate["scores"].get("final_score", 0.0)
            if final_score > best_score:
                best = dict(candidate)
                best["_match_score"] = round(final_score, 3)
                best_score = final_score
        return best

    def _register_visual_folder(self, folder: str) -> List[Dict[str, Any]]:
        if not folder:
            return []
        path = Path(folder.strip().strip('"'))
        assert_not_test_like_path(path, "visual folder path")
        if not path.exists() or not path.is_dir():
            return []
        assets = []
        for file_path in sorted(path.iterdir()):
            if file_path.is_file() and file_path.suffix.lower() in MEDIA_EXTS:
                assets.append(
                    self.register_asset(
                        AssetRegisterRequest(
                            path=str(file_path),
                            source_type="visual_map_folder",
                            tags=["visual"],
                        )
                    )
                )
        return assets

    def _parse_visual_map_entries(self, visual_map_id: str, content: str) -> List[Dict[str, Any]]:
        entries = []
        for row_index, raw_line in enumerate(content.splitlines()):
            line = raw_line.strip()
            if not line or set(line) <= {"-", "|", " "}:
                continue
            parts = [p.strip().strip('"') for p in line.split("|")]
            if len(parts) < 2:
                continue
            if row_index == 0 and "folder" in line.lower() and "script" in line.lower():
                continue
            entries.append({
                "id": self._id("vme"),
                "visual_map_id": visual_map_id,
                "row_index": len(entries),
                "script_line_or_keyword": parts[0],
                "visual_folder": parts[1],
                "visual_type": parts[2] if len(parts) > 2 else "",
                "placement_note": parts[3] if len(parts) > 3 else "",
                "priority": parts[4] if len(parts) > 4 else "normal",
                "matched_asset_ids": [],
            })
        return entries

    def _split_script_lines(self, script_id: str, content: str) -> List[Dict[str, Any]]:
        raw_lines = []
        for paragraph in re.split(r"\n+|(?<=[.!?])\s+(?=[A-Z0-9])", content):
            text = paragraph.strip(" \t\r\n-*")
            if len(text) >= 3:
                raw_lines.append(text)
        lines = []
        for index, text in enumerate(raw_lines):
            lines.append({
                "id": self._id("line"),
                "script_id": script_id,
                "line_index": index,
                "text": text,
                "meaning_summary": self._meaning_summary(text),
                "priority": "normal",
                "desired_duration": None,
                "visual_requirement": "",
            })
        return lines

    def _index_asset(self, asset: Dict[str, Any]):
        body = " ".join([
            asset.get("path", ""),
            asset.get("asset_type", ""),
            asset.get("source_type", ""),
            " ".join(asset.get("tags", [])),
        ])
        db.upsert_fts("asset", asset["id"], asset["name"], body, " ".join(asset.get("tags", [])))

    def _decode_asset(self, row: Dict[str, Any]) -> Dict[str, Any]:
        row = dict(row)
        row["has_audio"] = bool(row.get("has_audio"))
        row["tags"] = db.loads(row.get("tags"), [])
        row["metadata"] = db.loads(row.get("metadata"), {})
        return row

    def _decode_segment(self, row: Dict[str, Any]) -> Dict[str, Any]:
        row = dict(row)
        row["words"] = db.loads(row.get("words"), [])
        return row

    def _decode_candidate(self, row: Dict[str, Any]) -> Dict[str, Any]:
        row = dict(row)
        row["warnings"] = db.loads(row.get("warnings"), [])
        row["scores"] = db.loads(row.get("scores"), {})
        row["metadata"] = db.loads(row.get("metadata"), {})
        return row

    def _candidate_warnings(self, text: str, duration: float) -> List[str]:
        lowered = text.lower()
        warnings = []
        filler_count = sum(lowered.count(filler) for filler in FILLERS)
        if filler_count >= 3:
            warnings.append("filler_heavy")
        words = re.findall(r"[a-zA-Z']+", lowered)
        bigrams = [" ".join(words[i:i + 2]) for i in range(max(0, len(words) - 1))]
        if any(count >= 3 for count in Counter(bigrams).values()):
            warnings.append("possible_repetition")
        if duration > 16:
            warnings.append("long_segment")
        if len(words) < 4:
            warnings.append("very_short")
        return warnings

    def _score_candidate(self, text: str, warnings: List[str]) -> Dict[str, float]:
        words = re.findall(r"[a-zA-Z']+", text.lower())
        length_score = min(1.0, max(0.2, len(words) / 35.0))
        cleanliness = max(0.1, 1.0 - 0.18 * len(warnings))
        delivery = max(0.1, 0.75 * cleanliness + 0.25 * length_score)
        final = round((cleanliness + delivery + length_score) / 3.0, 3)
        return {
            "semantic_usefulness": round(length_score, 3),
            "delivery_quality": round(delivery, 3),
            "audio_quality": 0.8,
            "cleanliness": round(cleanliness, 3),
            "natural_pacing": round(length_score, 3),
            "final_score": final,
        }

    def _clean_text(self, text: str) -> str:
        cleaned = text
        for filler in sorted(FILLERS, key=len, reverse=True):
            cleaned = re.sub(rf"\b{re.escape(filler)}\b,?\s*", "", cleaned, flags=re.IGNORECASE)
        return re.sub(r"\s+", " ", cleaned).strip()

    def _meaning_summary(self, text: str) -> str:
        words = self._tokenize(text)
        return " ".join(words[:12])

    def _tokenize(self, text: str) -> List[str]:
        stop = {"the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "this", "that", "it"}
        return [w for w in re.findall(r"[a-zA-Z0-9']+", text.lower()) if w not in stop and len(w) > 2]

    def _overlap_score(self, left: List[str], right: List[str]) -> float:
        if not left or not right:
            return 0.0
        left_set = set(left)
        right_set = set(right)
        return len(left_set & right_set) / max(1, len(left_set))

    def _ref_id(self, ref: str) -> str:
        if ":" in ref:
            return ref.split(":", 1)[1]
        return ref

    def _fingerprint(self, path: Path, file_size: int) -> str:
        if not path.exists() or not path.is_file():
            return ""
        stat = path.stat()
        seed = f"{path.resolve()}|{file_size}|{stat.st_mtime}".encode("utf-8")
        h = hashlib.sha1(seed)
        try:
            with path.open("rb") as f:
                h.update(f.read(1024 * 1024))
        except Exception:
            pass
        return h.hexdigest()

    def _id(self, prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex[:12]}"


v2_registry_service = V2RegistryService()
