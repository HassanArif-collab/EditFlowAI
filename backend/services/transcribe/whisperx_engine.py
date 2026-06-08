"""WhisperX transcription engine adapter.

WhisperX provides forced-alignment word timestamps with ~50 ms accuracy,
making it the best available engine for precise cut-point detection.

Requires: ``whisperx`` and ``torch`` (pip install whisperx torch).
"""
import asyncio
import logging
from typing import Optional

from .base import TranscribeEngine
from ...models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord

logger = logging.getLogger(__name__)


class WhisperXEngine(TranscribeEngine):
    """Transcription engine backed by WhisperX with forced alignment.

    Priority: **best** — ~50 ms word-timestamp accuracy thanks to
    forced alignment via wav2vec2.

    Attributes:
        name: Engine identifier written into ``TranscriptResult.engine``.
        boundary_window_ms: Snap window for Stage 6 VAD-boundary correction.
    """

    name: str = "whisperx"
    boundary_window_ms: int = 200  # whisperx is very precise; tight window

    # Default model settings (overridable at construction time)
    _DEFAULT_MODEL_SIZE: str = "base"
    _DEFAULT_DEVICE: str = "cuda"
    _DEFAULT_COMPUTE_TYPE: str = "float16"
    _DEFAULT_BATCH_SIZE: int = 8

    def __init__(
        self,
        model_size: Optional[str] = None,
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
        batch_size: Optional[int] = None,
    ):
        self._model_size = model_size or self._DEFAULT_MODEL_SIZE
        self._device = device or self._DEFAULT_DEVICE
        self._compute_type = compute_type or self._DEFAULT_COMPUTE_TYPE
        self._batch_size = batch_size or self._DEFAULT_BATCH_SIZE
        self._model = None
        self._align_model = None
        self._align_metadata = None
        self._model_info: dict = {}

    # ── Availability ──

    def is_available(self) -> bool:
        """Return True if ``whisperx`` and ``torch`` can be imported."""
        try:
            import whisperx  # noqa: F401
            import torch  # noqa: F401
            return True
        except ImportError:
            return False

    # ── Lazy model loading ──

    def _load_model(self):
        """Load the WhisperX model (sync — call via ``to_thread``)."""
        if self._model is not None:
            return

        import torch
        import whisperx

        device = self._device
        compute_type = self._compute_type

        # Fall back to CPU if CUDA is not available
        if device == "cuda" and not torch.cuda.is_available():
            logger.warning("CUDA not available, falling back to CPU for WhisperX")
            device = "cpu"
            compute_type = "int8"

        logger.info(f"Loading WhisperX model: {self._model_size} ({device}/{compute_type})")
        self._model = whisperx.load_model(
            self._model_size,
            device=device,
            compute_type=compute_type,
        )
        self._model_info = {
            "model": self._model_size,
            "device": device,
            "compute_type": compute_type,
            "engine": "whisperx",
        }
        logger.info(f"WhisperX model loaded: {self._model_size}")

    # ── Transcription ──

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
    ) -> TranscriptResult:
        """Transcribe an audio file using WhisperX with forced alignment.

        Args:
            audio_path: Path to an audio file (WAV preferred).
            language: Language hint (None for auto-detect).
            word_timestamps: Whether to run forced alignment for word-level
                timestamps (always True for WhisperX — the flag is accepted
                for API compatibility).
            vad_filter: Whether to use VAD filtering (WhisperX uses its own
                VAD internally).

        Returns:
            ``TranscriptResult`` with ``engine="whisperx"`` populated.

        Raises:
            RuntimeError: If WhisperX or its dependencies cannot be loaded.
        """
        if not self.is_available():
            raise RuntimeError(
                "WhisperX engine not available — install with: pip install whisperx torch"
            )

        # Load model in worker thread
        await asyncio.to_thread(self._load_model)

        import torch
        import whisperx

        # 1. Load audio
        audio = await asyncio.to_thread(whisperx.load_audio, audio_path)

        # 2. Transcribe
        def _transcribe():
            return self._model.transcribe(
                audio,
                batch_size=self._batch_size,
                language=language,
            )

        result = await asyncio.to_thread(_transcribe)
        detected_language = result.get("language", language or "")

        # 3. Forced alignment for word-level timestamps
        segments = result.get("segments", [])
        if word_timestamps and segments:
            try:
                device = self._device
                if device == "cuda" and not torch.cuda.is_available():
                    device = "cpu"

                if self._align_model is None:
                    self._align_model, self._align_metadata = whisperx.load_align_model(
                        language_code=detected_language,
                        device=device,
                    )

                def _align():
                    return whisperx.align(
                        segments,
                        self._align_model,
                        self._align_metadata,
                        audio,
                        device,
                        return_char_alignments=False,
                    )

                aligned = await asyncio.to_thread(_align)
                segments = aligned.get("segments", segments)
            except Exception as e:
                logger.warning(f"Forced alignment failed, using raw segments: {e}")

        # 4. Convert to TranscriptResult
        transcript_segments = []
        full_text_parts = []

        for seg in segments:
            words = []
            for w in seg.get("words", []):
                words.append(TranscriptWord(
                    word=w.get("word", w.get("text", "")).strip(),
                    start=round(float(w.get("start", 0)), 3),
                    end=round(float(w.get("end", 0)), 3),
                    probability=round(float(w.get("score", w.get("probability", 0))), 3),
                ))

            text = seg.get("text", "").strip()
            transcript_segments.append(TranscriptSegment(
                start=round(float(seg.get("start", 0)), 3),
                end=round(float(seg.get("end", 0)), 3),
                text=text,
                words=words,
            ))
            full_text_parts.append(text)

        # Compute duration from segments if not directly available
        duration = 0.0
        if transcript_segments:
            duration = round(transcript_segments[-1].end, 2)

        return TranscriptResult(
            source_file=audio_path,
            language=detected_language,
            duration=duration,
            segments=transcript_segments,
            full_text=" ".join(full_text_parts),
            engine=self.name,
            model=self._model_info.get("model", self._model_size),
            model_revision="whisperx",
        )
