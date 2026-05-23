"""Base class for transcription engines."""
from abc import ABC, abstractmethod
from typing import List, Optional

from ...models.schemas import TranscriptResult, TranscriptWord, TranscriptSegment, VADSegment


class TranscribeEngine(ABC):
    """Abstract base for transcription engines.

    Every engine must implement:
      - ``transcribe()`` – run transcription and return a ``TranscriptResult``
      - ``is_available()`` – return True if the engine's dependencies are importable

    The ``name`` and ``boundary_window_ms`` class attributes are used by the
    pipeline to log which engine was chosen (so Stage 6 knows which snap
    window to apply) and to parameterise the VAD-snapping step.
    """

    name: str = "unknown"
    boundary_window_ms: int = 500  # ms, used by stage 6 for VAD snapping

    @abstractmethod
    async def transcribe(
        self,
        audio_path: str,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
    ) -> TranscriptResult:
        """Transcribe an audio file. Returns TranscriptResult."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Check if this engine's dependencies are importable."""
        ...

    @staticmethod
    def run_vad(audio_path: str) -> List[VADSegment]:
        """Run silero-vad on an audio file. Returns VAD segments.

        This is a separate pass from transcription, as the plan specifies
        we don't trust Whisper's internal VAD for boundary detection.
        Falls back to an empty list if silero-vad is not available.
        """
        try:
            import torch
            model, utils = torch.hub.load(
                repo_or_dir="snakers4/silero-vad",
                model="silero_vad",
                trust_repo=True,
            )
            (get_speech_timestamps, _, read_audio, _, _) = utils
            wav = read_audio(audio_path)
            speech_timestamps = get_speech_timestamps(wav, model)
            return [
                VADSegment(start=ts["start"] / 16000, end=ts["end"] / 16000, is_speech=True)
                for ts in speech_timestamps
            ]
        except Exception:
            return []
