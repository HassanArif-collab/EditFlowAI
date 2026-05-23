"""
EditFlow AI - Content-Addressed Audio Preparation

Stage 2 of the take-based editing pipeline.  Given a source media file
(video or audio), this service:

1. Computes a content-addressed fingerprint.
2. Checks the audio cache — if a 16 kHz mono WAV already exists for this
   fingerprint, returns it immediately.
3. If not cached, extracts audio via ffmpeg to 16 kHz mono PCM WAV.
4. Computes the *audio* fingerprint of the extracted WAV (PCM-level hash).
5. Stores the prepared audio in the cache directory keyed by fingerprint.
6. Returns a ``PreparedAudio`` result with all metadata.

Every downstream operation (Whisper transcription, VAD, segmenter) reads
from the prepared audio cache, never from the original file.  This ensures:

- **Transcribe-once-per-source-file**: the fingerprint is the cache key.
  If the same file is referenced from two different clips or folders,
  transcription only runs once.
- **Reproducibility**: the same source content always produces the same
  prepared WAV, regardless of where the file lives on disk.
- **Invalidation**: if the source file changes, its fingerprint changes,
  and the cache misses — forcing a fresh extraction + transcription.
"""
from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any, Dict, Optional

from ..config import Settings, get_settings
from ..models.schemas import PreparedAudio
from ..services.media_fingerprint import (
    compute_audio_fingerprint,
    compute_file_fingerprint,
)
from ..utils.ffmpeg_utils import extract_audio

logger = logging.getLogger(__name__)


