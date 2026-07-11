"""EditFlow AI — Captions routes (ProRes rendering + import).

Endpoints (all under /api/captions):

  POST /render    Render words + style → ProRes 4444 video with alpha.
                  Returns the path to the .mov file for import into Premiere.

  POST /transcribe  Transcribe an uploaded audio file → word-level cues.
                    (Reuses the existing Whisper transcription.)

Everything here is ADDITIVE. A failure in captions never mutates
Review / agent / cut state.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from ..config import get_settings
from ..services.captions import render_caption_video, compute_render_fingerprint
from ..services.whisper_service import whisper_service
from ..utils.progress import ProgressReporter
from .whisper_admin import is_model_installed

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/captions", tags=["captions"])


# ── Models ──

class RenderReq(BaseModel):
    """Request body for POST /captions/render."""
    words: list[dict]               # [{word: str, start: float, end: float}, ...]
    style: dict[str, Any] = {}      # {font_family, font_size, fill_color, ...}
    render: dict[str, Any] = {}     # {width, height, fps, duration}
    client_id: Optional[str] = None


class TranscribeReq(BaseModel):
    """Used internally — the upload endpoint handles multipart."""
    pass


# ── Routes ──

@router.post("/render")
async def render_captions(req: RenderReq):
    """Render animated captions to a ProRes 4444 video with alpha.

    The video is saved to data/output/captions/<fingerprint>.mov and can
    be imported into Premiere Pro via the ExtendScript importFiles() call.

    Returns:
        {path: str, fingerprint: str, size_mb: float, duration: float}
    """
    if not req.words:
        raise HTTPException(status_code=400, detail="No words provided.")

    try:
        settings = get_settings()
        out_dir = settings.DATA_DIR / "output" / "captions"
        out_dir.mkdir(parents=True, exist_ok=True)

        fingerprint = compute_render_fingerprint(req.words, req.style, req.render)
        output_path = out_dir / f"captions_{fingerprint}.mov"

        # Cache hit — if the file already exists, return it immediately
        if output_path.exists() and output_path.stat().st_size > 0:
            logger.info(f"Caption cache hit: {output_path}")
            return {
                "path": str(output_path),
                "fingerprint": fingerprint,
                "size_mb": round(output_path.stat().st_size / 1024 / 1024, 1),
                "duration": req.render.get("duration", 0),
                "cached": True,
            }

        # Set up progress reporting
        reporter = ProgressReporter(
            task_type="caption_render",
            client_id=req.client_id,
        )

        async def progress_cb(progress: float, message: str):
            await reporter.update(progress, message)

        await reporter.start("Rendering caption video...")

        # Render
        await render_caption_video(
            words=req.words,
            style_config=req.style,
            render_config=req.render,
            output_path=output_path,
            progress_callback=progress_cb,
        )

        await reporter.complete(f"Rendered to {output_path.name}")

        return {
            "path": str(output_path),
            "fingerprint": fingerprint,
            "size_mb": round(output_path.stat().st_size / 1024 / 1024, 1),
            "duration": req.render.get("duration", 0),
            "cached": False,
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("captions.render failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    client_id: Optional[str] = Form(None),
    sequence_name: Optional[str] = Form(None),
):
    """Transcribe an uploaded audio file → word-level cues.

    Reuses the existing Whisper transcription service. Returns word-level
    timestamps suitable for the caption editor.
    """
    try:
        active_model = whisper_service.get_active_model_name()
        fingerprint = hashlib.sha256(
            f"{sequence_name or file.filename}|{active_model}".encode("utf-8")
        ).hexdigest()[:16]

        # Save uploaded file
        mixdowns_dir = get_settings().DATA_DIR / "media_cache" / "captions"
        mixdowns_dir.mkdir(parents=True, exist_ok=True)
        wav_path = mixdowns_dir / f"{fingerprint}.wav"
        try:
            content = await file.read()
            wav_path.write_bytes(content)
        finally:
            await file.close()

        # Check model
        if not is_model_installed(active_model):
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "no_model",
                    "available": [],
                    "download_hint": "open_settings_whisper",
                },
            )

        # Transcribe
        reporter = ProgressReporter(task_type="transcribe", client_id=client_id)
        result = await whisper_service.transcribe_fingerprinted(
            source_path=str(wav_path),
            file_fingerprint=fingerprint,
            language=None,
            word_timestamps=True,
            vad_filter=True,
            progress=reporter,
            range_in=0.0,
            range_out=0.0,
        )

        words_out: list[dict] = []
        for seg in result.segments:
            for w in seg.words:
                words_out.append({
                    "word": w.word,
                    "start": w.start,
                    "end": w.end,
                    "confidence": w.probability,
                })

        return {
            "words": words_out,
            "fingerprint": fingerprint,
            "duration": result.duration,
            "model": result.model or active_model,
            "engine": result.engine,
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("captions.transcribe failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc
