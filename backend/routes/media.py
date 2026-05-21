"""
EditFlow AI - Media Analysis API Routes
Video scanning and transcription endpoints.
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from ..services.whisper_service import whisper_service
from ..utils.ffmpeg_utils import get_media_info, scan_directory
from ..utils.path_safety import (
    DEFAULT_MEDIA_EXTS,
    safe_dir_path,
    safe_file_path,
)
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/media", tags=["media"])
MAX_SCAN_RESULTS = 500


@router.get("/info")
async def get_video_info(path: str):
    """Get detailed information about a video file."""
    resolved = safe_file_path(path, label="path", allow_extensions=DEFAULT_MEDIA_EXTS)
    info = get_media_info(str(resolved))
    if "error" in info:
        raise HTTPException(status_code=404, detail=info["error"])
    return info


@router.post("/scan")
async def scan_for_videos(directory: str, extensions: Optional[List[str]] = None):
    """Scan a directory for video files."""
    resolved = safe_dir_path(directory, label="directory")
    files = scan_directory(str(resolved), extensions)
    files = files[:MAX_SCAN_RESULTS]
    return {
        "directory": str(resolved),
        "count": len(files),
        "files": [
            {
                "name": f.name,
                "path": str(f),
                "size": f.stat().st_size if f.exists() else 0,
                "extension": f.suffix,
            }
            for f in files[:100]
        ],
    }


@router.post("/transcribe")
async def transcribe_video(
    path: str,
    language: Optional[str] = None,
    client_id: Optional[str] = None,
):
    """Transcribe a video file using local Whisper."""
    resolved = safe_file_path(path, label="path", allow_extensions=DEFAULT_MEDIA_EXTS)

    progress = ProgressReporter(task_type="transcribe", client_id=client_id)
    try:
        result = await whisper_service.transcribe(
            video_path=str(resolved),
            language=language,
            progress=progress,
        )
        return result.model_dump()
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/transcribe-directory")
async def transcribe_directory(
    directory: str,
    language: Optional[str] = None,
    client_id: Optional[str] = None,
):
    """Transcribe all videos in a directory."""
    resolved = safe_dir_path(directory, label="directory")

    progress = ProgressReporter(task_type="transcribe_batch", client_id=client_id)
    try:
        results = await whisper_service.transcribe_directory(
            directory=str(resolved),
            language=language,
            progress=progress,
        )
        return {
            "total": len(results),
            "results": [r.model_dump() for r in results],
        }
    except Exception as e:
        logger.error(f"Batch transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
