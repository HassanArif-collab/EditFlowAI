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
from ..services import scribe_service
from ..services.review_media import ensure_playable_proxy, silence_regions, waveform_peaks
from ..services.review_service import (
    ReviewError,
    Segment,
    Word,
    build_gemma_prompt,
    classify,
    kept_cuts,
    parse_gemma_decisions,
    parse_transcript,
    refine_words,
    segments_to_dicts,
    tighten,
    words_from_segments,
    words_to_cuts,
)
from ..services.review_trace import ReviewTrace, final_stage, llm_stage
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/review", tags=["review"])

def _suggest_max_tokens(n_segments: int) -> int:
    """Reply budget for the decisions JSON — scales with the transcript so the
    model's reply never truncates (≈90 tokens per segment covers id+keep+reason),
    with a sane floor and a ceiling so it can't run away."""
    return min(16000, max(2000, n_segments * 90))

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


def _word_summary(words: list[Word], source_name: str) -> dict:
    """Word-level readout used by the word editor: kept/cut counts, merged-cut
    count, and the final runtime (sum of merged contiguous kept spans)."""
    kept_ids = [w.id for w in words if w.keep]
    by_id = {w.id: w for w in words}
    cuts = words_to_cuts(by_id, kept_ids, source_name)
    final = sum(c["source_out"] - c["source_in"] for c in cuts)
    return {
        "total_words": len(words),
        "kept_words": len(kept_ids),
        "cut_words": len(words) - len(kept_ids),
        "cuts": len(cuts),
        "final_duration": round(final, 2),
    }


def _persist(review_id: str, rev: dict) -> None:
    """Best-effort snapshot to data/review/{id}.json (debugging aid; non-fatal).

    Excludes the live dataclass lists (segments/words) and re-serializes them as
    plain dicts so the snapshot is valid JSON.
    """
    try:
        from ..config import get_settings
        out = get_settings().DATA_DIR / "review"
        out.mkdir(parents=True, exist_ok=True)
        snap = {k: v for k, v in rev.items() if k not in ("segments", "words")}
        snap["segments"] = segments_to_dicts(rev["segments"])
        snap["words"] = [w.to_dict() for w in rev.get("words", [])]
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

    # 5. Split into words (approximate per-word times; Scribe replaces these later).
    words = words_from_segments(segments)
    source_name = Path(source_path).name

    rev = {
        "source_path": source_path,
        "source_name": source_name,
        "proxy_path": proxy_path,
        "segments": segments,
        "words": words,
        "script": (req.script or "").strip(),
        "duration": duration,
        "codec": codec,
        "media_error": media_error,
    }
    _reviews[review_id] = rev
    _persist(review_id, rev)

    return {
        "review_id": review_id,
        "source_name": source_name,
        "source_path": source_path,
        "duration": duration,
        "codec": codec,
        "media_url": f"/api/review/media/{review_id}" if proxy_path else None,
        "media_error": media_error,
        "segments": segments_to_dicts(segments),
        "words": [w.to_dict() for w in words],
        "summary": _summary(segments),
        "word_summary": _word_summary(words, source_name),
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


# ── GET /waveform/{review_id} ──────────────────────────────────────

@router.get("/waveform/{review_id}")
async def waveform(review_id: str):
    """Return normalized amplitude peaks for the waveform strip (cached, []-safe)."""
    rev = _reviews.get(review_id)
    if not rev:
        raise HTTPException(status_code=404, detail="Review session not found (re-ingest).")
    try:
        peaks = await waveform_peaks(rev["source_path"])
    except Exception as exc:  # noqa: BLE001
        logger.warning("review.waveform failed for %s: %s", rev.get("source_path"), exc)
        peaks = []
    return {"peaks": peaks, "duration": rev.get("duration", 0)}


# ── POST /suggest ──────────────────────────────────────────────────

class SuggestReq(BaseModel):
    review_id: str
    use_llm: Optional[bool] = False
    debug: Optional[bool] = False


def _propagate_to_words(rev: dict) -> None:
    """Mirror each segment's keep/cut decision onto its child words.

    Phase-1/2 bridge: the deterministic + AI passes decide at segment level; the
    word editor then lets the user refine at word level. A word inherits its
    parent segment's decision/reason; the user's per-word overrides win after.
    """
    words: list[Word] = rev.get("words") or []
    segs = {s.id: s for s in rev["segments"]}
    for w in words:
        seg = segs.get(w.segment_id)
        if seg is None:
            continue
        w.keep = seg.decision == "keep"
        w.reason = "" if w.keep else (seg.reason or "")


@router.post("/suggest")
async def suggest(req: SuggestReq):
    """Run the deterministic classifier (+ optional active-model refine).

    When ``debug`` is set, also returns a structured ``trace`` of every stage's
    keep/cut decisions for the panel's debug drawer.
    """
    rev = _reviews.get(req.review_id)
    if not rev:
        raise HTTPException(status_code=404, detail="Review session not found (re-ingest).")

    segments: list[Segment] = rev["segments"]
    trace = ReviewTrace() if req.debug else None
    classify(segments, rev.get("script", ""), trace=trace)

    llm_used = False
    if req.use_llm:
        prompt = build_gemma_prompt(segments, rev.get("script", ""))
        text = ""
        decisions: dict = {}
        flips: list[dict] = []
        err: Optional[str] = None
        max_tokens = _suggest_max_tokens(len(segments))
        try:
            from ..services.provider_service import provider_service
            raw = await provider_service.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=max_tokens,
            )
            text = (raw or {}).get("response") or ""
            decisions = parse_gemma_decisions(text, {s.id for s in segments})
            # The model may only TIGHTEN (flip keep→cut); it can't resurrect a
            # reliable deterministic cut. This keeps the safe baseline intact.
            for s in segments:
                if s.decision == "keep" and s.id in decisions:
                    keep, reason = decisions[s.id]
                    if not keep:
                        s.decision = "cut"
                        s.reason = reason or "llm_off_script"
                        flips.append({"id": s.id, "reason": s.reason})
            llm_used = bool(decisions)
        except Exception as exc:  # noqa: BLE001
            err = str(exc) or exc.__class__.__name__
            logger.warning("review.suggest: model refine skipped (%s)", err)
        if trace is not None:
            trace.add(llm_stage(prompt, text, max_tokens,
                                len(decisions), len(segments), flips, err))

    _propagate_to_words(rev)
    refine_words(rev.get("words", []))  # word-level: cut junk words inside kept lines
    if trace is not None:
        trace.add(final_stage(segments))
    _persist(req.review_id, rev)
    source_name = rev.get("source_name", "")
    return {
        "review_id": req.review_id,
        "llm_used": llm_used,
        "segments": segments_to_dicts(segments),
        "words": [w.to_dict() for w in rev.get("words", [])],
        "summary": _summary(segments),
        "word_summary": _word_summary(rev.get("words", []), source_name),
        "trace": trace.to_dict() if trace is not None else None,
    }


