"""
EditFlow AI - Whisper Transcription Service
Local transcription using faster-whisper with VAD and word timestamps.
"""
import asyncio
import logging
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

from ..config import Settings
from ..models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord
from ..utils.ffmpeg_utils import extract_audio
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)


class WhisperService:
    """Local Whisper transcription service using faster-whisper."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or Settings()
        self._model = None
        self._model_info = {}

    def _load_model(self):
        """Lazy-load the Whisper model."""
        if self._model is not None:
            return

        try:
            from faster_whisper import WhisperModel

            # Try device/compute combinations
            attempts = []
            if self.settings.WHISPER_LOCAL_DIR:
                attempts.append(
                    (self.settings.WHISPER_LOCAL_DIR, self.settings.WHISPER_DEVICE, self.settings.WHISPER_COMPUTE_TYPE)
                )

            # Always try standard model names as fallback
            model_name = self.settings.WHISPER_MODEL
            attempts.append((model_name, self.settings.WHISPER_DEVICE, self.settings.WHISPER_COMPUTE_TYPE))

            # Try CPU int8 as fallback
            if self.settings.WHISPER_DEVICE != "cpu" or self.settings.WHISPER_COMPUTE_TYPE != "int8":
                attempts.append((model_name, "cpu", "int8"))

            # Fallback to smaller models if the primary model fails to load/download
            smaller_models = ["base", "tiny"]
            for small_model in smaller_models:
                if small_model != model_name:
                    attempts.append((small_model, "cpu", "int8"))

            for model_spec, device, compute_type in attempts:
                try:
                    logger.info(f"Loading Whisper model: {model_spec} ({device}/{compute_type})")
                    self._model = WhisperModel(
                        model_spec,
                        device=device,
                        compute_type=compute_type,
                        # Only use local_files_only if we have a local dir
                        local_files_only=bool(self.settings.WHISPER_LOCAL_DIR and Path(self.settings.WHISPER_LOCAL_DIR).exists()),
                    )
                    self._model_info = {
                        "model": str(model_spec),
                        "device": device,
                        "compute_type": compute_type,
                    }
                    logger.info(f"Whisper loaded: {model_spec} ({device}/{compute_type})")
                    return
                except Exception as e:
                    logger.warning(f"Failed to load Whisper {model_spec} ({device}/{compute_type}): {e}")
                    continue

            raise RuntimeError("Could not load any Whisper model variant")

        except ImportError:
            raise RuntimeError("faster-whisper not installed. Run: pip install faster-whisper")

    async def transcribe(
        self,
        video_path: str,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
        progress: Optional[ProgressReporter] = None,
    ) -> TranscriptResult:
        """Transcribe a video file.

        Args:
            video_path: Path to video or audio file
            language: Language hint (None for auto-detect)
            word_timestamps: Whether to include word-level timestamps
            vad_filter: Whether to use Voice Activity Detection
            progress: Optional progress reporter

        Returns:
            TranscriptResult with segments and word timestamps
        """
        if progress:
            await progress.start("Loading Whisper model...")

        # Load model in executor to not block
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._load_model)

        if progress:
            await progress.update(0.1, "Extracting audio...")

        # Extract audio if needed
        video_path = Path(video_path)
        audio_path = None

        if video_path.suffix.lower() in [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]:
            # Video file - extract audio
            tmp_dir = self.settings.MEDIA_CACHE_DIR
            tmp_dir.mkdir(parents=True, exist_ok=True)
            audio_path = tmp_dir / f"{video_path.stem}_audio.wav"
            if not audio_path.exists():
                await loop.run_in_executor(
                    None,
                    lambda: extract_audio(video_path, audio_path),
                )
        elif video_path.suffix.lower() in [".wav", ".mp3", ".flac", ".ogg", ".m4a"]:
            audio_path = video_path
        else:
            return TranscriptResult(
                source_file=str(video_path),
                language="",
                duration=0.0,
                segments=[],
                full_text="",
            )

        if progress:
            await progress.update(0.2, "Transcribing audio...")

        # Transcribe
        try:
            segments_iter, info = await loop.run_in_executor(
                None,
                lambda: self._model.transcribe(
                    str(audio_path),
                    task="transcribe",
                    language=language,
                    vad_filter=vad_filter,
                    word_timestamps=word_timestamps,
                    beam_size=5,
                ),
            )

            # Process segments
            result_segments = []
            full_text_parts = []
            total_segments = 0

            for segment in segments_iter:
                words = []
                if word_timestamps and segment.words:
                    for w in segment.words:
                        words.append(TranscriptWord(
                            word=w.word.strip(),
                            start=round(w.start, 3),
                            end=round(w.end, 3),
                            probability=round(w.probability, 3),
                        ))

                result_segments.append(TranscriptSegment(
                    start=round(segment.start, 3),
                    end=round(segment.end, 3),
                    text=segment.text.strip(),
                    words=words,
                ))
                full_text_parts.append(segment.text.strip())
                total_segments += 1

                if progress and total_segments % 10 == 0:
                    # Rough progress estimate based on segments
                    await progress.update(
                        0.2 + 0.7 * (total_segments / max(total_segments, 50)),
                        f"Transcribed {total_segments} segments...",
                    )

            if progress:
                await progress.complete(f"Transcription complete: {total_segments} segments")

            return TranscriptResult(
                source_file=str(video_path),
                language=info.language,
                duration=round(info.duration, 2),
                segments=result_segments,
                full_text=" ".join(full_text_parts),
            )

        except Exception as e:
            logger.error(f"Transcription error: {e}")
            if progress:
                await progress.fail(f"Transcription failed: {e}")
            raise

    async def transcribe_directory(
        self,
        directory: str,
        extensions: Optional[List[str]] = None,
        language: Optional[str] = None,
        progress: Optional[ProgressReporter] = None,
    ) -> List[TranscriptResult]:
        """Transcribe all video files in a directory.

        Args:
            directory: Directory containing video files
            extensions: Video file extensions to include
            language: Language hint
            progress: Progress reporter

        Returns:
            List of TranscriptResult objects
        """
        from ..utils.ffmpeg_utils import scan_directory

        files = scan_directory(directory, extensions)
        results = []

        for i, file_path in enumerate(files):
            if progress:
                await progress.step(i + 1, len(files), f"Transcribing {file_path.name}...")

            try:
                result = await self.transcribe(
                    str(file_path),
                    language=language,
                    progress=None,  # Don't create nested progress
                )
                results.append(result)
            except Exception as e:
                logger.error(f"Failed to transcribe {file_path}: {e}")
                continue

        if progress:
            await progress.complete(f"Batch transcription complete: {len(results)}/{len(files)} files")

        return results

    @property
    def model_info(self) -> Dict:
        """Get information about the loaded model."""
        return self._model_info


# Global service instance
whisper_service = WhisperService()
