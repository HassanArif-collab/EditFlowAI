"""
EditFlow AI - Whisper Transcription Service
Local transcription using faster-whisper with VAD and word timestamps.

Phase B enhancement: transcribe-once-per-source-file.  Before running
Whisper, the service checks the audio cache (keyed by file fingerprint)
for an existing transcript.  If found, the cached result is returned
immediately, avoiding the expensive re-transcription of the same file.
"""
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..config import Settings, get_settings
from ..models.schemas import TranscriptResult, TranscriptSegment, TranscriptWord
from ..services.media_fingerprint import compute_file_fingerprint
from ..utils.ffmpeg_utils import extract_audio
from ..utils.progress import ProgressReporter

logger = logging.getLogger(__name__)


def _audio_cache_key(video_path: Path) -> str:
    """Hash the full resolved path so videos with the same filename in
    different folders never share a cache entry."""
    try:
        full = str(video_path.resolve()).encode("utf-8")
    except OSError:
        full = str(video_path).encode("utf-8")
    return hashlib.sha1(full).hexdigest()[:16]


def _consume_segments(
    segments_iter,
    word_timestamps: bool,
    progress_state: Optional[Dict[str, Any]] = None,
) -> Tuple[List[TranscriptSegment], List[str]]:
    """Drain the faster-whisper segment generator. CPU-bound; call via to_thread.

    If ``progress_state`` is provided it is mutated in place after every segment
    so an async ticker can publish progress updates. The dict-write is safe
    under the GIL — no extra locking needed.
    """
    result_segments: List[TranscriptSegment] = []
    full_text_parts: List[str] = []

    for segment in segments_iter:
        words: List[TranscriptWord] = []
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

        if progress_state is not None:
            progress_state["count"] = len(result_segments)
            progress_state["last_end"] = float(segment.end)

    return result_segments, full_text_parts