# ── POST /build ────────────────────────────────────────────────────

class BuildReq(BaseModel):
    review_id: str
    kept_ids: Optional[list[int]] = None        # segment ids (legacy segment editor)
    kept_word_ids: Optional[list[int]] = None   # word ids (word editor) — wins if set


@router.post("/build")
async def build(req: BuildReq):
    """Turn the kept words (or segments) into a Plan via the external-plan path."""
    rev = _reviews.get(req.review_id)
    if not rev:
        raise HTTPException(status_code=404, detail="Review session not found (re-ingest).")

    source_path = rev["source_path"]
    source_name = Path(source_path).name

    if req.kept_word_ids is not None:
        words: list[Word] = rev.get("words") or []
        by_id = {w.id: w for w in words}
        cuts = words_to_cuts(by_id, req.kept_word_ids, source_name)
    else:
        cuts = kept_cuts(rev["segments"], source_name, req.kept_ids)

    if not cuts:
        raise HTTPException(status_code=400, detail="Nothing is kept — keep some words first.")

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


# ── Scribe (ElevenLabs) — key, estimate, transcribe ────────────────

class ScribeKeyReq(BaseModel):
    key: str


@router.get("/scribe/status")
async def scribe_status():
    return {"has_key": scribe_service.has_api_key(), "model": scribe_service.DEFAULT_MODEL}


@router.post("/scribe/key")
async def scribe_set_key(req: ScribeKeyReq):
    scribe_service.set_api_key(req.key)
    return {"ok": True, "has_key": scribe_service.has_api_key()}


class ScribeEstimateReq(BaseModel):
    source_file: Optional[str] = None
    bin_references: Optional[list[str]] = None


@router.post("/scribe/estimate")
async def scribe_estimate(req: ScribeEstimateReq):
    try:
        source_path = _resolve_source(req.source_file, req.bin_references)
    except ReviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    est = scribe_service.estimate_for_file(source_path)
    est["has_key"] = scribe_service.has_api_key()
    est["source_name"] = Path(source_path).name
    return est


class TranscribeReq(BaseModel):
    source_file: Optional[str] = None
    bin_references: Optional[list[str]] = None
    script: Optional[str] = ""
    language_code: Optional[str] = "ur"
    client_id: Optional[str] = None


@router.post("/transcribe")
async def transcribe_clip(req: TranscribeReq):
    """Transcribe a clip with ElevenLabs Scribe and open a review session.

    The "no pasting" path: exact per-word times straight from Scribe → the word
    editor. Requires an API key (Settings / ELEVENLABS_API_KEY).
    """
    try:
        source_path = _resolve_source(req.source_file, req.bin_references)
    except ReviewError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        data = await scribe_service.transcribe(source_path, language_code=req.language_code or None)
    except scribe_service.ScribeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    segments, words = scribe_service.build_segments_and_words(data)
    if not words:
        raise HTTPException(status_code=400, detail="Scribe returned no words for this clip.")

    review_id = uuid.uuid4().hex[:12]
    reporter = ProgressReporter(task_type="review_proxy", client_id=req.client_id)
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
        logger.warning("review.transcribe proxy failed for %s: %s", source_path, exc)

    source_name = Path(source_path).name
    rev = {
        "source_path": source_path, "source_name": source_name, "proxy_path": proxy_path,
        "segments": segments, "words": words, "script": (req.script or "").strip(),
        "duration": duration, "codec": codec, "media_error": media_error,
        "transcript_source": "scribe",
    }
    _reviews[review_id] = rev
    _persist(review_id, rev)
    return {
        "review_id": review_id, "source_name": source_name, "source_path": source_path,
        "duration": duration, "codec": codec,
        "media_url": f"/api/review/media/{review_id}" if proxy_path else None,
        "media_error": media_error,
        "segments": segments_to_dicts(segments),
        "words": [w.to_dict() for w in words],
        "summary": _summary(segments),
        "word_summary": _word_summary(words, source_name),
        "transcript_source": "scribe",
    }
