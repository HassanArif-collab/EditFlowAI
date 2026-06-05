"""EditFlow AI — Review routes (transcript-first cut editor).

Endpoints (all under ``/api/review``):

  POST /ingest        paste an SRT/JSON transcript → parse, resolve the source
                      clip, build a playable proxy, tighten to speech, store a
                      review session → returns segments + a media URL.
  GET  /media/{id}    range-aware (HTTP 206) streaming of the proxy so the
                      panel's <video> can seek instantly.
  POST /suggest       deterministic keep/cut proposal (+ optional Gemma refine).
  POST /build         turn the user's kept segments into a Plan via the EXISTING
                      external-plan ingest path → returns plan_id. The panel then
                      calls the existing /api/edit/plan/{id}/apply to build the
                      sequence — no new timeline code.

Everything here is ADDITIVE. The legacy orchestrator / agent / external-plan
flows are untouched; a failure in Review never mutates their state.
"""
from __future__ import annotations

import json
import logging
import re
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from ..services.bin_resolver import resolve as resolve_bins
from ..services.external_plan import ExternalPlanError, build_plan_from_pasted_json
from ..services.review_media import ensure_playable_proxy, silence_regions
from ..services.review_service import (
    ReviewError,
    Segment,
    build_gemma_prompt,
    classify,
    kept_cuts,
    parse_gemma_decisions,
    parse_transcript,
    segments_to_dicts,
    tighten,
)
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/review", tags=["review"])

# In-memory review sessions for this backend process. Each entry:
#   { source_path, source_name, proxy_path, segments: list[Segment],
#     script, duration, codec, media_error }
_reviews: dict[str, dict] = {}


# ── Helpers ────────────────────────────────────────────────────────

def _get_project_scan() -> dict:
    """Latest project scan posted by the panel (lives on the premiere route)."""
    try:
        from . import premiere
        return getattr(premiere, "_project_context", None) or {}
    except Exception:  # noqa: BLE001
        return {}


def _scan_clip_paths(scan: dict) -> list[str]:
    paths: list[str] = []
    for it in (scan.get("items") or scan.get("clips") or []):
        mp = it.get("mediaPath") or it.get("media_path") or it.get("path")
        if mp:
            paths.append(mp)
    return paths


def _resolve_source(source_file: Optional[str], bin_references: Optional[list[str]]) -> str:
    """Map a basename / path / bin to one absolute source clip path.

    Resolution order: explicit existing path → bin references → project scan,
    matched by basename. Raises :class:`ReviewError` with an actionable message.
    """
    # 1. An explicit, existing path wins outright.
    if source_file:
        p = Path(source_file)
        if p.exists() and p.is_file():
            return str(p)

    scan = _get_project_scan()
    candidates: list[str] = []
    if bin_references:
        try:
            candidates = [c.path for c in resolve_bins(bin_references, scan)]
        except Exception as exc:  # noqa: BLE001
            logger.info("review: bin resolve failed (%s) — falling back to scan items", exc)
    if not candidates:
        candidates = _scan_clip_paths(scan)

    if source_file:
        base = Path(source_file).name.lower()
        matches = [c for c in candidates if Path(c).name.lower() == base]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ReviewError(
                f"Multiple clips are named '{Path(source_file).name}'. "
                "Paste the clip's full file path in the Source field."
            )

    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise ReviewError(
            "I couldn't find the source clip. Scan your project in EditFlow first, "
            "or paste the clip's full file path in the Source field."
        )
    raise ReviewError(
        f"Found {len(candidates)} clips in the project — type the clip's filename "
        "in the Source field so I know which one this transcript belongs to."
    )


def _kept(segments: list[Segment]) -> list[Segment]:
    return [s for s in segments if s.decision == "keep"]


def _summary(segments: list[Segment]) -> dict:
    kept = _kept(segments)
    final = sum((s.tight_out or s.end) - (s.tight_in or s.start) for s in kept)
    return {
        "total": len(segments),
        "keep": len(kept),
        "cut": len(segments) - len(kept),
        "final_duration": round(final, 2),
    }


