"""EditFlow AI — Subtitles routes (cues, SRT export).

Endpoints (all under ``/api/subtitles``):

  POST /cues   words → cues. Words come from an open review session
               (``review_id``; ``source="final_cut"`` remaps the KEPT words to
               output-sequence time) or are passed directly (``words``).
  POST /srt    cues → SRT text + a file under data/output/subtitles/.

Everything here is ADDITIVE (plan §12). A failure in subtitles never mutates
Review / agent / cut state. Placement endpoints (presets, placement-payload)
arrive with Phases 1–3.
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.subtitles.cue_builder import (
    CueOpts,
    build_cues,
    remap_kept_words_to_output,
)
from ..services.subtitles.srt_export import cues_to_srt

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/subtitles", tags=["subtitles"])


def _review_words(review_id: str) -> list[dict]:
    """Words of an open review session (same cross-route pattern as
    review._get_project_scan reading premiere._project_context)."""
    from . import review
    rev = review._reviews.get(review_id)
    if not rev:
        raise HTTPException(status_code=404, detail="Review session not found (re-ingest).")
    return [w.to_dict() for w in (rev.get("words") or [])]


class CuesReq(BaseModel):
    review_id: Optional[str] = None
    words: Optional[list[dict]] = None          # wins over review_id when given
    source: Optional[str] = "standalone"        # "standalone" | "final_cut"
    opts: Optional[dict[str, Any]] = None       # CueOpts overrides


@router.post("/cues")
async def cues(req: CuesReq):
    if req.words is not None:
        words = req.words
    elif req.review_id:
        words = _review_words(req.review_id)
    else:
        raise HTTPException(status_code=400, detail="Pass review_id or words.")

    if (req.source or "standalone") == "final_cut":
        words = remap_kept_words_to_output(words)

    try:
        opts = CueOpts(**(req.opts or {}))
    except TypeError as exc:
        raise HTTPException(status_code=400, detail=f"Bad cue option: {exc}") from exc

    built = build_cues(words, opts)
    return {
        "cues": built,
        "summary": {
            "cues": len(built),
            "words": len(words),
            "duration": round(built[-1]["end"] - built[0]["start"], 2) if built else 0.0,
        },
    }


class SrtReq(BaseModel):
    cues: list[dict]
    name: Optional[str] = None


@router.post("/srt")
async def srt(req: SrtReq):
    text = cues_to_srt(req.cues)
    if not text:
        raise HTTPException(status_code=400, detail="No non-empty cues to export.")
    srt_path = ""
    try:
        from ..config import get_settings
        out_dir = get_settings().DATA_DIR / "output" / "subtitles"
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = (req.name or f"subtitles-{uuid.uuid4().hex[:8]}").rsplit(".", 1)[0]
        path = out_dir / f"{stem}.srt"
        path.write_text(text, encoding="utf-8")
        srt_path = str(path)
    except Exception as exc:  # noqa: BLE001
        logger.warning("subtitles.srt: file write failed: %s", exc)
    return {"srt": text, "srt_path": srt_path}
