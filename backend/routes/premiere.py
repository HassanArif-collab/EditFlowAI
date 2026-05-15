import os
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, List

from ..services.premiere_context_service import premiere_context_service

router = APIRouter()
MAX_SCAN_FILES = 500
BLOCKED_SCAN_DIRS = {
    Path(os.environ.get("WINDIR", "C:/Windows")).resolve(),
    Path(os.environ.get("PROGRAMFILES", "C:/Program Files")).resolve(),
    Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")).resolve(),
}

# Global project context
PROJECT_CONTEXT = {}

class ProjectContext(BaseModel):
    items: List[Dict[str, Any]]
    bins: List[Dict[str, Any]] = []
    sequences: List[Dict[str, Any]] = []


@router.post("/context/clear")
async def clear_project_context():
    """Clear cached Premiere project references so stale bins cannot be reused."""
    global PROJECT_CONTEXT
    PROJECT_CONTEXT = {}
    cleared = premiere_context_service.clear_project_context()
    return {"status": "success", "message": "Project context cleared", "registry": cleared}
    
@router.post("/context")
async def update_project_context(context: ProjectContext):
    """Update the backend's understanding of the Premiere project state"""
    global PROJECT_CONTEXT
    try:
        # Simplify and store
        items = context.items
        video_count = sum(1 for i in items if _item_has_media(i, "video"))
        audio_count = sum(1 for i in items if _item_has_media(i, "audio"))
        
        bin_names = [
            str(b.get("bin_path") or b.get("binPath") or b.get("name") or "")
            for b in context.bins
            if b.get("bin_path") or b.get("binPath") or b.get("name")
        ]
        item_bins = [i.get('bin_path', '') for i in items if i.get('bin_path')]
        PROJECT_CONTEXT = {
            "total_items": len(items),
            "video_items": video_count,
            "audio_items": audio_count,
            "bins": sorted(set(bin_names + item_bins)),
            "sequences": context.sequences[:20],
            "items": items[:50] # Store up to 50 items to avoid prompt bloat
        }
        saved = premiere_context_service.save_project_context(context.dict())
        return {"status": "success", "message": "Project context updated", "registry": saved}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/context")
async def get_project_context():
    """Get the current project context"""
    return PROJECT_CONTEXT

@router.post("/scan-folders")
async def scan_folders(payload: Dict[str, List[str]]):
    """Scan local folders for media files to import"""
    paths = payload.get("paths", [])
    if not paths:
        return {"success": False, "error": "No paths provided"}
        
    found_files = []
    supported_exts = {'.mp4', '.mov', '.wav', '.mp3', '.m4a', '.jpg', '.png'}
    
    for raw_path in paths:
        path_obj = Path(raw_path).expanduser()
        try:
            resolved = path_obj.resolve()
        except OSError:
            continue
        if not _is_allowed_scan_path(resolved):
            continue
        if resolved.is_file():
            if resolved.suffix.lower() in supported_exts:
                found_files.append(str(resolved))
        elif resolved.is_dir():
            for root, dirs, files in os.walk(resolved):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for f in files:
                    if os.path.splitext(f)[1].lower() in supported_exts:
                        found_files.append(os.path.join(root, f))
                        if len(found_files) >= MAX_SCAN_FILES:
                            break
                if len(found_files) >= MAX_SCAN_FILES:
                    break
                        
    return {
        "success": True,
        "scanned_paths": paths,
        "found_files": found_files
    }


def _is_allowed_scan_path(path: Path) -> bool:
    if path.anchor and path == Path(path.anchor):
        return False
    for blocked in BLOCKED_SCAN_DIRS:
        try:
            if path == blocked or blocked in path.parents:
                return False
        except OSError:
            continue
    return True


def _item_has_media(item: Dict[str, Any], media_kind: str) -> bool:
    if item.get(f"has_{media_kind}") is True:
        return True
    media_type = str(item.get("mediaType") or item.get("media_type") or "").lower()
    if media_kind == "video":
        return media_type in {"video", "av"} or "video" in media_type
    if media_kind == "audio":
        return media_type in {"audio", "av"} or "audio" in media_type
    return False