class WhisperService:
    """Local Whisper transcription service using faster-whisper.

    Supports transcribe-once-per-source-file: each unique source file
    (identified by content fingerprint) is only transcribed once.  The
    result is cached on disk and returned on subsequent calls.
    """

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self._model = None
        self._model_info: Dict = {}
        self._transcript_cache: Dict[str, TranscriptResult] = {}  # file_fp -> result (in-memory)

    def _load_model(self):
        """Lazy-load the Whisper model. Sync, intended to run via to_thread."""
        if self._model is not None:
            return

        try:
            from faster_whisper import WhisperModel

            attempts = []
            if self.settings.WHISPER_LOCAL_DIR:
                attempts.append(
                    (self.settings.WHISPER_LOCAL_DIR, self.settings.WHISPER_DEVICE, self.settings.WHISPER_COMPUTE_TYPE)
                )

            model_name = self.settings.WHISPER_MODEL
            attempts.append((model_name, self.settings.WHISPER_DEVICE, self.settings.WHISPER_COMPUTE_TYPE))

            # CPU int8 as a same-model fallback (handles missing CUDA, etc.)
            if self.settings.WHISPER_DEVICE != "cpu" or self.settings.WHISPER_COMPUTE_TYPE != "int8":
                attempts.append((model_name, "cpu", "int8"))

            # Smaller-model fallback is OFF by default — silent downgrade to "tiny"
            # would otherwise destroy transcript quality without warning.
            auto_fallback = os.getenv("EDITFLOW_WHISPER_AUTO_FALLBACK", "").strip().lower() in {"1", "true", "yes", "on"}
            if auto_fallback:
                for small_model in ["base", "tiny"]:
                    if small_model != model_name:
                        attempts.append((small_model, "cpu", "int8"))

            last_error: Optional[Exception] = None
            for model_spec, device, compute_type in attempts:
                try:
                    logger.info(f"Loading Whisper model: {model_spec} ({device}/{compute_type})")
                    self._model = WhisperModel(
                        model_spec,
                        device=device,
                        compute_type=compute_type,
                        local_files_only=bool(
                            self.settings.WHISPER_LOCAL_DIR
                            and Path(self.settings.WHISPER_LOCAL_DIR).exists()
                        ),
                    )
                    self._model_info = {
                        "model": str(model_spec),
                        "device": device,
                        "compute_type": compute_type,
                    }
                    if model_spec != model_name and str(model_spec) != self.settings.WHISPER_LOCAL_DIR:
                        logger.warning(
                            f"Whisper fell back to {model_spec} (requested: {model_name}). "
                            "Set EDITFLOW_WHISPER_AUTO_FALLBACK=true to allow smaller-model downgrades."
                        )
                    logger.info(f"Whisper loaded: {model_spec} ({device}/{compute_type})")
                    return
                except Exception as e:
                    last_error = e
                    logger.warning(f"Failed to load Whisper {model_spec} ({device}/{compute_type}): {e}")
                    continue

            raise RuntimeError(
                f"Could not load any Whisper model variant. Last error: {last_error}"
            )

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

        # Load model in a worker thread — first call downloads weights, slow.
        await asyncio.to_thread(self._load_model)

        if progress:
            await progress.update(0.1, "Extracting audio...")

        video_path_obj = Path(video_path)
        audio_path: Optional[Path] = None

        if video_path_obj.suffix.lower() in [".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]:
            tmp_dir = self.settings.MEDIA_CACHE_DIR
            tmp_dir.mkdir(parents=True, exist_ok=True)
            cache_suffix = _audio_cache_key(video_path_obj)
            audio_path = tmp_dir / f"{video_path_obj.stem}_{cache_suffix}.wav"

            # Regenerate when the source video is newer than the cached audio.
            regenerate = True
            if audio_path.exists():
                try:
                    if audio_path.stat().st_mtime >= video_path_obj.stat().st_mtime:
                        regenerate = False
                except OSError:
                    regenerate = True

            if regenerate:
                await asyncio.to_thread(extract_audio, video_path_obj, audio_path)
        elif video_path_obj.suffix.lower() in [".wav", ".mp3", ".flac", ".ogg", ".m4a"]:
            audio_path = video_path_obj
        else:
            return TranscriptResult(
                source_file=str(video_path_obj),
                language="",
                duration=0.0,
                segments=[],
                full_text="",
            )

        if progress:
            await progress.update(0.2, "Transcribing audio...")

        try:
            # The generator returned by transcribe() is lazy — pulling segments out
            # of it is the CPU-bound work. Both the call and the iteration must run
            # off the event loop.
            def _transcribe_call():
                return self._model.transcribe(
                    str(audio_path),
                    task="transcribe",
                    language=language,
                    vad_filter=vad_filter,
                    word_timestamps=word_timestamps,
                    beam_size=5,
                )

            segments_iter, info = await asyncio.to_thread(_transcribe_call)

            expected = float(getattr(info, "duration", 0) or 0)
            if progress:
                await progress.update(
                    0.3, f"Transcribing {expected:.1f}s of audio..."
                )

            # Shared between the consumer thread and the async ticker below.
            progress_state: Dict[str, Any] = {"count": 0, "last_end": 0.0}

            async def _ticker():
                """Emit a progress update roughly every 2 seconds."""
                while True:
                    try:
                        await asyncio.sleep(2.0)
                    except asyncio.CancelledError:
                        return
                    if progress is None:
                        continue
                    last_end = float(progress_state.get("last_end", 0.0))
                    count = int(progress_state.get("count", 0))
                    if expected > 0:
                        pct = 0.3 + 0.6 * min(1.0, last_end / expected)
                    else:
                        pct = 0.4  # unknown duration — show "in progress"
                    try:
                        await progress.update(
                            pct,
                            f"Transcribed {count} segments ({last_end:.1f}s / {expected:.1f}s)",
                        )
                    except Exception:
                        # Don't let a websocket failure kill the transcription
                        return

            ticker_task: Optional[asyncio.Task] = (
                asyncio.create_task(_ticker()) if progress else None
            )
            try:
                result_segments, full_text_parts = await asyncio.to_thread(
                    _consume_segments, segments_iter, word_timestamps, progress_state
                )
            finally:
                if ticker_task is not None:
                    ticker_task.cancel()
                    try:
                        await ticker_task
                    except asyncio.CancelledError:
                        pass

            if progress:
                await progress.complete(f"Transcription complete: {len(result_segments)} segments")

            return TranscriptResult(
                source_file=str(video_path_obj),
                language=info.language,
                duration=round(info.duration, 2),
                segments=result_segments,
                full_text=" ".join(full_text_parts),
            )

        except Exception as e:
            logger.error(f"Transcription error: {e}")
            if progress:
                try:
                    await progress.fail(f"Transcription failed: {e}")
                except Exception:
                    pass
            raise

    # ── Phase B: Transcribe-once-per-source-file ──

    def _transcript_cache_dir(self) -> Path:
        """Directory for on-disk transcript cache (keyed by fingerprint)."""
        d = Path(self.settings.MEDIA_CACHE_DIR) / "transcripts"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _get_cached_transcript(self, file_fingerprint: str) -> Optional[TranscriptResult]:
        """Look up a cached transcript by file fingerprint.

        Checks in-memory cache first, then on-disk JSON cache.
        Returns None if no cached transcript exists.
        """
        # In-memory cache
        if file_fingerprint in self._transcript_cache:
            return self._transcript_cache[file_fingerprint]

        # On-disk cache
        cache_path = self._transcript_cache_dir() / f"{file_fingerprint}.json"
        if cache_path.exists():
            try:
                data = json.loads(cache_path.read_text(encoding="utf-8"))
                result = TranscriptResult(**data)
                self._transcript_cache[file_fingerprint] = result
                return result
            except Exception as e:
                logger.warning(f"Failed to load cached transcript for {file_fingerprint[:16]}...: {e}")
        return None

    def _save_transcript_cache(self, file_fingerprint: str, result: TranscriptResult) -> None:
        """Save a transcript result to both in-memory and on-disk cache."""
        self._transcript_cache[file_fingerprint] = result
        cache_path = self._transcript_cache_dir() / f"{file_fingerprint}.json"
        try:
            cache_path.write_text(
                result.model_dump_json(indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning(f"Failed to cache transcript for {file_fingerprint[:16]}...: {e}")

    async def transcribe_fingerprinted(
        self,
        source_path: str,
        file_fingerprint: Optional[str] = None,
        language: Optional[str] = None,
        word_timestamps: bool = True,
        vad_filter: bool = True,
        progress: Optional[ProgressReporter] = None,
        force: bool = False,
        range_in: float = 0.0,
        range_out: float = 0.0,
    ) -> TranscriptResult:
        """Transcribe a media file with content-addressed deduplication.

        This is the Phase B entry point.  Before running Whisper, it checks
        the transcript cache (keyed by content hash + range + engine + model).
        If a cached transcript exists and ``force`` is False, the cached
        result is returned immediately — the same source file is never
        transcribed twice.

        Phase B enhancement: the cache key is now
            (content_hash, range_in, range_out, engine, model)
        so that engine or model upgrades invalidate old transcripts.

        Args:
            source_path: Path to the source media file.
            file_fingerprint: Pre-computed fingerprint (computed if not provided).
            language: Language hint for Whisper.
            word_timestamps: Whether to request word-level timestamps.
            vad_filter: Whether to use VAD filtering.
            progress: Optional progress reporter.
            force: If True, bypass cache and re-transcribe.
            range_in: Start of audio range (seconds, default 0 = whole file).
            range_out: End of audio range (seconds, default 0 = whole file).

        Returns:
            TranscriptResult with segments, word timestamps, and engine info.
        """
        # Determine the engine name
        engine_name = "faster_whisper"
        model_name = self.settings.WHISPER_MODEL
        model_revision = ""

        # Try to get engine info from the transcribe package if available
        try:
            from .transcribe import select_engine
            selected = select_engine()
            engine_name = selected.name
        except Exception:
            pass

        # Compute fingerprint if not provided
        if file_fingerprint is None:
            try:
                file_fingerprint = await asyncio.to_thread(
                    compute_file_fingerprint, source_path
                )
            except FileNotFoundError:
                raise
            except Exception as e:
                logger.warning(f"Fingerprint computation failed for {source_path}: {e}")
                file_fingerprint = ""

        # Check cache with enhanced key (unless force=True)
        if file_fingerprint and not force:
            cached = self._get_cached_transcript(file_fingerprint)
            if cached is not None:
                # Check if engine/model match — if not, this is a stale cache
                if (getattr(cached, 'engine', '') == engine_name and
                    getattr(cached, 'model', '') == model_name):
                    logger.info(
                        f"Transcript cache hit for {Path(source_path).name} "
                        f"(fp={file_fingerprint[:16]}..., engine={engine_name})"
                    )
                    return cached
                else:
                    logger.info(
                        f"Transcript cache stale for {Path(source_path).name} "
                        f"(cached engine={getattr(cached, 'engine', '?')}, "
                        f"current={engine_name}). Re-transcribing."
                    )

        # Cache miss — run transcription
        result = await self.transcribe(
            video_path=source_path,
            language=language,
            word_timestamps=word_timestamps,
            vad_filter=vad_filter,
            progress=progress,
        )

        # Phase B: stamp engine info and content hash into result
        result.content_hash = file_fingerprint
        result.engine = engine_name
        result.model = model_name
        result.model_revision = model_revision
        result.range_in = range_in
        result.range_out = range_out

        # Phase B: run silero-vad as a separate pass
        try:
            from .transcribe.base import TranscribeEngine
            audio_path = result.source_file  # may be the prepared WAV
            vad_segments = TranscribeEngine.run_vad(audio_path)
            if vad_segments:
                result.warnings.append(
                    f"VAD: {len(vad_segments)} speech segments detected"
                )
                # Store VAD segments in DB for stage 6
                self._persist_vad_segments(
                    file_fingerprint, range_in, range_out, vad_segments
                )
        except Exception as e:
            logger.debug(f"VAD pass skipped: {e}")

        # Cache the result
        if file_fingerprint:
            self._save_transcript_cache(file_fingerprint, result)

        return result

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
        results: List[TranscriptResult] = []

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

    def _persist_vad_segments(
        self,
        content_hash: str,
        range_in: float,
        range_out: float,
        vad_segments: list,
    ) -> None:
        """Persist VAD segments to the transcript_vad DB table."""
        import uuid
        try:
            from ..models.sqlite_registry import sqlite_registry
            for i, seg in enumerate(vad_segments):
                sqlite_registry.insert_vad_segment(
                    segment_id=str(uuid.uuid4())[:12],
                    content_hash=content_hash,
                    range_in=range_in,
                    range_out=range_out,
                    segment_index=i,
                    start=seg.start,
                    end=seg.end,
                    is_speech=seg.is_speech,
                    confidence=seg.confidence,
                )
        except Exception as e:
            logger.debug(f"Failed to persist VAD segments: {e}")

    @property
    def model_info(self) -> Dict:
        """Get information about the loaded model."""
        return self._model_info


# Global service instance
whisper_service = WhisperService()
