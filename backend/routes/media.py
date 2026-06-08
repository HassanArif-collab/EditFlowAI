"""
EditFlow AI - Media Analysis API Routes
Video scanning, fingerprinting, audio preparation, and transcription endpoints.
"""
import logging
from typing import List, Optional

from fastapi import APIRouter, HTTPException

from ..models.schemas import FingerprintResult
from ..services.audio_prepare import audio_prepare_service
from ..services.media_fingerprint import (
    compute_audio_fingerprint,
    compute_file_fingerprint,
)
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


# ── Phase B: Fingerprint + Audio Prepare endpoints ──

@router.get("/fingerprint", response_model=FingerprintResult)
async def fingerprint_file(path: str):
    """Compute content fingerprints for a media file.

    Returns both the file-level fingerprint (SHA-256 of file bytes) and
    the audio-level fingerprint (SHA-256 of decoded PCM data for WAVs).
    """
    try:
        resolved = safe_file_path(
            path, label="path",
            allow_extensions=DEFAULT_MEDIA_EXTS,
        )
    except HTTPException:
        # If the extension check fails, try a more permissive check
        from pathlib import Path
        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"File not found: {path}")
        resolved = p

    try:
        file_fp = compute_file_fingerprint(str(resolved))
        audio_fp = compute_audio_fingerprint(str(resolved))
        file_size = resolved.stat().st_size if resolved.exists() else 0
        return FingerprintResult(
            path=str(resolved),
            file_fingerprint=file_fp,
            audio_fingerprint=audio_fp,
            file_size=file_size,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    except Exception as e:
        logger.error(f"Fingerprint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/prepare-audio")
async def prepare_audio(path: str):
    """Content-addressed audio preparation.

    Extracts audio from a media file to 16 kHz mono WAV, caches it by
    file fingerprint, and returns the preparation result.  If the file
    has already been prepared, returns the cached result without
    re-extracting.
    """
    try:
        resolved = safe_file_path(
            path, label="path",
            allow_extensions=DEFAULT_MEDIA_EXTS,
        )
    except HTTPException:
        from pathlib import Path
        p = Path(path)
        if not p.exists():
            raise HTTPException(status_code=404, detail=f"File not found: {path}")
        resolved = p

    try:
        result = audio_prepare_service.prepare(str(resolved))
        return result.model_dump()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    except RuntimeError as e:
        logger.error(f"Audio preparation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/transcribe")
async def transcribe_video(
    path: str,
    language: Optional[str] = None,
    client_id: Optional[str] = None,
    force: bool = False,
):
    """Transcribe a video file using local Whisper.

    Phase B: uses transcribe-once-per-source-file by default.  Set
    ``force=true`` to bypass the cache and re-transcribe.
    """
    resolved = safe_file_path(path, label="path", allow_extensions=DEFAULT_MEDIA_EXTS)

    progress = ProgressReporter(task_type="transcribe", client_id=client_id)
    try:
        result = await whisper_service.transcribe_fingerprinted(
            source_path=str(resolved),
            language=language,
            progress=progress,
            force=force,
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