def _persist(review_id: str, rev: dict) -> None:
    """Best-effort snapshot to data/review/{id}.json (debugging aid; non-fatal)."""
    try:
        from ..config import get_settings
        out = get_settings().DATA_DIR / "review"
        out.mkdir(parents=True, exist_ok=True)
        snap = {k: v for k, v in rev.items() if k != "segments"}
        snap["segments"] = segments_to_dicts(rev["segments"])
        (out / f"{review_id}.json").write_text(
            json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("review: snapshot write failed: %s", exc)


# ── POST /ingest ───────────────────────────────────────────────────

class IngestReq(BaseModel):
    transcript_text: str
    source_file: Optional[str] = None
    bin_references: Optional[list[str]] = None
    script: Optional[str] = ""
    fmt: Optional[str] = "auto"
    tighten: Optional[bool] = True
    client_id: Optional[str] = None


@router.post("/ingest")
async def ingest(req: IngestReq):
    """Parse a transcript, prepare the clip for preview, and open a review session."""
    # 1. Parse the transcript (precise 400 on bad input).
    try:
        segments = parse_transcript(req.transcript_text, fmt=req.fmt or "auto")
    except ReviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # 2. Resolve which clip this transcript belongs to.
    try:
        source_path = _resolve_source(req.source_file, req.bin_references)
    except ReviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    review_id = uuid.uuid4().hex[:12]
    reporter = ProgressReporter(task_type="review_proxy", client_id=req.client_id)

    # 3. Build a browser-playable proxy (non-fatal: text review still works).
    media_error: Optional[str] = None
    proxy_path: Optional[str] = None
    duration = 0.0
    codec = ""
    try:
        info = await ensure_playable_proxy(source_path, reporter=reporter)
        proxy_path = info["proxy_path"]
        duration = info.get("duration") or 0.0
        codec = info.get("src_codec") or ""
    except Exception as exc:  # noqa: BLE001
        media_error = f"Couldn't prepare the video preview: {exc}"
        logger.warning("review.ingest proxy failed for %s: %s", source_path, exc)

    # 4. Tighten to speech (non-fatal: falls back to raw boundaries).
    if req.tighten:
        try:
            regions = await silence_regions(source_path)
            tighten(segments, regions, pad=0.0)
        except Exception as exc:  # noqa: BLE001
            logger.warning("review.ingest tighten failed for %s: %s", source_path, exc)

    rev = {
        "source_path": source_path,
        "source_name": Path(source_path).name,
        "proxy_path": proxy_path,
        "segments": segments,
        "script": (req.script or "").strip(),
        "duration": duration,
        "codec": codec,
        "media_error": media_error,
    }
    _reviews[review_id] = rev
    _persist(review_id, rev)

    return {
        "review_id": review_id,
        "source_name": rev["source_name"],
        "source_path": source_path,
        "duration": duration,
        "codec": codec,
        "media_url": f"/api/review/media/{review_id}" if proxy_path else None,
        "media_error": media_error,
        "segments": segments_to_dicts(segments),
        "summary": _summary(segments),
    }


# ── GET /media/{review_id} ─────────────────────────────────────────

_RANGE = re.compile(r"bytes=(\d*)-(\d*)")


@router.get("/media/{review_id}")
async def media(review_id: str, request: Request):
    """Stream the proxy with HTTP Range support so <video> can seek."""
    rev = _reviews.get(review_id)
    if not rev or not rev.get("proxy_path"):
        raise HTTPException(status_code=404, detail="No preview for this review.")
    path = Path(rev["proxy_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Preview file is missing.")

    file_size = path.stat().st_size
    range_header = request.headers.get("range") or request.headers.get("Range")
    base_headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}

    if not range_header:
        return FileResponse(path, media_type="video/mp4", headers=base_headers)

    m = _RANGE.match(range_header.strip())
    if not m:
        return FileResponse(path, media_type="video/mp4", headers=base_headers)

    start = int(m.group(1)) if m.group(1) else 0
    end = int(m.group(2)) if m.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}", "Accept-Ranges": "bytes"},
        )

    length = end - start + 1

    def _iter():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            chunk = 256 * 1024
            while remaining > 0:
                data = f.read(min(chunk, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "no-store",
    }
    return StreamingResponse(_iter(), status_code=206, headers=headers, media_type="video/mp4")


# ── POST /suggest ──────────────────────────────────────────────────

class SuggestReq(BaseModel):
    review_id: str
    use_llm: Optional[bool] = False


@router.post("/suggest")
async def suggest(req: SuggestReq):
    """Run the deterministic classifier (+ optional Gemma refine) on a session."""
    rev = _reviews.get(req.review_id)
    if not rev:
        raise HTTPException(status_code=404, detail="Review session not found (re-ingest).")

    segments: list[Segment] = rev["segments"]
    classify(segments, rev.get("script", ""))

    llm_used = False
    if req.use_llm:
        try:
            from ..services.provider_service import provider_service
            prompt = build_gemma_prompt(segments, rev.get("script", ""))
            raw = await provider_service.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=1500,
            )
            text = (raw or {}).get("response") or ""
            decisions = parse_gemma_decisions(text, {s.id for s in segments})
            # Gemma may only TIGHTEN (flip keep→cut); it can't resurrect a
            # reliable deterministic cut. This keeps the safe baseline intact.
            for s in segments:
                if s.decision == "keep" and s.id in decisions:
                    keep, reason = decisions[s.id]
                    if not keep:
                        s.decision = "cut"
                        s.reason = reason or "llm_off_script"
            llm_used = bool(decisions)
        except Exception as exc:  # noqa: BLE001
            logger.warning("review.suggest: Gemma refine skipped (%s)", exc)

    _persist(req.review_id, rev)
    return {
        "review_id": req.review_id,
        "llm_used": llm_used,
        "segments": segments_to_dicts(segments),
        "summary": _summary(segments),
    }


# ── POST /build ────────────────────────────────────────────────────

class BuildReq(BaseModel):
    review_id: str
    kept_ids: Optional[list[int]] = None  # explicit user selection (in order)


@router.post("/build")
async def build(req: BuildReq):
    """Turn the kept segments into a Plan via the existing external-plan path."""
    rev = _reviews.get(req.review_id)
    if not rev:
        raise HTTPException(status_code=404, detail="Review session not found (re-ingest).")

    segments: list[Segment] = rev["segments"]
    source_path = rev["source_path"]
    source_name = Path(source_path).name
    cuts = kept_cuts(segments, source_name, req.kept_ids)

    if not cuts:
        raise HTTPException(status_code=400, detail="No segments are kept — nothing to build.")

    try:
        plan = build_plan_from_pasted_json(
            json.dumps({"version": 1, "cuts": cuts}, ensure_ascii=False),
            bin_reference="@review",
            script=rev.get("script", ""),
            transcripts_ready={source_path: "ready"},
            user_hint="review_editor",
        )
    except ExternalPlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "plan_id": plan.plan_id,
        "summary": plan.summary,
        "gaps": plan.gaps,
        "cuts_count": len(plan.cuts),
    }