class AudioPrepareService:
    """Content-addressed audio preparation: extract, cache, fingerprint."""

    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()

    def prepare(self, source_path: str | Path) -> PreparedAudio:
        """Prepare audio from a source file with content-addressed caching.

        If a prepared WAV already exists for this source file's fingerprint,
        return it without re-extracting.  This is the core of the
        transcribe-once-per-source-file guarantee.

        Args:
            source_path: Path to the source media file (video or audio).

        Returns:
            PreparedAudio with fingerprint, cache path, and metadata.

        Raises:
            FileNotFoundError: If source_path does not exist.
            RuntimeError: If audio extraction fails.
        """
        source = Path(source_path).resolve()
        if not source.exists():
            raise FileNotFoundError(f"Source file not found: {source}")

        # ── Step 1: Compute the file-level fingerprint ──
        file_fp = compute_file_fingerprint(source)
        logger.info(f"File fingerprint for {source.name}: {file_fp[:16]}...")

        # ── Step 2: Check the audio cache ──
        cache_dir = Path(self.settings.MEDIA_CACHE_DIR) / "audio"
        cache_dir.mkdir(parents=True, exist_ok=True)

        # The prepared WAV is keyed by file fingerprint.  If the same file
        # (by content) has been prepared before, we already have the WAV.
        cached_wav = cache_dir / f"{file_fp}.wav"
        if cached_wav.exists():
            audio_fp = compute_audio_fingerprint(cached_wav)
            duration = self._wav_duration(cached_wav)
            logger.info(
                f"Audio cache hit for {source.name} (fp={file_fp[:16]}...), "
                f"duration={duration:.2f}s"
            )
            return PreparedAudio(
                source_file=str(source),
                file_fingerprint=file_fp,
                audio_fingerprint=audio_fp,
                prepared_wav_path=str(cached_wav),
                duration=duration,
                sample_rate=16000,
                channels=1,
                from_cache=True,
            )

        # ── Step 3: Extract audio via ffmpeg ──
        # Write to a temporary path first, then rename to avoid partial reads.
        tmp_wav = cache_dir / f"{file_fp}.tmp.wav"
        try:
            extract_audio(source, tmp_wav, sample_rate=16000)
        except Exception as e:
            # Clean up partial file
            if tmp_wav.exists():
                tmp_wav.unlink(missing_ok=True)
            raise RuntimeError(
                f"Audio extraction failed for {source}: {e}"
            ) from e

        # ── Step 4: Compute audio-level fingerprint ──
        audio_fp = compute_audio_fingerprint(tmp_wav)
        duration = self._wav_duration(tmp_wav)

        # ── Step 5: Atomically move to final cache location ──
        try:
            shutil.move(str(tmp_wav), str(cached_wav))
        except OSError:
            # Another process may have written it; that's fine.
            if tmp_wav.exists():
                tmp_wav.unlink(missing_ok=True)

        logger.info(
            f"Audio prepared for {source.name}: "
            f"file_fp={file_fp[:16]}..., audio_fp={audio_fp[:16]}..., "
            f"duration={duration:.2f}s, cached at {cached_wav.name}"
        )

        return PreparedAudio(
            source_file=str(source),
            file_fingerprint=file_fp,
            audio_fingerprint=audio_fp,
            prepared_wav_path=str(cached_wav),
            duration=duration,
            sample_rate=16000,
            channels=1,
            from_cache=False,
        )

    def get_cached(self, file_fingerprint: str) -> Optional[PreparedAudio]:
        """Look up a previously prepared audio file by file fingerprint.

        Returns None if no cached WAV exists for this fingerprint.
        """
        cache_dir = Path(self.settings.MEDIA_CACHE_DIR) / "audio"
        cached_wav = cache_dir / f"{file_fingerprint}.wav"
        if not cached_wav.exists():
            return None

        audio_fp = compute_audio_fingerprint(cached_wav)
        duration = self._wav_duration(cached_wav)

        return PreparedAudio(
            source_file="",  # Original source path unknown in cache-only lookup
            file_fingerprint=file_fingerprint,
            audio_fingerprint=audio_fp,
            prepared_wav_path=str(cached_wav),
            duration=duration,
            sample_rate=16000,
            channels=1,
            from_cache=True,
        )

    def invalidate(self, file_fingerprint: str) -> bool:
        """Remove a cached prepared audio file.

        Returns True if the file was removed, False if it wasn't in cache.
        """
        cache_dir = Path(self.settings.MEDIA_CACHE_DIR) / "audio"
        cached_wav = cache_dir / f"{file_fingerprint}.wav"
        if cached_wav.exists():
            cached_wav.unlink()
            logger.info(f"Invalidated audio cache for fp={file_fingerprint[:16]}...")
            return True
        return False

    @staticmethod
    def _wav_duration(path: Path) -> float:
        """Compute duration of a WAV file from its header.

        Uses pure Python — no ffprobe dependency.  Falls back to 0.0 if
        the header can't be parsed.
        """
        import struct

        try:
            with open(path, "rb") as f:
                header = f.read(44)
                if len(header) < 44:
                    return 0.0
                # RIFF header: bytes 16-20 = audio format, 20-22 = channels,
                # 22-24 = sample rate, 24-28 = byte rate, 28-30 = block align,
                # 30-32 = bits per sample.
                # For data chunk starting at byte 36: bytes 40-44 = data size.
                # But we should find the 'data' chunk properly.
                f.seek(0)
                # Skip RIFF header (12 bytes)
                f.read(12)
                data_size = None
                sample_rate = 16000
                channels = 1
                bits_per_sample = 16
                while True:
                    chunk_header = f.read(8)
                    if len(chunk_header) < 8:
                        break
                    chunk_id = chunk_header[:4]
                    chunk_size = struct.unpack("<I", chunk_header[4:8])[0]

                    if chunk_id == b"fmt ":
                        fmt_data = f.read(chunk_size)
                        if len(fmt_data) >= 16:
                            channels = struct.unpack("<H", fmt_data[2:4])[0]
                            sample_rate = struct.unpack("<I", fmt_data[4:8])[0]
                            bits_per_sample = struct.unpack("<H", fmt_data[14:16])[0]
                    elif chunk_id == b"data":
                        data_size = chunk_size
                        break
                    else:
                        f.seek(chunk_size, 1)
                        if chunk_size % 2:
                            f.seek(1, 1)

                if data_size is not None and sample_rate > 0 and channels > 0:
                    bytes_per_sample = bits_per_sample // 8
                    if bytes_per_sample == 0:
                        bytes_per_sample = 2  # assume 16-bit
                    num_samples = data_size // (bytes_per_sample * channels)
                    return num_samples / sample_rate
            return 0.0
        except Exception:
            return 0.0


# Global service instance
audio_prepare_service = AudioPrepareService()
