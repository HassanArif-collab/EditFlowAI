"""
EditFlow AI - Timeline Visual Overlay API Routes
Exposes endpoints to transcribe active Premiere Pro sequences and auto-place visual B-roll overlays.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.broll_placement_engine import BrollPlacementEngine
from ..services.timeline_visual_service import timeline_visual_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/timeline-visuals", tags=["Timeline Visuals"])


class TimelineAnalyzeRequest(BaseModel):
    clips: List[Dict[str, Any]]
    sequence_name: Optional[str] = "Active Sequence"
    duration: Optional[float] = 60.0
    script_path: Optional[str] = None
    script_content: Optional[str] = None
    aspect_ratio: str = "9:16"
    pacing_style: str = "editorial"
    target_track: int = 1
    language: str = "auto"
    force: bool = False


class TimelineRecomputeRequest(BaseModel):
    segments: List[Dict[str, Any]]
    sequence_name: Optional[str] = "Active Sequence"
    duration: Optional[float] = 60.0
    aspect_ratio: str = "9:16"
    pacing_style: str = "editorial"
    target_track: int = 1


@router.post("/analyze")
async def analyze_timeline_visuals(req: TimelineAnalyzeRequest):
    """
    Transcribes the active sequence audio, matches with script/speech concepts,
    and returns high-density micro-visual placements and Premiere Pro EDL operations.
    """
    try:
        plan = await timeline_visual_service.compile_timeline_visual_plan(
            clips=req.clips,
            sequence_duration=float(req.duration or 60.0),
            sequence_name=req.sequence_name or "Active Sequence",
            script_path=req.script_path,
            script_content=req.script_content,
            aspect_ratio=req.aspect_ratio or "9:16",
            pacing_style=req.pacing_style or "editorial",
            target_track=int(req.target_track if req.target_track is not None else 1),
            language=req.language or "auto",
            force=req.force,
        )
        return plan
    except Exception as e:
        logger.error(f"[timeline_visuals] Error compiling visual plan: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/recompute")
async def recompute_timeline_visuals(req: TimelineRecomputeRequest):
    """
    Instantly recomputes B-roll placements when the user changes pacing (Dynamic/Editorial/Story)
    or target track without re-transcribing audio.
    """
    try:
        placements, cuts = BrollPlacementEngine.place_broll_for_timeline_segments(
            segments=req.segments,
            aspect_ratio=req.aspect_ratio or "9:16",
            pacing_style=req.pacing_style or "editorial",
            target_track=int(req.target_track if req.target_track is not None else 1),
        )

        edl_ops = timeline_visual_service.generate_timeline_edl_ops(
            placements=placements,
            target_track=int(req.target_track if req.target_track is not None else 1),
            sequence_name=req.sequence_name or "Active Sequence",
        )

        unique_files = list(set(p.source_file for p in placements if p.source_file))

        return {
            "success": True,
            "sequence_name": req.sequence_name,
            "pacing_style": req.pacing_style,
            "target_track": req.target_track,
            "target_track_name": f"V{req.target_track + 1}",
            "broll_placements": [p.to_dict() for p in placements],
            "cuts": [c.to_dict() for c in cuts],
            "edl_ops": edl_ops,
            "summary": {
                "total_segments": len(req.segments),
                "total_visuals": len(placements),
                "unique_visual_files": len(unique_files),
                "pacing": req.pacing_style,
                "target_track_name": f"V{req.target_track + 1}",
                "duration": req.duration,
            },
        }
    except Exception as e:
        logger.error(f"[timeline_visuals] Error recomputing visuals: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
