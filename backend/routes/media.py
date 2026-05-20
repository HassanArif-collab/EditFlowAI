"""
EditFlow AI - Media Analysis API Routes
Video scanning and transcription endpoints.
"""
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from ..models.schemas import TranscriptResult
from ..services.whisper_service import whisper_service
from ..utils.ffmpeg_utils import get_media_info, scan_directory
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/media", tags=["media"])
MAX_SCAN_RESULTS = 500


@router.get("/info")
async def get_video_info(path: str):
    """Get detailed information about a video file."""
    info = get_media_info(path)
    if "error" in info:
        raise HTTPException(status_code=404, detail=info["error"])
    return info


@router.post("/scan")
async def scan_for_videos(directory: str, extensions: Optional[List[str]] = None):
    """Scan a directory for video files."""
    root = Path(directory).expanduser()
    try:
        resolved = root.resolve()
    except OSError:
        raise HTTPException(status_code=400, detail="Invalid directory")
    if not resolved.exists() or not resolved.is_dir():
        raise HTTPException(status_code=404, detail=f"Directory not found: {directory}")
    if resolved == Path(resolved.anchor):
        raise HTTPException(status_code=400, detail="Refusing to scan a drive root")
    files = scan_directory(directory, extensions)
    files = files[:MAX_SCAN_RESULTS]
    return {
        "directory": directory,
        "count": len(files),
        "files": [
            {
                "name": f.name,
                "path": str(f),
                "size": f.stat().st_size,
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
    if not Path(path).exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    progress = ProgressReporter(task_type="transcribe", client_id=client_id)
    try:
        result = await whisper_service.transcribe(
            video_path=path,
            language=language,
            progress=progress,
        )
        return result.dict()
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
    if not Path(directory).exists():
        raise HTTPException(status_code=404, detail=f"Directory not found: {directory}")

    progress = ProgressReporter(task_type="transcribe_batch", client_id=client_id)
    try:
        results = await whisper_service.transcribe_directory(
            directory=directory,
            language=language,
            progress=progress,
        )
        return {
            "total": len(results),
            "results": [r.dict() for r in results],
        }
    except Exception as e:
        logger.error(f"Batch transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
