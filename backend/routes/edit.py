"""
EditFlow AI - Edit Routes

Wire up the four HTTP endpoints the CEP panel calls for the
take-based script editing workflow.

MVP Task M9.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..models.schemas import utc_now
from ..services.bin_resolver import AmbiguousReferenceError, resolve as resolve_bins
from ..services.cut_planner import Plan, build_plan, plan_to_edl_ops
from ..services.match_validator import validate_and_fix
from ..services.plan_store import plan_store
from ..services.script_matcher import match_script_to_takes
from ..services.take_segmenter import segment_into_takes
from ..services.whisper_service import filter_junk_segments, whisper_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/edit", tags=["edit"])


# ── Request/Response models ──


class AnalyzeRequest(BaseModel):
    bin_references: List[str] = Field(default_factory=list)
    bin: Optional[str] = None
    script: str
    language: Optional[str] = None
    user_hint: Optional[str] = None
    matcher_model: Optional[str] = None
    client_id: Optional[str] = None


class ApplyRequest(BaseModel):
    target_sequence_name: Optional[str] = None


class RegenerateRequest(BaseModel):
    bin_references: List[str] = Field(default_factory=list)
    bin: Optional[str] = None
    script: str
    language: Optional[str] = None
    user_hint: Optional[str] = None
    matcher_model: Optional[str] = None
    previous_plan_id: Optional[str] = None
    client_id: Optional[str] = None


# ── Helpers ──


def _get_project_scan() -> dict:
    """Fetch the latest project scan from the premiere context endpoint."""
    try:
        from . import premiere
        return premiere._project_context
    except Exception:
        return getattr(_get_project_scan, "_cache", {})


def _store_project_scan(scan: dict) -> None:
    """Cache the project scan in memory."""
    _get_project_scan._cache = scan


def _resolve_matcher_model(requested: Optional[str]) -> str:
    """Resolve the matcher model name from request or active provider."""
    if requested:
        return requested
    try:
        from ..services.provider_service import provider_service
        return provider_service._active_chat_model or "gemma3:4b"
    except Exception:
        return "gemma3:4b"


# ── Endpoints ──


async def run_analyze(req: AnalyzeRequest) -> dict:
    """Run the full take-based editing pipeline: resolve, transcribe, match, plan.

    Extracted as a free function so the agent tools can call it directly
    without going through the HTTP layer.

    Returns the plan ID, status, and summary.
    """
    bin_references = req.bin_references or ([req.bin] if req.bin else [])
    if not bin_references:
        raise HTTPException(status_code=400, detail="bin_references is required")
    if not req.script.strip():
        raise HTTPException(status_code=400, detail="script is required")

    # Step 1: Resolve bin references
    project_scan = _get_project_scan()
    all_warnings: list[str] = []
    try:
        clips = resolve_bins(bin_references, project_scan)
    except AmbiguousReferenceError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if not clips:
        raise HTTPException(status_code=400, detail="No audio clips found in referenced bins")

    # Performance guardrail: warn or reject on very long bins
    total_duration = sum(clip.duration for clip in clips)
    if total_duration > 12 * 3600:  # > 12 hours
        raise HTTPException(status_code=400, detail=f"Bin contains {total_duration/3600:.1f} hours of audio. Please narrow the bin reference to under 12 hours.")
    elif total_duration > 4 * 3600:  # > 4 hours
        all_warnings.append(f"WARNING: Bin contains {total_duration/3600:.1f} hours of audio. Transcription may take a very long time.")
    elif total_duration > 30 * 60:  # > 30 minutes
        all_warnings.append(f"INFO: Bin contains {total_duration/60:.1f} minutes of audio.")

    # Step 2: Transcribe each unique source file
    transcripts: dict[str, Any] = {}
    all_takes = []

    for i, clip in enumerate(clips):
        try:
            # Try to reuse the transcript cached by transcribe_clips first.
            # transcribe_clips calls whisper_service.transcribe_fingerprinted
            # with the SOURCE path (clip.path), so its cache key is the
            # source's content hash.  If we run audio_prepare here and then
            # pass the prepared WAV's path, we compute a DIFFERENT cache key
            # and trigger a full re-transcription — 5+ minutes wasted per
            # script-match call.  Always try the source path first.
            try:
                result = await whisper_service.transcribe_fingerprinted(
                    clip.path,
                    language=req.language,
                    force=False,  # cache-only mode in practice when a hit exists
                )
            except Exception as cache_miss:
                # Fallback to the prepared-audio path if direct transcription
                # of the source fails (e.g. unsupported container that needs
                # ffmpeg extraction first).
                logger.info(
                    f"run_analyze: source-path transcribe failed for {clip.name}, "
                    f"falling back to audio_prepare ({cache_miss})"
                )
                from ..services.audio_prepare import audio_prepare_service
                prepared = audio_prepare_service.prepare(clip.path)
                result = await whisper_service.transcribe_fingerprinted(
                    prepared.prepared_wav_path or clip.path,
                    language=req.language,
                )

            # Junk filter
            result, junk_reasons = filter_junk_segments(result)
            if junk_reasons:
                all_warnings.extend(
                    f"{clip.name}: dropped {len(junk_reasons)} segment(s)"
                    for _ in [1]
                )

            # Segment into takes
            takes = segment_into_takes(clip.path, result)
            all_takes.extend(takes)
            transcripts[clip.path] = result

        except FileNotFoundError:
            all_warnings.append(f"File not found: {clip.path}")
            continue
        except Exception as e:
            all_warnings.append(f"Failed to process {clip.name}: {e}")
            logger.warning(f"Failed to process {clip.path}: {e}")
            continue

    if not all_takes:
        raise HTTPException(status_code=400, detail="No takes could be extracted from the source files")

    # Step 3: Build word lookup (source_file -> flat word list)
    from ..models.schemas import TranscriptWord
    word_lookup: dict[str, list[TranscriptWord]] = {}
    for path, transcript in transcripts.items():
        flat_words = []
        for seg in transcript.segments:
            flat_words.extend(seg.words)
        word_lookup[path] = flat_words

    # Step 4: Match script to takes
    matcher_model = _resolve_matcher_model(req.matcher_model)
    matched = await match_script_to_takes(
        req.script,
        all_takes,
        word_lookup=word_lookup,
        language_hint=req.language,
        user_hint=req.user_hint,
        matcher_model=matcher_model,
    )

    # Step 5: Validate matches
    validated = []
    for mb in matched:
        if mb.take is not None:
            take_words = word_lookup.get(mb.take.source_file, [])
            take_words = take_words[mb.take.word_offset:mb.take.word_offset + mb.take.word_count]
            vm = validate_and_fix(mb, take_words)
        else:
            # FIX: was `from .match_validator` (wrong package — would fire
            # ModuleNotFoundError whenever the matcher returned an unmatched
            # beat, which is exactly when this fallback is needed).
            # match_validator lives in backend.services, not backend.routes.
            from ..services.match_validator import ValidatedMatch
            vm = ValidatedMatch(matched=mb)
        validated.append(vm)

    # Step 6: Build plan
    # Determine engine from transcript results (use first available)
    engine = "faster_whisper"
    for _path, tr in transcripts.items():
        if getattr(tr, "engine", None):
            engine = tr.engine
            break

    plan = build_plan(
        bin_reference=", ".join(bin_references),
        script=req.script,
        user_hint=req.user_hint,
        matcher_model=matcher_model,
        validated_matches=validated,
        word_lookup=word_lookup,
        engine=engine,
        takes_qualities=None,  # placeholder: no LUFS data available yet
    )

    # Step 7: Save plan
    plan_path = plan_store.save(plan)
    logger.info(f"Plan {plan.plan_id} saved to {plan_path}")

    # Determine status
    if plan.summary["unmatched"] == 0:
        status = "ready"
    elif plan.summary["matched"] > 0:
        status = "partial"
    else:
        status = "low_confidence"

    return {
        "plan_id": plan.plan_id,
        "status": status,
        "summary": plan.summary,
        "warnings": all_warnings,
    }


@router.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """HTTP endpoint for the edit analysis pipeline."""
    return await run_analyze(req)


@router.get("/plan/{plan_id}")
async def get_plan(plan_id: str):
    """Return a stored plan by ID."""
    try:
        plan_data = plan_store.load(plan_id)
        return plan_data
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found")
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))


async def run_apply_plan(plan_id: str, req: ApplyRequest) -> dict:
    """Apply a plan: generate ExtendScript operations for the CEP panel.

    Extracted as a free function so the agent tools can call it directly.
    The panel dispatches the ops via ``evalExtendScript('processEDL', ...)``.
    """
    try:
        plan_data = plan_store.load(plan_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found")

    # Reconstruct Plan from dict (simplified)
    cuts = plan_data.get("cuts", [])
    if not cuts:
        raise HTTPException(status_code=400, detail="Plan has no cuts to apply")

    # Determine target sequence name
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target_name = req.target_sequence_name or f"EditFlow Cut — {ts}"

    # Build ExtendScript operations
    from ..services.cut_planner import Plan as PlanModel, Cut
    # Reconstruct a minimal Plan object for plan_to_edl_ops
    plan_obj = PlanModel(
        plan_id=plan_data.get("plan_id", plan_id),
        created_at=plan_data.get("created_at", ""),
        bin_reference=plan_data.get("bin_reference", ""),
        script=plan_data.get("script", ""),
        user_hint=plan_data.get("user_hint"),
        matcher_model=plan_data.get("matcher_model", ""),
        cuts=[
            Cut(
                beat_index=c.get("beat_index", 0),
                beat_text=c.get("beat_text", ""),
                take_source_file=c.get("take_source_file", ""),
                source_in=c.get("source_in", 0.0),
                source_out=c.get("source_out", 0.0),
                duration=c.get("duration", 0.0),
                timeline_position=c.get("timeline_position", 0.0),
                audio_fade_in_ms=c.get("audio_fade_in_ms", 15),
                audio_fade_out_ms=c.get("audio_fade_out_ms", 15),
                rationale=c.get("rationale", ""),
                warnings=c.get("warnings", []),
                fell_back_to_word_boundary=c.get("fell_back_to_word_boundary", False),
                take_id=c.get("take_id", ""),
                confidence=c.get("confidence", 0.0),
                alternates=c.get("alternates", []),
            )
            for c in cuts
        ],
        gaps=plan_data.get("gaps", []),
        summary=plan_data.get("summary", {}),
        level_warnings=plan_data.get("level_warnings", []),
    )

    edl_ops = plan_to_edl_ops(plan_obj, target_name)

    return {
        "extendscript_ops": edl_ops,
        "target_sequence_name": target_name,
        "cuts_applied": len(cuts),
    }


@router.post("/plan/{plan_id}/apply")
async def apply_plan(plan_id: str, req: ApplyRequest):
    """HTTP endpoint: apply a plan."""
    return await run_apply_plan(plan_id, req)


@router.post("/regenerate")
async def regenerate(req: RegenerateRequest):
    """Re-run the matcher with an optional hint.

    Re-uses cached transcripts + embeddings; only the matcher reruns.
    Produces a new plan (old plan stays on disk).
    """
    # Regeneration is essentially the same as analyze, but with a hint
    # and the previous_plan_id for reference
    analyze_req = AnalyzeRequest(
        bin_references=req.bin_references,
        bin=req.bin,
        script=req.script,
        language=req.language,
        user_hint=req.user_hint,
        matcher_model=req.matcher_model,
        client_id=req.client_id,
    )
    return await analyze(analyze_req)


@router.get("/plans")
async def list_plans(limit: int = 50):
    """List recent plans."""
    return plan_store.list(limit=limit)


@router.patch("/plan/{plan_id}/beat/{beat_index}")
async def override_beat(plan_id: str, beat_index: int, take_id: str):
    """Override a single beat's chosen take.

    Updates the plan so that beat ``beat_index`` uses the specified
    ``take_id`` instead of the matcher's original choice.  The plan
    file on disk is rewritten in place.
    """
    try:
        plan_data = plan_store.load(plan_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found")

    cuts = plan_data.get("cuts", [])
    if beat_index < 0 or beat_index >= len(cuts):
        raise HTTPException(status_code=400, detail=f"beat_index {beat_index} out of range (0–{len(cuts)-1})")

    beat = cuts[beat_index]
    beat["take_id"] = take_id
    beat["overridden"] = True

    # Persist updated plan
    plan_store.save_raw(plan_id, plan_data)

    return {
        "plan_id": plan_id,
        "beat_index": beat_index,
        "take_id": take_id,
        "message": f"Beat {beat_index} overridden to take {take_id}",
    }


@router.post("/plan/{plan_id}/export")
async def export_plan(plan_id: str, format: str = "json"):
    """Export a plan in various formats (json, edl).

    OTIO/XML export can be added when opentimelineio is installed.
    """
    try:
        plan_data = plan_store.load(plan_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Plan {plan_id} not found")

    if format == "json":
        return plan_data
    elif format == "edl":
        # Build a simple EDL from the plan cuts
        cuts = plan_data.get("cuts", [])
        edl_lines = []
        edl_lines.append("TITLE: EditFlow Cut Plan")
        for i, cut in enumerate(cuts):
            source = cut.get("take_source_file", "UNKNOWN")
            src_in = cut.get("source_in", 0.0)
            src_out = cut.get("source_out", 0.0)
            rec_in = cut.get("timeline_position", 0.0)
            rec_out = rec_in + (src_out - src_in)
            # Simple CMX 3600-style EDL line
            edl_lines.append(
                f"{i+1:03d}  AX       V     C        "
                f"{src_in:02d}:{int((src_in%1)*30):02d}:{int(((src_in%1)*30%1)*30):02d}:00 "
                f"{src_out:02d}:{int((src_out%1)*30):02d}:{int(((src_out%1)*30%1)*30):02d}:00 "
                f"{rec_in:02d}:{int((rec_in%1)*30):02d}:{int(((rec_in%1)*30%1)*30):02d}:00 "
                f"{rec_out:02d}:{int((rec_out%1)*30):02d}:{int(((rec_out%1)*30%1)*30):02d}:00"
            )
            edl_lines.append(f"* FROM CLIP NAME: {source}")
        return {"format": "edl", "content": "\n".join(edl_lines)}
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown export format '{format}'. Supported: json, edl. "
                   "OTIO/XML support can be added when opentimelineio is installed.",
        )
