"""Transcription engine selection cascade.

Phase B: deterministic engine selection.
Priority: whisperx (best, ~50ms accuracy) > stable-ts (fallback, ~100ms) > faster-whisper (existing, ~200-300ms)

Usage::

    from backend.services.transcribe import select_engine

    engine = select_engine()          # returns the best available engine
    result = await engine.transcribe("/path/to/audio.wav")

The selected engine's ``name`` and ``boundary_window_ms`` are written into
the ``TranscriptResult`` so that Stage 6 (VAD snap) knows which window to
apply.
"""
import logging

from .base import TranscribeEngine
from .whisperx_engine import WhisperXEngine
from .stable_ts_engine import StableTSEngine
from .whisper_engine import FasterWhisperEngine

logger = logging.getLogger(__name__)

# Ordered by priority: best first
_ENGINES = [
    WhisperXEngine(),
    StableTSEngine(),
    FasterWhisperEngine(),
]


def select_engine() -> TranscribeEngine:
    """Select the best available transcription engine.

    Returns the first engine whose dependencies are importable,
    in priority order: whisperx > stable-ts > faster-whisper.

    Returns:
        A ``TranscribeEngine`` instance ready for use.

    Raises:
        RuntimeError: If no engine's dependencies are available.
    """
    for engine in _ENGINES:
        if engine.is_available():
            logger.info(f"Selected transcription engine: {engine.name} (boundary_window_ms={engine.boundary_window_ms})")
            return engine

    raise RuntimeError(
        "No transcription engine available "
        "(need whisperx, stable-ts, or faster-whisper)"
    )


def get_engine_by_name(name: str) -> TranscribeEngine:
    """Get a specific engine by name.

    Useful when you want to force a particular engine regardless of
    the default cascade (e.g. for testing or re-transcription with a
    different engine).

    Args:
        name: One of ``"whisperx"``, ``"stable_ts"``, ``"faster_whisper"``.

    Returns:
        The matching ``TranscribeEngine`` if it is available.

    Raises:
        RuntimeError: If the named engine is not available.
    """
    for engine in _ENGINES:
        if engine.name == name and engine.is_available():
            return engine

    available = [e.name for e in _ENGINES if e.is_available()]
    raise RuntimeError(
        f"Transcription engine '{name}' not available. "
        f"Available engines: {available or 'none'}"
    )


def list_engines() -> dict:
    """Return a summary of all engines and their availability.

    Useful for diagnostics and the preflight check.

    Returns:
        A dict mapping engine name → {"available": bool, "boundary_window_ms": int}.
    """
    return {
        engine.name: {
            "available": engine.is_available(),
            "boundary_window_ms": engine.boundary_window_ms,
        }
        for engine in _ENGINES
    }


__all__ = [
    "TranscribeEngine",
    "select_engine",
    "get_engine_by_name",
    "list_engines",
]
