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
from ..utils.progress import manager as ws_manager

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
# NOTE: size_mb values reflect the CT2-converted faster-whisper artifacts
# on disk, NOT the original OpenAI Whisper PT sizes. The CT2 conversion is
# noticeably bigger because it stores both quantized and reference weights.
# Verified against actual files in data/hf-cache after fresh downloads.
_MODEL_CATALOG = [
    {"name": "tiny", "size_mb": 75, "speed": "4-8x real-time", "quality": "low",
     "hf_repo_fragments": ["faster-whisper-tiny"]},
    {"name": "base", "size_mb": 145, "speed": "2-4x real-time", "quality": "basic",
     "hf_repo_fragments": ["faster-whisper-base"]},
    {"name": "small", "size_mb": 466, "speed": "1-2x real-time", "quality": "good for English",
     "hf_repo_fragments": ["faster-whisper-small"]},
    {"name": "medium", "size_mb": 1500, "speed": "0.5-1x real-time", "quality": "multilingual sweet spot",
     "hf_repo_fragments": ["faster-whisper-medium"]},
    {"name": "large-v3-turbo", "size_mb": 1600, "speed": "0.3-0.5x real-time",
     "quality": "best with reasonable CPU speed",
     "hf_repo_fragments": ["faster-whisper-large-v3-turbo"]},
    {"name": "large-v3", "size_mb": 3100, "speed": "0.1-0.2x real-time",
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


def is_model_installed(model_name: str) -> bool:
    """Public wrapper around _is_model_installed + catalog lookup.

    Returns True if ``model_name`` is in the catalog AND its weights
    are present (non-empty snapshot) in the HuggingFace hub cache.
    Used by routes that need a quick boolean without re-iterating the
    catalog themselves (e.g. /api/subtitles/transcribe-mixdown's 409
    short-circuit before the user uploads a WAV for nothing).
    """
    for m in _MODEL_CATALOG:
        if m["name"] == model_name:
            return _is_model_installed(m["name"], m["hf_repo_fragments"])
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


def _largest_incomplete_blob_size(cache_dir: Path, fragments: list[str]) -> int:
    """Return the byte size of the largest *.incomplete blob for `fragments`.

    HuggingFace's chunked downloader writes the partial file as
    `blobs/<sha>.incomplete` while a download is in progress; it's renamed
    to its final hash (no extension) on completion. Polling this size is
    the simplest cross-version-of-HF way to track real download progress
    without monkey-patching tqdm or hooking into hf_hub internals.
    """
    if not cache_dir.exists():
        return 0
    largest = 0
    for entry in cache_dir.iterdir():
        if not entry.is_dir() or not entry.name.startswith("models--"):
            continue
        name_lower = entry.name.lower()
        if not any(f.lower() in name_lower for f in fragments):
            continue
        blobs = entry / "blobs"
        if not blobs.exists():
            continue
        try:
            for blob in blobs.iterdir():
                if blob.name.endswith(".incomplete"):
                    try:
                        largest = max(largest, blob.stat().st_size)
                    except OSError:
                        continue
        except OSError:
            continue
    return largest


async def _emit_download_progress(
    model_name: str,
    fragments: list[str],
    expected_mb: int,
    stop_event: asyncio.Event,
) -> None:
    """Poll cache dir for the .incomplete blob and broadcast progress events.

    Runs as a background task while _load_model() blocks in a worker thread.
    Emits at most one event per second AND only when the size actually
    changed — avoids spamming the panel during idle moments (e.g. before
    the download starts producing bytes).
    """
    cache_dir = _hf_cache_dir()
    expected_bytes = expected_mb * 1024 * 1024
    last_size = -1

    # Emit a 'started' event right away so the panel can show the bar at 0%.
    await ws_manager.broadcast({
        "type": "whisper_download_progress",
        "payload": {
            "status": "started",
            "model": model_name,
            "downloaded_mb": 0,
            "total_mb": expected_mb,
            "percent": 0.0,
        },
    })

    while not stop_event.is_set():
        try:
            size_bytes = _largest_incomplete_blob_size(cache_dir, fragments)
        except Exception:
            size_bytes = 0

        if size_bytes != last_size and size_bytes > 0:
            size_mb = round(size_bytes / (1024 * 1024), 1)
            percent = min(99.9, round(100.0 * size_bytes / expected_bytes, 1)) if expected_bytes else 0.0
            await ws_manager.broadcast({
                "type": "whisper_download_progress",
                "payload": {
                    "status": "downloading",
                    "model": model_name,
                    "downloaded_mb": size_mb,
                    "total_mb": expected_mb,
                    "percent": percent,
                },
            })
            last_size = size_bytes

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=1.0)
        except asyncio.TimeoutError:
            continue


@router.post("/set-model")
async def set_whisper_model(request: SetModelRequest):
    """Switch the active Whisper model. Persists to disk.

    If `preload=true`, blocks until the model is loaded (downloads it if needed)
    AND broadcasts `whisper_download_progress` WS events every second so the
    panel can show a live progress bar instead of staring at a stuck button.
    If `preload=false` (default), returns immediately and the next transcribe
    call triggers the load+download (no progress events).
    """
    try:
        result = whisper_service.set_active_model(request.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    if request.preload:
        # Delegate to whisper_service which handles BOTH the polling-progress
        # broadcast AND the actual load atomically. Same code path is now used
        # by transcribe() so the user sees the progress bar regardless of
        # which surface triggered the load. Don't duplicate the polling here.
        try:
            await whisper_service._load_model_with_progress()
            result["preloaded"] = True
            result["model_loaded"] = whisper_service._model is not None
        except Exception as e:
            logger.error(f"Whisper preload failed for {request.model}: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Model switch succeeded but preload failed: {e}",
            )

    return result
