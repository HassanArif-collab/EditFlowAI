"""
EditFlow AI - Visual Library API Routes
Endpoints for managing raw data folders, running video quality analysis,
browsing visual library assets, serving thumbnails, and auto-placing B-roll.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..services.broll_placement_engine import broll_placement_engine
from ..services.visual_library_service import visual_library_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/visual-library", tags=["visual-library"])

_indexing_status = {
    "is_busy": False,
    "current_folder": "",
    "processed": 0,
    "total": 0,
    "message": "Idle"
}


class AddFolderRequest(BaseModel):
    folder_path: str
    brand: Optional[str] = None
    auto_analyze: Optional[bool] = True


class TranscribeAndIndexRequest(BaseModel):
    folder_path: Optional[str] = None
    brand: Optional[str] = None
    force: Optional[bool] = False


class RemoveFolderRequest(BaseModel):
    folder_path: str


class AutoPlaceRequest(BaseModel):
    aspect_ratio: Optional[str] = "9:16"
    pacing_style: Optional[str] = "editorial_insert"


@router.get("/status")
async def get_status(brand: Optional[str] = None) -> Dict[str, Any]:
    """Get current indexing & analysis status."""
    if brand and _indexing_status.get("brand") and brand.casefold() != _indexing_status["brand"].casefold():
        return {"success": True, "status": {"is_busy": False, "message": "Idle", "brand": brand}, "worker_busy": _indexing_status["is_busy"]}
    return {"success": True, "status": _indexing_status}


def _begin_job(brand: Optional[str], folder_path: Optional[str]) -> str:
    if _indexing_status["is_busy"]:
        raise HTTPException(409, "Visual indexing is already running. Wait for that job to finish.")
    job_id = uuid.uuid4().hex
    _indexing_status.update(is_busy=True, job_id=job_id, brand=brand or "", current_folder=folder_path or "",
                            processed=0, total=0, percent=0, state="running", message="Starting indexing...")
    return job_id


@router.get("/brands")
async def list_brands() -> Dict[str, Any]:
    """List all detected brands / clients across local folders."""
    try:
        brands = visual_library_service.list_brands()
        return {"success": True, "brands": brands}
    except Exception as e:
        logger.error(f"[visual_library_routes] List brands error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/folders")
async def list_folders(brand: Optional[str] = Query(None, description="Filter by brand name")) -> Dict[str, Any]:
    """List all registered raw data folders in the visual library, optionally filtered by brand."""
    try:
        folders = visual_library_service.list_folders(brand=brand)
        return {"success": True, "total": len(folders), "folders": folders}
    except Exception as e:
        logger.error(f"[visual_library_routes] List folders error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _background_analyze(folder_path: Optional[str] = None, force: bool = False):
    global _indexing_status
    _indexing_status["is_busy"] = True
    _indexing_status["message"] = f"Analyzing {folder_path or 'all folders'}..."
    try:
        if folder_path:
            visual_library_service.analyze_folder(folder_path, force=force)
        else:
            visual_library_service.analyze_all(force=force)
        _indexing_status["message"] = "Analysis complete."
        _indexing_status["state"] = "completed"
    except Exception as e:
        logger.error(f"[visual_library_routes] Background analysis error: {e}", exc_info=True)
        _indexing_status["message"] = f"Error: {e}"
        _indexing_status["state"] = "failed"
    finally:
        _indexing_status["is_busy"] = False


@router.post("/folders")
async def add_folder(req: AddFolderRequest, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    """Add a raw data folder to the visual library and trigger indexing in background."""
    try:
        res = visual_library_service.add_folder(req.folder_path, brand=req.brand, auto_analyze=False)
        if not res.get("success"):
            raise HTTPException(status_code=400, detail=res.get("error"))

        if req.auto_analyze:
            res["job_id"] = _begin_job(req.brand, req.folder_path)
            background_tasks.add_task(_background_analyze, req.folder_path, False)

        return res
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[visual_library_routes] Add folder error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/folders")
async def remove_folder(folder_path: str = Query(..., description="Folder path to remove")) -> Dict[str, Any]:
    """Remove a raw data folder from the visual library."""
    try:
        res = visual_library_service.remove_folder(folder_path)
        if not res.get("success"):
            raise HTTPException(status_code=400, detail=res.get("error"))
        return res
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[visual_library_routes] Remove folder error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))



async def _background_transcribe_and_index(folder_path: Optional[str] = None, brand: Optional[str] = None, force: bool = False):
    global _indexing_status
    _indexing_status["is_busy"] = True
    _indexing_status["message"] = f"Transcribing & indexing footage..."
    
    async def on_prog(p: Dict[str, Any]):
        _indexing_status["processed"] = p.get("processed", 0)
        _indexing_status["total"] = p.get("total", 0)
        _indexing_status["percent"] = p.get("percent", 0)
        _indexing_status["message"] = p.get("message", "Processing...")
        await asyncio.sleep(0.02)
        
    try:
        failures = []
        if folder_path:
            result = await visual_library_service.transcribe_and_index_folder(folder_path, force=force, on_progress=on_prog)
            failures.extend(result.get("errors", []))
        else:
            folders = visual_library_service.list_folders(brand=brand)
            for f in folders:
                result = await visual_library_service.transcribe_and_index_folder(f["path"], force=force, on_progress=on_prog)
                failures.extend(result.get("errors", []))
        if failures:
            raise RuntimeError(f"{len(failures)} source(s) failed transcription. First: {failures[0]['file']}: {failures[0]['error']}")
        _indexing_status["message"] = "Transcription & indexing complete."
        _indexing_status["state"] = "completed"
    except Exception as e:
        logger.error(f"[visual_library_routes] Background transcribe error: {e}", exc_info=True)
        _indexing_status["message"] = f"Error: {e}"
        _indexing_status["state"] = "failed"
    finally:
        _indexing_status["is_busy"] = False


@router.post("/transcribe-and-index")
async def transcribe_and_index(req: TranscribeAndIndexRequest, background_tasks: BackgroundTasks) -> Dict[str, Any]:
    """Batch transcribe all untranscribed clips and deep index visual quality."""
    if not req.brand:
        raise HTTPException(400, "Choose the brand to index.")
    folders = visual_library_service.list_folders(brand=req.brand)
    if not folders or (req.folder_path and not any(os.path.normcase(os.path.abspath(f["path"])) == os.path.normcase(os.path.abspath(req.folder_path)) for f in folders)):
        raise HTTPException(400, "Register the selected brand's footage folder before indexing.")
    job_id = _begin_job(req.brand, req.folder_path)
    background_tasks.add_task(_background_transcribe_and_index, req.folder_path, req.brand, req.force)
    return {"success": True, "job_id": job_id, "brand": req.brand, "message": "Background transcription & indexing initiated."}

@router.post("/analyze")
async def analyze_all(background_tasks: BackgroundTasks, force: bool = Query(False, description="Force re-analysis of all files"), brand: Optional[str] = Query(None)) -> Dict[str, Any]:
    """Analyze all active raw data folders in the visual library asynchronously."""
    if not brand:
        raise HTTPException(400, "Choose the brand to analyze.")
    folders = visual_library_service.list_folders(brand=brand)
    if not folders:
        raise HTTPException(400, "This brand has no registered visual folders.")
    job_id = _begin_job(brand, None)
    background_tasks.add_task(_background_analyze_brand, folders, force)
    return {"success": True, "job_id": job_id, "brand": brand, "message": "Background analysis initiated."}


def _background_analyze_brand(folders, force):
    try:
        for folder in folders:
            _indexing_status["current_folder"] = folder["path"]
            visual_library_service.analyze_folder(folder["path"], force=force)
        _indexing_status.update(state="completed", percent=100, message="Analysis complete.")
    except Exception as exc:
        _indexing_status.update(state="failed", message=str(exc))
    finally:
        _indexing_status["is_busy"] = False


@router.get("/items")
async def query_items(
    query: str = Query("", description="Keyword search in filename or tags"),
    category: str = Query("all", description="all, pure_broll, demonstration_broll, talking_head, still_graphic"),
    folder: str = Query("", description="Filter by folder path"),
    aspect_ratio: str = Query("", description="Filter by aspect ratio (9:16, 16:9, etc.)"),
    min_quality: float = Query(0.0, description="Minimum quality score"),
    limit: int = Query(50, ge=1, le=200),
    brand: Optional[str] = Query(None, description="Brand whose registered assets may be returned"),
) -> Dict[str, Any]:
    """Query, filter, and browse items in the visual library."""
    try:
        items = visual_library_service.query_items(
            query=query,
            category=category,
            folder=folder,
            aspect_ratio=aspect_ratio,
            min_quality=min_quality,
            limit=limit,
            brand=brand,
        )
        return {"success": True, "total": len(items), "items": items}
    except Exception as e:
        logger.error(f"[visual_library_routes] Query items error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/thumb/{item_id}")
async def get_thumbnail(item_id: str):
    """Stream cached thumbnail image for an item in the visual library."""
    p = visual_library_service.get_thumbnail_file(item_id)
    if not p or not p.exists():
        raise HTTPException(status_code=404, detail=f"Thumbnail not found for item: {item_id}")
    return FileResponse(str(p), media_type="image/jpeg")


@router.get("/match-cut")
async def match_broll_for_cue(
    cue: str = Query(..., description="Visual cue text or dialogue"),
    aspect_ratio: str = Query("9:16", description="Target aspect ratio"),
    limit: int = Query(6, ge=1, le=20),
    brand: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Return top candidate visual B-roll clips for a specific cut's cue or quote."""
    try:
        items = visual_library_service.query_items(query=cue, aspect_ratio=aspect_ratio, limit=limit, brand=brand)
        if not items:
            items = visual_library_service.query_items(query=cue, limit=limit, brand=brand)
        items = [item for item in items if not item.get("banned") and item.get("category") != "talking_head"]
        return {"success": True, "cue": cue, "matches": items}
    except Exception as e:
        logger.error(f"[visual_library_routes] Match cut error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/metadata/reload")
async def reload_curated_metadata():
    visual_library_service.initialize()
    result = visual_library_service.refresh_metadata(force=True)
    visual_library_service._save_index()
    visual_library_service._save_config()
    return result


class RecordUsageRequest(BaseModel):
    brand: str
    sequence_name: str
    stems: List[str]


@router.post("/usage")
async def record_usage(req: RecordUsageRequest):
    broll_placement_engine._record_usage(req.sequence_name, req.stems, brand=req.brand)
    return {"success": True}
