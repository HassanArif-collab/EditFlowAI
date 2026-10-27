"""
EditFlow AI - Media Resolver API Routes
Endpoints for indexing project directories, resolving media stems (C5032, C6019),
retrieving verified speaker rosters from Person_Crossreference.md, and fuzzy B-roll retrieval.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..services.media_resolver import media_resolver

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/media-resolver", tags=["media-resolver"])


class IndexRequest(BaseModel):
    root_dir: Optional[str] = None
    force: Optional[bool] = False


@router.post("/index")
async def index_media(req: IndexRequest) -> Dict[str, Any]:
    """Index media assets and cross-references in the specified or default directory."""
    try:
        stats = media_resolver.index_directory(root_dir=req.root_dir, force=bool(req.force))
        return stats
    except Exception as e:
        logger.error(f"[media_resolver_routes] Index error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/resolve")
async def resolve_media_stem(
    query: str = Query(..., description="Filename, stem, or legacy path to resolve"),
    prefer_video: bool = Query(True, description="Prefer video file over audio/transcript if multiple match"),
) -> Dict[str, Any]:
    """Resolve an opaque stem (e.g. C5032) or legacy path into its absolute on-disk media item."""
    item = media_resolver.resolve_media(query, prefer_video=prefer_video)
    if not item:
        raise HTTPException(status_code=404, detail=f"Media could not be resolved for: {query}")
    return {"success": True, "item": item.to_dict()}


@router.get("/pair")
async def resolve_audio_pair(
    query: str = Query(..., description="Clip stem or path to resolve companion files for"),
) -> Dict[str, Any]:
    """Resolve video, raw audio, enhanced audio, and transcript companion files for a clip."""
    pair = media_resolver.resolve_audio_pair(query)
    return {"success": True, "pair": pair.to_dict()}


@router.get("/broll")
async def find_broll_clips(
    cue: str = Query(..., description="Script visual cue or keywords e.g. 'concrete trucks pouring'"),
    limit: int = Query(5, ge=1, le=20, description="Maximum candidate clips to return"),
) -> Dict[str, Any]:
    """Find candidate B-roll clips and stills matching a visual cue using semantic keyword clustering."""
    matches = media_resolver.find_broll(cue, limit=limit)
    return {"success": True, "cue": cue, "matches": matches}


@router.get("/speakers")
async def get_speakers() -> Dict[str, Any]:
    """Return the roster of verified speakers parsed from Person_Crossreference.md."""
    speakers = media_resolver.get_all_speakers()
    return {"success": True, "total": len(speakers), "speakers": speakers}


@router.get("/speaker/{speaker_name}/clips")
async def get_speaker_clips(speaker_name: str) -> Dict[str, Any]:
    """Return all media clips associated with a specific speaker."""
    clips = media_resolver.get_speaker_clips(speaker_name)
    return {"success": True, "speaker": speaker_name, "total": len(clips), "clips": clips}


@router.get("/stats")
async def get_resolver_stats() -> Dict[str, Any]:
    """Return summary statistics of currently indexed assets."""
    return media_resolver.get_stats()


@router.get("/current")
async def get_current_project() -> Dict[str, Any]:
    """Return the active project root directory and summary statistics."""
    return {
        "success": True,
        "root_dir": media_resolver.root_dir,
        "stats": media_resolver.get_stats(),
    }


@router.get("/audio-preview")
async def audio_preview(path: str = Query(..., description="Absolute path to audio or video file")):
    """Stream audio file for preview in the CEP panel."""
    import os
    from fastapi.responses import FileResponse
    p = media_resolver.remap_legacy_path(path)
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail=f"File not found on disk: {p}")
    ext = os.path.splitext(p)[1].lower()
    media_type = "audio/mpeg" if ext == ".mp3" else ("audio/wav" if ext == ".wav" else "video/mp4")
    return FileResponse(p, media_type=media_type)

