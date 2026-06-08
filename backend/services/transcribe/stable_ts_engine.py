"""stable-ts transcription engine adapter.

stable-ts provides improved word-level timestamps on top of Whisper models
with ~100 ms accuracy — a solid fallback when WhisperX is unavailable.

Requires: ``stable-ts`` (pip install stable-ts).
"""
import asyncio
import logging
from typing import Optional

from .base import TranscribeEngine
from ...models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord

logger = logging.getLogger(__name__)


class StableTSEngine(TranscribeEngine):
    """Transcription engine backed by stable-ts.

    Priority: **fallback** — ~100 ms word-timestamp accuracy via
    stable-ts stabilization and re-alignment on top of a Whisper model.

    Attributes:
        name: Engine identifier written into ``TranscriptResult.engine``.
        boundary_window_ms: Snap window for Stage 6 VAD-boundary correction.
    """

    name: str = "stable_ts"
    boundary_window_ms: int = 350  # stable-ts is decent; moderate window

    _DEFAULT_MODEL_SIZE: str = "base"
    _DEFAULT_DEVICE: str = "cuda"
    _DEFAULT_COMPUTE_TYPE: str = "float16"

    def __init__(
        self,
        model_size: Optional[str] = None,
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
    ):
        self._model_size = model_size or self._DEFAULT_MODEL_SIZE
        self._device = device or self._DEFAULT_DEVICE
        self._compute_type = compute_type or self._DEFAULT_COMPUTE_TYPE
        self._model = None
        self._model_info: dict = {}

    # ── Availability ──

    def is_available(self) -> bool:
        """Return True if ``stable_ts`` can be imported."""
        try:
            import stable_ts  # noqa: F401
            return True
        except ImportError:
            return False

    # ── Lazy model loading ──

    def _load_model(self):
        """Load the stable-ts model (sync — call via ``to_thread``)."""
        if self._model is not None:
            return

        import torch
        import stable_ts

        device = self._device
        compute_type = self._compute_type

        # Fall back to CPU if CUDA is not available
        if device == "cuda" and not torch.cuda.is_available():
            logger.warning("CUDA not available, falling back to CPU for stable-ts")
            device = "cpu"
            compute_type = "int8"

        logger.info(f"Loading stable-ts model: {self._model_size} ({device}/{compute_type})")

        # stable-ts loads a Whisper model via faster-whisper under the hood
        self._model = stable_ts.load_model(
            self._model_size,
            device=device,
            compute_type=compute_type,
        )
        self._model_info = {
            "model": self._model_size,
            "device": device,
            "compute_type": compute_type,
            "engine": "stable_ts",
        }
        logger.info(f"stable-ts model loaded: {self._model_size}")

    # ── Transcription ──

    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
    ) -> TranscriptResult:
        """Transcribe an audio file using stable-ts.

        Args:
            audio_path: Path to an audio file (WAV preferred).
            language: Language hint (None for auto-detect).
            word_timestamps: Whether to include word-level timestamps.
            vad_filter: Whether to use VAD filtering.

        Returns:
            ``TranscriptResult`` with ``engine="stable_ts"`` populated.

        Raises:
            RuntimeError: If stable-ts or its dependencies cannot be loaded.
        """
        if not self.is_available():
            raise RuntimeError(
                "stable-ts engine not available — install with: pip install stable-ts"
            )

        # Load model in worker thread
        await asyncio.to_thread(self._load_model)

        # Run transcription in worker thread (CPU/GPU-bound)
        def _transcribe():
            return self._model.transcribe(
                audio_path,
                language=language,
                word_timestamps=word_timestamps,
                vad=word_timestamps,  # stable-ts uses vad param for word-level alignment
            )

        result = await asyncio.to_thread(_transcribe)

        # Convert stable-ts result to our schema
        # stable-ts returns a result object with segments and word-level data
        transcript_segments = []
        full_text_parts = []

        # Access segments from the result
        segments = []
        if hasattr(result, "segments"):
            segments = result.segments
        elif isinstance(result, dict):
            segments = result.get("segments", [])

        for seg in segments:
            # Build word list
            words = []
            seg_words = []
            if hasattr(seg, "words"):
                seg_words = seg.words
            elif isinstance(seg, dict):
                seg_words = seg.get("words", [])

            for w in seg_words:
                word_text = getattr(w, "word", None) or getattr(w, "text", "")
                word_start = float(getattr(w, "start", 0))
                word_end = float(getattr(w, "end", 0))
                word_prob = float(getattr(w, "probability", getattr(w, "score", 0)))

                words.append(TranscriptWord(
                    word=word_text.strip(),
                    start=round(word_start, 3),
                    end=round(word_end, 3),
                    probability=round(word_prob, 3),
                ))

            # Get segment text and timing
            seg_text = getattr(seg, "text", "") if not isinstance(seg, dict) else seg.get("text", "")
            seg_start = float(getattr(seg, "start", 0) if not isinstance(seg, dict) else seg.get("start", 0))
            seg_end = float(getattr(seg, "end", 0) if not isinstance(seg, dict) else seg.get("end", 0))

            transcript_segments.append(TranscriptSegment(
                start=round(seg_start, 3),
                end=round(seg_end, 3),
                text=seg_text.strip(),
                words=words,
            ))
            full_text_parts.append(seg_text.strip())

        # Detect language from result
        detected_language = language or ""
        if hasattr(result, "language"):
            detected_language = result.language
        elif isinstance(result, dict):
            detected_language = result.get("language", language or "")

        # Compute duration from segments
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
            model_revision="stable_ts",
        )
