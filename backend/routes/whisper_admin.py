"""
Whisper admin routes — runtime model switching + install detection.

The active model persists in data/whisper_config.json across restarts.
faster-whisper auto-downloads models from HuggingFace on first use, so
"installing" a model is just "set it active and let the next transcribe
warm it up". The /status endpoint reports per-model installed state by
scanning the HuggingFace cache directory.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..services.whisper_service import whisper_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/whisper", tags=["whisper"])


# Pydantic models for request bodies. Missing this class was the cause of the
# 422 "Field required" error: FastAPI fell back to interpreting `request` as a
# query parameter when the type annotation referenced an undefined class.
class SetModelRequest(BaseModel):
    model: str
    preload: bool = False


# Catalog of supported Whisper models with size hints and HuggingFace repo
# fragments. The "hf_repo_fragments" list contains substrings that appear in
# the cache directory name (`models--{org}--{repo}`). We check all of them
# because faster-whisper can pull from multiple mirrors (mobiuslabsgmbh,
# dropbox-dash, etc.) depending on which one is reachable.
_MODEL_CATALOG = [
    {"name": "tiny", "size_mb": 39, "speed": "4-8x real-time", "quality": "low",
     "hf_repo_fragments": ["faster-whisper-tiny"]},
    {"name": "base", "size_mb": 74, "speed": "2-4x real-time", "quality": "basic",
     "hf_repo_fragments": ["faster-whisper-base"]},
    {"name": "small", "size_mb": 244, "speed": "1-2x real-time", "quality": "good for English",
     "hf_repo_fragments": ["faster-whisper-small"]},
    {"name": "medium", "size_mb": 769, "speed": "0.5-1x real-time", "quality": "multilingual sweet spot",
     "hf_repo_fragments": ["faster-whisper-medium"]},
    {"name": "large-v3-turbo", "size_mb": 1500, "speed": "0.3-0.5x real-time",
     "quality": "best with reasonable CPU speed",
     "hf_repo_fragments": ["faster-whisper-large-v3-turbo"]},
    {"name": "large-v3", "size_mb": 3000, "speed": "0.1-0.2x real-time",
     "quality": "highest (GPU recommended)",
     "hf_repo_fragments": ["faster-whisper-large-v3"]},
]


def _hf_cache_dir() -> Path:
    """Find the HuggingFace hub cache directory.

    Respects HF_HOME, HUGGINGFACE_HUB_CACHE, and HF_HUB_CACHE env vars.
    Falls back to the default ~/.cache/huggingface/hub.
    """
    for env in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        val = os.environ.get(env)
        if val:
            return Path(val).expanduser()
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return Path(hf_home).expanduser() / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def _is_model_installed(model_name: str, fragments: list[str]) -> bool:
    """Check whether a Whisper model is downloaded to the HF cache.

    A model is considered installed if any directory under the hub cache
    contains one of the repo fragments AND has a model.bin or non-empty
    snapshots/ subdir. Some entries are sentinel "marker" dirs (empty);
    we don't count those.
    """
    cache_dir = _hf_cache_dir()
    if not cache_dir.exists():
        return False
    # Iterate hub model dirs (faster than rglob over the whole cache).
    for entry in cache_dir.iterdir():
        if not entry.is_dir() or not entry.name.startswith("models--"):
            continue
        lower = entry.name.lower()
        if not any(frag.lower() == lower.split("--", 2)[-1] or frag.lower() in lower for frag in fragments):
            continue
        # Real installs have a snapshots/<rev>/ folder with model.bin
        snapshots = entry / "snapshots"
        if not snapshots.exists():
            continue

        # If there's an in-progress download (HF writes blobs/<hash>.incomplete
        # during the chunked download), this model is NOT installed yet — even
        # if the metadata files (config.json, tokenizer.json, vocabulary.txt)
        # are already present. Previously the >1KB fallback below misidentified
        # such half-downloaded entries as "installed", causing the panel UI to
        # claim 'medium' was ready when only 2 KB of metadata existed and the
        # 770 MB model.bin was still partial.
        blobs = entry / "blobs"
        if blobs.exists():
            try:
                if any(p.name.endswith(".incomplete") for p in blobs.iterdir()):
                    continue
            except OSError:
                pass

        for rev in snapshots.iterdir():
            if (rev / "model.bin").exists():
                return True
            # Some converted checkpoints publish model.safetensors instead.
            if (rev / "model.safetensors").exists():
                return True
            # Fallback for unusual layouts: accept if a *weight-shaped* file
            # exists (>10 MB, not metadata). Was previously >1 KB, which let
            # metadata-only directories slip through.
            try:
                if any(p.is_file() and p.stat().st_size > 10 * 1024 * 1024
                       for p in rev.iterdir()):
                    return True
            except OSError:
                continue
    return False


@router.get("/status")
async def whisper_status():
    """Return the active model + per-model installed state + cache location."""
    cache_dir = _hf_cache_dir()
    supported = []
    for m in _MODEL_CATALOG:
        supported.append({
            "name": m["name"],
            "size_mb": m["size_mb"],
            "speed": m["speed"],
            "quality": m["quality"],
            "installed": _is_model_installed(m["name"], m["hf_repo_fragments"]),
        })
    return {
        "active_model": whisper_service.get_active_model_name(),
        "model_loaded": whisper_service._model is not None,
        "model_info": whisper_service._model_info,
        "cache_dir": str(cache_dir),
        "supported_models": supported,
    }


@router.post("/set-model")
async def set_whisper_model(request: SetModelRequest):
    """Switch the active Whisper model. Persists to disk.

    If `preload=true`, blocks until the model is loaded (downloads it if needed).
    If `preload=false` (default), returns immediately and the next transcribe
    call triggers the load+download.
    """
    try:
        result = whisper_service.set_active_model(request.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if request.preload:
        # Run the blocking model load on a thread so the request can still time out cleanly.
        try:
            await asyncio.to_thread(whisper_service._load_model)
            result["preloaded"] = True
            result["model_loaded"] = whisper_service._model is not None
        except Exception as e:
            logger.error(f"Whisper preload failed for {request.model}: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Model switch succeeded but preload failed: {e}",
            )

    return result
