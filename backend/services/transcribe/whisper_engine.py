"""Faster-Whisper transcription engine adapter.

This is the existing engine used by EditFlowAI, wrapped behind the
``TranscribeEngine`` interface for compatibility with the Phase B engine
selection cascade.  Word-timestamp accuracy is ~200-300 ms — the widest
boundary window of the three engines.

Requires: ``faster_whisper`` (pip install faster-whisper).
"""
import logging
from typing import Optional

from .base import TranscribeEngine
from ...models.schemas import TranscriptResult

logger = logging.getLogger(__name__)


class FasterWhisperEngine(TranscribeEngine):
    """Transcription engine backed by the existing ``WhisperService``.

    This is the **existing** engine and the last resort in the cascade.
    It wraps ``backend.services.whisper_service.WhisperService`` so that
    all engines share the same ``TranscribeEngine`` interface.

    Priority: **existing / last resort** — ~200-300 ms word-timestamp
    accuracy.

    Attributes:
        name: Engine identifier written into ``TranscriptResult.engine``.
        boundary_window_ms: Snap window for Stage 6 VAD-boundary correction.
    """

    name: str = "faster_whisper"
    boundary_window_ms: int = 500  # wider window; less precise timestamps

    def __init__(self):
        self._service = None

    # ── Availability ──

    def is_available(self) -> bool:
        """Return True if ``faster_whisper`` can be imported."""
        try:
            import faster_whisper  # noqa: F401
            return True
        except ImportError:
            return False

    # ── Lazy service access ──

    def _get_service(self):
        """Lazily instantiate the global WhisperService."""
        if self._service is None:
            from ..whisper_service import whisper_service
            self._service = whisper_service
        return self._service

    # ── Transcription ──

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
    ) -> TranscriptResult:
        """Transcribe an audio file using the existing WhisperService.

        This delegates to ``WhisperService.transcribe()`` and then stamps
        the result with ``engine="faster_whisper"`` and model metadata
        so that Stage 6 knows which snap window to use.

        Args:
            audio_path: Path to a video or audio file.
            language: Language hint (None for auto-detect).
            word_timestamps: Whether to include word-level timestamps.
            vad_filter: Whether to use VAD filtering.

        Returns:
            ``TranscriptResult`` with ``engine="faster_whisper"`` populated.

        Raises:
            RuntimeError: If faster-whisper or its dependencies cannot be loaded.
        """
        if not self.is_available():
            raise RuntimeError(
                "faster-whisper engine not available — install with: pip install faster-whisper"
            )

        service = self._get_service()

        # Delegate to the existing WhisperService
        result = await service.transcribe(
            video_path=audio_path,
            language=language,
            word_timestamps=word_timestamps,
            vad_filter=vad_filter,
        )

        # Stamp engine metadata so Stage 6 can pick the right snap window
        result.engine = self.name
        model_info = service.model_info
        result.model = model_info.get("model", "")
        result.model_revision = (
            f"{model_info.get('device', 'cpu')}/{model_info.get('compute_type', 'int8')}"
        )

        return result
